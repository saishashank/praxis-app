// @vitest-environment node
// SEC-017, PLT-016, PLT-076: signed maintenance route (same cases as the self-check route tests)
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import * as route from "@/app/api/internal/maintenance/route";
import { createMaintenanceHandler } from "@/lib/maintenance/handler";
import type { NonceStore } from "@/lib/security/replay";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const SECRET = "9".repeat(64);
const PII = "4".repeat(64);
const NOW = 1_700_000_000;
const BODY = '{"purpose":"maintenance","date":"2023-11-15"}';
const ENV = { ACTIONS_HMAC_SECRET: SECRET, PII_HASH_KEY: PII };
const memStore = (): NonceStore => {
  const seen = new Set<string>();
  return {
    claim: async (n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    },
  };
};
let main: Client;
let auth: Client;
beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
});
const make = (over: Record<string, unknown> = {}) =>
  createMaintenanceHandler({
    env: ENV,
    store: memStore(),
    nowSec: () => NOW,
    mainDb: () => main,
    authDb: () => auth,
    ...over,
  });
let n = 0;
const nextNonce = () => (++n).toString(16).padStart(32, "0");
const post = (body = BODY, headers?: Record<string, string>, nonce = nextNonce()) =>
  new Request("https://praxis-host.vercel.app/api/internal/maintenance", {
    method: "POST",
    body,
    headers: headers ?? (sign(SECRET, body, NOW, nonce) as Record<string, string>),
  });
const runCount = async () =>
  Number((await main.execute("SELECT COUNT(*) AS c FROM run_record")).rows[0].c);

describe("maintenance handler", () => {
  it("200 with counts and no-store; writes one run record", async () => {
    const r = await make()(post());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      ok: true,
      skipped: false,
      date: "2023-11-15",
      prunedRuns: 0,
      prunedLogs: 0,
      prunedNonces: 0,
      hashedUsers: 0,
    });
    expect(await runCount()).toBe(1);
  });

  it("a second signed call for the same date is skipped and writes nothing (PLT-076)", async () => {
    const h = make();
    expect((await h(post())).status).toBe(200);
    const r = await h(post());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ skipped: true });
    expect(await runCount()).toBe(1);
  });

  it("401 generic body for bad signature, missing headers, replay, stale timestamp; no run", async () => {
    const h = make();
    const bad = sign("8".repeat(64), BODY, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, BODY, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const future = sign(SECRET, BODY, NOW + 301, "d".repeat(32)) as Record<string, string>;
    const tampered = sign(
      SECRET,
      '{"purpose":"maintenance","date":"2023-11-14"}',
      NOW,
      "e".repeat(32),
    ) as Record<string, string>;
    const nonce = "c".repeat(32);
    expect((await h(post(BODY, undefined, nonce))).status).toBe(200);
    const before = await runCount();
    for (const req of [
      post(BODY, bad),
      post(BODY, {}),
      post(BODY, stale),
      post(BODY, future),
      post(BODY, tampered),
      post(BODY, undefined, nonce),
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    expect(await runCount()).toBe(before);
  });

  it("a self-check signature cannot be replayed against this route (purpose is signed)", async () => {
    const body = '{"purpose":"self-check"}';
    const r = await make()(post(body));
    expect(r.status).toBe(400);
    expect(await runCount()).toBe(0);
  });

  it("503 generic when secret is missing or malformed (signature not evaluated)", async () => {
    for (const secret of [undefined, "", "zz"]) {
      const r = await make({ env: { ...ENV, ACTIONS_HMAC_SECRET: secret } })(post());
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "unavailable" });
    }
  });

  it("503 when the replay store fails, without leaking its error", async () => {
    const store = { claim: () => Promise.reject(new Error("db host secret")) };
    const r = await make({ store })(post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
  });

  it("400 for oversize body, non-JSON, wrong purpose, non-object, bad or missing date", async () => {
    const h = make();
    const bodies = [
      "x".repeat(4097),
      "not json",
      '{"purpose":"other","date":"2023-11-15"}',
      "null",
      "[]",
      '{"purpose":"maintenance"}',
      '{"purpose":"maintenance","date":"2023-02-30"}',
      '{"purpose":"maintenance","date":"15/11/2023"}',
      '{"purpose":"maintenance","date":20231115}',
    ];
    for (const body of bodies) {
      const r = await h(post(body));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
    expect(await runCount()).toBe(0);
  });

  it("500 {error:'failed'} when a step fails, with a failed run record and no leaked detail", async () => {
    await main.execute("DROP TABLE app_log");
    const r = await make()(post());
    expect(r.status).toBe(500);
    expect(await r.text()).toBe('{"error":"failed"}');
    const rec = (await main.execute("SELECT status, error_summary FROM run_record")).rows[0];
    expect(rec.status).toBe("failed");
    expect(rec.error_summary).toBe("failed steps: prune_logs");
  });

  it("503 when a database cannot be opened or the run cannot start", async () => {
    const boom = () => {
      throw new Error("database not configured https://secret-host");
    };
    const r1 = await make({ mainDb: boom })(post());
    expect(r1.status).toBe(503);
    expect(await r1.text()).not.toContain("secret-host");
    expect((await make({ authDb: boom })(post())).status).toBe(503);
    await main.execute("DROP TABLE run_record");
    expect((await make()(post())).status).toBe(503);
  });

  it("503 on an unexpected exception", async () => {
    const broken = {
      text: () => Promise.reject(new Error("x")),
      headers: new Headers(),
    } as unknown as Request;
    expect((await make()(broken)).status).toBe(503);
  });
});

describe("route module", () => {
  it("exports POST only, dynamic and nodejs", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });
  it("POST answers 503 when ACTIONS_HMAC_SECRET is not configured (no network reached)", async () => {
    const saved = process.env.ACTIONS_HMAC_SECRET;
    delete process.env.ACTIONS_HMAC_SECRET;
    try {
      expect((await route.POST(post(BODY, {}))).status).toBe(503);
    } finally {
      if (saved !== undefined) process.env.ACTIONS_HMAC_SECRET = saved;
    }
  });
  it("POST with a valid signature fails closed (503) when the nonce store is not configured", async () => {
    const saved = { ...process.env };
    process.env.ACTIONS_HMAC_SECRET = SECRET;
    delete process.env.TURSO_MAIN_URL;
    delete process.env.TURSO_MAIN_TOKEN;
    try {
      const headers = sign(SECRET, BODY, Math.floor(Date.now() / 1000), nextNonce());
      const r = await route.POST(post(BODY, headers as Record<string, string>));
      expect(r.status).toBe(503);
    } finally {
      process.env = saved;
    }
  });
});

// @vitest-environment node
// POST /api/internal/universe-import (M2 T11, D-067; SEC-017 c2): signature, replay, size cap,
// environment binding, date binding, generic errors, no echo; plus the real route wired to a
// local database. Synthetic data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import {
  createUniverseImportHandler,
  MAX_BODY_BYTES,
  MAX_CSV_BYTES,
  type Deps,
} from "@/lib/data/universe/handler";
import type { ImportResult } from "@/lib/data/universe/import";
import type { NonceStore } from "@/lib/security/replay";
import { isPublicPath } from "@/lib/http/gate";
import { cleanupTempDbs } from "../db/helpers";
import { cos, csvOf, instruments, newDb } from "./helpers";

const mem = vi.hoisted(() => ({ seen: new Set<string>(), db: null as unknown }));
vi.mock("@/lib/security/replay", () => ({
  TursoNonceStore: class {
    async claim(n: string) {
      if (mem.seen.has(n)) return false;
      mem.seen.add(n);
      return true;
    }
  },
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.db }));

import * as route from "@/app/api/internal/universe-import/route";

afterEach(() => {
  cleanupTempDbs();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const SECRET = "7".repeat(64);
// 2026-10-13 07:30 AEDT (UTC+11).
const NOW_MS = Date.UTC(2026, 9, 12, 20, 30, 0);
const NOW = NOW_MS / 1000;
const TODAY = "2026-10-13";
const STAGING_ENV = { WORKER_HMAC_SECRET: SECRET, TEST_IDENTITY_SECRET: "1".repeat(64) };
const PROD_ENV = { WORKER_HMAC_SECRET: SECRET, BACKUP_PUBLIC_KEY: "age1xyz" };
const CSV = csvOf(cos(3));
const good = (over: Record<string, unknown> = {}) => ({
  purpose: "universe-import",
  env: "staging",
  d: TODAY,
  csv: CSV,
  ...over,
});

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
type Call = { csv: string; today: string };
const ok = (): ImportResult => ({
  ok: true,
  status: "applied",
  counts: {
    file: 3,
    prevActive: 0,
    inserted: 3,
    updated: 0,
    unchanged: 0,
    reactivated: 0,
    missingOnce: 0,
    delisted: 0,
  },
  parsed: { records: 3, valid: 3, duplicates: 0, badCodes: 0, malformed: 0 },
});
const make = (over: Partial<Deps> = {}, calls: Call[] = [], result: () => ImportResult = ok) =>
  createUniverseImportHandler({
    env: STAGING_ENV,
    store: memStore(),
    nowSec: () => NOW,
    today: () => TODAY,
    importCsv: async (csv, today) => {
      calls.push({ csv, today });
      return result();
    },
    ...over,
  });
let n = 0;
const nextNonce = () => (++n).toString(16).padStart(32, "0");
const post = (
  body: string | object = good(),
  headers?: Record<string, string>,
  nonce = nextNonce(),
) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://praxis-host.vercel.app/api/internal/universe-import", {
    method: "POST",
    body: raw,
    headers: headers ?? (sign(SECRET, raw, NOW, nonce) as Record<string, string>),
  });
};

describe("universe-import handler", () => {
  it("200 {result:applied, counts}, no-store; the CSV and the Sydney date reach the importer", async () => {
    const calls: Call[] = [];
    const r = await make({}, calls)(post());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = await r.json();
    expect(j.result).toBe("applied");
    expect(j.counts.inserted).toBe(3);
    expect(calls).toEqual([{ csv: CSV, today: TODAY }]);
  });

  it("an already applied date answers {result:already_applied}", async () => {
    const r = await make({}, [], () => ({ ok: true, status: "already_applied" }))(post());
    expect(await r.json()).toEqual({ result: "already_applied" });
  });

  it("accepts the production environment with BACKUP_PUBLIC_KEY", async () => {
    const calls: Call[] = [];
    const r = await make({ env: PROD_ENV }, calls)(post(good({ env: "production" })));
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("401 generic body: wrong secret, no headers, stale, future, tampered body, replay", async () => {
    const calls: Call[] = [];
    const h = make({}, calls);
    const raw = JSON.stringify(good());
    const wrong = sign("8".repeat(64), raw, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, raw, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const future = sign(SECRET, raw, NOW + 301, "d".repeat(32)) as Record<string, string>;
    const okHeaders = sign(SECRET, raw, NOW, "e".repeat(32)) as Record<string, string>;
    const nonce = "c".repeat(32);
    expect((await h(post(raw, undefined, nonce))).status).toBe(200);
    const tampered = JSON.stringify(good({ d: "2026-10-14" }));
    for (const req of [
      post(raw, wrong),
      post(raw, {}),
      post(raw, stale),
      post(raw, future),
      post(tampered, okHeaders),
      post(raw, undefined, nonce), // replay
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    expect(calls).toHaveLength(1); // only the first, signed request reached the importer
  });

  it("503 when WORKER_HMAC_SECRET is missing or malformed, nothing evaluated", async () => {
    for (const secret of [undefined, "", "zz", "A".repeat(64)]) {
      const calls: Call[] = [];
      const r = await make({ env: { ...STAGING_ENV, WORKER_HMAC_SECRET: secret } }, calls)(post());
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "unavailable" });
      expect(calls).toHaveLength(0);
    }
  });

  it("503 when the replay store fails, without leaking its error", async () => {
    const store = { claim: () => Promise.reject(new Error("db host secret")) };
    const r = await make({ store })(post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
  });

  it("503 on an unexpected exception and when the importer throws", async () => {
    const broken = {
      text: () => Promise.reject(new Error("x")),
      headers: new Headers(),
    } as unknown as Request;
    expect((await make()(broken)).status).toBe(503);
    const throws = make({
      importCsv: async () => {
        throw new Error("db SECRET-9");
      },
    });
    const r = await throws(post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("SECRET-9");
  });

  it("size cap: a declared oversize body is refused before it is read", async () => {
    const calls: Call[] = [];
    const req = new Request("https://praxis-host.vercel.app/api/internal/universe-import", {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    });
    const text = vi.spyOn(req, "text");
    const r = await make({}, calls)(req);
    expect(r.status).toBe(400);
    expect(text).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("size cap: an oversize body (even correctly signed) and an oversize CSV are 400", async () => {
    const calls: Call[] = [];
    const h = make({}, calls);
    const bigBody = JSON.stringify(good({ pad: "x".repeat(MAX_BODY_BYTES) }));
    expect((await h(post(bigBody))).status).toBe(400);
    const bigCsv = JSON.stringify(good({ csv: "a".repeat(MAX_CSV_BYTES + 1) }));
    expect((await h(post(bigCsv))).status).toBe(400);
    expect(calls).toHaveLength(0);
    // Exactly at the cap is fine.
    const atCap = JSON.stringify(good({ csv: "a".repeat(MAX_CSV_BYTES) }));
    expect((await h(post(atCap))).status).toBe(200);
  });

  it("400 for non-JSON, wrong purpose, non-object, bad csv type", async () => {
    const calls: Call[] = [];
    const h = make({}, calls);
    for (const body of [
      "not json",
      "null",
      "[]",
      JSON.stringify(good({ purpose: "worker-report" })),
      JSON.stringify(good({ csv: 5 })),
      JSON.stringify(good({ csv: undefined })),
    ]) {
      const r = await h(post(body));
      expect(r.status, body).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("400 on an environment mismatch (both directions, and when neither can be derived)", async () => {
    const calls: Call[] = [];
    expect((await make({}, calls)(post(good({ env: "production" })))).status).toBe(400);
    expect((await make({ env: PROD_ENV }, calls)(post(good({ env: "staging" })))).status).toBe(400);
    const both = { ...PROD_ENV, TEST_IDENTITY_SECRET: "1".repeat(64) };
    expect((await make({ env: both }, calls)(post(good({ env: "production" })))).status).toBe(400);
    for (const env of [undefined, "", "dev", 1]) {
      expect((await make({}, calls)(post(good({ env })))).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("400 when the signed date is not the server's Sydney date", async () => {
    const calls: Call[] = [];
    for (const d of [undefined, "", "2026-10-12", "2026-10-14", "13/10/2026", 20261013]) {
      expect((await make({}, calls)(post(good({ d })))).status, String(d)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("maps importer outcomes: 422 unrecognised_format, 409 suspicious_shrink, 503 unavailable", async () => {
    const mapped = async (e: "unrecognised_format" | "suspicious_shrink" | "unavailable") => {
      const r = await make({}, [], () => ({ ok: false, error: e }))(post());
      return [r.status, await r.json()];
    };
    expect(await mapped("unrecognised_format")).toEqual([422, { error: "unrecognised_format" }]);
    expect(await mapped("suspicious_shrink")).toEqual([409, { error: "suspicious_shrink" }]);
    expect(await mapped("unavailable")).toEqual([503, { error: "unavailable" }]);
  });

  it("never echoes a secret, the CSV or the request body in any response", async () => {
    const marker = csvOf([{ code: "ZZMARK", name: "Synthetic MARKER-NAME Ltd" }]);
    const responses = [
      await make()(post(good({ csv: marker }))),
      await make()(post(good({ csv: marker }), {})),
      await make({ env: { ...STAGING_ENV, WORKER_HMAC_SECRET: undefined } })(post()),
      await make()(post(good({ csv: marker, env: "production" }))),
      await make({}, [], () => ({ ok: false, error: "unrecognised_format" }))(
        post(good({ csv: marker })),
      ),
      await make({}, [], () => ({ ok: false, error: "suspicious_shrink" }))(
        post(good({ csv: marker })),
      ),
    ];
    for (const r of responses) {
      const t = await r.text();
      expect(t).not.toContain(SECRET);
      expect(t).not.toContain("MARKER-NAME");
      expect(t).not.toContain("ZZMARK");
      expect(t).not.toContain("praxis-host");
    }
  });
});

describe("the route file and the gate", () => {
  it("exports POST only and is a public machine route (no session, no origin check)", () => {
    expect(typeof route.POST).toBe("function");
    expect(Object.keys(route).filter((k) => ["GET", "PUT", "DELETE", "PATCH"].includes(k))).toEqual(
      [],
    );
    expect(isPublicPath("/api/internal/universe-import")).toBe(true);
    expect(isPublicPath("/api/internal/universe-import/x")).toBe(false);
    expect(isPublicPath("/api/internal/universe-importx")).toBe(false);
  });
});

describe("the real route against a local database", () => {
  let db: Client;
  beforeEach(async () => {
    mem.seen.clear();
    db = await newDb();
    mem.db = db;
    vi.useFakeTimers({ toFake: ["Date"], now: NOW_MS });
    vi.stubEnv("WORKER_HMAC_SECRET", SECRET);
    vi.stubEnv("TEST_IDENTITY_SECRET", "1".repeat(64));
    vi.stubEnv("BACKUP_PUBLIC_KEY", "");
  });

  it("a signed request imports the instruments; the same body replayed is refused", async () => {
    const raw = JSON.stringify(good({ csv: csvOf(cos(5)) }));
    const nonce = "f".repeat(32);
    const mk = () =>
      new Request("https://praxis-host.vercel.app/api/internal/universe-import", {
        method: "POST",
        body: raw,
        headers: sign(SECRET, raw, NOW, nonce) as Record<string, string>,
      });
    const r = await route.POST(mk());
    expect(r.status).toBe(200);
    expect(await instruments(db)).toHaveLength(5);
    expect((await route.POST(mk())).status).toBe(401);
    // A fresh nonce for the same date: already applied, nothing changes.
    const r2 = await route.POST(post(raw));
    expect(await r2.json()).toEqual({ result: "already_applied" });
    expect(await instruments(db)).toHaveLength(5);
  });

  it("an unsigned request changes nothing", async () => {
    const r = await route.POST(post(good({ csv: csvOf(cos(5)) }), {}));
    expect(r.status).toBe(401);
    expect(await instruments(db)).toHaveLength(0);
  });
});

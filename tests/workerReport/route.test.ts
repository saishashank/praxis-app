// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import * as route from "@/app/api/internal/worker-report/route";
import { createWorkerReportHandler, type WorkerReport } from "@/lib/workerReport/handler";
import { recordWorkerReport, WORKER_SELFCHECK_JOB } from "@/lib/workerReport/record";
import type { NonceStore } from "@/lib/security/replay";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const SECRET = "7".repeat(64);
const NOW = 1_700_000_000;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const STAGING_ENV = { WORKER_HMAC_SECRET: SECRET, TEST_IDENTITY_SECRET: "1".repeat(64) };
const PROD_ENV = { WORKER_HMAC_SECRET: SECRET, BACKUP_PUBLIC_KEY: "age1xyz" };
const good = (over: Record<string, unknown> = {}) => ({
  purpose: "worker-report",
  env: "staging",
  commit: COMMIT,
  results: [
    { name: "TURSO_MAIN round trip", ok: true, detail: "create/insert/select/drop ok" },
    { name: "GITHUB_DISPATCH_TOKEN", ok: true, detail: "HTTP 200" },
  ],
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
type Recorded = { report: WorkerReport }[];
const make = (over: Record<string, unknown> = {}, recorded: Recorded = []) =>
  createWorkerReportHandler({
    env: STAGING_ENV,
    store: memStore(),
    nowSec: () => NOW,
    recordRun: async (report) => void recorded.push({ report }),
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
  return new Request("https://praxis-host.vercel.app/api/internal/worker-report", {
    method: "POST",
    body: raw,
    headers: headers ?? (sign(SECRET, raw, NOW, nonce) as Record<string, string>),
  });
};

describe("worker-report handler", () => {
  it("200 {recorded:true}, no-store; records the commit and results plus the server-side result", async () => {
    const rec: Recorded = [];
    const r = await make({}, rec)(post());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ recorded: true });
    expect(rec).toHaveLength(1);
    expect(rec[0].report.commit).toBe(COMMIT);
    expect(rec[0].report.results).toEqual([
      ...good().results,
      { name: "WORKER_HMAC_SECRET", ok: true, detail: "signed report accepted" },
    ]);
  });

  it("accepts commit 'unknown', production env with BACKUP_PUBLIC_KEY, and an empty results list", async () => {
    const rec: Recorded = [];
    const h = make({ env: PROD_ENV }, rec);
    expect(
      (await h(post(good({ env: "production", commit: "unknown", results: [] })))).status,
    ).toBe(200);
    expect(rec[0].report.commit).toBe("unknown");
    expect(rec[0].report.results).toHaveLength(1);
  });

  it("401 generic body: wrong secret, no headers, stale, future, tampered body, replay", async () => {
    const h = make();
    const raw = JSON.stringify(good());
    const wrong = sign("8".repeat(64), raw, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, raw, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const future = sign(SECRET, raw, NOW + 301, "d".repeat(32)) as Record<string, string>;
    const okHeaders = sign(SECRET, raw, NOW, "e".repeat(32)) as Record<string, string>;
    const nonce = "c".repeat(32);
    expect((await h(post(raw, undefined, nonce))).status).toBe(200);
    const tampered = JSON.stringify(good({ commit: "unknown" }));
    for (const req of [
      post(raw, wrong),
      post(raw, {}),
      post(raw, stale),
      post(raw, future),
      post(tampered, okHeaders),
      post(raw, undefined, nonce),
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("a rejected request records nothing", async () => {
    const rec: Recorded = [];
    expect((await make({}, rec)(post(good(), {}))).status).toBe(401);
    expect(rec).toHaveLength(0);
  });

  it("503 when WORKER_HMAC_SECRET is missing or malformed, nothing evaluated", async () => {
    for (const secret of [undefined, "", "zz", "A".repeat(64)]) {
      const rec: Recorded = [];
      const r = await make({ env: { ...STAGING_ENV, WORKER_HMAC_SECRET: secret } }, rec)(post());
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "unavailable" });
      expect(rec).toHaveLength(0);
    }
  });

  it("503 when the replay store fails, without leaking its error", async () => {
    const store = { claim: () => Promise.reject(new Error("db host secret")) };
    const r = await make({ store })(post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
  });

  it("503 (not a false success) when the run record cannot be written, without leaking", async () => {
    const recordRun = async () => {
      throw new Error("db down SECRET-123");
    };
    const r = await make({ recordRun })(post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("SECRET-123");
  });

  it("503 on an unexpected exception", async () => {
    const broken = {
      text: () => Promise.reject(new Error("x")),
      headers: new Headers(),
    } as unknown as Request;
    expect((await make()(broken)).status).toBe(503);
  });

  it("400 for oversize body (signed), non-JSON, wrong purpose, non-object", async () => {
    const h = make();
    const big = JSON.stringify(good({ pad: "x".repeat(4096) }));
    for (const body of [
      big,
      "not json",
      JSON.stringify(good({ purpose: "self-check" })),
      "null",
      "[]",
    ]) {
      const r = await h(post(body));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
  });

  it("400 on an environment mismatch (both directions, and when neither can be derived)", async () => {
    expect((await make()(post(good({ env: "production" })))).status).toBe(400);
    expect((await make({ env: PROD_ENV })(post(good({ env: "staging" })))).status).toBe(400);
    // production holding the staging-only secret is not production (SEC-109)
    const both = { ...PROD_ENV, TEST_IDENTITY_SECRET: "1".repeat(64) };
    expect((await make({ env: both })(post(good({ env: "production" })))).status).toBe(400);
    for (const env of [undefined, "", "dev", 1]) {
      expect((await make()(post(good({ env })))).status).toBe(400);
    }
  });

  it("400 on a bad commit", async () => {
    for (const commit of [undefined, "", "ABCDEF".repeat(7).slice(0, 40), "abc", COMMIT + "0", 5]) {
      expect((await make()(post(good({ commit })))).status).toBe(400);
    }
  });

  it("400 on malformed results", async () => {
    const item = { name: "n", ok: true, detail: "d" };
    const bad: unknown[] = [
      undefined,
      null,
      "x",
      {},
      Array.from({ length: 21 }, () => item),
      [null],
      ["x"],
      [{ ...item, name: "" }],
      [{ ...item, name: "n".repeat(61) }],
      [{ ...item, name: 5 }],
      [{ ...item, detail: "d".repeat(121) }],
      [{ ...item, detail: 5 }],
      [{ ...item, detail: undefined }],
      [{ ...item, ok: "true" }],
      [{ ...item, ok: 1 }],
      [{ ...item, ok: undefined }],
      [{ ...item, name: "bad\nname" }],
      [{ ...item, detail: "\u0000" }],
      [{ ...item, name: "WORKER_HMAC_SECRET" }],
    ];
    for (const results of bad) {
      const r = await make()(post(good({ results })));
      expect(r.status, JSON.stringify(results)).toBe(400);
    }
  });

  it("accepts exactly 20 items, and maximal name and detail lengths", async () => {
    const small = { name: "n", ok: false, detail: "d" };
    const big = { name: "n".repeat(60), ok: false, detail: "d".repeat(120) };
    const rec: Recorded = [];
    const h = make({}, rec);
    expect((await h(post(good({ results: Array.from({ length: 20 }, () => small) })))).status).toBe(
      200,
    );
    expect(rec[0].report.results).toHaveLength(21);
    expect((await h(post(good({ results: [big, big, big] })))).status).toBe(200);
    expect(rec[1].report.results[0]).toEqual(big);
  });

  it("copies only name/ok/detail: extra fields never reach the record or the response", async () => {
    const rec: Recorded = [];
    const r = await make(
      {},
      rec,
    )(
      post(
        good({
          results: [{ name: "n", ok: true, detail: "d", token: "LEAK-1", pending: true }],
          extra: "LEAK-2",
        }),
      ),
    );
    const text = await r.text();
    expect(text).toBe('{"recorded":true}');
    expect(JSON.stringify(rec)).not.toContain("LEAK");
    expect(Object.keys(rec[0].report.results[0]).sort()).toEqual(["detail", "name", "ok"]);
  });

  it("never echoes a secret or the request body in any response", async () => {
    const bodyWithMarker = good({ results: [{ name: "n", ok: true, detail: "MARKER-DETAIL" }] });
    const responses = [
      await make()(post(bodyWithMarker)),
      await make()(post(bodyWithMarker, {})),
      await make({ env: { ...STAGING_ENV, WORKER_HMAC_SECRET: undefined } })(post()),
      await make()(post(good({ env: "production" }))),
    ];
    for (const r of responses) {
      const t = await r.text();
      expect(t).not.toContain(SECRET);
      expect(t).not.toContain("MARKER-DETAIL");
      expect(t).not.toContain("praxis-host");
    }
  });
});

describe("recordWorkerReport", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
  });
  afterEach(cleanupTempDbs);

  const rows = async () => (await db.execute("SELECT * FROM run_record")).rows;

  it("success run record with commit, details and a worker-selfcheck concurrency key", async () => {
    await recordWorkerReport(db, {
      commit: COMMIT,
      results: [
        { name: "a", ok: true, detail: "HTTP 200" },
        { name: "b", ok: true, detail: "ok" },
      ],
    });
    const [row] = await rows();
    expect(WORKER_SELFCHECK_JOB).toBe("worker-selfcheck");
    expect(row.job).toBe("worker-selfcheck");
    expect(String(row.concurrency_key)).toMatch(/^worker-selfcheck:\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(row.status).toBe("success");
    expect(row.commit_sha).toBe(COMMIT);
    expect(row.items_processed).toBe(2);
    expect(row.error_summary).toBeNull();
    expect(JSON.parse(String(row.details_json))).toEqual([
      { name: "a", ok: true, detail: "HTTP 200" },
      { name: "b", ok: true, detail: "ok" },
    ]);
  });

  it("failed when any result is not ok, with a names-free error summary", async () => {
    await recordWorkerReport(db, {
      commit: "unknown",
      results: [
        { name: "a", ok: true, detail: "x" },
        { name: "SECRETISH", ok: false, detail: "HTTP 401" },
      ],
    });
    const [row] = await rows();
    expect(row.status).toBe("failed");
    expect(row.error_summary).toBe("1 check(s) failed");
    expect(row.commit_sha).toBe("unknown");
  });

  it("the Worker's decision query finds the success but not a failure older than 15 minutes", async () => {
    await recordWorkerReport(db, {
      commit: COMMIT,
      results: [{ name: "a", ok: false, detail: "x" }],
    });
    const sql =
      "SELECT 1 FROM run_record WHERE job='worker-selfcheck' AND commit_sha=? AND (status='success' OR started_at>?) LIMIT 1";
    const recent = new Date(Date.now() - 15 * 60_000).toISOString();
    expect((await db.execute({ sql, args: [COMMIT, recent] })).rows).toHaveLength(1);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await db.execute({ sql, args: [COMMIT, future] })).rows).toHaveLength(0);
    await recordWorkerReport(db, {
      commit: COMMIT,
      results: [{ name: "a", ok: true, detail: "x" }],
    });
    expect((await db.execute({ sql, args: [COMMIT, future] })).rows).toHaveLength(1);
  });
});

describe("route module", () => {
  it("exports POST only, dynamic and nodejs", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });
  it("POST answers 503 when WORKER_HMAC_SECRET is not configured (no network reached)", async () => {
    const saved = process.env.WORKER_HMAC_SECRET;
    delete process.env.WORKER_HMAC_SECRET;
    try {
      expect((await route.POST(post(good(), {}))).status).toBe(503);
    } finally {
      if (saved !== undefined) process.env.WORKER_HMAC_SECRET = saved;
    }
  });
  it("POST with a valid signature fails closed (503) when the nonce store is not configured", async () => {
    const saved = { ...process.env };
    process.env.WORKER_HMAC_SECRET = SECRET;
    delete process.env.TURSO_MAIN_URL;
    delete process.env.TURSO_MAIN_TOKEN;
    try {
      const raw = JSON.stringify(good());
      const headers = sign(SECRET, raw, Math.floor(Date.now() / 1000), nextNonce());
      const r = await route.POST(post(raw, headers as Record<string, string>));
      expect(r.status).toBe(503);
    } finally {
      process.env = saved;
    }
  });
});

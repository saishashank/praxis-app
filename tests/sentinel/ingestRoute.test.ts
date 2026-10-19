// @vitest-environment node
// POST /api/internal/sentinel-ingest (M5 T5, decision 36, D-067 pattern, D-029; SEC-017 c2):
// signature, replay, stale and future timestamps, tampered body, fail-closed 503, size caps,
// purpose / environment / date / hash binding, outcome mapping, no echo; plus the real route wired
// to a local database. Synthetic data only (SEC-110).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import {
  createSentinelIngestHandler,
  MAX_BODY_BYTES,
  MAX_FEED_BYTES,
  type Deps,
} from "@/lib/sentinel/handler";
import type { IngestResult } from "@/lib/sentinel/ingest";
import type { NonceStore } from "@/lib/security/replay";
import { isPublicPath } from "@/lib/http/gate";
import { cleanupTempDbs, freshDb } from "../db/helpers";

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

import * as route from "@/app/api/internal/sentinel-ingest/route";

afterEach(() => {
  cleanupTempDbs();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const SECRET = "7".repeat(64);
// 2026-10-13 11:10 AEDT (UTC+11).
const NOW_MS = Date.UTC(2026, 9, 13, 0, 10, 0);
const NOW = NOW_MS / 1000;
const TODAY = "2026-10-13";
const STAGING_ENV = { WORKER_HMAC_SECRET: SECRET, TEST_IDENTITY_SECRET: "1".repeat(64) };
const PROD_ENV = { WORKER_HMAC_SECRET: SECRET, BACKUP_PUBLIC_KEY: "age1xyz" };
const URL_ = "https://praxis-host.vercel.app/api/internal/sentinel-ingest";

const feedOf = (n = 2, marker = "") =>
  JSON.stringify({
    data: Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      code: "ZZAA",
      time: new Date(NOW_MS - (60 - i) * 60_000).toISOString(),
      type: "Progress Report",
      price_sensitive: false,
      title: `Synthetic update ${i}${marker}`,
      url: "https://example.test/x.pdf",
    })),
  });
const shaOf = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const good = (over: Record<string, unknown> = {}, feed = feedOf()) => ({
  purpose: "sentinel-ingest",
  env: "staging",
  d: TODAY,
  sha: shaOf(feed),
  feed,
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
type Call = { feed: string; sha: string; today: string };
const ok = (): IngestResult => ({ ok: true, seen: 2, skipped: 0, new: 2, assessed: 2, carried: 0 });
const make = (over: Partial<Deps> = {}, calls: Call[] = [], result: () => IngestResult = ok) =>
  createSentinelIngestHandler({
    env: STAGING_ENV,
    store: memStore(),
    nowSec: () => NOW,
    today: () => TODAY,
    ingest: async (feed, sha, today) => {
      calls.push({ feed, sha, today });
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
  return new Request(URL_, {
    method: "POST",
    body: raw,
    headers: headers ?? (sign(SECRET, raw, NOW, nonce) as Record<string, string>),
  });
};

describe("sentinel-ingest handler", () => {
  it("200 {new, assessed, carried}, no-store; the feed, hash and Sydney date reach the ingest", async () => {
    const calls: Call[] = [];
    const feed = feedOf();
    const r = await make({}, calls)(post(good({}, feed)));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ new: 2, assessed: 2, carried: 0 });
    expect(calls).toEqual([{ feed, sha: shaOf(feed), today: TODAY }]);
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
      post(raw, undefined, nonce), // replay: the same nonce twice
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    expect(calls).toHaveLength(1); // only the first, signed request reached the ingest
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

  it("503 when the replay store fails or the ingest throws, without leaking the error", async () => {
    const store = { claim: () => Promise.reject(new Error("db host secret")) };
    const r = await make({ store })(post());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
    const throws = make({
      ingest: async () => {
        throw new Error("db SECRET-9");
      },
    });
    const r2 = await throws(post());
    expect(r2.status).toBe(503);
    expect(await r2.text()).not.toContain("SECRET-9");
  });

  it("size cap: a declared oversize body is refused before it is read", async () => {
    const calls: Call[] = [];
    const req = new Request(URL_, {
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

  it("size cap: an oversize body (even correctly signed) and an oversize feed are 400", async () => {
    const calls: Call[] = [];
    const h = make({}, calls);
    expect((await h(post(JSON.stringify(good({ pad: "x".repeat(MAX_BODY_BYTES) }))))).status).toBe(
      400,
    );
    const big = "a".repeat(MAX_FEED_BYTES + 1);
    expect((await h(post(good({}, big)))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("400 for non-JSON, wrong purpose, non-object, bad feed type", async () => {
    const calls: Call[] = [];
    const h = make({}, calls);
    for (const body of [
      "not json",
      "null",
      "[]",
      JSON.stringify(good({ purpose: "universe-import" })),
      JSON.stringify(good({ feed: 5 })),
      JSON.stringify(good({ feed: undefined })),
    ]) {
      const r = await h(post(body));
      expect(r.status, body).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("400 when the hash is missing, malformed or does not match the feed", async () => {
    const calls: Call[] = [];
    const h = make({}, calls);
    for (const sha of [undefined, "", "abc", "A".repeat(64), "0".repeat(64), 5]) {
      expect((await h(post(good({ sha })))).status, String(sha)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("400 on an environment mismatch (both directions, and when neither can be derived)", async () => {
    const calls: Call[] = [];
    expect((await make({}, calls)(post(good({ env: "production" })))).status).toBe(400);
    expect((await make({ env: PROD_ENV }, calls)(post(good({ env: "staging" })))).status).toBe(400);
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

  it("maps ingest outcomes: 422 unrecognised_format, 503 unavailable", async () => {
    const mapped = async (e: "unrecognised_format" | "unavailable") => {
      const r = await make({}, [], () => ({ ok: false, error: e }))(post());
      return [r.status, await r.json()];
    };
    expect(await mapped("unrecognised_format")).toEqual([422, { error: "unrecognised_format" }]);
    expect(await mapped("unavailable")).toEqual([503, { error: "unavailable" }]);
  });

  it("never echoes a secret, the feed or the request body in any response", async () => {
    const feed = feedOf(1, " MARKER-TITLE");
    const responses = [
      await make()(post(good({}, feed))),
      await make()(post(good({}, feed), {})),
      await make({ env: { ...STAGING_ENV, WORKER_HMAC_SECRET: undefined } })(post()),
      await make()(post(good({ env: "production" }, feed))),
      await make({}, [], () => ({ ok: false, error: "unrecognised_format" }))(post(good({}, feed))),
    ];
    for (const r of responses) {
      const t = await r.text();
      expect(t).not.toContain(SECRET);
      expect(t).not.toContain("MARKER-TITLE");
      expect(t).not.toContain("ZZAA");
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
    expect(isPublicPath("/api/internal/sentinel-ingest")).toBe(true);
    expect(isPublicPath("/api/internal/sentinel-ingest/x")).toBe(false);
    expect(isPublicPath("/api/internal/sentinel-ingestx")).toBe(false);
  });
});

describe("the real route against a local database", () => {
  let db: Client;
  beforeEach(async () => {
    mem.seen.clear();
    db = await freshDb("main");
    mem.db = db;
    vi.useFakeTimers({ toFake: ["Date"], now: NOW_MS });
    vi.stubEnv("WORKER_HMAC_SECRET", SECRET);
    vi.stubEnv("TEST_IDENTITY_SECRET", "1".repeat(64));
    vi.stubEnv("BACKUP_PUBLIC_KEY", "");
  });

  it("a signed request stores and assesses the items; the same body replayed is refused; a re-signed repeat changes nothing", async () => {
    const feed = feedOf(3);
    const raw = JSON.stringify(good({}, feed));
    const nonce = "f".repeat(32);
    const mk = () =>
      new Request(URL_, {
        method: "POST",
        body: raw,
        headers: sign(SECRET, raw, NOW, nonce) as Record<string, string>,
      });
    const r = await route.POST(mk());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ new: 3, assessed: 3, carried: 0 });
    const count = async (t: string) =>
      Number((await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
    expect(await count("announcement")).toBe(3);
    expect(await count("item_assessment")).toBe(3);
    expect((await route.POST(mk())).status).toBe(401); // replay
    const r2 = await route.POST(post(raw)); // fresh nonce, same body
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ new: 0, assessed: 0, carried: 0 });
    expect(await count("announcement")).toBe(3);
    expect(await count("sentinel_ingest")).toBe(1);
  });

  it("a body that is not a feed is 422 and writes nothing", async () => {
    const feed = "<html>not a feed</html>";
    const r = await route.POST(post(good({}, feed)));
    expect(r.status).toBe(422);
    expect(Number((await db.execute("SELECT COUNT(*) AS n FROM announcement")).rows[0].n)).toBe(0);
  });

  it("fails closed with no secret configured", async () => {
    vi.stubEnv("WORKER_HMAC_SECRET", "");
    expect((await route.POST(post())).status).toBe(503);
  });

  it("honours sentinel_max_items_per_run from the configuration", async () => {
    await db.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, reason, changed_at) VALUES ('sentinel_max_items_per_run','global','3','test',?)",
      args: [new Date(NOW_MS).toISOString()],
    });
    const feed = feedOf(5);
    const r = await route.POST(post(good({}, feed)));
    expect(await r.json()).toEqual({ new: 5, assessed: 3, carried: 2 });
  });
});

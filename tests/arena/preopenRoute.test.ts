// @vitest-environment node
// M5 T8: the signed route api/internal/preopen (SEC-017 c2, D-067 pattern). It refuses unsigned,
// stale, replayed, tampered, mis-bound and oversize requests with fixed words; a correct call runs
// the re-check (here: the data-only market is skipped, a full market is checked once); a failing
// re-check answers 503 so the Worker retries at 09:58. Synthetic data, no network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import { MAX_BODY_BYTES, type MachineDeps } from "@/lib/alerts/machine";
import { createPreopenHandler } from "@/lib/arena/preopenRoute";
import type { NonceStore } from "@/lib/security/replay";
import { isPublicPath } from "@/lib/http/gate";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const mem = vi.hoisted(() => ({ seen: new Set<string>(), main: null as unknown }));
vi.mock("@/lib/security/replay", () => ({
  TursoNonceStore: class {
    async claim(n: string) {
      if (mem.seen.has(n)) return false;
      mem.seen.add(n);
      return true;
    }
  },
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main }));

import * as route from "@/app/api/internal/preopen/route";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

const SECRET = "7".repeat(64);
const NOW_MS = Date.UTC(2026, 9, 18, 23, 54, 0); // Mon 2026-10-19 09:54 AEDT
const NOW = NOW_MS / 1000;
const TODAY = "2026-10-19";
const ENV = { WORKER_HMAC_SECRET: SECRET, PRAXIS_ENV: "staging" } as Record<
  string,
  string | undefined
>;
const URL_PRE = "https://praxis-host.vercel.app/api/internal/preopen";

let main: Client;
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
const deps = (over: Partial<MachineDeps> = {}): MachineDeps => ({
  env: ENV,
  store: memStore(),
  nowSec: () => NOW,
  today: () => TODAY,
  ctx: () => ({ db: main, env: ENV }),
  ...over,
});
let n = 0;
const nonce = () => (++n).toString(16).padStart(32, "0");
const body = (over: Record<string, unknown> = {}) => ({
  purpose: "preopen",
  env: "staging",
  d: TODAY,
  attempt: 1,
  ...over,
});
const post = (b: string | object, headers?: Record<string, string>, nc = nonce()) => {
  const raw = typeof b === "string" ? b : JSON.stringify(b);
  return new Request(URL_PRE, {
    method: "POST",
    body: raw,
    headers: headers ?? (sign(SECRET, raw, NOW, nc) as Record<string, string>),
  });
};

beforeEach(async () => {
  main = await freshDb("main");
  mem.main = main;
  mem.seen.clear();
});

describe("POST /api/internal/preopen: signed-route refusal", () => {
  it("200 when signed; the data-only market is skipped and nothing is written", async () => {
    const r = await createPreopenHandler(deps())(post(body()));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ status: "skipped", reason: "data_only_guard" });
    expect((await main.execute("SELECT 1 FROM preopen_run")).rows).toHaveLength(0);
  });

  it("a full trading-day market is checked once; the retry call is a no-op", async () => {
    await main.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    const h = createPreopenHandler(deps());
    expect(await (await h(post(body()))).json()).toEqual({
      status: "ok",
      attempt: 1,
      checked: 0,
      cancelled: 0,
    });
    expect(await (await h(post(body({ attempt: 2 })))).json()).toMatchObject({
      status: "already_done",
    });
    expect((await main.execute("SELECT status FROM preopen_run")).rows).toHaveLength(1);
  });

  it("401 generic body: wrong secret, no headers, stale, future, tampered body, replay", async () => {
    const h = createPreopenHandler(deps());
    const raw = JSON.stringify(body());
    const wrong = sign("8".repeat(64), raw, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, raw, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const future = sign(SECRET, raw, NOW + 301, "d".repeat(32)) as Record<string, string>;
    const okHeaders = sign(SECRET, raw, NOW, "e".repeat(32)) as Record<string, string>;
    const once = "c".repeat(32);
    expect((await h(post(raw, undefined, once))).status).toBe(200);
    const tampered = JSON.stringify(body({ attempt: 2 }));
    for (const req of [
      post(raw, wrong),
      post(raw, {}),
      post(raw, stale),
      post(raw, future),
      post(tampered, okHeaders),
      post(raw, undefined, once), // replay
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("503 when WORKER_HMAC_SECRET is missing or malformed; nothing runs", async () => {
    for (const secret of [undefined, "", "zz", "A".repeat(64)]) {
      const ctx = vi.fn();
      const r = await createPreopenHandler(
        deps({ env: { ...ENV, WORKER_HMAC_SECRET: secret }, ctx: ctx as never }),
      )(post(body()));
      expect(r.status).toBe(503);
      expect(ctx).not.toHaveBeenCalled();
    }
  });

  it("400: another purpose, environment, date, attempt, oversize, not an object", async () => {
    const h = createPreopenHandler(deps());
    for (const b of [
      body({ purpose: "alert-flush" }),
      body({ env: "production" }),
      body({ d: "2026-10-18" }),
      body({ d: 5 }),
      body({ attempt: 3 }),
      body({ attempt: "1" }),
      body({ pad: "x".repeat(MAX_BODY_BYTES) }),
      "[]",
      "not json",
    ]) {
      const r = await h(post(b));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request" });
    }
  });

  it("503 without leaking when the replay store or the database fails (fail closed)", async () => {
    const store = { claim: () => Promise.reject(new Error("db host secret")) };
    const r = await createPreopenHandler(deps({ store }))(post(body()));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("secret");
    const boom = deps({
      ctx: () => {
        throw new Error("SECRET-9");
      },
    });
    const r2 = await createPreopenHandler(boom)(post(body()));
    expect(r2.status).toBe(503);
    expect(await r2.text()).not.toContain("SECRET-9");
  });

  it("the real route exports POST only, answers 401 unsigned, and is a public machine path", async () => {
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([
      "POST",
    ]);
    vi.stubEnv("WORKER_HMAC_SECRET", SECRET);
    const r = await route.POST(new Request(URL_PRE, { method: "POST", body: "{}" }));
    expect(r.status).toBe(401);
    expect(isPublicPath("/api/internal/preopen")).toBe(true);
  });
});

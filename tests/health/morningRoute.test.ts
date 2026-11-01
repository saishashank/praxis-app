// @vitest-environment node
// POST /api/internal/morning (M5 T13): signed Worker route (SEC-017 c2, D-067 pattern). Refuses
// unsigned, stale, replayed, tampered, mis-bound and oversize requests; a good call runs the
// reminder and the brief once. Mock provider; synthetic data.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import type { MachineDeps } from "@/lib/alerts/machine";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { createMorningHandler } from "@/lib/health/morningRoute";
import { isPublicPath } from "@/lib/http/gate";
import type { NonceStore } from "@/lib/security/replay";
import { KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

vi.mock("@/lib/security/replay", () => ({
  TursoNonceStore: class {
    async claim() {
      return true;
    }
  },
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => null, authDb: () => null }));

import * as morningRoute from "@/app/api/internal/morning/route";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

const SECRET = "7".repeat(64);
const NOW_MS = Date.UTC(2026, 9, 18, 21, 0, 0); // Mon 2026-10-19 08:00 AEDT
const NOW = NOW_MS / 1000;
const TODAY = "2026-10-19";
const URL_M = "https://praxis-host.vercel.app/api/internal/morning";
const ENV = {
  WORKER_HMAC_SECRET: SECRET,
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: KEY,
  PRAXIS_ENV: "staging",
} as Record<string, string | undefined>;

let db: Client;
let mock: MockProvider;
let n = 0;
const nonce = () => (++n).toString(16).padStart(32, "0");
const memStore = (): NonceStore => {
  const seen = new Set<string>();
  return { claim: async (x) => !seen.has(x) && !!seen.add(x) };
};
const deps = (over: Partial<MachineDeps> = {}): MachineDeps => ({
  env: ENV,
  store: memStore(),
  nowSec: () => NOW,
  today: () => TODAY,
  ctx: () => ({ db, env: ENV, provider: mock, sleep: async () => {} }),
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  purpose: "morning",
  env: "staging",
  d: TODAY,
  ...over,
});
const post = (b: string | object, headers?: Record<string, string>, nc = nonce()) => {
  const raw = typeof b === "string" ? b : JSON.stringify(b);
  return new Request(URL_M, {
    method: "POST",
    body: raw,
    headers: headers ?? (sign(SECRET, raw, NOW, nc) as Record<string, string>),
  });
};

beforeEach(async () => {
  db = await freshDb("main");
  mock = createMockProvider();
  await db.execute({
    sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', '\"full\"', 'x')",
    args: [],
  });
});

describe("POST /api/internal/morning", () => {
  it("200 with both results when signed; an amber item gives one reminder, a repeat gives none", async () => {
    await db.execute({
      sql: "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES ('d_turso_main_tokens', '2026-10-31', 'x', 1)",
      args: [],
    });
    const h = createMorningHandler(deps());
    const r = await h(post(body()));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ reminder: "sent", brief: "skipped", reminder_items: 1 });
    expect(mock.outbox).toHaveLength(1);
    const r2 = await h(post(body()));
    expect(await r2.json()).toMatchObject({ reminder: "duplicate" });
    expect(mock.outbox).toHaveLength(1);
  });

  it("503 while a reminder send is pending, so the Worker retries (V1-S8, D-691)", async () => {
    await db.execute({
      sql: "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES ('d_turso_main_tokens', '2026-10-31', 'x', 1)",
      args: [],
    });
    mock.script = [
      { outcome: "retryable", httpStatus: 503 },
      { outcome: "retryable", httpStatus: 503 },
    ];
    const h = createMorningHandler(deps());
    const r = await h(post(body()));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: "send_pending" });
    // A retry inside the 60 s gap answers "duplicate" from sendEmail but the row is still claimed.
    const r2 = await h(post(body()));
    expect(r2.status).toBe(503);
    expect(mock.outbox).toHaveLength(0);
  });

  it("all green: 200, no email", async () => {
    const r = await createMorningHandler(deps())(post(body()));
    expect(await r.json()).toEqual({ reminder: "none", brief: "skipped", reminder_items: 0 });
    expect(mock.outbox).toHaveLength(0);
  });

  it("401 generic body: wrong secret, no headers, stale, tampered body, replay", async () => {
    const h = createMorningHandler(deps());
    const raw = JSON.stringify(body());
    const wrong = sign("8".repeat(64), raw, NOW, "a".repeat(32)) as Record<string, string>;
    const stale = sign(SECRET, raw, NOW - 301, "b".repeat(32)) as Record<string, string>;
    const ok = sign(SECRET, raw, NOW, "e".repeat(32)) as Record<string, string>;
    const once = "c".repeat(32);
    expect((await h(post(raw, undefined, once))).status).toBe(200);
    for (const req of [
      post(raw, wrong),
      post(raw, {}),
      post(raw, stale),
      post(JSON.stringify(body({ d: "2026-10-20" })), ok),
      post(raw, undefined, once),
    ]) {
      const r = await h(req);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized" });
    }
    expect(mock.outbox).toHaveLength(0);
  });

  it("503 without a valid secret; 400 for another purpose, environment or date", async () => {
    const bad = deps({ env: { ...ENV, WORKER_HMAC_SECRET: "zz" } });
    expect((await createMorningHandler(bad)(post(body()))).status).toBe(503);
    const h = createMorningHandler(deps());
    for (const b of [
      body({ purpose: "alert-flush" }),
      body({ env: "production" }),
      body({ d: "2026-10-18" }),
    ]) {
      expect((await h(post(b))).status).toBe(400);
    }
  });

  it("503 without leaking when the run fails", async () => {
    const boom = deps({
      ctx: () => {
        throw new Error("SECRET-9");
      },
    });
    const r = await createMorningHandler(boom)(post(body()));
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("SECRET-9");
  });

  it("the real route exports POST only, answers 401 unsigned, and is a public machine path", async () => {
    const verbs = Object.keys(morningRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k));
    expect(verbs).toEqual(["POST"]);
    vi.stubEnv("WORKER_HMAC_SECRET", SECRET);
    const r = await morningRoute.POST(new Request(URL_M, { method: "POST", body: "{}" }));
    expect(r.status).toBe(401);
    expect(isPublicPath("/api/internal/morning")).toBe(true);
  });
});

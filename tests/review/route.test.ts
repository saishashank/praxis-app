// @vitest-environment node
// M5 T10 signed route api/internal/evening-review (SEC-017 c2, D-029, D-106): the Worker slot and the
// YAML watchdog call it with their own secrets. Unsigned, stale, replayed, tampered, mis-bound, wrong
// date, oversize and misconfigured requests are refused with a fixed word; a signed call runs the
// send loop and answers with the state; calling twice (Worker then watchdog) is one email.
// Mock e-mail provider only; synthetic data.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
// @ts-expect-error plain .mjs watchdog script without types
import { callRoute } from "../../scripts/watchdog/run.mjs";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { isPublicPath } from "@/lib/http/gate";
import {
  createEveningReviewHandler,
  MAX_BODY_BYTES,
  type ReviewRouteDeps,
} from "@/lib/review/routeHandler";
import type { NonceStore } from "@/lib/security/replay";
import { cleanupTempDbs } from "../db/helpers";
import { APP, D, mainWorld, tradingDay } from "./helpers";

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

import * as route from "@/app/api/internal/evening-review/route";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

const WORKER = "7".repeat(64);
const ACTIONS = "9".repeat(64);
const NOW_MS = Date.UTC(2026, 9, 19, 9, 0, 0); // Mon 20:00 AEDT
const NOW = NOW_MS / 1000;
const URL_ER = "https://praxis-host.vercel.app/api/internal/evening-review";
const ENV = {
  WORKER_HMAC_SECRET: WORKER,
  ACTIONS_HMAC_SECRET: ACTIONS,
  TEST_IDENTITY_SECRET: "1".repeat(64), // makes the app environment "staging"
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "staging",
} as Record<string, string | undefined>;

let main: Client;
let mock: MockProvider;

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
const deps = (over: Partial<ReviewRouteDeps> = {}): ReviewRouteDeps => ({
  env: ENV,
  store: memStore(),
  nowSec: () => NOW,
  db: () => main,
  provider: mock,
  sleep: async () => {},
  ...over,
});
let n = 0;
const nonce = () => (++n).toString(16).padStart(32, "0");
const workerBody = (over: Record<string, unknown> = {}) => ({
  purpose: "evening-review",
  env: "staging",
  d: D,
  slot: "evening-review",
  ...over,
});
const actionsBody = (over: Record<string, unknown> = {}) => ({
  purpose: "evening-review",
  date: D,
  source: "watchdog",
  slot: "2040",
  ...over,
});
const post = (
  body: string | object,
  secret = WORKER,
  headers?: Record<string, string>,
  nc = nonce(),
  ts = NOW,
) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(URL_ER, {
    method: "POST",
    body: raw,
    headers: headers ?? (sign(secret, raw, ts, nc) as Record<string, string>),
  });
};
const setMode = (mode: string) =>
  main.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(mode)],
  });

beforeEach(async () => {
  main = await mainWorld();
  mem.main = main;
  mem.seen.clear();
  mock = createMockProvider();
  await tradingDay(main);
  await setMode("full");
});

describe("verification (fail closed, fixed words)", () => {
  it("is a public machine route", () => {
    expect(isPublicPath("/api/internal/evening-review")).toBe(true);
  });

  it("refuses an unsigned request", async () => {
    const res = await createEveningReviewHandler(deps())(
      new Request(URL_ER, { method: "POST", body: JSON.stringify(workerBody()) }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses a stale timestamp, a wrong secret and a tampered body", async () => {
    const h = createEveningReviewHandler(deps());
    expect((await h(post(workerBody(), WORKER, undefined, nonce(), NOW - 301))).status).toBe(401);
    expect((await h(post(workerBody(), "5".repeat(64)))).status).toBe(401);
    const raw = JSON.stringify(workerBody());
    const headers = sign(WORKER, raw, NOW, nonce()) as Record<string, string>;
    const tampered = raw.replace(D, "2026-10-18");
    expect((await h(post(tampered, WORKER, headers))).status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses a replayed nonce", async () => {
    const h = createEveningReviewHandler(deps());
    const nc = nonce();
    expect((await h(post(workerBody(), WORKER, undefined, nc))).status).toBe(200);
    expect((await h(post(workerBody(), WORKER, undefined, nc))).status).toBe(401);
  });

  it("is unavailable when neither secret is configured, or the replay store fails", async () => {
    const none = { ...ENV, WORKER_HMAC_SECRET: undefined, ACTIONS_HMAC_SECRET: "short" };
    expect((await createEveningReviewHandler(deps({ env: none }))(post(workerBody()))).status).toBe(
      503,
    );
    const store: NonceStore = {
      claim: async () => {
        throw new Error("down");
      },
    };
    expect((await createEveningReviewHandler(deps({ store }))(post(workerBody()))).status).toBe(
      503,
    );
  });

  it("refuses a wrong purpose, environment, date, slot or shape (400)", async () => {
    const h = createEveningReviewHandler(deps());
    const bad = [
      workerBody({ purpose: "alert-flush" }),
      workerBody({ env: "production" }),
      workerBody({ d: "2026-10-17" }), // neither today nor yesterday
      workerBody({ d: "2026-10-20" }), // tomorrow
      workerBody({ d: "19/10/2026" }),
      workerBody({ slot: "x".repeat(40) }),
      actionsBody({ date: "nope" }),
      [1, 2, 3],
    ];
    for (const b of bad) {
      const secret = "source" in (b as object) ? ACTIONS : WORKER;
      const res = await h(post(b as object, secret));
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect((await h(post("{not json"))).status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });

  it("refuses an oversize body before parsing it", async () => {
    const big = JSON.stringify(workerBody({ pad: "x".repeat(MAX_BODY_BYTES) }));
    expect((await createEveningReviewHandler(deps())(post(big))).status).toBe(400);
  });

  it("the Worker secret is not accepted for a body that names another environment's caller", async () => {
    // a watchdog-style body (no env) signed with the Worker secret fails the environment check
    const res = await createEveningReviewHandler(deps())(post(actionsBody(), WORKER));
    expect(res.status).toBe(400);
  });
});

describe("the states, over HTTP", () => {
  it("the Worker slot sends the review and answers sent", async () => {
    const res = await createEveningReviewHandler(deps())(post(workerBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      status: "sent",
      d: D,
      kind: "full",
      partial: false,
      late: false,
      unread_incident: "none",
    });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.subject.startsWith("[STAGING] ")).toBe(true);
  });

  it("the watchdog's signed call after the Worker is one email (already_sent)", async () => {
    const h = createEveningReviewHandler(deps());
    expect((await h(post(workerBody()))).status).toBe(200);
    const res = await h(post(actionsBody(), ACTIONS));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "already_sent" });
    expect(mock.outbox).toHaveLength(1);
  });

  it("the watchdog first (20:40, date field) sends once; the Worker slot after is a no-op", async () => {
    const h = createEveningReviewHandler(deps({ nowSec: () => NOW + 40 * 60 }));
    const first = await h(post(actionsBody(), ACTIONS, undefined, nonce(), NOW + 40 * 60));
    expect(await first.json()).toMatchObject({ ok: true, status: "sent" });
    const second = await h(post(workerBody(), WORKER, undefined, nonce(), NOW + 40 * 60));
    expect(await second.json()).toMatchObject({ status: "already_sent" });
    expect(mock.outbox).toHaveLength(1);
  });

  it("yesterday's date is accepted after midnight", async () => {
    const later = NOW + 3 * 3600 + 10 * 60; // 23:10... next local day 00:10
    const h = createEveningReviewHandler(deps({ nowSec: () => later }));
    const res = await h(post(workerBody({ d: D }), WORKER, undefined, nonce(), later));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "sent", d: D, late: true });
  });

  it("a provider failure answers 200 with ok false so the watchdog falls back", async () => {
    mock.script = [{ outcome: "rejected", httpStatus: 422 }];
    const res = await createEveningReviewHandler(deps())(post(workerBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: "failed" });
  });

  it("waiting, paused, no recipient and off keep ok true", async () => {
    const before = NOW - 3600; // 19:00 local: too early
    const early = await createEveningReviewHandler(deps({ nowSec: () => before }))(
      post(workerBody(), WORKER, undefined, nonce(), before),
    );
    expect(await early.json()).toMatchObject({ ok: true, status: "waiting", reason: "early" });
    const noOwner = { ...ENV, OWNER_EMAIL: undefined };
    const res = await createEveningReviewHandler(deps({ env: noOwner }))(post(workerBody()));
    expect(await res.json()).toMatchObject({ ok: true, status: "no_recipient" });
    await main.execute("DELETE FROM worker_state");
    const off = await createEveningReviewHandler(deps())(post(workerBody()));
    expect(await off.json()).toMatchObject({ ok: true, status: "suppressed_off" });
  });

  it("the watchdog script's callRoute is happy with it (ok: true over a real handler)", async () => {
    const h = createEveningReviewHandler(deps());
    const fetchImpl = async (_url: string, init: RequestInit) =>
      h(
        new Request(URL_ER, {
          method: "POST",
          body: init.body as string,
          headers: init.headers as HeadersInit,
        }),
      );
    const r = await callRoute(
      { APP_BASE_URL: "https://praxis-host.vercel.app", ACTIONS_HMAC_SECRET: ACTIONS },
      fetchImpl,
      D,
      "2040",
      NOW_MS,
    );
    expect(r).toBe("ok");
    expect(mock.outbox).toHaveLength(1);
  });
});

describe("the route module", () => {
  it("POST uses the process environment and the main database; a bad call is refused", async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v ?? "");
    vi.stubEnv("OWNER_EMAIL", "owner@example.test");
    vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
    try {
      const res = await route.POST(post(workerBody()));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; ok: boolean };
      expect(body.ok).toBe(true);
      expect(body.status).toBe("sent");
      const row = await main.execute(
        "SELECT status FROM email_message WHERE email_key = 'review:2026-10-19'",
      );
      expect(row.rows[0]!.status).toBe("sent");
      const bad = await route.POST(
        new Request(URL_ER, { method: "POST", body: JSON.stringify(workerBody()) }),
      );
      expect(bad.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers non-POST methods with 405 (no handler export)", () => {
    expect((route as Record<string, unknown>).GET).toBeUndefined();
  });
});

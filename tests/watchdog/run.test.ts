// @vitest-environment node
// M5 T12: scripts/watchdog/run.mjs paths with the mock provider and a temp database (docs/M5_design.md
// 4.8; D-096 decisions 11, 12, 42; AT-20 fallback; NFR-006). Route ok, route down -> direct minimal
// review, one email per review date across both paths, database down -> plain incident email,
// deliberate failure, check problems -> incident email. No network: the route is a stub fetch and
// the provider is the mock; the real Resend API is never called.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { createMockProvider } from "@/lib/email/mock";
import * as lib from "@/lib/watchdog/script";
// @ts-expect-error plain .mjs without types
import { run } from "../../scripts/watchdog/run.mjs";
// @ts-expect-error plain .mjs without types
import { loadWatchdogLib } from "../../scripts/watchdog/lib.mjs";

afterEach(cleanupTempDbs);

const D = "2026-10-19";
const T_2040 = new Date("2026-10-19T09:40:30.000Z"); // 20:40 AEDT
const SECRET = "ab".repeat(32);
const OWNER = "owner@example.test";
const ENV: Record<string, string> = {
  WATCHDOG_SLOT: "2040",
  APP_BASE_URL: "https://praxis.example.test",
  ACTIONS_HMAC_SECRET: SECRET,
  OWNER_EMAIL: OWNER,
  PII_HASH_KEY: "k".repeat(64),
  EMAIL_PROVIDER: "mock",
  PRAXIS_ENV: "production",
};

let db: Client;
let mock: ReturnType<typeof createMockProvider>;
let lines: string[];
const out = (s: string) => lines.push(s);

beforeEach(async () => {
  db = await freshDb("main");
  mock = createMockProvider();
  lines = [];
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
          VALUES ('worker-clock', 'AU', ?, ?, 'success')`,
    args: [`worker-clock:AU:${D}`, T_2040.toISOString()],
  });
});

async function setMode(mode: "off" | "incidents" | "full") {
  await db.execute({
    sql: "INSERT OR REPLACE INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, ?)",
    args: [JSON.stringify(mode), T_2040.toISOString()],
  });
}

type Route = "ok" | "down" | "503" | "notok";
function routeFetch(kind: Route) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (kind === "down") throw Object.assign(new Error("connect"), { name: "TypeError" });
    if (kind === "503") return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ ok: kind === "ok", status: "sent" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const go = (env: Record<string, string>, route: Route, over: Record<string, unknown> = {}) => {
  const r = routeFetch(route);
  return run(env, {
    fetchImpl: r.f,
    out,
    now: () => T_2040,
    lib,
    db,
    provider: mock,
    ...over,
  }).then((code: number) => ({ code, route: r }));
};

const rows = async (key: string) =>
  (await db.execute({ sql: "SELECT status FROM email_message WHERE email_key = ?", args: [key] }))
    .rows;

describe("watchdog run.mjs", () => {
  it("route ok: signed call to the evening-review route, no direct email, exit 0", async () => {
    await setMode("incidents");
    const { code, route } = await go(ENV, "ok");
    expect(code).toBe(0);
    expect(route.calls).toHaveLength(1);
    expect(route.calls[0]!.url).toBe("https://praxis.example.test/api/internal/evening-review");
    const h = route.calls[0]!.init.headers as Record<string, string>;
    expect(h["X-Praxis-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["X-Praxis-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(String(route.calls[0]!.init.body))).toMatchObject({
      purpose: "evening-review",
      date: D,
      slot: "2040",
    });
    expect(mock.calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("checks ok");
  });

  it.each<Route>(["down", "503", "notok"])(
    "route %s: the minimal review is sent directly with the review key, then the run fails",
    async (kind) => {
      await setMode("incidents");
      const { code } = await go(ENV, kind);
      expect(code).toBe(1);
      expect(mock.outbox).toHaveLength(1);
      const m = mock.outbox[0]!;
      expect(m.subject).toContain("(minimal)");
      expect(m.to).toBe(OWNER);
      expect(m.idempotencyKey).toBe(`production:review:${D}`);
      expect((await rows(`review:${D}`))[0]!.status).toBe("sent");
      expect(lines.join("\n")).toContain("minimal review sent");
      expect(lines.join("\n")).toContain("failing the run on purpose");
    },
  );

  it("one email per review date: a second watchdog run, or a review the app already sent, adds none", async () => {
    await setMode("incidents");
    await go(ENV, "down");
    await go({ ...ENV, WATCHDOG_SLOT: "2150" }, "down");
    expect(mock.outbox).toHaveLength(1);
    expect(lines.join("\n")).toContain("review already sent");
    // A claim by any path (the app's route uses the same key) makes the direct send a duplicate.
    const again = await lib.sendFallbackReview(
      { db, env: ENV, now: () => T_2040, provider: mock },
      D,
      "x",
    );
    expect(again.status).toBe("duplicate");
    expect(mock.outbox).toHaveLength(1);
  });

  it("email_mode off: nothing is sent, the failed route still fails the run", async () => {
    await setMode("off");
    const { code } = await go(ENV, "down");
    expect(code).toBe(1);
    expect(mock.calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("minimal review suppressed_off");
  });

  it("database down: one plain database-down incident email, run fails", async () => {
    const dead = {
      execute: async () => {
        throw new Error("unreachable");
      },
      close: () => undefined,
    };
    const { code } = await go(ENV, "ok", { db: dead });
    expect(code).toBe(1);
    expect(mock.outbox).toHaveLength(1);
    const m = mock.outbox[0]!;
    expect(m.subject).toContain("Database unreachable");
    expect(m.idempotencyKey).toBe(`production:dbdown:${D}:2040`);
    expect(lines.join("\n")).toContain("DATABASE UNREACHABLE; database-down email sent");
    // Same slot again: the provider's idempotency key makes it the same message.
    await go(ENV, "ok", { db: dead });
    expect(mock.outbox).toHaveLength(1);
  });

  it("database down with no recipient: skipped, still exit 1, never a crash", async () => {
    const dead = {
      execute: async () => {
        throw new Error("unreachable");
      },
    };
    const { OWNER_EMAIL: _o, ...noOwner } = ENV;
    void _o;
    const { code } = await go(noOwner, "ok", { db: dead });
    expect(code).toBe(1);
    expect(mock.calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("database-down email skipped");
  });

  it("deliberate failure mode: exits 1 at once, calls nothing", async () => {
    const { code, route } = await go({ ...ENV, WATCHDOG_DELIBERATE_FAILURE: "1" }, "ok");
    expect(code).toBe(1);
    expect(route.calls).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("DELIBERATE FAILURE");
  });

  it("a missing Worker clock is a problem: one incident email, run fails", async () => {
    await setMode("incidents");
    await db.execute("DELETE FROM run_record");
    const { code } = await go(ENV, "ok");
    expect(code).toBe(1);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.subject).toContain("The Worker has not run today");
    // V1-I2 (D-772): through notifyIncident: the key is the incident id
    expect(mock.outbox[0]!.idempotencyKey).toMatch(/^production:inc:[0-9]+:open$/);
    expect((await db.execute("SELECT kind FROM incident")).rows.map((r) => r.kind)).toEqual([
      "worker_blind",
    ]);
    // Running again does not send a second email for the same problem and slot.
    await go(ENV, "ok");
    expect(mock.outbox).toHaveLength(1);
  });

  it("full mode with the route ok but no review sent is reported missing", async () => {
    await setMode("full");
    const { code } = await go(ENV, "ok");
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("PROBLEM review_missing");
  });

  it("21:50 fails while an incident opened today is still open", async () => {
    await setMode("incidents");
    await db.execute({
      sql: "INSERT INTO incident (at, severity, kind) VALUES (?, 'S2', 'worker_blind')",
      args: [T_2040.toISOString()],
    });
    const env = { ...ENV, WATCHDOG_SLOT: "2150" };
    expect((await go(env, "ok")).code).toBe(1);
    expect(lines.join("\n")).toContain("PROBLEM incident_open");
    lines = [];
    expect((await go(ENV, "ok")).code).toBe(0); // 20:40 does not judge open incidents
  });

  it("output carries statuses only: no address, secret or app URL", async () => {
    await setMode("incidents");
    await go(ENV, "down");
    const text = lines.join("\n");
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("praxis.example.test");
  });

  it("the TypeScript engine bundles for plain Node like the arena CLIs", async () => {
    const built = await loadWatchdogLib();
    for (const name of [
      "sendFallbackReview",
      "sendDbDown",
      "runChecks",
      "openDb",
      "melbourneDate",
    ]) {
      expect(typeof built[name]).toBe("function");
    }
    expect(built.melbourneDate(T_2040)).toBe(D);
  }, 120_000);
});

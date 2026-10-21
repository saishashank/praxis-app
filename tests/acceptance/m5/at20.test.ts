// @vitest-environment node
// AT-20 Evening Review (M5 T15; EML-010...015, EML-035/036, DAT-022, ROL-105, NFR-006). Verbatim:
// "On a trading day and on a non-trading day, exactly one review is sent 20:00-20:45 to the Owner only
// (trading day: all 10 sections), <= 90 KB, arrives in the Gmail inbox (not spam), stored in-app and in
// KB; a late pipeline yields a 'partial' review; with the email route disabled the 20:40 watchdog sends
// a minimal review directly via Resend (production, one forced run in M5, TST-115); staging emails carry
// '[STAGING]'". Real code, mock provider, synthetic data. Heavier cover: tests/review/{send,assemble,
// sections,route}.test.ts, tests/email/templates.test.ts, tests/watchdog/run.test.ts.
// PENDING (Owner / production, not evidenced here): inbox-not-spam check, KB archive (M6, AT-24), the
// forced production watchdog run, the deliberate-failure email test.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { REVIEW_MAX_BYTES } from "@/lib/email/templates";
import * as watchdog from "@/lib/watchdog/script";
import { markRead, readState } from "@/lib/review/assemble";
import { REVIEW_SECTION_NAMES } from "@/lib/review/facts";
import { runReviewSend, type ReviewSendCtx } from "@/lib/review/send";
// @ts-expect-error plain .mjs without types
import { run as runWatchdog } from "../../../scripts/watchdog/run.mjs";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { APP, D, SAT, addMarker, mainWorld, tradingDay } from "../../review/helpers";

afterEach(cleanupTempDbs);

const OWNER = "owner@example.test";
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: OWNER,
  APP_BASE_URL: APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;

let db: Client;
let mock: MockProvider;
let clock: Date;

/** Melbourne local time (AEDT, UTC+11, in force on all October 2026 dates here) as a UTC instant. */
const at = (hhmm: string, date = D) => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  clock = new Date(Date.UTC(y!, mo! - 1, d!, h! - 11, m!));
};
const ctx = (env = ENV): ReviewSendCtx => ({
  db,
  env,
  now: () => clock,
  provider: mock,
  sleep: async () => {},
});
const send = (date = D, env = ENV) => runReviewSend(ctx(env), date);
const setMode = (mode: string) =>
  db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(mode)],
  });
const count = async (sql: string, args: (string | number)[] = []) =>
  Number((await db.execute({ sql, args })).rows[0]!.n);

beforeEach(async () => {
  db = await mainWorld();
  mock = createMockProvider();
  await setMode("full");
  at("20:00");
});

describe("AT-20 Evening Review", () => {
  it("trading day: exactly one review in the 20:00-20:45 window, to the Owner only, all 10 sections, <= 90 KB HTML, plain text, no remote image or pixel", async () => {
    await tradingDay(db);
    for (const t of ["20:00", "20:05", "20:40"]) {
      at(t);
      await send();
    }
    expect(mock.outbox).toHaveLength(1); // the workflow ran three times for the same date: one email (04 AC)
    const m = mock.outbox[0]!;
    expect(m.to).toBe(OWNER);
    expect(m.subject).toContain("Evening Review");
    REVIEW_SECTION_NAMES.forEach((name, i) => expect(m.text).toContain(`${i + 1}. ${name}`));
    expect(Buffer.byteLength(m.html, "utf8")).toBeLessThanOrEqual(REVIEW_MAX_BYTES); // EML-013: HTML bytes before transfer encoding
    expect(m.text.length).toBeGreaterThan(200);
    expect(m.html).not.toMatch(/<img\b/i);
    expect(m.html).not.toMatch(/src=["']https?:/i);
    expect(m.html).toContain(`${APP}/reviews/${D}`); // link to the authenticated in-app page
    const row = await db.execute({
      sql: "SELECT sent_at FROM email_message WHERE email_key = ?",
      args: [`review:${D}`],
    });
    expect(String(row.rows[0]!.sent_at)).toBe("2026-10-19T09:00:00.000Z"); // 20:00 AEDT: the first tick
    expect(await count("SELECT COUNT(*) AS n FROM evening_review WHERE d = ?", [D])).toBe(1); // stored in-app (KB archive: M6, pending)
  });

  it("non-trading day (Saturday): exactly one review, all 10 headings kept", async () => {
    await addMarker(db, SAT, "non-trading");
    at("20:00", SAT);
    await send(SAT);
    at("20:05", SAT);
    await send(SAT);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.to).toBe(OWNER);
    REVIEW_SECTION_NAMES.forEach((name, i) =>
      expect(mock.outbox[0]!.text).toContain(`${i + 1}. ${name}`),
    );
  });

  it("a late pipeline yields a partial review at 20:30 listing what is missing; the complete version is stored later and not re-sent", async () => {
    for (const t of ["20:00", "20:15", "20:25"]) {
      at(t);
      expect((await send()).status).toBe("waiting");
    }
    expect(mock.outbox).toHaveLength(0);
    at("20:30");
    expect(await send()).toMatchObject({ status: "sent", kind: "partial", partial: true });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.text).toMatch(/Partial review/i);
    await tradingDay(db);
    at("21:00");
    expect(await send()).toMatchObject({ status: "complete_later", kind: "full" });
    expect(mock.outbox).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM evening_review WHERE d = ?", [D])).toBe(2);
  });

  it("all LLM providers unavailable: still sent with template text ('Written without AI today') and the numbers from data", async () => {
    await tradingDay(db); // no llm_call or narrative rows exist
    await send();
    const m = mock.outbox[0]!;
    expect(m.text).toContain("Written without AI today");
    expect(m.text).toContain("E01");
  });

  it("staging emails carry [STAGING]", async () => {
    await tradingDay(db);
    expect((await send(D, { ...ENV, PRAXIS_ENV: "staging" })).status).toBe("sent");
    expect(mock.outbox[0]!.subject.startsWith("[STAGING] ")).toBe(true);
  });

  it("mark-as-read is an explicit POST-style write, recorded once (EML-036)", async () => {
    await tradingDay(db);
    await send();
    expect(await readState(db, D)).toBeNull();
    expect(await markRead(db, D, "page", clock)).toEqual({ firstRead: true });
    expect(await markRead(db, D, "page", clock)).toEqual({ firstRead: false });
    expect(await readState(db, D)).toMatchObject({ via: "page" });
  });

  it("email_mode off (the default) stores the review in-app but sends nothing", async () => {
    await tradingDay(db);
    await setMode("off");
    expect((await send()).ok).toBe(true);
    expect(mock.outbox).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM evening_review WHERE d = ?", [D])).toBe(1);
  });
});

describe("AT-20 watchdog fallback (script path, mock Resend)", () => {
  const SECRET = "ab".repeat(32);
  const WENV: Record<string, string> = {
    WATCHDOG_SLOT: "2040",
    APP_BASE_URL: APP,
    ACTIONS_HMAC_SECRET: SECRET,
    OWNER_EMAIL: OWNER,
    PII_HASH_KEY: "k".repeat(64),
    EMAIL_PROVIDER: "mock",
    PRAXIS_ENV: "production",
  };
  const T_2040 = new Date("2026-10-19T09:40:30.000Z");
  const lines: string[] = [];
  const down = (async () => {
    throw new TypeError("connect");
  }) as unknown as typeof fetch;
  const okRoute = (async () =>
    new Response(JSON.stringify({ ok: true, status: "already_sent" }), {
      status: 200,
    })) as unknown as typeof fetch;

  async function wdb(): Promise<Client> {
    const w = await freshDb("main");
    await w.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
            VALUES ('worker-clock', 'AU', ?, ?, 'success')`,
      args: [`worker-clock:AU:${D}`, T_2040.toISOString()],
    });
    await w.execute({
      sql: "INSERT OR REPLACE INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')",
      args: [JSON.stringify("incidents")],
    });
    return w;
  }
  const go = async (fetchImpl: typeof fetch) =>
    runWatchdog(WENV, {
      fetchImpl,
      out: (s: string) => lines.push(s),
      now: () => T_2040,
      lib: watchdog,
      db: await wdb(),
      provider: mock,
    }) as Promise<number>;

  it("email route disabled at 20:40: the watchdog sends the minimal review directly under the review key, then fails the run on purpose", async () => {
    expect(await go(down)).toBe(1);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.subject).toContain("(minimal)");
    expect(mock.outbox[0]!.to).toBe(OWNER);
    expect(mock.outbox[0]!.idempotencyKey).toBe(`production:review:${D}`);
  });

  it("the route already sent the review: the watchdog sends nothing more", async () => {
    expect(await go(okRoute)).toBe(0);
    expect(mock.outbox).toHaveLength(0);
  });
});

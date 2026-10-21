// @vitest-environment node
// AT-20a Morning Brief and AT-20b Attention reminder (M5 T15; EML-016, EML-023, PLT-061; D-108).
// AT-20a verbatim: "Given the Morning Brief is enabled, at 08:00 Melbourne on a trading day of an active
// market exactly one Morning Brief is sent by 08:45; on a non-trading day none is sent; when disabled
// none is sent". AT-20b verbatim: "With a fixture that makes one component amber, one reminder is sent
// at 08:00 Melbourne (weekend day included) listing the item, days open, deadline and fix link; with all
// green none is sent; snooze suppresses it; a red item cannot be snoozed; never more than one per day".
// Real code, mock provider, synthetic data. Heavier cover: tests/email/{morningBrief,reminder}.test.ts,
// tests/health/{components,morningRoute}.test.ts, worker/test/m5Slots.test.ts (08:00 slot, disabled).
// PENDING (Owner): the staging run with a live "[STAGING]" brief and reminder (decision 3).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { runBrief } from "@/lib/email/brief";
import { createMockProvider } from "@/lib/email/mock";
import { runReminder } from "@/lib/email/reminder";
import { setConfig } from "@/lib/config/store";
import { KEY } from "../../auth/helpers";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { mainWorld } from "../../review/helpers";

afterEach(cleanupTempDbs);

const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: KEY,
  PRAXIS_ENV: "staging",
} as Record<string, string | undefined>;
const MON = "2026-10-19"; // Monday session
const SAT = "2026-10-17";
const SUN = "2026-10-18";
const TURSO = "d_turso_main_tokens";
/** 08:00 Melbourne (AEDT, UTC+11) on a date = 21:00Z the day before. */
const eight = (d: string) => new Date(new Date(`${d}T08:00:00Z`).getTime() - 11 * 3_600_000);

const mode = (db: Client, m: string) =>
  db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(m)],
  });

describe("AT-20a Morning Brief", () => {
  async function world(m: "full" | "data_only" = "full") {
    const db = await mainWorld({ mode: m });
    await mode(db, "full");
    const mock = createMockProvider();
    const brief = (d: string) =>
      runBrief({ db, env: ENV, provider: mock, now: () => eight(d), sleep: async () => {} });
    const enable = () =>
      setConfig(db, {
        key: "morning_brief_enabled",
        value: "on",
        userId: null,
        now: "2026-10-01T00:00:00.000Z",
      });
    return { db, mock, brief, enable };
  }

  it("enabled, trading day, active market: exactly one brief at 08:00, and a repeat adds none", async () => {
    const { mock, brief, enable } = await world();
    await enable();
    expect(await brief(MON)).toEqual({ status: "sent", send: "sent" });
    expect(await brief(MON)).toEqual({ status: "duplicate", send: "duplicate" });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.subject).toContain("Morning Brief");
    expect(mock.outbox[0]!.to).toBe("owner@example.test");
  });

  it("non-trading day: none", async () => {
    const { mock, brief, enable } = await world();
    await enable();
    expect(await brief(SAT)).toEqual({ status: "skipped", reason: "non_trading" });
    expect(mock.outbox).toHaveLength(0);
  });

  it("disabled (the default): none", async () => {
    const { mock, brief } = await world();
    expect(await brief(MON)).toEqual({ status: "skipped", reason: "disabled" });
    expect(mock.outbox).toHaveLength(0);
  });

  it("market not active (data-only): none", async () => {
    const { mock, brief, enable } = await world("data_only");
    await enable();
    expect(await brief(MON)).toEqual({ status: "skipped", reason: "not_active" });
    expect(mock.outbox).toHaveLength(0);
  });
});

describe("AT-20b Attention reminder", () => {
  async function world() {
    const db = await freshDb("main");
    await mode(db, "full");
    const mock = createMockProvider();
    const remind = (d: string) =>
      runReminder({ db, env: ENV, provider: mock, now: () => eight(d), sleep: async () => {} });
    const expiry = (name: string, on: string) =>
      db.execute({
        sql: "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES (?, ?, 'x', 1)",
        args: [name, on],
      });
    const snooze = (key: string, from: string, until: string) =>
      db.execute({
        sql: "INSERT INTO attention_snooze (id, component, item_key, from_d, until_d, created_at, created_by) VALUES (?, 'security', ?, ?, ?, 'x', 1)",
        args: [`sn:${key}:${until}`, key, from, until],
      });
    return { db, mock, remind, expiry, snooze };
  }

  it("one amber component on a Sunday: one reminder listing item, deadline and fix link; a second call the same day adds none", async () => {
    const { mock, remind, expiry } = await world();
    await expiry(TURSO, "2026-10-30");
    expect(await remind(SUN)).toMatchObject({ status: "sent", items: 1 });
    expect(await remind(SUN)).toMatchObject({ status: "duplicate" });
    expect(mock.outbox).toHaveLength(1);
    const m = mock.outbox[0]!;
    expect(m.subject).toContain("1 item needs attention");
    expect(m.text).toContain("Turso");
    expect(m.text).toContain("30"); // deadline
    expect(m.text).toContain("Renew it"); // fix
    expect(m.text).toContain("https://praxis.example.test"); // fix link
    expect(m.text).toMatch(/day/i); // days open
  });

  it("all green: none, and no key consumed", async () => {
    const { db, mock, remind } = await world();
    expect(await remind(SUN)).toEqual({ status: "none" });
    expect(mock.outbox).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM email_message")).rows).toHaveLength(0);
  });

  it("snooze suppresses an amber item on those days, and the reminder returns after", async () => {
    const { mock, remind, expiry, snooze } = await world();
    await expiry(TURSO, "2026-11-12");
    await remind("2026-10-30");
    mock.outbox.length = 0;
    await snooze(`credential.${TURSO}`, "2026-10-30", "2026-11-02");
    expect(await remind("2026-10-31")).toEqual({ status: "none" });
    expect(await remind("2026-11-02")).toEqual({ status: "none" });
    expect(mock.outbox).toHaveLength(0);
    expect(await remind("2026-11-03")).toMatchObject({ status: "sent" });
  });

  it("a red item (expired) cannot be snoozed: the reminder still goes out", async () => {
    const { mock, remind, expiry, snooze } = await world();
    await expiry(TURSO, "2026-11-12");
    await snooze(`credential.${TURSO}`, "2026-11-09", "2026-11-14");
    expect(await remind("2026-11-13")).toMatchObject({ status: "sent" });
    expect(mock.outbox[0]!.text).toContain("expired");
  });
});

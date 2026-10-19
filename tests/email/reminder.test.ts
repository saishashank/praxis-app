// @vitest-environment node
// Attention reminder (M5 T13, EML-023, AT-20b): one amber item (a credential expiring in 12 days)
// gives one reminder on a Sunday; all green gives none; one email per key; a snooze hides only the
// snoozed item and ends when the item turns red or nears its deadline; email_mode off sends nothing
// but the day's snapshot is still stored. Mock provider and synthetic data only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfig } from "@/lib/config/store";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { runReminder } from "@/lib/email/reminder";
import { parseAttentionItems } from "@/lib/health/attention";
import { KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: KEY,
  PRAXIS_ENV: "staging",
} as Record<string, string | undefined>;
const SUN = "2026-10-18"; // Sunday
const at = (d: string) => () => new Date(`${d}T01:00:00Z`); // 12:00 Melbourne on that date
const TURSO = "d_turso_main_tokens";
const AUTH = "e_turso_auth_token";

let db: Client;
let mock: MockProvider;

const run = (d: string) =>
  runReminder({ db, env: ENV, provider: mock, now: at(d), sleep: async () => {} });
const mode = (m: string) =>
  db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(m)],
  });
const expiry = (name: string, on: string) =>
  db.execute({
    sql: "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES (?, ?, 'x', 1)",
    args: [name, on],
  });
const snooze = (name: string, key: string, from: string, until: string) =>
  db.execute({
    sql: "INSERT INTO attention_snooze (id, component, item_key, from_d, until_d, created_at, created_by) VALUES (?, 'security', ?, ?, ?, 'x', 1)",
    args: [`sn:${name}:${until}`, `credential.${name}`, from, until],
  });

beforeEach(async () => {
  db = await freshDb("main");
  mock = createMockProvider();
  await mode("full");
});

describe("AT-20b attention reminder", () => {
  it("all green: no email and no key consumed", async () => {
    expect(await run(SUN)).toEqual({ status: "none" });
    expect(mock.outbox).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM email_message")).rows).toHaveLength(0);
  });

  it("one amber credential on a Sunday: one reminder with item, deadline and fix; second call adds none", async () => {
    await expiry(TURSO, "2026-10-30");
    const r = await run(SUN);
    expect(r).toMatchObject({ status: "sent", items: 1 });
    expect(mock.outbox).toHaveLength(1);
    const m = mock.outbox[0]!;
    expect(m.subject).toContain("1 item needs attention");
    expect(m.text).toContain("Turso");
    expect(m.text).toContain("30");
    expect(m.text).toContain("Renew it");
    const row = await db.execute(
      "SELECT slot, status FROM email_message WHERE email_key = 'reminder:2026-10-18'",
    );
    expect(row.rows[0]).toMatchObject({ slot: "reserved_reminder", status: "sent" });
    expect(await run(SUN)).toMatchObject({ status: "duplicate" });
    expect(mock.outbox).toHaveLength(1);
  });

  it("stores the day's snapshot once, in the shape the snooze reader parses", async () => {
    await expiry(TURSO, "2026-10-30");
    await run(SUN);
    await run(SUN);
    const s = await db.execute(
      "SELECT components_json FROM health_snapshot WHERE purpose = 'reminder'",
    );
    expect(s.rows).toHaveLength(1);
    const items = parseAttentionItems(String(s.rows[0]!.components_json));
    expect(items).toMatchObject([
      {
        component: "security",
        key: `credential.${TURSO}`,
        state: "attention",
        deadlineD: "2026-10-30",
      },
    ]);
    expect(JSON.parse(String(s.rows[0]!.components_json)).components).toHaveLength(9);
  });

  it("email_mode off: nothing sent, key not consumed, snapshot still written", async () => {
    await mode("off");
    await expiry(TURSO, "2026-10-30");
    expect(await run(SUN)).toMatchObject({ status: "suppressed" });
    expect(mock.outbox).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM health_snapshot")).rows).toHaveLength(1);
    expect(
      (await db.execute("SELECT 1 FROM email_message WHERE email_key = 'reminder:2026-10-18'"))
        .rows,
    ).toHaveLength(0);
  });

  it("attention_reminder_enabled off: snapshot only, no email", async () => {
    await setConfig(db, {
      key: "attention_reminder_enabled",
      value: "off",
      userId: null,
      now: "2026-10-01T00:00:00.000Z",
    });
    await expiry(TURSO, "2026-10-30");
    expect(await run(SUN)).toEqual({ status: "disabled" });
    expect(mock.outbox).toHaveLength(0);
    expect((await db.execute("SELECT 1 FROM health_snapshot")).rows).toHaveLength(1);
  });
});

describe("snooze", () => {
  it("hides only the snoozed item; the other still triggers a reminder", async () => {
    await expiry(TURSO, "2026-11-05");
    await expiry(AUTH, "2026-11-06");
    await run("2026-10-25");
    mock.outbox.length = 0;
    await snooze(TURSO, `credential.${TURSO}`, "2026-10-25", "2026-10-28");
    const r = await run("2026-10-26");
    expect(r).toMatchObject({ status: "sent", items: 1 });
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]!.text).toContain("(e)");
    expect(mock.outbox[0]!.text).not.toContain("(d) Turso");
  });

  it("every item snoozed: no email on those days, the reminder returns after the snooze ends", async () => {
    await expiry(TURSO, "2026-11-12");
    await run("2026-10-30");
    mock.outbox.length = 0;
    await snooze(TURSO, `credential.${TURSO}`, "2026-10-30", "2026-11-02");
    expect(await run("2026-10-31")).toEqual({ status: "none" });
    expect(await run("2026-11-02")).toEqual({ status: "none" });
    expect(mock.outbox).toHaveLength(0);
    expect(await run("2026-11-03")).toMatchObject({ status: "sent" });
  });

  it("ends when the item changes: within 2 days of its deadline, or red, the snooze no longer hides it", async () => {
    await expiry(TURSO, "2026-11-12");
    await snooze(TURSO, `credential.${TURSO}`, "2026-11-09", "2026-11-14");
    expect(await run("2026-11-09")).toEqual({ status: "none" }); // 3 days left: still snoozable
    expect(await run("2026-11-10")).toMatchObject({ status: "sent" }); // 2 days left: guard applies
    mock.outbox.length = 0;
    expect(await run("2026-11-13")).toMatchObject({ status: "sent" }); // expired = red
    expect(mock.outbox[0]!.text).toContain("expired");
  });

  it("'Resolved since yesterday' lists an item that is gone", async () => {
    await expiry(TURSO, "2026-11-05");
    await run("2026-10-25");
    await db.execute({
      sql: "UPDATE credential_expiry SET expires_on = ? WHERE name = ?",
      args: ["2027-06-01", TURSO],
    });
    await expiry(AUTH, "2026-11-06");
    await run("2026-10-26");
    expect(mock.outbox[1]!.text).toContain("Resolved since yesterday");
    expect(mock.outbox[1]!.text).toContain("Turso main");
  });
});

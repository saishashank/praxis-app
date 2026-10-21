// @vitest-environment node
// Morning Brief (M5 T13, EML-016, AT-20a, decision 4): default off; sent only when enabled, D is a
// trading day and the market is active (mode full); fixed template, one email per key; email_mode
// off sends nothing. Mock provider and synthetic data only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBrief } from "@/lib/email/brief";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { setConfig } from "@/lib/config/store";
import { KEY } from "../auth/helpers";
import { cleanupTempDbs } from "../db/helpers";
import { mainWorld } from "../review/helpers";

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
let db: Client;
let mock: MockProvider;

const run = (d = MON) =>
  runBrief({
    db,
    env: ENV,
    provider: mock,
    now: () => new Date(`${d}T01:00:00Z`),
    sleep: async () => {},
  });
const enable = () =>
  setConfig(db, {
    key: "morning_brief_enabled",
    value: "on",
    userId: null,
    now: "2026-10-01T00:00:00.000Z",
  });
const mode = (m: string) =>
  db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [JSON.stringify(m)],
  });
const announce = (id: string, code: string, at: string, title: string) =>
  db.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, title, source)
          VALUES ('AU', ?, ?, ?, ?, ?, 'asx_test')`,
    args: [code, id, at, at, title],
  });

async function world(m: "full" | "data_only" = "full") {
  db = await mainWorld({ mode: m });
  mock = createMockProvider();
  await mode("full");
}

beforeEach(() => world());

describe("AT-20a Morning Brief", () => {
  it("default off: nothing sent", async () => {
    expect(await run()).toEqual({ status: "skipped", reason: "disabled" });
    expect(mock.outbox).toHaveLength(0);
  });

  it("enabled + trading day + active market: one brief with overnight items on watched codes only", async () => {
    await enable();
    await db.execute({
      sql: `INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d)
            VALUES ('w1', 'AU', 'ZZA', 1, '2026-10-10T00:00:00Z', '2026-12-01')`,
      args: [],
    });
    await announce("1", "ZZA", "2026-10-18T10:00:00Z", "ZZA trading halt overnight"); // 21:00 AEDT Sunday
    await announce("2", "ZZB", "2026-10-18T10:00:00Z", "ZZB unwatched notice");
    await announce("3", "ZZA", "2026-10-18T05:00:00Z", "ZZA before the window"); // 16:00 AEDT
    expect(await run()).toEqual({ status: "sent", send: "sent" });
    expect(mock.outbox).toHaveLength(1);
    const m = mock.outbox[0]!;
    expect(m.subject).toContain("Morning Brief");
    expect(m.text).toContain("ZZA trading halt overnight");
    expect(m.text).not.toContain("ZZB");
    expect(m.text).not.toContain("before the window");
    const row = await db.execute(
      "SELECT slot FROM email_message WHERE email_key = 'brief:2026-10-19'",
    );
    expect(row.rows[0]!.slot).toBe("pool");
  });

  it("one email per key: a second call is a duplicate", async () => {
    await enable();
    await run();
    expect(await run()).toEqual({ status: "duplicate", send: "duplicate" });
    expect(mock.outbox).toHaveLength(1);
  });

  it("non-trading day: none", async () => {
    await enable();
    expect(await run(SAT)).toEqual({ status: "skipped", reason: "non_trading" });
    expect(mock.outbox).toHaveLength(0);
  });

  it("market not active (data-only): none", async () => {
    await world("data_only");
    await enable();
    expect(await run()).toEqual({ status: "skipped", reason: "not_active" });
    expect(mock.outbox).toHaveLength(0);
  });

  it("email_mode off: suppressed, key not consumed", async () => {
    await enable();
    await mode("off");
    expect(await run()).toMatchObject({ status: "suppressed" });
    expect(mock.outbox).toHaveLength(0);
    const k = "SELECT 1 FROM email_message WHERE email_key = 'brief:2026-10-19'";
    expect((await db.execute(k)).rows).toHaveLength(0);
  });
});

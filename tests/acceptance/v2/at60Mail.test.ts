// @vitest-environment node
// M17 WP4 AT-60 (b): through the real quote-poll tick with the pick mailer plugged in, a pick that
// stays at or under its limit over several ticks (and a repeated tick) sends exactly ONE hit e-mail
// for the session; the mail comes after the state row. Mock provider, injected fetch, no network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPickAlertPoll, type PollRunDeps } from "@/lib/alerts/pick/poll";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { createPickMailer } from "@/lib/email/pickMail";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const SHA = "a".repeat(64);
const TICKS = ["23:45", "23:50", "23:55"].map((t) => new Date(`2026-11-03T${t}:00.000Z`)); // 10:45..10:55 AEDT
let db: Client;
let auth: Client;
let mock: MockProvider;
let clock: Date;

const fetchStub: PollRunDeps["fetch"] = async (url) => {
  const code = /chart\/([A-Z0-9]+)\.AX/.exec(url)![1];
  return {
    ok: true,
    status: 200,
    json: async () =>
      syntheticChart({
        price: 9.9, // at or under the 10.00 limit, over the 9.00 stop: a hit on every tick
        prevClose: 10,
        volume: 5000,
        timeS: (clock.getTime() - 20 * 60_000) / 1000,
        symbol: `${code}.AX`,
      }),
  };
};

beforeEach(async () => {
  db = await freshDb("main");
  auth = await freshDb("auth");
  mock = createMockProvider();
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'");
  for (const [k, v] of [
    ["dispatch_enabled", '"1"'],
    ["email_mode", '"full"'],
  ])
    await db.execute({
      sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 't')",
      args: [k, v],
    });
  await auth.execute(
    "INSERT INTO app_user (id, email, role, status, created_at, updated_at) VALUES (1, 'owner@example.test', 'owner', 'active', 't', 't')",
  );
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', '2026-11-03', 'P1', 1, 'ZZ01', 'F1', 'U1', 'F1.v1', 'sig', 'Synthetic ZZ01', 10000000,
            10000000, '2026-11-12', 9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?, '2026-11-03T07:10:00.000Z')`,
    args: [SHA],
  });
});

describe("AT-60 (b) one hit mail per pick per session over duplicate ticks", () => {
  it("three ticks plus a repeated tick send one hit e-mail", async () => {
    const env = {
      EMAIL_PROVIDER: "mock",
      OWNER_EMAIL: "owner@example.test",
      APP_BASE_URL: "https://praxis.example.test",
      PII_HASH_KEY: "k".repeat(64),
      PRAXIS_ENV: "production",
    } as Record<string, string | undefined>;
    const run = async (now: Date) => {
      clock = now;
      return runPickAlertPoll({
        db,
        now: () => now,
        fetch: fetchStub,
        sleep: async () => {},
        recipients: async () => ["1"],
        mailer: createPickMailer({ db, auth, env, now: () => now, provider: mock }),
      });
    };
    for (const t of TICKS) await run(t);
    await run(TICKS[2]); // the same tick posted again
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0].subject).toBe("[Praxis] Buy price hit — ZZ01 (delayed)");
    const hits = await db.execute("SELECT COUNT(*) AS n FROM pick_alert WHERE state = 'hit'");
    expect(Number(hits.rows[0].n)).toBe(1);
    const mails = await db.execute("SELECT status FROM pick_alert_mail");
    expect(mails.rows.map((r) => String(r.status))).toEqual(["sent"]);
  });
});

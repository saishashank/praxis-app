// @vitest-environment node
// M21 C3 (EML-043, D-1226; AT-77): the stop-hit e-mail. `stopHitDue` is pure (a hit alert, a usable quote,
// a price under the stop). Through the poll with the real pick mailer: one mail per alert and session; the
// pick cap is shared with the other pick mails; quiet hours send nothing and claim nothing; a stale quote
// sends nothing; the user's opt-in (default off) decides; no pick_alert, pick_alert_mail or order row is
// written; no internal code appears in the mail.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPickAlertPoll, type PollRunDeps } from "@/lib/alerts/pick/poll";
import { stopHitDue } from "@/lib/alerts/pick/stopHit";
import { setConfig } from "@/lib/config/store";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import type { DelayedQuote } from "@/lib/data/quotes/types";
import { emailKeys, keyMatchesKind } from "@/lib/email/keys";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { createPickMailer } from "@/lib/email/pickMail";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const SESSION = "2026-11-04"; // Wed, AEDT (UTC+11)
const T1045 = new Date("2026-11-03T23:45:00.000Z");
const T1050 = new Date("2026-11-03T23:50:00.000Z");
const T1055 = new Date("2026-11-03T23:55:00.000Z");
const T1100 = new Date("2026-11-04T00:00:00.000Z");
const T1105 = new Date("2026-11-04T00:05:00.000Z");
const SHA = "a".repeat(64);
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: "owner@example.test",
  APP_BASE_URL: "https://praxis.example.test",
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;

describe("stopHitDue (pure)", () => {
  const P = { now: new Date("2026-11-04T00:00:00.000Z"), maxAgeMin: 10, delayMin: 20 };
  const q = (over: Partial<DelayedQuote> = {}): DelayedQuote =>
    ({
      code: "ZZ01",
      lastMicro: 8_500_000n,
      prevCloseMicro: 10_000_000n,
      cumVolume: 5000n,
      quoteAt: "2026-11-03T23:40:00.000Z", // 20 minutes old: the feed delay
      halted: false,
      ...over,
    }) as DelayedQuote;
  const hit = { state: "hit" as const, stopMicro: 9_000_000n };

  it("due only for a hit alert whose usable price is under the stop", () => {
    expect(stopHitDue(hit, q(), P)).toBe(true);
    expect(stopHitDue(hit, q({ lastMicro: 9_000_000n }), P)).toBe(false); // at the stop is not under it
    expect(stopHitDue(hit, q({ lastMicro: 9_500_000n }), P)).toBe(false);
    expect(stopHitDue({ ...hit, state: "armed" }, q(), P)).toBe(false);
    expect(stopHitDue({ ...hit, state: "cleared" }, q(), P)).toBe(false);
    expect(stopHitDue(hit, null, P)).toBe(false);
  });

  it("a stale quote or one without cumulative volume is never due", () => {
    expect(stopHitDue(hit, q({ quoteAt: "2026-11-03T22:00:00.000Z" }), P)).toBe(false);
    expect(stopHitDue(hit, q({ cumVolume: null }), P)).toBe(false);
  });
});

describe("the stop-hit key (D-1226)", () => {
  it("is a pick_cleared key with its own hash, per alert and session", () => {
    const a = emailKeys.pickStopHit("b".repeat(64), SESSION);
    expect(keyMatchesKind("pick_cleared", a)).toBe(true);
    expect(a).toMatch(/^pickclr:[0-9a-f]{32}:2026-11-04$/);
    expect(a).not.toBe(emailKeys.pickCleared("b".repeat(64), SESSION));
    expect(a).not.toBe(emailKeys.pickStopHit("c".repeat(64), SESSION));
    expect(a).not.toBe(emailKeys.pickStopHit("b".repeat(64), "2026-11-05"));
  });
});

let db: Client;
let auth: Client;
let mock: MockProvider;
let clock: Date;
let price: number;
let ageMin: number;

const fetchStub: PollRunDeps["fetch"] = async (url) => {
  if (String(url).includes("%5EAXJO")) return { ok: false, status: 404, json: async () => ({}) };
  const code = /chart\/([A-Z0-9]+)\.AX/.exec(url)![1];
  if (code !== "ZZ01") return { ok: false, status: 404, json: async () => ({}) };
  return {
    ok: true,
    status: 200,
    json: async () =>
      syntheticChart({
        price,
        prevClose: 10,
        volume: 5000,
        timeS: (clock.getTime() - ageMin * 60_000) / 1000,
        symbol: "ZZ01.AX",
      }),
  };
};

const tick = async (now: Date, users: string[] = ["1"]) => {
  clock = now;
  return runPickAlertPoll({
    db,
    now: () => now,
    fetch: fetchStub,
    sleep: async () => {},
    recipients: async () => users,
    mailer: createPickMailer({
      db,
      auth,
      env: ENV,
      now: () => now,
      provider: mock,
      sleep: async () => {},
    }),
  });
};

const setPrefs = (prefs: Record<string, unknown>) =>
  auth.execute({
    sql: "INSERT OR REPLACE INTO user_preference (user_id, prefs_json, updated_at) VALUES (1, ?, 't')",
    args: [JSON.stringify(prefs)],
  });
const scalar = async (sql: string): Promise<number> => Number((await db.execute(sql)).rows[0].n);
const stopMails = () => mock.outbox.filter((m) => /traded under its stop/.test(m.subject));
const defaultOn = () =>
  setConfig(db, {
    key: "stop_hit_email_default",
    value: "on",
    userId: null,
    reason: "test",
    now: "2026-11-01T00:00:00.000Z",
  });

async function goToHit(): Promise<void> {
  price = 10.0; // at the limit: hit on the first tick
  ageMin = 20;
  await tick(T1045);
  expect(
    (await db.execute("SELECT state FROM pick_alert ORDER BY seq")).rows.map((r) => r.state),
  ).toEqual(["armed", "hit"]);
  mock.outbox.length = 0;
}

beforeEach(async () => {
  db = await freshDb("main");
  auth = await freshDb("auth");
  mock = createMockProvider();
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'");
  await db.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
  );
  await db.execute(
    `INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', '"full"', 't')`,
  );
  await auth.execute(
    "INSERT INTO app_user (id, email, role, status, created_at, updated_at) VALUES (1, 'owner@example.test', 'owner', 'active', 't', 't')",
  );
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', '2026-11-03', 'P1', 1, 'ZZ01', 'F1', 'U1', 'F1.v1', 'sig-ZZ01', 'SYNTHETIC ZZ01 LIMITED',
            10000000, 10000000, '2026-11-12', 9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?,
            '2026-11-03T07:00:00.000Z')`,
    args: [SHA],
  });
  clock = T1045;
});

describe("the stop-hit mail through the poll (D-1226)", () => {
  it("is off by default: a hit alert under its stop writes no mail and no row", async () => {
    await goToHit();
    const mailRows = await scalar("SELECT COUNT(*) AS n FROM pick_alert_mail");
    price = 8.5;
    await tick(T1050);
    expect(stopMails()).toHaveLength(0);
    expect(
      await scalar("SELECT COUNT(*) AS n FROM email_message WHERE kind = 'pick_cleared'"),
    ).toBe(0);
    expect(await scalar("SELECT COUNT(*) AS n FROM pick_alert_mail")).toBe(mailRows);
  });

  it("opted in: one mail under the pick_cleared kind, once per alert and session over repeated ticks", async () => {
    await setPrefs({ pick_alerts: "on", stop_hit_emails: "on" });
    await goToHit();
    price = 8.5;
    await tick(T1050);
    await tick(T1055);
    await tick(T1100);
    expect(stopMails()).toHaveLength(1);
    const m = stopMails()[0];
    expect(m.subject).toBe("[Praxis] ZZ01 traded under its stop (delayed)");
    expect(m.text).toContain("information only");
    expect(m.text).toContain("manage your own stop");
    expect(m.text).toContain("A$8.500");
    expect(m.text).toContain("Synthetic ZZ01 Limited"); // display-cased, the stock's own code kept
    const rows = (
      await db.execute("SELECT kind, status, slot FROM email_message WHERE kind = 'pick_cleared'")
    ).rows;
    expect(rows.map((r) => `${r.kind}:${r.status}:${r.slot}`)).toEqual(["pick_cleared:sent:pool"]);
  });

  it("writes no pick_alert row, no pick_alert_mail row and no order", async () => {
    await setPrefs({ pick_alerts: "on", stop_hit_emails: "on" });
    await goToHit();
    const count = async () => [
      await scalar("SELECT COUNT(*) AS n FROM pick_alert"),
      await scalar("SELECT COUNT(*) AS n FROM pick_alert_mail"),
      await scalar("SELECT COUNT(*) AS n FROM arena_order"),
    ];
    const before = await count();
    price = 8.5;
    await tick(T1050);
    expect(stopMails()).toHaveLength(1);
    expect(await count()).toEqual(before);
  });

  it("the config default on applies while the user has not chosen", async () => {
    await defaultOn();
    await setPrefs({ pick_alerts: "on" });
    await goToHit();
    price = 8.5;
    await tick(T1050);
    expect(stopMails()).toHaveLength(1);
  });

  it("an explicit off beats the config default on", async () => {
    await defaultOn();
    await setPrefs({ pick_alerts: "on", stop_hit_emails: "off" });
    await goToHit();
    price = 8.5;
    await tick(T1050);
    expect(stopMails()).toHaveLength(0);
  });

  it("a price above the stop, or a stale quote under it, sends nothing", async () => {
    await setPrefs({ pick_alerts: "on", stop_hit_emails: "on" });
    await goToHit();
    price = 9.5;
    await tick(T1050);
    price = 8.5;
    ageMin = 90;
    await tick(T1055);
    expect(stopMails()).toHaveLength(0);
  });

  it("quiet hours: nothing is sent and nothing is claimed; the first tick after the window sends it", async () => {
    await setPrefs({
      pick_alerts: "on",
      stop_hit_emails: "on",
      quiet_hours: { start: "10:00", end: "11:00" },
    });
    await goToHit();
    price = 8.5;
    await tick(T1050);
    expect(stopMails()).toHaveLength(0);
    expect(
      await scalar("SELECT COUNT(*) AS n FROM email_message WHERE kind = 'pick_cleared'"),
    ).toBe(0);
    await tick(T1105);
    expect(stopMails()).toHaveLength(1);
  });

  it("shares the daily pick cap: at the cap the mail is suppressed, not sent", async () => {
    await setPrefs({ pick_alerts: "on", stop_hit_emails: "on" });
    await goToHit();
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(T1050);
    for (let i = 0; i < 12; i++) {
      await db.execute({
        sql: `INSERT INTO email_message (email_key, env, kind, d, slot, status, recipient_sha, created_at, sent_at, ref_json)
              VALUES (?, 'production', 'pick_hit', ?, 'pool', 'sent', ?, 't', 't', '{}')`,
        args: [`pickhit:${String(i).padStart(8, "0")}:${d}`, d, "5".repeat(64)],
      });
    }
    price = 8.5;
    await tick(T1050);
    expect(stopMails()).toHaveLength(0);
    expect(
      await scalar(
        "SELECT COUNT(*) AS n FROM email_message WHERE kind = 'pick_cleared' AND status = 'suppressed_cap'",
      ),
    ).toBe(1);
  });

  it("an alert cleared this tick (the user turned the master toggle off) gets no stop mail", async () => {
    await setPrefs({ pick_alerts: "on", stop_hit_emails: "on" });
    await goToHit();
    price = 8.5;
    await tick(T1050, []); // not a recipient any more: the poll clears it as muted
    expect(
      (await db.execute("SELECT clear_reason FROM pick_alert WHERE seq = 3")).rows[0].clear_reason,
    ).toBe("muted");
    expect(stopMails()).toHaveLength(0);
  });

  it("the mail has no internal codes and carries the delay words and a quote time", async () => {
    await setPrefs({ pick_alerts: "on", stop_hit_emails: "on" });
    await goToHit();
    price = 8.5;
    await tick(T1050);
    const m = stopMails()[0];
    for (const s of [m.text, m.html.replace(/<[^>]*>/g, " ")]) {
      expect(s).not.toMatch(/\bE\d{2}\b/);
      expect(s).not.toMatch(/\bF\d-[UL]\b/);
      expect(s).not.toMatch(/\bARN-\d+/);
      expect(s).not.toMatch(/\bP[012]\b/);
      expect(s).not.toMatch(/\bD-\d{3,4}\b/);
      expect(s).not.toMatch(/real[- ]?time/i);
    }
    expect(m.text).toContain("delayed");
    expect(m.text).toContain("Wed 4 Nov 2026");
  });
});

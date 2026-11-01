// @vitest-environment node
// V2-S3 / V2-S5 / V2-S7 (D-694..D-698): armed-pick reserve and extras cadence of the quote-poll, the
// whole-run deadline and the +done reconciliation of the quote_run reservation, and the health lines of
// the recurring route slots. Synthetic ZZ data, injected fetch and clock, no network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickAlertsHealth, runPickAlertPoll, type PollRunDeps } from "@/lib/alerts/pick/poll";
import { armedReserve, extrasCadence, remainingPollTicks } from "@/lib/alerts/pick/reserve";
import { quoteRequestsToday } from "@/lib/data/quotes/budget";
import { fetchDelayedQuotes } from "@/lib/data/quotes/fetch";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import { intradayScanHealth } from "@/lib/intraday/run";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const SESSION = "2026-11-04"; // Wed, AEDT (UTC+11)
const SHA = "a".repeat(64);
const at = (hm: string) => new Date(`${SESSION}T${hm}:00.000+11:00`);

let db: Client;
let calls: string[];

const fetchStub: PollRunDeps["fetch"] = async (url) => {
  calls.push(url);
  const code = /chart\/([A-Z0-9]+)\.AX/.exec(url)![1];
  return {
    ok: true,
    status: 200,
    json: async () =>
      syntheticChart({
        price: 10.3,
        prevClose: 10,
        volume: 5000,
        timeS: Date.now() / 1000,
        symbol: `${code}.AX`,
      }),
  };
};
const deps = (now: Date, over: Partial<PollRunDeps> = {}): PollRunDeps => ({
  db,
  now: () => now,
  fetch: fetchStub,
  sleep: async () => {},
  recipients: async () => ["1"],
  ...over,
});
const codesCalled = () => calls.map((u) => /chart\/(\w+)\.AX/.exec(u)![1]);

async function seedPick(code: string, rank: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', '2026-11-03', 'P1', ?, ?, 'F1', 'U1', 'F1.v1', ?, 'UNVALIDATED', 10000000, 10000000,
            '2026-11-12', 9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?, '2026-11-03T07:00:00.000Z')`,
    args: [rank, code, `sig-${code}`, SHA],
  });
}
async function watch(code: string): Promise<void> {
  await db.execute({
    sql: "INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d) VALUES (?, 'AU', ?, 1, '2026-11-03T00:00:00.000Z', '2026-12-01')",
    args: [`w-${code}`, code],
  });
}
const usage = (n: number, slot = "09:00") =>
  db.execute({
    sql: "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) VALUES ('AU', ?, ?, 'scan', 't', ?)",
    args: [SESSION, slot, n],
  });
const pollRow = (slot: string, requests = 3) =>
  db.execute({
    sql: "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) VALUES ('AU', ?, ?, 'poll', 't', ?)",
    args: [SESSION, slot, requests],
  });

beforeEach(async () => {
  db = await freshDb("main");
  calls = [];
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'");
  await db.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
  );
});

describe("armed reserve and extras cadence (V2-S5, D-694/D-695)", () => {
  it("pure helpers: ticks left, reserve, cadence falls back instead of stopping", () => {
    expect(remainingPollTicks(at("10:00"), at("16:00"), 5)).toBe(73);
    expect(remainingPollTicks(at("16:00"), at("16:00"), 5)).toBe(1);
    expect(armedReserve(10, 73)).toBe(730);
    const base = { dayMax: 2000, armed: 10, ticksLeft: 73, extras: 30 };
    // 1900 - 730 = 1170 requests for extras = 39 polls of 30 codes, fewer than the 73 ticks left.
    expect(extrasCadence({ ...base, usedToday: 0 })).toBe(Math.ceil(73 / 39));
    expect(extrasCadence({ ...base, usedToday: 1200 })).toBe(0);
    expect(extrasCadence({ ...base, extras: 5, usedToday: 0 })).toBe(1);
    expect(extrasCadence({ ...base, extras: 0, usedToday: 0 })).toBe(0);
  });

  it("at 95 % an armed pick is still polled, watch-listed codes are not", async () => {
    await seedPick("ZZ01", 1);
    await watch("ZZW1");
    await usage(1900);
    const r = await runPickAlertPoll(deps(at("15:00")));
    expect(r).toMatchObject({ status: "ok", codes: 1 });
    expect(codesCalled()).toEqual(["ZZ01"]);
  });

  it("with the budget healthy, watch-listed codes follow the armed picks every tick", async () => {
    await seedPick("ZZ01", 1);
    await watch("ZZW1");
    const r = await runPickAlertPoll(deps(at("10:45")));
    expect(r).toMatchObject({ status: "ok", codes: 2 });
    expect(codesCalled()).toEqual(["ZZ01", "ZZW1"]);
  });

  it("with the armed reserve using the room, extras are skipped this tick but the pick is polled", async () => {
    await seedPick("ZZ01", 1);
    await watch("ZZW1");
    // 10:45 = 14 ticks... ticks left to 16:00 = 64; reserve 64; used 1850 leaves no room for extras.
    await usage(1850);
    const r = await runPickAlertPoll(deps(at("10:45")));
    expect(r).toMatchObject({ status: "ok", codes: 1, narrowed: true });
    expect(codesCalled()).toEqual(["ZZ01"]);
  });

  it("with no armed pick at 95 % the tick is budget_stop", async () => {
    await usage(1900);
    expect(await runPickAlertPoll(deps(at("15:00")))).toMatchObject({
      status: "skipped",
      reason: "budget_stop",
    });
  });
});

describe("whole-run deadline and reconciliation (V2-S7, D-696/D-697)", () => {
  it("stops starting requests at the deadline with a clock the signed request time does not drive", async () => {
    let t = 1_000_000;
    const codes = Array.from({ length: 10 }, (_, i) => `ZZ${i}`);
    const f = await fetchDelayedQuotes(
      {
        fetch: async (url) => {
          t += 6_000; // a slow host
          return fetchStub(url, { headers: {} });
        },
        now: () => at("11:00"), // frozen, like the route's signed time
        clock: () => t,
        sleep: async () => {},
        sourceState: async () => ({ register: "enabled", mode: "on", dispatchEnabled: true }),
      },
      codes,
      { perRunMax: 10, dayMax: 2000, usedToday: 0 },
      { deadlineAt: 1_000_000 + 22_000 },
    );
    expect(f.cut).toBe(true);
    expect(f.requests).toBeLessThan(10);
    expect(f.unfetched.length).toBeGreaterThan(0);
  });

  it("a run that made fewer requests than it reserved adds a +done row and is charged the actual count", async () => {
    for (let i = 1; i <= 6; i++) await seedPick(`ZZ0${i}`, i);
    const r = await runPickAlertPoll(
      deps(at("10:45"), {
        fetch: async (url) => {
          calls.push(url);
          return { ok: false, status: 429, json: async () => ({}) };
        },
      }),
    );
    expect(r).toMatchObject({ status: "ok", paused: "rate_limited" });
    const claim = await db.execute("SELECT requests FROM quote_run WHERE slot_minute = '10:45'");
    expect(Number(claim.rows[0].requests)).toBe(6); // reserved
    const done = await db.execute(
      "SELECT requests FROM quote_run WHERE slot_minute = '10:45+done'",
    );
    expect(Number(done.rows[0].requests)).toBe(4);
    expect(await quoteRequestsToday(db, "AU", SESSION)).toBe(Number(done.rows[0].requests));
  });

  it("a claim without a +done row (killed run) stays charged in full", async () => {
    await usage(40, "10:00");
    await usage(7, "10:05");
    await db.execute({
      sql: "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) VALUES ('AU', ?, '10:05+done', 'scan', 't', 2)",
      args: [SESSION],
    });
    expect(await quoteRequestsToday(db, "AU", SESSION)).toBe(42);
  });
});

describe("health lines of the recurring slots (V2-S3, D-698)", () => {
  it("poll: nothing before the grace, 'no successful run today' after it, a last-run line when it lags", async () => {
    expect(await pickAlertsHealth(db, at("10:05"))).toEqual([]);
    expect(await pickAlertsHealth(db, at("11:00"))).toEqual([
      "Pick-alert poll: no successful run today (since 10:00)",
    ]);
    await pollRow("10:30");
    expect(await pickAlertsHealth(db, at("10:40"))).toEqual([]);
    expect(await pickAlertsHealth(db, at("11:00"))).toEqual([
      "Pick-alert poll: last successful run 10:30",
    ]);
    expect(await pickAlertsHealth(db, at("17:00"))).toEqual([]); // window over, a run happened
  });

  it("a paused slot is not successful; a weekend and an off source give no run line", async () => {
    await pollRow("10:30");
    await db.execute({
      sql: "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, paused) VALUES ('AU', ?, '10:30+paused', 'poll', 't', 0, 'network')",
      args: [SESSION],
    });
    expect(await pickAlertsHealth(db, at("11:00"))).toEqual(["Prices paused"]);
    expect(await pickAlertsHealth(db, new Date("2026-11-07T01:00:00.000Z"))).toEqual([]); // Saturday
    await db.execute(
      "UPDATE source_register SET status = 'pending' WHERE source = 'yahoo_delayed'",
    );
    expect((await pickAlertsHealth(db, at("11:00")))[0]).toMatch(/^Pick alerts off/);
  });

  it("scan: 'no successful run today' on a trading day after the grace", async () => {
    const lines = await intradayScanHealth(db, at("12:00"));
    expect(lines.some((l) => l.startsWith("Intraday scan: no successful run today"))).toBe(true);
  });
});

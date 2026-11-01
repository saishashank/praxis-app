// @vitest-environment node
// PLT-074 / PLT-018 / AT-05: the heartbeat checks (src/lib/heartbeat/checks.ts), boundaries and
// skips. Routes (auth, production only, idempotency): tests/heartbeat/route.test.ts
// (api/cron/heartbeat-morning, api/cron/heartbeat-evening).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfig } from "@/lib/config/store";
import { runChecks, POLL_END } from "@/lib/heartbeat/checks";
import { localToUtc } from "@/lib/data/calendar";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

// Monday 2026-10-12 in Sydney (AEDT, UTC+11): 11:30 in the morning, 22:10 in the evening.
const MORNING = new Date("2026-10-11T00:30:00.000Z");
const MON = "2026-10-12";
const MORNING_MON = new Date("2026-10-12T00:30:00.000Z");
const EVENING_MON = new Date("2026-10-12T11:10:00.000Z");
const MIN = 60_000;

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

async function rollup(date = MON) {
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status)
          VALUES ('worker-clock', 'AU', ?, ?, ?, 'success')`,
    args: [`worker-clock:AU:${date}`, date, `${date}T00:00:00.000Z`],
  });
}
async function setState(key: string, on: boolean) {
  await db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [key, JSON.stringify(on ? "1" : "0")],
  });
}
const lastPoll = (iso: string | null) =>
  db.execute({ sql: "UPDATE asx_rate_token SET last_request_at = ? WHERE id = 1", args: [iso] });
const marker = (d: string, kind: string) =>
  db.execute({
    sql: "INSERT INTO completion_marker (market, d, kind, at, outcome) VALUES ('AU', ?, ?, 'x', 'ok')",
    args: [d, kind],
  });
const kinds = (r: Awaited<ReturnType<typeof runChecks>>) => r.problems.map((p) => p.kind);

async function healthyMorning() {
  await rollup();
  await setState("asx_enabled", true);
  await lastPoll(new Date(MORNING_MON.getTime() - 10 * MIN).toISOString());
}

describe("morning check", () => {
  it("is quiet when the Worker ticked today and the last ASX poll is recent", async () => {
    await healthyMorning();
    const r = await runChecks("morning", db, MORNING_MON);
    expect(r).toMatchObject({ date: MON, problems: [] });
  });

  it("raises worker_blind when no worker-clock rollup exists for today's Sydney date", async () => {
    await rollup("2026-10-11"); // yesterday's record does not count
    const r = await runChecks("morning", db, MORNING_MON);
    expect(kinds(r)).toEqual(["worker_blind"]);
    expect(r.problems[0].detail).toEqual({ check: "morning", date: MON });
  });

  it("the rollup must be a success record", async () => {
    await db.execute(
      `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
       VALUES ('worker-clock', 'AU', 'worker-clock:AU:2026-10-12', '2026-10-12T00:00:00.000Z', 'failed')`,
    );
    expect(kinds(await runChecks("morning", db, MORNING_MON))).toEqual(["worker_blind"]);
  });

  it("sentinel boundary: exactly 15 minutes is fine, one second more is blind", async () => {
    await rollup();
    await setState("asx_enabled", true);
    await lastPoll(new Date(MORNING_MON.getTime() - 15 * MIN).toISOString());
    expect((await runChecks("morning", db, MORNING_MON)).problems).toEqual([]);
    await lastPoll(new Date(MORNING_MON.getTime() - 15 * MIN - 1000).toISOString());
    const r = await runChecks("morning", db, MORNING_MON);
    expect(kinds(r)).toEqual(["sentinel_blind"]);
    expect(r.problems[0].detail).toMatchObject({ blindMinutes: 15, date: MON });
  });

  it("a Worker that never polled is blind; a corrupt timestamp too", async () => {
    await rollup();
    await setState("asx_enabled", true);
    expect(kinds(await runChecks("morning", db, MORNING_MON))).toEqual(["sentinel_blind"]);
    await lastPoll("not a date");
    expect(kinds(await runChecks("morning", db, MORNING_MON))).toEqual(["sentinel_blind"]);
  });

  it("uses the configured sentinel_blind_alert_min (ch.15)", async () => {
    await rollup();
    await setState("asx_enabled", true);
    await lastPoll(new Date(MORNING_MON.getTime() - 6 * MIN).toISOString());
    expect((await runChecks("morning", db, MORNING_MON)).problems).toEqual([]);
    await setConfig(db, {
      key: "sentinel_blind_alert_min",
      value: 5,
      userId: null,
      now: MORNING_MON.toISOString(),
    });
    const r = await runChecks("morning", db, MORNING_MON);
    expect(r.problems[0].detail).toMatchObject({ blindMinutes: 5 });
  });

  it.each([
    ["ASX contact off", async () => setState("asx_enabled", false)],
    [
      "ASX source off",
      async () =>
        db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'asx_announcements'"),
    ],
    [
      "ASX source tripped",
      async () =>
        db.execute("UPDATE source_status SET mode = 'tripped' WHERE source = 'asx_announcements'"),
    ],
    ["market off", async () => db.execute("UPDATE market SET mode = 'off'")],
  ])("the poll check is skipped (not an incident) when %s", async (_n, change) => {
    await healthyMorning();
    await change();
    await lastPoll(null);
    const r = await runChecks("morning", db, MORNING_MON);
    expect(r.problems).toEqual([]);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it("the poll check is skipped on a weekend and on a holiday, but the Worker check still runs", async () => {
    await setState("asx_enabled", true);
    const sat = await runChecks("morning", db, new Date("2026-10-10T00:30:00.000Z"));
    expect(sat.date).toBe("2026-10-10");
    expect(kinds(sat)).toEqual(["worker_blind"]);
    const goodFriday = await runChecks("morning", db, new Date("2026-04-03T00:30:00.000Z"));
    expect(goodFriday.date).toBe("2026-04-03");
    expect(kinds(goodFriday)).toEqual(["worker_blind"]);
    expect(goodFriday.notes.join(" ")).toMatch(/not a trading day/);
  });

  it("is local-date aware: it judges the Sydney date, not the UTC date", async () => {
    // 2026-10-11T23:30Z is 10:30 Monday 12 October in Sydney.
    await rollup("2026-10-12");
    const r = await runChecks("morning", db, new Date("2026-10-11T23:30:00.000Z"));
    expect(r.date).toBe("2026-10-12");
    expect(r.problems).toEqual([]);
    expect(MORNING.toISOString()).toBe("2026-10-11T00:30:00.000Z"); // Sunday in Sydney
  });

  it("outside announcement hours the poll check is skipped", async () => {
    await rollup();
    await setState("asx_enabled", true);
    const early = new Date("2026-10-11T19:50:00.000Z"); // 06:50 Monday in Sydney
    const r = await runChecks("morning", db, early);
    expect(r.problems).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/outside announcement hours/);
  });

  it("does not check the completion marker (evening only)", async () => {
    await healthyMorning();
    await setState("dispatch_enabled", true);
    expect((await runChecks("morning", db, MORNING_MON)).problems).toEqual([]);
  });
});

describe("evening check", () => {
  const endMs = () => localToUtc(MON, POLL_END, "Australia/Sydney").getTime();

  async function healthyEvening() {
    await rollup();
    await setState("asx_enabled", true);
    await setState("dispatch_enabled", true);
    await lastPoll(new Date(endMs() + 5 * MIN).toISOString());
    await marker(MON, "data");
  }

  it("is quiet with the Worker alive, a late poll and today's marker; email checks are skipped", async () => {
    await healthyEvening();
    const r = await runChecks("evening", db, EVENING_MON);
    expect(r.problems).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/email checks skipped \(data-only mode, BLD-024\)/);
  });

  it("raises completion_marker_missing on a trading day with dispatch on", async () => {
    await rollup();
    await setState("dispatch_enabled", true);
    const r = await runChecks("evening", db, EVENING_MON);
    expect(kinds(r)).toEqual(["completion_marker_missing"]);
    expect(r.problems[0].detail).toEqual({ check: "evening", date: MON });
  });

  it("accepts data and non-trading markers; late_sweep alone and another date do not count", async () => {
    await rollup();
    await setState("dispatch_enabled", true);
    await marker(MON, "late_sweep");
    await marker("2026-10-09", "data");
    expect(kinds(await runChecks("evening", db, EVENING_MON))).toEqual([
      "completion_marker_missing",
    ]);
    await marker(MON, "non-trading");
    expect((await runChecks("evening", db, EVENING_MON)).problems).toEqual([]);
  });

  it("skips the marker check when dispatch is off, on non-trading days and when the market is off", async () => {
    await rollup();
    const off = await runChecks("evening", db, EVENING_MON);
    expect(off.problems).toEqual([]);
    expect(off.notes.join(" ")).toMatch(/dispatch is off/);
    await setState("dispatch_enabled", true);
    await db.execute("UPDATE market SET mode = 'off'");
    expect((await runChecks("evening", db, EVENING_MON)).problems).toEqual([]);
    await db.execute("UPDATE market SET mode = 'data_only'");
    const sun = await runChecks("evening", db, new Date("2026-10-11T11:10:00.000Z"));
    expect(kinds(sun)).toEqual(["worker_blind"]); // only the Worker check
  });

  it("a weekday the calendar has no row for is NOT a trading day: calendar_missing, no marker check (V1-S3)", async () => {
    await setState("dispatch_enabled", true);
    const wed = new Date("2029-03-14T11:10:00.000Z");
    await rollup("2029-03-14");
    const r = await runChecks("evening", db, wed);
    expect(kinds(r).sort()).toEqual(["calendar_horizon", "calendar_missing"]);
    expect(r.notes.join(" ")).toMatch(/not a trading day/);
  });

  it("raises calendar_horizon when the calendar ends within 60 days, and not before", async () => {
    // seed ends 2027-12-31; 2027-11-01 has exactly 60 days left (quiet), 2027-11-02 has 59
    await rollup("2027-11-01");
    await rollup("2027-11-02");
    const quiet = await runChecks("morning", db, new Date("2027-11-01T00:30:00.000Z"));
    expect(kinds(quiet)).not.toContain("calendar_horizon");
    const loud = await runChecks("morning", db, new Date("2027-11-02T00:30:00.000Z"));
    expect(kinds(loud)).toContain("calendar_horizon");
    expect(loud.problems.find((p) => p.kind === "calendar_horizon")!.detail).toMatchObject({
      lastDate: "2027-12-31",
    });
  });

  it("a weekday with a session row raises no calendar problem", async () => {
    await rollup();
    expect(kinds(await runChecks("morning", db, MORNING_MON))).not.toContain("calendar_missing");
  });

  it("poll boundary: the last poll must be within 15 minutes of the 19:30 close", async () => {
    await healthyEvening();
    await lastPoll(new Date(endMs() - 15 * MIN).toISOString());
    expect((await runChecks("evening", db, EVENING_MON)).problems).toEqual([]);
    await lastPoll(new Date(endMs() - 15 * MIN - 1000).toISOString());
    const r = await runChecks("evening", db, EVENING_MON);
    expect(kinds(r)).toEqual(["sentinel_blind"]);
    await lastPoll(null);
    expect(kinds(await runChecks("evening", db, EVENING_MON))).toEqual(["sentinel_blind"]);
  });

  it("reports every problem it finds in one pass", async () => {
    await setState("asx_enabled", true);
    await setState("dispatch_enabled", true);
    expect(kinds(await runChecks("evening", db, EVENING_MON)).sort()).toEqual([
      "completion_marker_missing",
      "sentinel_blind",
      "worker_blind",
    ]);
  });

  it("falls back to the default 15 minutes for a bad stored threshold", async () => {
    await healthyEvening();
    await db.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('sentinel_blind_alert_min', 'global', '\"x\"', 'x')",
    });
    await lastPoll(new Date(endMs() - 16 * MIN).toISOString());
    const r = await runChecks("evening", db, EVENING_MON);
    expect(r.problems[0].detail).toMatchObject({ blindMinutes: 15 });
  });
});

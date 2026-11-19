// @vitest-environment node
// The live-tested progress meter (M23 M3; CXA-005, D-1624): per family the latest evaluated look's n_eff_live against 150 and the
// trade floor, a projected date from the pace between looks on a fixture calendar, F7 never measured, and nothing evaluated.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_TESTED_MIN_NEFF } from "@/lib/cortex/statusRules.mjs";
import {
  liveRate,
  lookPoints,
  neffLiveLineage,
  neffTradeLineage,
  quarterStart,
  runLiveTested,
} from "@/lib/research/meters/liveTested";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);
const M = "ZZ";
const at = (d: string) => ({ market: M, d, now: `${d}T12:00:00Z` });

/** Weekdays from a start date (inclusive). */
function weekdays(n: number, start: string): string[] {
  const out: string[] = [];
  const t = new Date(`${start}T00:00:00Z`);
  while (out.length < n) {
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}

async function sessions(db: Client, days: readonly string[]): Promise<void> {
  await db.batch(
    days.map((d) => ({
      sql: "INSERT OR IGNORE INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES (?, ?, 'session', NULL, 1, 'test')",
      args: [M, d],
    })),
    "write",
  );
}

async function look(
  db: Client,
  family: string,
  quarter: string,
  to: string,
  result: Record<string, unknown> | null,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json, logged_at, result_at, result_json, split, lineage_id)
          VALUES (?, ?, ?, NULL, 'status_look', ?, ?, ?, ?, 'validation', NULL)`,
    args: [
      `look:${M}:${family}:${quarter}`,
      M,
      family,
      JSON.stringify({ quarter, to }),
      `${to}T01:00:00.000Z`,
      result === null ? null : `${to}T01:00:00.001Z`,
      result === null ? null : JSON.stringify(result),
    ],
  });
}

const row = async (db: Client, lineage: string, d: string) =>
  (
    await db.execute({
      sql: "SELECT n, target, projected_d, status FROM research_meter WHERE market = ? AND lineage = ? AND d = ?",
      args: [M, lineage, d],
    })
  ).rows[0]!;

describe("live-tested progress", () => {
  it("quarter starts", () => {
    expect(quarterStart("2031Q1")).toBe("2031-01-01");
    expect(quarterStart("2031Q4")).toBe("2031-10-01");
    expect(quarterStart("x")).toBeNull();
  });

  it("with no look the figure is 0 for F1 to F6 (twelve rows), F7 is not measured, no date is projected", async () => {
    const db = await freshDb("main");
    await allowMarket(db, M);
    const out = await runLiveTested(db, at("2031-04-01"));
    expect(out.map((o) => o.family)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
    expect(Number((await db.execute("SELECT COUNT(*) n FROM research_meter")).rows[0]!.n)).toBe(12);
    const r = await row(db, neffLiveLineage("F1"), "2031-04-01");
    expect({ ...r }).toEqual({
      n: 0,
      target: LIVE_TESTED_MIN_NEFF,
      projected_d: null,
      status: "collecting",
    });
    expect(Number((await row(db, neffTradeLineage("F1"), "2031-04-01")).target)).toBe(200);
  });

  it("one look: pace = n_eff over the sessions of its quarter; the date walks that pace on the calendar", async () => {
    const db = await freshDb("main");
    await allowMarket(db, M);
    await sessions(db, weekdays(20, "2031-02-03")); // 20 sessions inside 2031Q1
    await look(db, "F1", "2031Q1", "2031-03-31", { outcome: "evaluated", n_eff_live: 60 });
    await look(db, "F2", "2031Q1", "2031-03-31", { outcome: "inconclusive", n_filled: 5 }); // no n_eff: no point
    await look(db, "F3", "2031Q1", "2031-03-31", null); // not resulted
    const pts = await lookPoints(db, M, "F1");
    expect(pts).toEqual([{ quarter: "2031Q1", to: "2031-03-31", nEff: 60 }]);
    expect(await liveRate(db, M, pts)).toBe(3);
    await runLiveTested(db, at("2031-04-01"));
    // 90 to go at 3 a session = 30 sessions = six weeks from Tuesday 1 April: Tuesday 13 May
    const live = await row(db, neffLiveLineage("F1"), "2031-04-01");
    expect({ ...live }).toEqual({
      n: 60,
      target: 150,
      projected_d: "2031-05-13",
      status: "collecting",
    });
    // 140 to go to the trade floor of 200: 47 sessions from Tuesday 1 April: Thursday 5 June
    const trade = await row(db, neffTradeLineage("F1"), "2031-04-01");
    expect(Number(trade.n)).toBe(60);
    expect(String(trade.projected_d)).toBe("2031-06-05");
    for (const f of ["F2", "F3"]) {
      const r = await row(db, neffLiveLineage(f), "2031-04-01");
      expect({ ...r }).toMatchObject({ n: 0, status: "collecting", projected_d: null });
    }
  });

  it("two looks: pace is the gain between them over the sessions between; met at 150 for the live line, not for the trade floor", async () => {
    const db = await freshDb("main");
    await allowMarket(db, M);
    await sessions(db, weekdays(20, "2031-02-03"));
    await sessions(db, weekdays(30, "2031-04-01")); // 30 sessions in the second quarter
    await look(db, "F1", "2031Q1", "2031-03-31", { outcome: "evaluated", n_eff_live: 60 });
    await look(db, "F1", "2031Q2", "2031-06-30", { outcome: "evaluated", n_eff_live: 120 });
    const pts = await lookPoints(db, M, "F1");
    expect(await liveRate(db, M, pts)).toBe(2);
    await runLiveTested(db, at("2031-07-01"));
    // 30 to go to 150 at 2 a session: 15 sessions (three weeks) from Tuesday 1 July: Tuesday 22 July
    expect({ ...(await row(db, neffLiveLineage("F1"), "2031-07-01")) }).toMatchObject({
      n: 120,
      projected_d: "2031-07-22",
    });
    await look(db, "F4", "2031Q2", "2031-06-30", { outcome: "evaluated", n_eff_live: 150 });
    await runLiveTested(db, at("2031-07-02"));
    expect({ ...(await row(db, neffLiveLineage("F4"), "2031-07-02")) }).toMatchObject({
      n: 150,
      status: "met",
      projected_d: null,
    });
    expect(String((await row(db, neffTradeLineage("F4"), "2031-07-02")).status)).toBe("collecting");
  });

  it("writes only research_meter: no family status, statement or look is touched", async () => {
    const db = await freshDb("main");
    await allowMarket(db, M);
    const before = await Promise.all(
      [
        "family_status",
        "cortex_statement",
        "cortex_ledger_cell",
        "holdout_look",
        "research_prereg",
      ].map(async (t) => Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n)),
    );
    await runLiveTested(db, at("2031-04-01"));
    const after = await Promise.all(
      [
        "family_status",
        "cortex_statement",
        "cortex_ledger_cell",
        "holdout_look",
        "research_prereg",
      ].map(async (t) => Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n)),
    );
    expect(after).toEqual(before);
  });
});

// @vitest-environment node
// D-908: a family with no live development rows publishes picks from a full replay's stored
// development record (replay_stat `pick_history:<family>|<rule version>|<variant>`); the live ledger
// still wins when it has enough rows; an insufficient or missing record publishes nothing.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPicksNight } from "@/lib/picks/nightly";
import { replayHistoryOf } from "@/lib/picks/inputs";
import type { PickHistorySummary } from "@/lib/replay/pickHistoryFormat";
import { cleanupTempDbs } from "../db/helpers";
import {
  D,
  MARKET,
  NOW,
  SESSIONS,
  addBars,
  addCard,
  addExecutionAndLabel,
  addSignal,
  addUniverse,
  params,
  world,
  type CodeSpec,
  type Sql,
} from "./harness";

const specs: CodeSpec[] = [
  { code: "ZZA1", tier: "U1", base: 10_000_000n, step: 0n },
  { code: "ZZB1", tier: "U1", base: 10_000_000n, step: 0n },
];

const summary = (over: Partial<PickHistorySummary> = {}): PickHistorySummary => ({
  v: 1,
  lineage: `${MARKET}:F4`,
  split: {
    version: 1,
    dev_end_d: SESSIONS[40]!,
    deferred_until_d: null,
    data_end_d: SESSIONS[58]!,
    stored: false,
  },
  n: 45,
  insufficient: false,
  reason: null,
  p10_ppm: -60_000,
  p50_ppm: 20_000,
  p90_ppm: 90_000,
  hold_median: 6,
  median_drop_ppm: 30_000,
  aim_reach_ppm: 100_000,
  win_rate_ppm: 580_000,
  ...over,
});

let db: Client;
let run: Sql;
const putSummary = (runId: string, d: string, v: PickHistorySummary, variant = "U") =>
  run("INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, ?, ?)", [
    runId,
    `pick_history:F4|F4.v1|${variant}`,
    "dev_summary",
    d,
    JSON.stringify(v),
  ]);

beforeAll(async () => {
  ({ db, run } = await world());
  for (const s of specs) await addBars(run, s, 0, 60);
  await addUniverse(run, D, specs);
  await addExecutionAndLabel(run, "F4", "F4.v1", "PASSED-BACKTEST");
  for (const s of specs) {
    const id = await addSignal(run, {
      d: D,
      family: "F4",
      rv: "F4.v1",
      code: s.code,
      tier: s.tier,
      closeMicro: 10_000_000n,
      rank: s.code === "ZZA1" ? "9/1" : "8/1",
    });
    await addCard(run, id, 9_200_000n);
  }
});

afterAll(cleanupTempDbs);

describe("D-908 picks from the replay's development record", () => {
  it("no live rows and no record: nothing is published (as before)", async () => {
    const r = await runPicksNight(db, { market: MARKET, d: D, params, calendar: [], now: NOW });
    expect(r.published).toBe(0);
    expect(r.candidates).toBe(2);
  });

  it("reads the newest record of the group; an insufficient one gives no scenario", async () => {
    await putSummary(
      "OLD",
      SESSIONS[10]!,
      summary({ insufficient: true, p10_ppm: null, p50_ppm: null, p90_ppm: null, n: 12 }),
    );
    let h = await replayHistoryOf(db, { family: "F4", ruleVersion: "F4.v1", variant: "U" });
    expect(h?.scenario).toBeNull();
    await putSummary("NEW", SESSIONS[50]!, summary());
    h = await replayHistoryOf(db, { family: "F4", ruleVersion: "F4.v1", variant: "U" });
    expect(h).toMatchObject({
      source: "replay",
      scenario: { n: 45, badPpm: -60_000, typicalPpm: 20_000, goodPpm: 90_000 },
      holdMedian: 6,
      medianDropPpm: 30_000,
      splitVersion: null,
    });
    expect(h!.aimReachByGood(90_000)).toBe(100_000);
    expect(h!.aimReachByGood(50_000)).toBeNull();
    expect(
      await replayHistoryOf(db, { family: "F4", ruleVersion: "F4.v1", variant: "other" }),
    ).toBeNull();
  });

  it("with the record, tonight's F4 signals become picks that say where their history comes from", async () => {
    const r = await runPicksNight(db, { market: MARKET, d: D, params, calendar: [], now: NOW });
    expect(r.published).toBeGreaterThan(0);
    const picks = (
      await db.execute({
        sql: "SELECT code, family, n_similar, good_ppm, based_on_json FROM pick WHERE market = ? AND d = ? ORDER BY profile, rank",
        args: [MARKET, D],
      })
    ).rows;
    expect(picks.length).toBe(r.published);
    for (const p of picks) {
      expect(p.family).toBe("F4");
      expect(Number(p.n_similar)).toBe(45);
      expect(Number(p.good_ppm)).toBe(90_000);
      expect(String(p.based_on_json)).toContain("45 similar past trades in the development replay");
      expect(String(p.based_on_json)).toContain("58 % of them ended with a net gain");
    }
  });
});

describe("historyLine", () => {
  it("says how many trades, where from and how often they ended with a net gain", async () => {
    const { historyLine } = await import("@/lib/picks/inputs");
    expect(historyLine(45, "replay", 580_000)).toBe(
      "History: 45 similar past trades in the development replay; 58 % of them ended with a net gain",
    );
    expect(historyLine(31, "ledger", null)).toBe(
      "History: 31 similar past trades in the development ledger",
    );
  });
});

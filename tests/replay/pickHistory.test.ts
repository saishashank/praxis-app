// @vitest-environment node
// D-908: a full replay's development track record per group, for the nightly picks. Development rows
// only (no validation or holdout row is read), the same net formula and percentiles as the live
// picks loader, the stored split when one exists, else the computed one.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import type { LedgerEntry, LedgerResult } from "@/lib/replay/ledger";
import {
  netOf,
  pickHistoryStats,
  PICK_HISTORY_METRIC,
  PICK_HISTORY_SCOPE,
  type PickHistorySummary,
} from "@/lib/replay/pickHistory";
import type { LineageSplitRecord } from "@/lib/stats/splits";

const params = defaultAgentParams();
const sessions = Array.from({ length: 200 }, (_, i) => {
  const t = new Date(Date.UTC(2030, 0, 1) + i * 86_400_000);
  return t.toISOString().slice(0, 10);
});
const DEV_END = sessions[120]!;

const split: LineageSplitRecord = {
  lineage_id: "AU:F1",
  version: 3,
  block_sessions: 5,
  holdout_len: 20,
  validation_len: 20,
  purge: 2,
  data_end_d: sessions[199]!,
  holdout_start_d: sessions[170]!,
  holdout_end_d: sessions[199]!,
  validation_start_d: sessions[130]!,
  validation_end_d: sessions[160]!,
  dev_end_d: DEV_END,
  deferred_until_d: null,
  reason: "create",
  measured_on_run: null,
};

/** A closed row: entry at session i, exit 3 sessions later at the given exit fill. */
function entry(i: number, exitFill: bigint, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    row: {
      id: `r${i}`,
      signal_id: `s${i}`,
      group_key: null,
      entry_d: sessions[i]!,
      exit_d: sessions[i + 3]!,
      exit_tag: "CS",
      qty: 100,
      fill_in_micro: 10_000_000n,
      fill_out_micro: exitFill,
      brok_in_micro: 0n,
      brok_out_micro: 0n,
      stress_in_micro: 0n,
      stress_out_micro: 0n,
      qty_out: 100,
      dividend_micro: 0n,
      gross_num: 1n,
      gross_den: 1n,
      timed: 1,
      forward: 0,
    },
    lineage: "AU:F1",
    family: "F1",
    ruleVersion: "F1.v1",
    variant: "base",
    code: "ZZA1",
    decisionD: sessions[i]!,
    exitRule: "cs",
    net: null,
    stress: null,
    excess: null,
    flags: [],
    mtm: [],
    controls: null,
    ...over,
  } as LedgerEntry;
}

const world = {
  sessions,
  // a flat bar with a low 2 % under the entry fill on every session
  bar: () =>
    ({ open: 10_000_000n, high: 10_100_000n, low: 9_800_000n, close: 10_000_000n }) as never,
  corpActions: () => [],
};

function run(entries: LedgerEntry[], existingSplits: LineageSplitRecord[] = [split]) {
  const ledger = { entries } as unknown as LedgerResult;
  return pickHistoryStats({
    market: "AU",
    ledger,
    world,
    params,
    runId: "RUN",
    existingSplits,
  });
}

describe("pickHistoryStats", () => {
  // 40 development rows (entries 0..39, net -10 % .. +29 %) and 20 rows after the dev end
  const dev = Array.from({ length: 40 }, (_, i) => entry(i, 9_000_000n + 100_000n * BigInt(i)));
  const late = Array.from({ length: 20 }, (_, i) => entry(130 + i, 30_000_000n));

  it("one row per group, development rows only: the rows after the dev end never count", () => {
    const rows = run([...dev, ...late]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe(`${PICK_HISTORY_SCOPE}F1|F1.v1|base`);
    expect(rows[0]!.metric).toBe(PICK_HISTORY_METRIC);
    const v = rows[0]!.value as PickHistorySummary;
    expect(v.n).toBe(40);
    expect(v.insufficient).toBe(false);
    expect(v.split).toMatchObject({ version: 3, dev_end_d: DEV_END, stored: true });
    // the late rows (+200 %) would move the good case far up if they were read
    expect(v.p90_ppm!).toBeLessThan(300_000);
    expect(v.p10_ppm!).toBeLessThan(v.p50_ppm!);
    expect(v.p50_ppm!).toBeLessThan(v.p90_ppm!);
    expect(v.hold_median).toBe(4); // entry and exit sessions included
    expect(v.median_drop_ppm).toBe(20_000); // low 2 % under the fill
    expect(v.aim_reach_ppm).toBeGreaterThan(0);
    expect(v.aim_reach_ppm).toBeLessThanOrEqual(200_000);
    // nets -10 % .. +29 % in 1 % steps: 29 of 40 above zero
    expect(v.win_rate_ppm).toBe(725_000);
  });

  it("the same as the live loader's numbers: below scenario_min_n is insufficient, no percentiles", () => {
    const v = run(dev.slice(0, 10))[0]!.value as PickHistorySummary;
    expect(v.n).toBe(10);
    expect(v.insufficient).toBe(true);
    expect(v.p90_ppm).toBeNull();
    expect(v.aim_reach_ppm).toBeNull();
  });

  it("without a stored split the run computes one (stored: false) and writes no split", () => {
    const v = run(dev, [])[0]!.value as PickHistorySummary;
    expect(v.split.stored).toBe(false);
  });

  it("netOf is (proceeds - cost) / cost with brokerage and dividends, as loadScenarioInput", () => {
    const e = entry(0, 11_000_000n);
    const withCosts = {
      ...e,
      row: {
        ...e.row,
        brok_in_micro: 3_000_000n,
        brok_out_micro: 3_000_000n,
        dividend_micro: 500_000n,
      },
    } as LedgerEntry;
    // cost 100 x 10 + 3 = 1,003; proceeds 100 x 11 - 3 + 0.5 = 1,097.5 (micro dollars)
    expect(netOf(withCosts)).toEqual({ num: 94_500_000n, den: 1_003_000_000n });
    expect(netOf({ ...e, row: { ...e.row, exit_d: null } } as LedgerEntry)).toBeNull();
  });
});

// D-908 (Owner 2026-11-09: "we need to have picks every day"): the development-period track record
// of every (family, rule version, variant), from a full replay's own ledger, for the nightly picks.
//
// Why. A pick shows its bad / typical / good outcomes from >= scenario_min_n closed similar trades
// of the DEVELOPMENT split (AGT-110, decision 21). The live `ledger_row` table holds only forward
// rows since go-live, all later than any development end, and the replay's historical rows go to
// data-repo files, so no pick could ever be published. The full replay now stores, per group, the
// same summary the picks loader computes from `ledger_row`, as one `replay_stat` row:
//   scope `pick_history:<family>|<rule version>|<variant>`, metric `dev_summary`.
//
// No look. Only development rows are read (entered and exited on or before the split's dev end);
// the split is the stored one of the lineage when it exists, else the one the cost gate already
// computes in memory on every run (`createLineageSplit`, D-282). Nothing here reads validation or
// holdout rows, and no split, trial or label is written. Pure.
import { buildScenario, type SplitInfo } from "@/lib/agents/cards";
import type { AgentParams } from "@/lib/agents/params";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { computeExcursion } from "@/lib/learning/attribution";
import {
  createLineageSplit,
  lineageId,
  maxHoldingUpperBound,
  type LineageSplitRecord,
} from "@/lib/stats/splits";
import type { ViewBar } from "@/lib/agents/decisionView";
import type { Fraction } from "./returns";
import type { LedgerEntry, LedgerResult } from "./ledger";
import type { ReplayStatInput } from "./scorecards";
import {
  PICK_HISTORY_FORMAT,
  PICK_HISTORY_METRIC,
  PICK_HISTORY_SCOPE,
  type PickHistorySummary,
} from "./pickHistoryFormat";

export { PICK_HISTORY_FORMAT, PICK_HISTORY_METRIC, PICK_HISTORY_SCOPE, type PickHistorySummary };

const PPM = 1_000_000n; // threshold-ok: parts per million

export type PickHistoryWorld = {
  readonly sessions: readonly string[];
  bar(code: string, d: string): ViewBar | null;
  corpActions(code: string): readonly CorpActionRecord[];
};

const lowerMedian = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

/** Net return of a closed row, the formula of `loadScenarioInput` (cards.ts), exact. */
export function netOf(e: LedgerEntry): Fraction | null {
  const r = e.row;
  if (r.exit_d === null || r.fill_out_micro === null || r.qty_out === null) return null;
  if (r.brok_out_micro === null) return null;
  const cost = BigInt(r.qty) * r.fill_in_micro + r.brok_in_micro;
  if (cost <= 0n) return null;
  const proceeds = BigInt(r.qty_out) * r.fill_out_micro - r.brok_out_micro + r.dividend_micro;
  return { num: proceeds - cost, den: cost };
}

function newestSplit(
  stored: readonly LineageSplitRecord[],
  lineage: string,
): LineageSplitRecord | null {
  let best: LineageSplitRecord | null = null;
  for (const s of stored) {
    if (s.lineage_id === lineage && (best === null || s.version > best.version)) best = s;
  }
  return best;
}

type Group = {
  readonly family: string;
  readonly ruleVersion: string;
  readonly variant: string;
  readonly entries: LedgerEntry[];
};

function groups(ledger: LedgerResult): Group[] {
  const m = new Map<string, Group>();
  for (const e of ledger.entries) {
    const key = `${e.family}|${e.ruleVersion}|${e.variant}`;
    let g = m.get(key);
    if (g === undefined) {
      g = { family: e.family, ruleVersion: e.ruleVersion, variant: e.variant, entries: [] };
      m.set(key, g);
    }
    g.entries.push(e);
  }
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
}

/** One `replay_stat` input per (family, rule version, variant) of the ledger. Pure. */
export function pickHistoryStats(o: {
  readonly market: string;
  readonly ledger: LedgerResult;
  readonly world: PickHistoryWorld;
  readonly params: AgentParams;
  readonly runId: string;
  readonly existingSplits: readonly LineageSplitRecord[];
}): ReplayStatInput[] {
  const out: ReplayStatInput[] = [];
  const index = new Map(o.world.sessions.map((d, i) => [d, i]));
  for (const g of groups(o.ledger)) {
    const lineage = lineageId(o.market, g.family);
    const stored = newestSplit(o.existingSplits, lineage);
    const split =
      stored ??
      createLineageSplit({
        market: o.market,
        family: g.family as never,
        calendar: o.world.sessions,
        maxHoldingUpper: maxHoldingUpperBound(g.family as never),
        primaryRows: g.entries.map((e) => ({ entryD: e.row.entry_d, exitD: e.row.exit_d })),
        params: o.params.stats,
        measuredOnRun: o.runId,
      });
    const info: SplitInfo = {
      version: split.version,
      devEndD: split.dev_end_d,
      deferredUntilD: split.deferred_until_d,
      asOfD: split.data_end_d,
    };
    const dev = split.dev_end_d;
    const devRows =
      dev === null
        ? []
        : g.entries.filter(
            (e) => e.row.exit_d !== null && e.row.entry_d <= dev && e.row.exit_d <= dev,
          );
    const nets: Fraction[] = [];
    const holds: number[] = [];
    const drops: number[] = [];
    for (const e of devRows) {
      const net = netOf(e);
      if (net === null) continue;
      nets.push(net);
      const a = index.get(e.row.entry_d);
      const b = index.get(e.row.exit_d!);
      if (a !== undefined && b !== undefined && b >= a) holds.push(b - a + 1);
      if (a !== undefined) {
        const ex = computeExcursion({
          entryFillMicro: e.row.fill_in_micro,
          entryD: e.row.entry_d,
          exitD: e.row.exit_d,
          asOfD: e.row.exit_d!,
          sessions: o.world.sessions,
          bar: (d) => o.world.bar(e.code, d),
          actions: o.world.corpActions(e.code),
        });
        if (ex !== null) drops.push(Math.abs(Number(ex.maePpm))); // money-float-ok: ppm integer
      }
    }
    const sc = buildScenario(
      { split: info, nets },
      g.variant,
      g.ruleVersion,
      o.params.stats.scenarioMinN,
    );
    const good = sc.p90_ppm;
    const aimReach =
      good === null || nets.length === 0
        ? null
        : Number(
            (BigInt(nets.filter((f) => f.num * PPM >= BigInt(good) * f.den).length) * PPM) /
              BigInt(nets.length),
          ); // money-float-ok: ppm share
    const value: PickHistorySummary = {
      v: PICK_HISTORY_FORMAT,
      lineage,
      split: {
        version: split.version,
        dev_end_d: split.dev_end_d,
        deferred_until_d: split.deferred_until_d,
        data_end_d: split.data_end_d,
        stored: stored !== null,
      },
      n: sc.n,
      insufficient: sc.insufficient_history,
      reason: "reason" in sc && typeof sc.reason === "string" ? sc.reason : null,
      p10_ppm: sc.p10_ppm,
      p50_ppm: sc.p50_ppm,
      p90_ppm: sc.p90_ppm,
      hold_median: lowerMedian(holds),
      median_drop_ppm: lowerMedian(drops),
      aim_reach_ppm: aimReach,
      win_rate_ppm:
        nets.length === 0
          ? null
          : Number((BigInt(nets.filter((f) => f.num > 0n).length) * PPM) / BigInt(nets.length)), // money-float-ok: ppm share
    };
    out.push({
      scope: `${PICK_HISTORY_SCOPE}${g.family}|${g.ruleVersion}|${g.variant}`,
      metric: PICK_HISTORY_METRIC,
      value,
    });
  }
  return out;
}

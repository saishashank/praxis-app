// CXA-010 monitor 8 (M23 task M2; D-1622, D-1703): the share of gate-passing setups the fill model leaves unfilled, per
// family. A setup passed every night gate (no first failing gate) and was scored; the fill model leaves it out when its
// outcome row says `unfilled` (the one status of an entry that did not fill; `cancelled` is a pre-open cancel and an
// unsized decision, which never reached the fill model, so it is not counted either way). The alarm: the share rose by
// `residual_monitor_alarm_pp` points or more over the previous quarter, because the published figures then cover fewer
// setups than they appear to. Reads only.
import type { Client } from "@libsql/client";
import { familyBadge } from "@/lib/ui/familyBadge";
import {
  previousQuarter,
  quarterRange,
  quarterlyPeriod,
  type MonitorDef,
  type MonitorResult,
} from "./store";
import { MIN_COHORTS, alarmPp } from "./stall";

/** Fewest scored setups on a side for a share to be compared (the same floor as monitor 7, D-1703). */
export const MIN_SETUPS: number = MIN_COHORTS;
const BP = 10_000; // threshold-ok: basis points per whole
const BP_PER_PP = 100; // threshold-ok: basis points per percentage point

/** The alarm sentence for one family, plain words. */
export const fillExclusionText = (family: string): string =>
  `More ${familyBadge(family).label} setups went unfilled than last quarter: the published figures cover fewer setups than they appear to`;

export type FillCount = {
  readonly family: string;
  /** Setups the fill model scored: filled plus unfilled. */
  readonly scored: number;
  readonly unfilled: number;
};

/** Monitor 8 from plain counts of this quarter and the one before. */
export function fillExclusionMonitor(
  now: readonly FillCount[],
  before: readonly FillCount[],
  pp: number,
): MonitorResult {
  const prev = new Map(before.map((b) => [b.family, b]));
  const share = (c: FillCount): number => Math.round((c.unfilled / c.scored) * BP);
  const rows = [...now]
    .sort((a, b) => (a.family < b.family ? -1 : 1))
    .map((c) => {
      const p = prev.get(c.family);
      const enough = c.scored >= MIN_SETUPS && p !== undefined && p.scored >= MIN_SETUPS;
      const alarm = enough && share(c) - share(p) >= pp * BP_PER_PP;
      return {
        family: c.family,
        scored: c.scored,
        unfilled: c.unfilled,
        unfilled_share: c.scored === 0 ? null : share(c) / BP,
        previous_scored: p?.scored ?? null,
        previous_share: p === undefined || p.scored === 0 ? null : share(p) / BP,
        alarm,
      };
    });
  const items = rows.filter((r) => r.alarm).map((r) => fillExclusionText(r.family));
  return {
    value: { alarm_pp: pp, min_setups: MIN_SETUPS, families: rows },
    alarm: items.length > 0,
    ownerItems: items,
  };
}

/** Gate-passing scored setups per family in a quarter and how many were left unfilled (distinct day and code). */
export async function loadFillCounts(
  db: Client,
  market: string,
  quarter: string,
): Promise<FillCount[]> {
  const { from, to } = quarterRange(quarter);
  // rows-ok: one grouped read of the quarter's gate-passing decisions joined to their outcome (primary key); one row a family
  const r = await db.execute({
    sql: `SELECT c.family AS family, COUNT(DISTINCT c.d || '|' || c.code) AS scored,
                 COUNT(DISTINCT CASE WHEN o.fill_status = 'unfilled' THEN c.d || '|' || c.code END) AS unfilled
          FROM cortex_decision c
          JOIN cortex_outcome o ON o.market = c.market AND o.d = c.d AND o.book_id = c.book_id
            AND o.code = c.code AND o.arm = c.arm
          WHERE c.market = ? AND c.d >= ? AND c.d <= ? AND c.first_fail_gate IS NULL
            AND o.fill_status IN ('filled', 'unfilled')
          GROUP BY c.family ORDER BY c.family LIMIT 20`,
    args: [market, from, to],
  });
  return r.rows.map((x) => ({
    family: String(x.family),
    scored: Number(x.scored),
    unfilled: Number(x.unfilled),
  }));
}

export const fillExclusionDef: MonitorDef = {
  monitor: 8,
  period: quarterlyPeriod,
  async compute(db, market, period) {
    const now = await loadFillCounts(db, market, period);
    const before = await loadFillCounts(db, market, previousQuarter(quarterRange(period).from));
    return fillExclusionMonitor(now, before, await alarmPp(db));
  },
};

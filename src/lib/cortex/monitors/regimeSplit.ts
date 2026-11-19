// CXA-010 monitor 5 (M23 task M2; D-1619, D-1700): per family, the share of the quarter's setups by regime. A family
// whose setups sit 90 % or more in one regime has not been tested in the others, so the label "one regime only" shows
// beside it. No alarm and no Owner item: it is a label. The regime is the first word of the G09 value in the stored gate
// trace (the same reading as `look.ts`). One grouped read over `cortex_decision`; writes nothing but its own row.
import type { Client } from "@libsql/client";
import { GATE_DEFAULTS } from "../statusRules.mjs";
import { quarterRange, quarterlyPeriod, r4, type MonitorDef, type MonitorResult } from "./store";

/** One regime holding at least this share of a family's setups earns the label (D-1619 [PROPOSED]); compared as 9 / 10. */
export const ONE_REGIME_SHARE = 0.9; // threshold-ok: D-1619 proposed share
/** Below this many setups in the quarter no label is given (the per-regime floor of the economic gate, D-1700). */
export const MIN_SETUPS: number = GATE_DEFAULTS.regimeMinSetups;
/** The label text (plain words). */
export const ONE_REGIME_LABEL = "one regime only";

export type RegimeCount = {
  readonly family: string;
  readonly regime: string;
  readonly setups: number;
};

/** Monitor 5 from plain counts. Shares are compared as whole counts (no float edge at exactly 90 %). */
export function regimeSplitMonitor(counts: readonly RegimeCount[]): MonitorResult {
  const byFamily = new Map<string, RegimeCount[]>();
  for (const c of counts)
    (byFamily.get(c.family) ?? byFamily.set(c.family, []).get(c.family)!).push(c);
  const families = [...byFamily]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([family, list]) => {
      const sorted = [...list].sort(
        (a, b) => b.setups - a.setups || (a.regime < b.regime ? -1 : 1),
      );
      const total = sorted.reduce((s, c) => s + c.setups, 0);
      const top = sorted[0]!;
      // top / total >= 0.9  <=>  top * 10 >= total * 9
      const oneRegime = total >= MIN_SETUPS && top.setups * 10 >= total * 9; // threshold-ok: 0.9 as 9 / 10 in whole counts
      return {
        family,
        setups: total,
        top_regime: top.regime,
        top_share: total === 0 ? 0 : r4(top.setups / total),
        regimes: sorted.map((c) => ({ regime: c.regime, setups: c.setups })),
        one_regime_only: oneRegime,
      };
    });
  return {
    value: { min_setups: MIN_SETUPS, label: ONE_REGIME_LABEL, families },
    alarm: false,
    ownerItems: [],
  };
}

/** Distinct setups (day and code) per family and regime in the quarter, from the stored gate trace. */
export async function loadRegimeCounts(
  db: Client,
  market: string,
  period: string,
): Promise<RegimeCount[]> {
  const { from, to } = quarterRange(period);
  // rows-ok: one grouped read of the quarter's decisions (covered by idx_cortex_decision_family); at most families x regimes rows
  const r = await db.execute({
    sql: `SELECT c.family AS family,
                 COALESCE(NULLIF(substr(json_extract(j.value, '$.value'), 1,
                   instr(json_extract(j.value, '$.value') || ':', ':') - 1), ''), 'unknown') AS regime,
                 COUNT(DISTINCT c.d || '|' || c.code) AS setups
          FROM cortex_decision c, json_each(c.gate_trace_json) j
          WHERE c.market = ? AND c.d >= ? AND c.d <= ? AND json_extract(j.value, '$.gateId') = 'G09_regime'
          GROUP BY c.family, regime ORDER BY c.family, regime LIMIT 200`,
    args: [market, from, to],
  });
  return r.rows.map((x) => ({
    family: String(x.family),
    regime: String(x.regime),
    setups: Number(x.setups),
  }));
}

export const regimeSplitDef: MonitorDef = {
  monitor: 5,
  period: quarterlyPeriod,
  async compute(db, market, period) {
    return regimeSplitMonitor(await loadRegimeCounts(db, market, period));
  },
};

// CXA-010 monitor 7 (M23 task M2; D-1621, D-1702): the realised stall rate per family against the expected one. A cohort
// stalls when its terminal state is "stalled" (arena/terminal.ts); a family's rate is the share of the cohorts that closed
// in the quarter and took a sized entry of that family (live or shadow arm). The expected rate is the one calibration
// stored (`expected_stall_rate` in the family's latest status evidence) and, where calibration stored none (checked at M2
// start: none does), the shadow arm's rate over the four quarters before, labelled "shadow, previous four quarters". The
// Owner item fires when realised minus expected is `residual_monitor_alarm_pp` points or more. Reads only.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import type { ConfigKey } from "@/lib/config/keys";
import { familyBadge } from "@/lib/ui/familyBadge";
import { GATE_DEFAULTS } from "../statusRules.mjs";
import {
  quarterRange,
  quarterlyPeriod,
  type MonitorDef,
  type MonitorResult,
  previousQuarter,
} from "./store";

/** The key's fixed value, used when the store cannot be read (CXA-010: 5 points, fixed). */
export const ALARM_PP_DEFAULT = 5; // threshold-ok: residual_monitor_alarm_pp default, a fixed key
/** Fewest cohorts on a side for a rate to be compared (the cell floor of the economic gate, D-1702). */
export const MIN_COHORTS: number = GATE_DEFAULTS.cellMinBlocks;
/** Quarters of shadow history behind the fallback expected rate (D-1621). */
export const EXPECTED_QUARTERS = 4; // threshold-ok: D-1621 four quarters
/** Basis points in one whole (rates are compared as whole basis points, so "exactly 5 points" is exact). */
const BP = 10_000; // threshold-ok: basis points per whole
/** Basis points in one percentage point. */
const BP_PER_PP = 100; // threshold-ok: basis points per percentage point

export const EXPECTED_CALIBRATION = "calibration";
export const EXPECTED_FALLBACK = "shadow, previous four quarters";

/** The alarm sentence for one family (D-1621), plain words. */
export const stallText = (family: string): string =>
  `Trades are stalling more than expected for ${familyBadge(family).label}: the parcel rule may need a review`;

export type StallCount = {
  readonly family: string;
  readonly cohorts: number;
  readonly stalled: number;
};
export type ExpectedRate = {
  readonly family: string;
  /** Stalled cohorts over cohorts, as a fraction. */
  readonly rate: number;
  /** Cohorts behind it (0 when stored by calibration without a count). */
  readonly cohorts: number;
  readonly source: typeof EXPECTED_CALIBRATION | typeof EXPECTED_FALLBACK;
};

/** The alarm line in percentage points, from the configuration store. */
export async function alarmPp(db: Pick<Client, "execute">): Promise<number> {
  try {
    const v = await getConfig(db, "residual_monitor_alarm_pp" as ConfigKey);
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) return v;
  } catch {
    // unreadable: the fixed default below
  }
  return ALARM_PP_DEFAULT;
}

const toBp = (x: number): number => Math.round(x * BP);

/** Monitor 7 from plain rows. */
export function stallMonitor(
  realised: readonly StallCount[],
  expected: readonly ExpectedRate[],
  pp: number,
): MonitorResult {
  const exp = new Map(expected.map((e) => [e.family, e]));
  const rows = [...realised]
    .sort((a, b) => (a.family < b.family ? -1 : 1))
    .map((r) => {
      const e = exp.get(r.family);
      const rate = r.cohorts === 0 ? null : r.stalled / r.cohorts;
      const enough =
        rate !== null &&
        r.cohorts >= MIN_COHORTS &&
        e !== undefined &&
        (e.source === EXPECTED_CALIBRATION || e.cohorts >= MIN_COHORTS);
      const alarm = enough && toBp(rate) - toBp(e.rate) >= pp * BP_PER_PP;
      return {
        family: r.family,
        cohorts: r.cohorts,
        stalled: r.stalled,
        realised_rate: rate === null ? null : toBp(rate) / BP,
        expected_rate: e === undefined ? null : toBp(e.rate) / BP,
        expected_cohorts: e?.cohorts ?? null,
        expected_source: e?.source ?? null,
        alarm,
      };
    });
  const items = rows.filter((r) => r.alarm).map((r) => stallText(r.family));
  return {
    value: { alarm_pp: pp, min_cohorts: MIN_COHORTS, families: rows },
    alarm: items.length > 0,
    ownerItems: items,
  };
}

/** Cohorts that closed in `[from, to]` and took a sized entry, per family; `arm` limits the arm (null: both). */
export async function loadStallCounts(
  db: Client,
  market: string,
  from: string,
  to: string,
  arm: "shadow" | null,
): Promise<StallCount[]> {
  // rows-ok: one grouped read of cohorts that closed in the window, joined on the cohort id; at most one row a family
  const r = await db.execute({
    sql: `SELECT c.family AS family, COUNT(DISTINCT co.id) AS cohorts,
                 COUNT(DISTINCT CASE WHEN co.terminal_kind = 'stalled' THEN co.id END) AS stalled
          FROM cortex_decision c JOIN cohort co ON co.id = c.book_id
          WHERE c.market = ? AND c.qty > 0 AND co.terminal_d >= ? AND co.terminal_d <= ?
            AND (? IS NULL OR c.arm = ?)
          GROUP BY c.family ORDER BY c.family LIMIT 20`,
    args: [market, from, to, arm, arm],
  });
  return r.rows.map((x) => ({
    family: String(x.family),
    cohorts: Number(x.cohorts),
    stalled: Number(x.stalled),
  }));
}

/** The expected rate calibration stored, per family, as of the end of the quarter (none is stored today). */
async function loadCalibrated(db: Client, market: string, to: string): Promise<ExpectedRate[]> {
  // rows-ok: family status history up to the quarter end (a row per change); newest first, capped at 200
  const r = await db.execute({
    sql: `SELECT family, evidence_json FROM family_status WHERE market = ? AND since_d <= ?
          ORDER BY since_d DESC LIMIT 200`,
    args: [market, to],
  });
  const seen = new Set<string>();
  const out: ExpectedRate[] = [];
  for (const row of r.rows) {
    const family = String(row.family);
    if (seen.has(family)) continue;
    seen.add(family);
    try {
      const v = (JSON.parse(String(row.evidence_json)) as Record<string, unknown>)
        .expected_stall_rate;
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1) {
        out.push({ family, rate: v, cohorts: 0, source: EXPECTED_CALIBRATION });
      }
    } catch {
      // unreadable evidence: nothing stored for this family
    }
  }
  return out;
}

/** The first night-quarter label `n` quarters before `q`. */
function quartersBefore(q: string, n: number): string {
  let cur = q;
  for (let i = 0; i < n; i += 1) {
    const { from } = quarterRange(cur);
    cur = previousQuarter(from);
  }
  return cur;
}

export const stallDef: MonitorDef = {
  monitor: 7,
  period: quarterlyPeriod,
  async compute(db, market, period) {
    const { from, to } = quarterRange(period);
    const realised = await loadStallCounts(db, market, from, to, null);
    const calibrated = await loadCalibrated(db, market, to);
    const have = new Set(calibrated.map((e) => e.family));
    const histFrom = quarterRange(quartersBefore(period, EXPECTED_QUARTERS)).from;
    const histTo = quarterRange(previousQuarter(from)).to;
    const hist = await loadStallCounts(db, market, histFrom, histTo, "shadow");
    const fallback: ExpectedRate[] = hist
      .filter((h) => !have.has(h.family) && h.cohorts > 0)
      .map((h) => ({
        family: h.family,
        rate: h.stalled / h.cohorts,
        cohorts: h.cohorts,
        source: EXPECTED_FALLBACK,
      }));
    return stallMonitor(realised, [...calibrated, ...fallback], await alarmPp(db));
  },
};

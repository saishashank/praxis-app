// CXA-010 monitor 2 (M23 task M1; D-1616): the permission rule's operating point. Once per market at calibration, for each
// family whose stored evidence carries an effective sample and a minimum detectable effect: 2,000 seeded simulated
// families under a null edge and 2,000 under a planted edge equal to that minimum detectable effect, each run through the
// real `decideFamily` with `GATE_DEFAULTS`. The published figures are the false-pass rate and the true-pass rate. This is a
// property of the rule, not of live data: no alarm. Simulation: a family's mean edge statistic is drawn normal around the
// edge with the standard error implied by its sample size, and its estimated standard error is drawn around the true one
// (normal approximation, chi-square scale); the bound is mean minus the one-sided 90 % quantile times that estimate.
// Pure given the seed; reads only `family_status` and `cortex_map`.
import type { Client } from "@libsql/client";
import { normalQuantile } from "@/lib/stats/normal";
import { mdeRows, PERMISSION_LEVEL } from "@/lib/stats/nulls";
import { scopedPrng, uniform01, type Prng } from "@/lib/stats/rng";
import { DEFAULT_MIN_NEFF_TRADE, GATE_DEFAULTS, decideFamily } from "../statusRules.mjs";
import { r4, type MonitorDef, type MonitorResult } from "./store";

/** Simulated families per condition (D-1616). */
export const SIMULATED_FAMILIES = 2000; // threshold-ok: D-1616 simulated families
/** The most families one row can carry inside the 4,000-character value limit. */
const FAMILY_ROWS_MAX = 7; // threshold-ok: F1 to F7

export type PermissionFamily = {
  readonly family: string;
  /** Effective sample size of the family's latest evaluation. */
  readonly nEff: number;
  /** Minimum detectable effect of that evaluation (the Brier-skill scale it was measured on). */
  readonly mde: number;
  /** The trade floor on n_eff the evaluation used; the default when it was not stored. */
  readonly minNEff?: number;
};

const TWO_PI = 2 * Math.PI;

/** One standard normal draw (Box-Muller); consumes two uniforms so the stream stays aligned. */
function normalDraw(rng: Prng): number {
  const u = Math.max(uniform01(rng), Number.MIN_VALUE);
  const v = uniform01(rng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
}

/** The factor of the minimum detectable effect: mde = factor x se (level and power of the permission test). */
export function mdeFactor(): number {
  return mdeRows(1, { nEffs: [1] })[0]!.mde;
}

/** Share of simulated families that `decideFamily` allows when the true edge is `edge`. Seeded. */
export function passRate(
  f: PermissionFamily,
  edge: number,
  scope: string,
  sims: number = SIMULATED_FAMILIES,
): number {
  if (!(f.nEff > 0) || !(f.mde > 0)) return 0;
  const se = f.mde / mdeFactor();
  const z = normalQuantile(1 - PERMISSION_LEVEL);
  const rng = scopedPrng(scope);
  const n = Math.max(1, Math.round(f.nEff));
  let passes = 0;
  for (let i = 0; i < sims; i += 1) {
    const mean = edge + se * normalDraw(rng);
    const seHat = Math.max(0, se * (1 + normalDraw(rng) / Math.sqrt(2 * Math.max(1, n - 1))));
    const lower = mean - z * seHat;
    const decision = decideFamily({
      family: f.family,
      nEff: f.nEff,
      minNEff: f.minNEff ?? DEFAULT_MIN_NEFF_TRADE,
      brierLo90: lower,
      slopeUb90: null,
      cell: {
        n: Math.max(n, GATE_DEFAULTS.cellMinSetups),
        blocks: GATE_DEFAULTS.cellMinBlocks,
        nEff: f.nEff,
        lower90: lower,
        byRegime: { calm: { n: GATE_DEFAULTS.regimeMinSetups, meanNet: mean } },
      },
      gateOpts: GATE_DEFAULTS,
    });
    if (decision.allowed) passes += 1;
  }
  return passes / sims;
}

/** Monitor 2 from plain rows: one entry per family. No alarm (D-1616). */
export function permissionMonitor(
  families: readonly PermissionFamily[],
  scope: string,
  sims: number = SIMULATED_FAMILIES,
): MonitorResult {
  const rows = [...families]
    .sort((a, b) => (a.family < b.family ? -1 : 1))
    .slice(0, FAMILY_ROWS_MAX)
    .map((f) => ({
      family: f.family,
      n_eff: r4(f.nEff),
      mde: r4(f.mde),
      false_pass: r4(passRate(f, 0, `${scope}:${f.family}:null`, sims)),
      true_pass: r4(passRate(f, f.mde, `${scope}:${f.family}:edge`, sims)),
    }));
  return { value: { simulated: sims, families: rows }, alarm: false, ownerItems: [] };
}

/** The calibration the monitor belongs to: the day of the newest fitted map of the market (null when none yet). */
export async function calibrationPeriod(db: Client, market: string): Promise<string | null> {
  // rows-ok: one aggregate over the market's calibration maps (index on the primary key); one row
  const r = await db.execute({
    sql: "SELECT MAX(fitted_at) AS v FROM cortex_map WHERE market = ?",
    args: [market],
  });
  const v = r.rows[0]?.v;
  return v === null || v === undefined ? null : `cal-${String(v).slice(0, 10)}`; // threshold-ok: date part
}

/** The latest stored evaluation of each family that has a sample size and a minimum detectable effect. */
export async function loadPermissionFamilies(
  db: Client,
  market: string,
): Promise<PermissionFamily[]> {
  // rows-ok: family status history of one market (a row per change); newest first, capped at 200
  const r = await db.execute({
    sql: `SELECT family, evidence_json FROM family_status WHERE market = ?
          ORDER BY since_d DESC LIMIT 200`,
    args: [market],
  });
  const seen = new Set<string>();
  const out: PermissionFamily[] = [];
  for (const row of r.rows) {
    const family = String(row.family);
    if (seen.has(family)) continue;
    seen.add(family);
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(String(row.evidence_json)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const nEff = ev.n_eff;
    const mde = ev.mde;
    if (typeof nEff !== "number" || typeof mde !== "number") continue;
    const min = ev.min_neff_trade;
    out.push({
      family,
      nEff,
      mde,
      ...(typeof min === "number" ? { minNEff: min } : {}),
    });
  }
  return out;
}

export const permissionDef: MonitorDef = {
  monitor: 2,
  period: async (db, market) => calibrationPeriod(db, market),
  async compute(db, market, period) {
    return permissionMonitor(
      await loadPermissionFamilies(db, market),
      `monitor2:${market}:${period}`,
    );
  },
};

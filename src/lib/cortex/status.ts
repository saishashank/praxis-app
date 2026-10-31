// CTX-053 family-status evaluator (M15 P6; CTX-072, D-280, D-300, D-305). A family becomes `allowed`
// ONLY through `recordFamilyStatus` here (CTX-072: no manual leaving of shadow; a test greps for other
// writers). Rules are the plain functions of statusRules.mjs (shared with the Owner-run import); this
// file feeds them from the C2 statistics and writes the `family_status` history rows.
import {
  brierSkillCi,
  brierSkillInfluence,
  calibrationSlopeCi,
  slopeHidden,
} from "@/lib/stats/calibration";
import type { CellStatistic } from "@/lib/stats/cells";
import { mdeRows } from "@/lib/stats/nulls";
import type { Prng } from "@/lib/stats/rng";
import {
  isUndefined,
  type BlockLayout,
  type BootstrapOptions,
} from "@/lib/stats/stationaryBootstrap";
import { allowedWeakRow } from "./statements";
import {
  familyStatusMap,
  getStatement,
  insertFamilyStatus,
  insertStatement,
  type BatchExec,
  type CortexFamily,
  type FamilyStatusRow,
} from "./store";
import {
  capAngleStatus,
  decideFamily,
  type FamilyDecision,
  type PooledCell,
} from "./statusRules.mjs";

export { capAngleStatus, decideFamily, type FamilyDecision };
export { A_D5_08_MIN_LIVE_SESSIONS, DEFAULT_MIN_NEFF_TRADE } from "./statusRules.mjs";

const sdOf = (v: ArrayLike<number>): number => {
  const n = v.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i += 1) m += v[i]!;
  m /= n;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (v[i]! - m) ** 2;
  return Math.sqrt(ss / (n - 1));
};

export type FamilySamples = {
  family: CortexFamily;
  /** Out-of-fold probabilities and outcomes (development data plus live shadow sessions). */
  p: readonly number[];
  y: readonly (0 | 1)[];
  layout: BlockLayout;
  /** The pre-registered pooled top-3 cell statistic. */
  cell: CellStatistic | null;
  prng: Prng;
  minNEff?: number;
  hideUb?: number;
  bootstrap?: BootstrapOptions;
};

/** The plain-number view of a cell statistic (NaN bound becomes null) that the shared rules read. */
export const pooledCellOf = (c: CellStatistic | null): PooledCell | null =>
  c === null
    ? null
    : {
        n: c.n,
        blocks: c.blocks,
        nEff: c.nEff ?? null,
        lower90: Number.isFinite(c.lower90) ? c.lower90 : null,
        byRegime: c.byRegime,
      };

/**
 * The CTX-053 verdict from samples: Brier skill (one-sided 90 % lower bound), the slope monitor and the
 * pooled-cell gate with regime stability. The evidence carries `{n_eff, mde, ...}` for the page (D-357).
 */
export function evaluateFamily(s: FamilySamples): FamilyDecision {
  const brier = brierSkillCi(s.p, s.y, s.layout, s.prng, s.bootstrap);
  const slope = calibrationSlopeCi(s.p, s.y, s.layout, s.prng, {
    ...s.bootstrap,
    ...(s.hideUb === undefined ? {} : { hideUb: s.hideUb }),
  });
  const nEff = isUndefined(brier) ? null : (brier.nEff ?? null);
  const decision = decideFamily({
    family: s.family,
    nEff,
    ...(s.minNEff === undefined ? {} : { minNEff: s.minNEff }),
    brierLo90: isUndefined(brier) ? null : brier.oneSidedLo,
    slopeUb90: isUndefined(slope) ? null : slope.slope.oneSidedHi,
    cell: pooledCellOf(s.cell),
    ...(s.hideUb === undefined ? {} : { hideUb: s.hideUb }),
  });
  const sd = sdOf(brierSkillInfluence(s.p, s.y));
  const own = nEff === null ? null : mdeRows(sd, { nEffs: [nEff] });
  const hidden = slopeHidden(slope);
  return {
    ...decision,
    pHidden: hidden,
    evidence: {
      ...decision.evidence,
      p_hidden: hidden,
      mde: own === null ? null : own[0]!.mde,
      mde_rows: mdeRows(sd),
    },
  };
}

export type RecordResult =
  | { written: false; reason: "suspended" | "unchanged" | "exists" }
  | { written: true; status: "allowed" | "shadow"; statementId: string | null };

/**
 * Appends the family's new status as of `sinceD` (the only writer that may say `allowed`). An Owner
 * kill (`suspended`) is left alone; an unchanged status writes nothing; an allowed family gets its
 * CTX-053 statement ("live-tested pending") in the same pass.
 */
export async function recordFamilyStatus(
  db: BatchExec,
  a: {
    market: string;
    family: CortexFamily;
    sinceD: string;
    decision: FamilyDecision;
    createdAt: string;
    nEffLivePerSession: number | null;
  },
): Promise<RecordResult> {
  const exists = await db.execute({
    sql: "SELECT since_d FROM family_status WHERE market = ? AND family = ?",
    args: [a.market, a.family],
  });
  if (exists.rows.some((r) => String(r.since_d) === a.sinceD))
    return { written: false, reason: "exists" };
  const current = (await familyStatusMap(db, a.market, a.sinceD))[a.family];
  if (current === "suspended") return { written: false, reason: "suspended" };
  const status = a.decision.status;
  if (exists.rows.length > 0 && status === current) return { written: false, reason: "unchanged" };
  let statementId: string | null = null;
  if (status === "allowed") {
    const row = allowedWeakRow({
      market: a.market,
      family: a.family,
      createdAt: a.createdAt,
      nEffLivePerSession: a.nEffLivePerSession,
    });
    if ((await getStatement(db, row.statementId)) === null) await insertStatement(db, row);
    statementId = row.statementId;
  }
  const rec: FamilyStatusRow = {
    market: a.market,
    family: a.family,
    sinceD: a.sinceD,
    status,
    evidence: a.decision.evidence,
    statementId,
    setBy: "evaluator",
  };
  await insertFamilyStatus(db, rec);
  return { written: true, status, statementId };
}

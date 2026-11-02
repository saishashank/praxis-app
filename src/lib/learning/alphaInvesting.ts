// Alpha-investing pools for the L2 lesson test (M6 T4; ARN-063 `l2_alpha_investing`; design 2.4;
// D-110 #14 and #43; D-111 `alpha_wealth` chaining; D-117 proposed).
//
// Foster-Stine alpha-investing, one pool per lineage (`<market>:<family>`) and one market pool
// (`<market>:*`). Wealth starts at W0 (`l2_alpha_w0`) and is NEVER reset: it carries across windows and
// rolls. Test j runs at level alpha_j = f x W (VAL-116, D-231: f = `l2_alpha_spend_fraction`, 0.1; M14
// replaced the earlier W / (2 + W)) and rejects when p <= alpha_j. Update:
//   rejection      W <- W + payout (`l2_alpha_payout`)
//   non-rejection  W <- W - alpha_j / (1 - alpha_j)
// W never goes below 0. The pool is exhausted when the NEXT level is below `l2_alpha_exhausted_level`
// (0.005): no further L2 test ("alpha-wealth exhausted"). The ledger
// `alpha_wealth` is append-only; the next test reads the last row of its pool and the DB trigger
// requires `w_before` to equal the previous `w_after` exactly, so this module always continues from
// the stored REAL value and never recomputes it.
import type { Client } from "@libsql/client";
import type { AgentParams } from "../agents/params";
import { LessonError } from "./windows";

type Exec = Pick<Client, "execute">;

/** The pool of a lineage lesson (`AU:F1`) or of a market-scope lesson (`AU:*`). */
export function poolId(market: string, family: string | null): string {
  return `${market}:${family ?? "*"}`;
}

/** VAL-116 default share of the pool spent on one test (`l2_alpha_spend_fraction`). */
export const DEFAULT_SPEND_FRACTION = 0.1; // threshold-ok: l2_alpha_spend_fraction default (VAL-116)
/** VAL-116 default exhaustion level (`l2_alpha_exhausted_level`). */
export const DEFAULT_EXHAUSTED_LEVEL = 0.005; // threshold-ok: l2_alpha_exhausted_level default (VAL-116)

/** alpha_j = f x W (VAL-116): a fixed share of the current wealth. */
export function alphaLevel(wealth: number, spendFraction: number = DEFAULT_SPEND_FRACTION): number {
  return spendFraction * wealth;
}

/** The pool is exhausted when the next test's level would be below `exhaustedLevel` (VAL-116). */
export function poolExhausted(
  wealth: number,
  spendFraction: number = DEFAULT_SPEND_FRACTION,
  exhaustedLevel: number = DEFAULT_EXHAUSTED_LEVEL,
): boolean {
  return !(wealth > 0) || alphaLevel(wealth, spendFraction) < exhaustedLevel;
}

export type AlphaStep = {
  readonly wBefore: number;
  readonly alphaJ: number;
  readonly p: number;
  readonly rejected: boolean;
  readonly wAfter: number;
};

/** One test of the sequence: the level, the decision and the new wealth (pure). */
export function alphaStep(
  wealth: number,
  p: number,
  payout: number,
  spendFraction: number = DEFAULT_SPEND_FRACTION,
  exhaustedLevel: number = DEFAULT_EXHAUSTED_LEVEL,
): AlphaStep {
  if (poolExhausted(wealth, spendFraction, exhaustedLevel)) {
    throw new LessonError("alpha_exhausted", "alpha-wealth is exhausted");
  }
  if (!(p >= 0 && p <= 1)) throw new RangeError("p must be in [0, 1]");
  const alphaJ = alphaLevel(wealth, spendFraction);
  const rejected = p <= alphaJ;
  const wAfter = rejected ? wealth + payout : Math.max(0, wealth - alphaJ / (1 - alphaJ));
  return { wBefore: wealth, alphaJ, p, rejected, wAfter };
}

/** The wealth sequence of a list of p-values from W0 (pure; tests and the hand table). */
export function alphaSequence(
  w0: number,
  ps: readonly number[],
  payout: number,
  spendFraction: number = DEFAULT_SPEND_FRACTION,
  exhaustedLevel: number = DEFAULT_EXHAUSTED_LEVEL,
): AlphaStep[] {
  const out: AlphaStep[] = [];
  let w = w0;
  for (const p of ps) {
    if (poolExhausted(w, spendFraction, exhaustedLevel)) break;
    const s = alphaStep(w, p, payout, spendFraction, exhaustedLevel);
    out.push(s);
    w = s.wAfter;
  }
  return out;
}

// ---- ledger ----------------------------------------------------------------------------------------------

export type PoolState = {
  /** Sequence number of the last row (0 when the pool has no test yet). */
  readonly seq: number;
  /** Wealth available for the next test: the last `w_after`, else W0. */
  readonly wealth: number;
  /** VAL-116: the next level would be below `l2_alpha_exhausted_level`; no test may run. */
  readonly exhausted: boolean;
};

export async function readPoolState(
  tx: Exec,
  pool: string,
  params: AgentParams,
): Promise<PoolState> {
  const r = await tx.execute({
    sql: "SELECT seq, w_after FROM alpha_wealth WHERE pool = ? ORDER BY seq DESC LIMIT 1",
    args: [pool],
  });
  const seq = r.rows.length === 0 ? 0 : Number(r.rows[0]!.seq);
  const wealth = r.rows.length === 0 ? params.learning.l2AlphaW0 : Number(r.rows[0]!.w_after);
  return {
    seq,
    wealth,
    exhausted: poolExhausted(
      wealth,
      params.learning.l2AlphaSpendFraction,
      params.learning.l2AlphaExhaustedLevel,
    ),
  };
}

export type AlphaTestRow = {
  readonly pool: string;
  readonly seq: number;
  readonly lesson_id: string;
  readonly window_key: string;
  readonly w_before: number;
  readonly alpha_j: number;
  readonly p: number;
  readonly rejected: boolean;
  readonly w_after: number;
  readonly run_id: string;
};

function rowOf(r: Record<string, unknown>): AlphaTestRow {
  return {
    pool: String(r.pool),
    seq: Number(r.seq),
    lesson_id: String(r.lesson_id),
    window_key: String(r.window_key),
    w_before: Number(r.w_before),
    alpha_j: Number(r.alpha_j),
    p: Number(r.p),
    rejected: Number(r.rejected) === 1,
    w_after: Number(r.w_after),
    run_id: String(r.run_id),
  };
}

export type AlphaTestOutcome =
  | { readonly kind: "exhausted"; readonly wealth: number }
  | { readonly kind: "existing"; readonly row: AlphaTestRow }
  | { readonly kind: "tested"; readonly row: AlphaTestRow };

/**
 * Run (or find) the one L2 test of `lessonId` on `windowKey` in `pool`. A stored test is returned as is
 * (a lesson is tested at most once per L2 window); a recomputed p that differs from the stored one RAISES.
 * Otherwise, if the pool still has wealth, one row is appended continuing the pool exactly.
 * The lesson row must already exist (the trigger requires it); call before the lesson's grade row.
 */
export async function recordAlphaTest(
  tx: Exec,
  t: {
    readonly pool: string;
    readonly lessonId: string;
    readonly windowKey: string;
    readonly p: number;
    readonly runId: string;
    readonly params: AgentParams;
  },
): Promise<AlphaTestOutcome> {
  const prior = await tx.execute({
    sql: "SELECT * FROM alpha_wealth WHERE lesson_id = ? AND window_key = ?",
    args: [t.lessonId, t.windowKey],
  });
  if (prior.rows.length > 0) {
    const row = rowOf(prior.rows[0]!);
    if (row.p !== t.p) {
      throw new LessonError(
        "alpha_conflict",
        `alpha test of ${t.lessonId} on ${t.windowKey}: stored p ${row.p} differs from ${t.p}`,
      );
    }
    return { kind: "existing", row };
  }
  const state = await readPoolState(tx, t.pool, t.params);
  if (state.exhausted) return { kind: "exhausted", wealth: state.wealth };
  const step = alphaStep(
    state.wealth,
    t.p,
    t.params.learning.l2AlphaPayout,
    t.params.learning.l2AlphaSpendFraction,
    t.params.learning.l2AlphaExhaustedLevel,
  );
  const row: AlphaTestRow = {
    pool: t.pool,
    seq: state.seq + 1,
    lesson_id: t.lessonId,
    window_key: t.windowKey,
    w_before: step.wBefore,
    alpha_j: step.alphaJ,
    p: step.p,
    rejected: step.rejected,
    w_after: step.wAfter,
    run_id: t.runId,
  };
  await tx.execute({
    sql: `INSERT INTO alpha_wealth (pool, seq, lesson_id, window_key, w_before, alpha_j, p, rejected,
            w_after, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.pool,
      row.seq,
      row.lesson_id,
      row.window_key,
      row.w_before,
      row.alpha_j,
      row.p,
      row.rejected ? 1 : 0,
      row.w_after,
      row.run_id,
    ],
  });
  return { kind: "tested", row };
}

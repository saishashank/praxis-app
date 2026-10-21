// A7 Critic: the six deterministic checks of AGT-041 for lessons >= L1 and for challengers, the
// `critique` rows, and the challenger review that sets `ready` (M6 T6; AGT-041/042, KB-040 review;
// D-110 #15-#17, #41, D-119). Pure checks first, then the writer.
//
//   1 sample size   2 regime dependence   3 stress costs   4 data issues   5 luck   6 bounds
//
// Every number comes from AgentParams (`criticParams`). The Critic only reads rows it is given
// (development rows for a lesson, the VAL-110 (i) rows of the same access for a challenger); it
// never loads validation or holdout data itself, and the wording module (criticWords.ts) never
// changes a state: concerns are shown, never block (AGT-042).
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { Rational } from "@/lib/money/rational";
import { canonicalJson } from "@/lib/llm/providers";
import { ratToNumber, type CheckState as Val110State } from "@/lib/stats/val110";
import {
  CRITIC_CHECK_COUNT,
  reviewChallenger,
  type CriticState,
  type ReviewVerdict,
} from "./challengerLifecycle";

export type { CriticState };

export const CRITIC_CHECK_NAMES = [
  "sample size",
  "regime dependence",
  "stress costs",
  "data issues",
  "luck",
  "bounds",
] as const;

// Check numbers of AGT-041 (1 and 2 are structural literals).
const CHECK_STRESS = 3; // threshold-ok: check number
const CHECK_DATA = 4; // threshold-ok: check number
const CHECK_LUCK = 5; // threshold-ok: check number
const CHECK_BOUNDS = 6; // threshold-ok: check number

/** Display precision of the numbers a check reports (stored in `critique.checks_json`). */
const DECIMALS = 4; // threshold-ok: display rounding of stored check values, not a rule

const round = (x: number): number => Number(x.toFixed(DECIMALS));

export type CriticParams = {
  /** ARN-082 minimum rows of a challenger (min_trades). */
  readonly minRows: number;
  /** Minimum blocks (min_blocks). */
  readonly minBlocks: number;
  /** Minimum rows of a lesson (lesson_L1_min_n); also the rows a regime needs to count. */
  readonly lessonMinRows: number;
  /** Largest share of flagged rows (survivorship_flag_share). */
  readonly flagShare: Rational;
};

export function criticParams(p: AgentParams): CriticParams {
  return {
    minRows: p.stats.minTrades,
    minBlocks: p.stats.minBlocks,
    lessonMinRows: p.learning.lessonL1MinN,
    flagShare: p.stats.survivorshipFlagShare,
  };
}

export type CriticRow = {
  readonly id: string;
  /** Entry-date regime label; null = unknown (not counted in check 2). */
  readonly regime: string | null;
  /** The row's metric (challenger: excess over the incumbent/controls; lesson: its metric). */
  readonly value: number | null;
  /** The same metric under P3 + stress slippage (lesson, negative direction). */
  readonly stressValue: number | null;
  /** Absolute net under P3 + stress slippage (lesson, positive direction). */
  readonly stressNet: number | null;
  /** A quality flag: quality-suspect, stale-data, first-seen difference, survivorship-exposed. */
  readonly flagged: boolean;
  readonly entryD: string;
  /** Date the outcome was observed; null = still open. */
  readonly outcomeD: string | null;
};

export type ParamBound = {
  readonly key: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
};

export type AuditWindow = {
  readonly startD: string;
  readonly endD: string;
  /** Test date: every outcome must be observed before it. */
  readonly testD: string;
};

export type ChallengerSubject = {
  readonly kind: "challenger";
  readonly id: string;
  readonly rows: readonly CriticRow[];
  readonly blocks: number;
  readonly effectiveN?: number;
  /** VAL-110 (i) and (iv) states of the same access. */
  readonly val110: { readonly i: Val110State; readonly iv: Val110State };
  /** M4 survivorship qualifier: true = the tested events are survivorship-exposed. */
  readonly survivorshipExposed?: boolean;
  readonly window: AuditWindow;
  /** Every parameter of the version with its ch.15 bounds. */
  readonly params: readonly ParamBound[];
};

export type LessonGradeName = "L1" | "L2" | "L3";

export type LessonSubject = {
  readonly kind: "lesson";
  readonly id: string;
  readonly grade: LessonGradeName;
  readonly direction: -1 | 1;
  readonly rows: readonly CriticRow[];
  readonly blocks: number;
  /** ARN-063 L2 test: passed / ran and did not reject / not reachable or not yet run. */
  readonly l2: "passed" | "not_passed" | "pending";
  readonly window: AuditWindow;
  /** The parameter the lesson names, if any. */
  readonly params?: readonly ParamBound[];
};

export type CriticSubject = ChallengerSubject | LessonSubject;

export type CheckResult = {
  readonly n: number;
  readonly name: string;
  readonly state: CriticState;
  /** One sentence built only from `values`. */
  readonly detail: string;
  readonly values: Readonly<Record<string, number | string | boolean | null>>;
};

export type Evaluation = {
  readonly kind: "lesson" | "challenger";
  readonly id: string;
  readonly checks: readonly CheckResult[];
  /** Challenger: all six pass. Lesson: all pass, check 5 may be pending for L1 (design 2.7). */
  readonly passed: boolean;
};

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const present = (xs: readonly (number | null)[]): number[] =>
  xs.filter((x): x is number => x !== null);

function check(
  n: number,
  state: CriticState,
  detail: string,
  values: CheckResult["values"],
): CheckResult {
  return { n, name: CRITIC_CHECK_NAMES[n - 1]!, state, detail, values };
}

// ---- the six checks -----------------------------------------------------------------------------------------

/** 1: enough rows and blocks. Challenger: min_trades and min_blocks; lesson: lesson_L1_min_n and min_blocks. */
export function checkSampleSize(s: CriticSubject, p: CriticParams): CheckResult {
  const rows = present(s.rows.map((r) => r.value)).length;
  const need = s.kind === "challenger" ? p.minRows : p.lessonMinRows;
  const ok = rows >= need && s.blocks >= p.minBlocks;
  const values: Record<string, number> = {
    rows,
    rowsNeeded: need,
    blocks: round(s.blocks),
    blocksNeeded: p.minBlocks,
  };
  if (s.kind === "challenger" && s.effectiveN !== undefined)
    values.effectiveN = round(s.effectiveN);
  return check(
    1,
    ok ? "pass" : "fail",
    `${rows} rows (need ${need}) and ${round(s.blocks)} blocks (need ${p.minBlocks})`,
    values,
  );
}

/** 2: per entry-date regime with enough rows, fail if the estimate has the wrong sign in at least half. */
export function checkRegime(s: CriticSubject, p: CriticParams): CheckResult {
  const dir = s.kind === "lesson" ? s.direction : 1;
  const byRegime = new Map<string, number[]>();
  for (const r of s.rows) {
    if (r.regime === null || r.value === null) continue;
    const list = byRegime.get(r.regime) ?? [];
    list.push(r.value);
    byRegime.set(r.regime, list);
  }
  const qualifying = [...byRegime.entries()]
    .filter(([, v]) => v.length >= p.lessonMinRows)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (qualifying.length === 0) {
    return check(2, "not_assessable", `no regime has ${p.lessonMinRows} rows`, {
      qualifying: 0,
      negative: 0,
      regimeRowsNeeded: p.lessonMinRows,
    });
  }
  const negative = qualifying.filter(([, v]) => dir * mean(v) < 0).length;
  const fail = 2 * negative >= qualifying.length;
  const per = qualifying.map(([k, v]) => `${k}=${round(mean(v))}`).join(", ");
  return check(
    2,
    fail ? "fail" : "pass",
    `${negative} of ${qualifying.length} qualifying regimes have the wrong sign (${per})`,
    { qualifying: qualifying.length, negative, regimeRowsNeeded: p.lessonMinRows },
  );
}

const vState = (s: Val110State): CriticState =>
  s === "pass"
    ? "pass"
    : s === "insufficient"
      ? "pending"
      : s === "n/a"
        ? "not_assessable"
        : "fail";

/** 3: stress costs. Challenger: VAL-110 (iv); lesson: stressed net > 0 (positive) or the stress excess keeps its sign (negative). */
export function checkStress(s: CriticSubject): CheckResult {
  if (s.kind === "challenger") {
    return check(CHECK_STRESS, vState(s.val110.iv), `VAL-110 (iv) is ${s.val110.iv}`, {
      val110Iv: s.val110.iv,
    });
  }
  const xs = present(s.rows.map((r) => (s.direction > 0 ? r.stressNet : r.stressValue)));
  if (xs.length === 0)
    return check(CHECK_STRESS, "not_assessable", "no stressed rows", { rows: 0 });
  const m = mean(xs);
  const ok = s.direction > 0 ? m > 0 : m < 0;
  return check(
    CHECK_STRESS,
    ok ? "pass" : "fail",
    `stressed mean ${round(m)} over ${xs.length} rows (direction ${s.direction})`,
    { rows: xs.length, stressMean: round(m), direction: s.direction },
  );
}

/** 4: flagged-row share within the cap, no survivorship exposure, and the input-bound audit. */
export function checkDataIssues(s: CriticSubject, p: CriticParams): CheckResult {
  const total = s.rows.length;
  if (total === 0) return check(CHECK_DATA, "not_assessable", "no rows", { rows: 0 });
  const flagged = s.rows.filter((r) => r.flagged).length;
  const shareOk = flagged * Number(p.flagShare.den) <= Number(p.flagShare.num) * total;
  const w = s.window;
  const outside = s.rows.filter(
    (r) => r.entryD < w.startD || r.entryD > w.endD || r.outcomeD === null || r.outcomeD >= w.testD,
  ).length;
  const exposed = s.kind === "challenger" && s.survivorshipExposed === true;
  const ok = shareOk && outside === 0 && !exposed;
  const cap = round(ratToNumber(p.flagShare));
  return check(
    CHECK_DATA,
    ok ? "pass" : "fail",
    `${flagged} of ${total} rows flagged (cap ${cap}), ${outside} rows outside the input bound` +
      (exposed ? ", survivorship-exposed" : ""),
    {
      rows: total,
      flagged,
      flagShareCap: cap,
      outsideInputBound: outside,
      survivorshipExposed: exposed,
    },
  );
}

/** 5: luck. Challenger: VAL-110 (i); lesson: the ARN-063 L2 test (pending is no failure). */
export function checkLuck(s: CriticSubject): CheckResult {
  if (s.kind === "challenger") {
    return check(CHECK_LUCK, vState(s.val110.i), `VAL-110 (i) is ${s.val110.i}`, {
      val110I: s.val110.i,
    });
  }
  const state: CriticState =
    s.l2 === "passed" ? "pass" : s.l2 === "not_passed" ? "fail" : "pending";
  return check(CHECK_LUCK, state, `the L2 test is ${s.l2.replace("_", " ")}`, { l2: s.l2 });
}

/** 6: every named parameter within its bounds. */
export function checkBounds(s: CriticSubject): CheckResult {
  const params = s.params ?? [];
  const bad = params.filter((q) => !Number.isFinite(q.value) || q.value < q.min || q.value > q.max);
  return check(
    CHECK_BOUNDS,
    bad.length === 0 ? "pass" : "fail",
    bad.length === 0
      ? `${params.length} parameters within bounds`
      : `out of bounds: ${bad.map((q) => q.key).join(", ")}`,
    { parameters: params.length, outOfBounds: bad.length },
  );
}

export function evaluateSubject(s: CriticSubject, p: CriticParams): Evaluation {
  const checks = [
    checkSampleSize(s, p),
    checkRegime(s, p),
    checkStress(s),
    checkDataIssues(s, p),
    checkLuck(s),
    checkBounds(s),
  ];
  const lessonL1 = s.kind === "lesson" && s.grade === "L1";
  // L1: check 5 (index 4) may be pending, the L2 test is not reachable yet; the rest must pass.
  const passed = checks.every(
    (c, i) => c.state === "pass" || (lessonL1 && i === CHECK_LUCK - 1 && c.state === "pending"),
  );
  return { kind: s.kind, id: s.id, checks, passed };
}

export const statesOf = (e: Evaluation): CriticState[] => e.checks.map((c) => c.state);

// ---- rows ---------------------------------------------------------------------------------------------------

export type WriteResult = {
  readonly written: boolean;
  readonly reason: "new" | "changed" | "unchanged" | "same-run";
};

export function checksJson(e: Evaluation): string {
  return canonicalJson(
    e.checks.map((c) => ({ n: c.n, state: c.state, detail: c.detail, values: c.values })),
  );
}

/**
 * Appends a `critique` row. Idempotent: the same run id writes nothing; a new run writes only when a
 * check state or number differs from the subject's latest row (design 4.6 step 4).
 */
export async function writeCritique(
  db: Client,
  args: {
    readonly evaluation: Evaluation;
    readonly runId: string;
    readonly d: string;
    readonly accessTrialId?: string | null;
  },
): Promise<WriteResult> {
  const { evaluation: e } = args;
  const same = await db.execute({
    sql: "SELECT 1 FROM critique WHERE subject_kind = ? AND subject_id = ? AND run_id = ?",
    args: [e.kind, e.id, args.runId],
  });
  if (same.rows.length > 0) return { written: false, reason: "same-run" };
  const json = checksJson(e);
  const latest = await db.execute({
    sql: `SELECT checks_json, passed FROM critique WHERE subject_kind = ? AND subject_id = ?
          ORDER BY d DESC, run_id DESC LIMIT 1`,
    args: [e.kind, e.id],
  });
  if (
    latest.rows.length > 0 &&
    String(latest.rows[0]!.checks_json) === json &&
    Number(latest.rows[0]!.passed) === (e.passed ? 1 : 0)
  ) {
    return { written: false, reason: "unchanged" };
  }
  await db.execute({
    sql: `INSERT INTO critique (subject_kind, subject_id, run_id, checks_json, passed, access_trial_id, d)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [e.kind, e.id, args.runId, json, e.passed ? 1 : 0, args.accessTrialId ?? null, args.d],
  });
  return { written: true, reason: latest.rows.length === 0 ? "new" : "changed" };
}

// ---- challenger review ---------------------------------------------------------------------------------------

export type CriticReview = {
  readonly evaluation: Evaluation;
  readonly critique: WriteResult;
  readonly verdict: ReviewVerdict;
  readonly readyChanged: boolean;
};

/**
 * The review step for a challenger in `review` (D-119): evaluate the six checks on the given rows
 * (checks 4 and 6 re-checked on current flags and bounds by the caller's fresh input), store the
 * `critique` row, and set `ready` only when all six pass.
 */
export async function reviewWithCritic(
  db: Client,
  args: {
    readonly challengerId: string;
    readonly runId: string;
    readonly d: string;
    readonly subject: ChallengerSubject;
    readonly params: CriticParams;
    readonly accessTrialId?: string | null;
  },
): Promise<CriticReview> {
  if (args.subject.id !== args.challengerId) {
    throw new Error(`subject ${args.subject.id} is not challenger ${args.challengerId}`);
  }
  const evaluation = evaluateSubject(args.subject, args.params);
  if (evaluation.checks.length !== CRITIC_CHECK_COUNT) {
    throw new Error("critic: six checks expected");
  }
  const critique = await writeCritique(db, {
    evaluation,
    runId: args.runId,
    d: args.d,
    accessTrialId: args.accessTrialId ?? null,
  });
  const r = await reviewChallenger(db, args.challengerId, statesOf(evaluation));
  return { evaluation, critique, verdict: r.verdict, readyChanged: r.changed };
}

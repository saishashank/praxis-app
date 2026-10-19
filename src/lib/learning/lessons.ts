// Lesson engine (M6 T4; ARN-063, KB-020; design 2.3, 2.4, 4.4; D-110 #12-#16, #22, #41-#43, #47;
// D-111 `alpha_wealth` chaining; D-113 attribution tags; D-117 proposed).
//
// Deterministic lesson candidates from attribution windows, graded L0 / L1 / L2 on DEVELOPMENT rows only:
//   L0  a template cell on the L1 window with n >= `lesson_L0_min_n`; a point estimate, no test.
//   L1  n >= `lesson_L1_min_n` relevant rows in the L1 window, >= 15 independent blocks, and the two-sided
//       90 % interval (5th / 95th percentile of the ARN-081 circular-block-bootstrap replicate means)
//       excludes 0. The lesson's direction s is the sign of the point estimate.
//   L2  on the L2 window, n >= `lesson_L1_min_n` rows and a studentised one-sided block-bootstrap test of
//       s x mean > 0 with p <= alpha_j of the lesson's alpha-investing pool (alphaInvesting.ts). Each
//       lesson is tested at most once per L2 window; a non-rejection keeps L1.
//   retired  (a) the rule version is retired, (b) a roll's re-frozen L1 window no longer meets L1,
//       (c) the template version is withdrawn. Terminal; a new `lesson_grade` row, nothing is deleted.
// L3 (adoption) is written by Lane A (T7), never here.
//
// The p-values do not depend on the pool, so `buildCandidates` is pure; `runLessons` then walks the
// candidates in the order (pool, lesson id), runs the alpha-investing tests in that order inside one
// transaction per pool and writes `lesson`, then `alpha_wealth`, then `lesson_grade`. Idempotent: the
// same grade chain at the same split version writes nothing; a different value at the same split
// version RAISES (ARN-102 style); provisional rows ("L2 not reachable", "alpha-wealth exhausted") may be
// superseded by a later row. Look-ahead (TST-109): a row counts only when its entry session is in the
// window and its outcome is observed on or before `asOfD`. No clock, no Math.random: seeds derive from
// the scope string. Every threshold comes from AgentParams.
import type { Client } from "@libsql/client";
import type { AgentParams } from "../agents/params";
import { ARENA_MASTER_SEED } from "../arena/closeBooks";
import { canonicalJson } from "../arena/cohort";
import {
  circularBlockBootstrap,
  MIN_INDEPENDENT_BLOCKS,
  mean,
  percentile,
  sampleSd,
} from "../stats/bootstrap";
import { scopedPrng } from "../stats/rng";
import { alphaLevel, poolId, recordAlphaTest } from "./alphaInvesting";
import {
  bootstrapDifference,
  replicatesFor,
  studentisedDiffP,
  type CompRow,
  type DiffBootstrap,
} from "./comparisons";
import type { LessonGradeRow, LessonRow } from "./schema";
import {
  lessonId,
  LESSON_TEMPLATES_V1,
  renderStatement,
  templateById,
  templateKey,
  type LessonCell,
  type LessonObs,
  type LessonTemplate,
  type Subject,
} from "./templates";
import {
  crossFamilyWindows,
  LessonError,
  rowsInWindow,
  windowBounds,
  type LessonWindows,
} from "./windows";

export { LessonError };

type Exec = Pick<Client, "execute">;

// ---- state texts (contract: AT-22 quotes them) --------------------------------------------------------

export const STATE_DEFERRED = "split deferred — no L1 / L2 window, observation only";
export const STATE_L2_UNREACHABLE = "L2 not reachable";
export const STATE_ALPHA_EXHAUSTED = "L2 not run — alpha-wealth exhausted";
export const stateFewRows = (n: number, min: number): string =>
  `fewer than ${String(min)} relevant rows in the L1 window (n = ${String(n)})`;
export const stateFewBlocks = (blocks: number): string =>
  `insufficient independent blocks (${blocks.toFixed(1)})`; // threshold-ok: display digits
export const stateIntervalIncludesZero = (pct: number): string =>
  `${String(pct)} % interval includes 0`;
export const stateDirectionChanged = (was: number): string =>
  `estimate sign differs from the lesson's direction (${was > 0 ? "+" : "-"})`;
export const stateL2Passed = (window: string): string => `L2 test passed (${window})`;
export const stateL2NotPassed = (window: string): string => `L2 test not passed (${window})`;

const isProvisional = (stateText: string): boolean =>
  stateText.startsWith(STATE_L2_UNREACHABLE) || stateText === STATE_ALPHA_EXHAUSTED;

// ---- inputs ----------------------------------------------------------------------------------------------

export type LineageInput = {
  readonly family: string;
  readonly lineageId: string;
  readonly ruleVersion: string;
  /** `lineage_split` version; 0 when the split is deferred. */
  readonly splitVersion: number;
  /** null = deferred split: only L0 lessons exist, on all of `devSessions`. */
  readonly windows: LessonWindows | null;
  /** Development entry sessions (used only when `windows` is null). */
  readonly devSessions?: readonly string[];
  /** The lineage's frozen block length (sessions). */
  readonly block: number;
};

export type LessonRunInput = {
  readonly market: string;
  readonly runId: string;
  /** The run's Melbourne date (stamps `created_d` and `d`). */
  readonly d: string;
  /** Rows count only when their outcome is observed on or before this date. */
  readonly asOfD: string;
  readonly params: AgentParams;
  readonly rows: readonly LessonObs[];
  readonly lineages: readonly LineageInput[];
  /** Rule-version label in the ids of market-scope lessons. */
  readonly marketRuleVersion?: string;
  /** Date of the next roll that could add rows to an unreachable L2 window. */
  readonly nextRollD?: string | null;
  readonly retiredRuleVersions?: ReadonlySet<string>;
  /** Withdrawn template versions, as `templateKey`. */
  readonly withdrawnTemplates?: ReadonlySet<string>;
  readonly masterSeed?: bigint;
};

// ---- candidates (pure) -----------------------------------------------------------------------------------

export type L1Assessment = {
  readonly grade: "L0" | "L1";
  readonly n: number;
  readonly blocks: number;
  readonly estimate: number;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly B: number;
  readonly stateText: string;
  readonly direction: -1 | 1;
};

export type L2Plan =
  | {
      readonly status: "ready";
      readonly n: number;
      readonly blocks: number;
      readonly estimate: number;
      readonly p: number;
      readonly B: number;
      readonly windowLabel: string;
    }
  | {
      readonly status: "unreachable";
      readonly n: number;
      readonly blocks: number;
      readonly estimate: number | null;
      readonly stateText: string;
      readonly reachableD: string | null;
    };

export type LessonCandidate = {
  readonly id: string;
  readonly lesson: Omit<LessonRow, "created_d" | "created_run">;
  readonly template: LessonTemplate;
  readonly subject: Subject;
  readonly family: string | null;
  readonly pool: string;
  readonly splitVersion: number;
  readonly windowKey: string;
  readonly l1: L1Assessment;
  readonly l2: L2Plan | null;
};

const sign = (x: number): -1 | 1 => (x < 0 ? -1 : 1);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Cut = { rows: readonly LessonObs[]; sessionOf: Map<LessonObs, number>; sessionCount: number };

function cut(rows: readonly LessonObs[], sessions: readonly string[], asOfD: string): Cut {
  const w = rowsInWindow(rows, sessions, asOfD);
  const sessionOf = new Map<LessonObs, number>();
  w.rows.forEach((r, i) => sessionOf.set(r, w.sessions[i]!));
  return { rows: w.rows, sessionOf, sessionCount: w.sessionCount };
}

type Side = { rows: CompRow[]; values: number[] };

function sideOf(
  t: LessonTemplate,
  obs: readonly LessonObs[],
  sessionOf: Map<LessonObs, number>,
): Side {
  const rows: CompRow[] = [];
  const values: number[] = [];
  for (const o of obs) {
    const v = t.valueOf(o);
    const s = sessionOf.get(o);
    if (v === null || s === undefined) continue;
    rows.push({ session: s, value: v });
    values.push(v);
  }
  return { rows, values };
}

type CellStats = {
  readonly n: number;
  readonly nA: number;
  readonly nB: number | null;
  readonly estimate: number;
  readonly a: Side;
  readonly b: Side | null;
};

function cellStats(
  t: LessonTemplate,
  cell: LessonCell,
  sessionOf: Map<LessonObs, number>,
): CellStats | null {
  const a = sideOf(t, cell.a, sessionOf);
  const b = cell.b ? sideOf(t, cell.b, sessionOf) : null;
  if (a.values.length === 0 || (b && b.values.length === 0)) return null;
  const n = b ? Math.min(a.values.length, b.values.length) : a.values.length;
  const estimate = b ? mean(a.values) - mean(b.values) : mean(a.values);
  return { n, nA: a.values.length, nB: b ? b.values.length : null, estimate, a, b };
}

function bootstrapCell(
  s: CellStats,
  sessionCount: number,
  block: number,
  replicates: number,
  scope: string,
  masterSeed: bigint,
): DiffBootstrap {
  const rng = scopedPrng(scope, masterSeed);
  if (s.b) return bootstrapDifference(s.a.rows, s.b.rows, sessionCount, block, replicates, rng);
  const r = circularBlockBootstrap(
    {
      sessions: s.a.rows.map((x) => x.session),
      sessionCount,
      block,
      replicates,
      series: [s.a.values],
    },
    rng,
  );
  const reps = r.replicateMeans[0]!;
  return { estimate: s.estimate, se: sampleSd(reps), replicates: reps, redraws: r.redraws };
}

type Scope = {
  readonly template: LessonTemplate;
  readonly lineage: LineageInput | null;
  readonly family: string | null;
  readonly rows: readonly LessonObs[];
  readonly pool: string;
  readonly ruleVersion: string;
  readonly splitVersion: number;
  readonly block: number;
  /** null = L0-only (deferred). */
  readonly windows: LessonWindows | null;
  /** The L1 sessions (windows.l1, or all development sessions when deferred). */
  readonly l1Sessions: readonly string[];
};

function scopesOf(input: LessonRunInput): Scope[] {
  const out: Scope[] = [];
  for (const t of LESSON_TEMPLATES_V1) {
    if (input.withdrawnTemplates?.has(templateKey(t))) continue;
    if (t.scope === "lineage") {
      for (const l of input.lineages) {
        if (t.families && !t.families.includes(l.family)) continue;
        if (input.retiredRuleVersions?.has(l.ruleVersion)) continue;
        out.push({
          template: t,
          lineage: l,
          family: l.family,
          rows: input.rows.filter((r) => r.family === l.family),
          pool: poolId(input.market, l.family),
          ruleVersion: l.ruleVersion,
          splitVersion: l.splitVersion,
          block: l.block,
          windows: l.windows,
          l1Sessions: l.windows ? l.windows.l1 : [...(l.devSessions ?? [])].sort(cmp),
        });
      }
    } else {
      const involved = input.lineages.filter((l) => t.families?.includes(l.family));
      if (involved.length === 0) continue;
      const allWindowed = involved.every((l) => l.windows !== null);
      const cross = allWindowed ? crossFamilyWindows(involved.map((l) => l.windows!)) : null;
      const sessions = cross
        ? cross.l1
        : [
            ...new Set(
              involved.flatMap((l) => (l.windows ? [...l.windows.l1] : [...(l.devSessions ?? [])])),
            ),
          ].sort(cmp);
      out.push({
        template: t,
        lineage: null,
        family: null,
        rows: input.rows.filter((r) => t.families?.includes(r.family)),
        pool: poolId(input.market, null),
        ruleVersion: input.marketRuleVersion ?? "all",
        splitVersion: Math.max(...involved.map((l) => l.splitVersion)),
        block: Math.max(...involved.map((l) => l.block)),
        windows: cross,
        l1Sessions: sessions,
      });
    }
  }
  return out;
}

const pctOfLevel = (level: number): number => Math.round((1 - level) * 100); // threshold-ok: percent display

export function intervalPct(params: AgentParams): number {
  return pctOfLevel(params.learning.lessonBootstrapLevel);
}

/**
 * Every lesson candidate of a run, sorted by (pool, lesson id). Pure and deterministic; development rows
 * only; nothing after `asOfD` is read. Also returns the split version per lineage (`*` = market scope).
 */
export function buildCandidates(input: LessonRunInput): {
  candidates: LessonCandidate[];
  splits: Map<string, number>;
} {
  const L = input.params.learning;
  const level = L.lessonBootstrapLevel;
  const B = replicatesFor(input.params, level);
  const master = input.masterSeed ?? ARENA_MASTER_SEED;
  const out: LessonCandidate[] = [];
  const splits = new Map<string, number>();
  for (const sc of scopesOf(input)) {
    const t = sc.template;
    splits.set(sc.lineage ? sc.lineage.lineageId : "*", sc.splitVersion);
    const l1 = cut(sc.rows, sc.l1Sessions, input.asOfD);
    const l2 = sc.windows ? cut(sc.rows, sc.windows.l2, input.asOfD) : null;
    for (const subject of t.enumerate(l1.rows)) {
      const id = lessonId(input.market, t.id, subject, sc.ruleVersion);
      const stats = cellStats(t, t.select(l1.rows, subject), l1.sessionOf);
      if (!stats || stats.n < L.lessonL0MinN) continue;
      // ---- L0 / L1 assessment on the L1 window
      let l1a: L1Assessment;
      const blocksF = sc.windows ? l1.sessionCount / sc.block : 0;
      const base = { n: stats.n, blocks: Math.floor(blocksF), estimate: stats.estimate };
      const dir = sign(stats.estimate);
      if (!sc.windows) {
        l1a = {
          grade: "L0",
          ...base,
          lower: null,
          upper: null,
          B: 0,
          stateText: STATE_DEFERRED,
          direction: dir,
        };
      } else if (stats.n < L.lessonL1MinN) {
        l1a = {
          grade: "L0",
          ...base,
          lower: null,
          upper: null,
          B: 0,
          stateText: stateFewRows(stats.n, L.lessonL1MinN),
          direction: dir,
        };
      } else if (blocksF < MIN_INDEPENDENT_BLOCKS) {
        l1a = {
          grade: "L0",
          ...base,
          lower: null,
          upper: null,
          B: 0,
          stateText: stateFewBlocks(blocksF),
          direction: dir,
        };
      } else {
        const boot = bootstrapCell(
          stats,
          l1.sessionCount,
          sc.block,
          B,
          `lesson:${id}:${String(sc.splitVersion)}`,
          master,
        );
        const lower = percentile(boot.replicates, level / 2);
        const upper = percentile(boot.replicates, 1 - level / 2);
        const excludes = lower > 0 || upper < 0;
        l1a = {
          grade: excludes ? "L1" : "L0",
          ...base,
          lower,
          upper,
          B,
          stateText: excludes ? "" : stateIntervalIncludesZero(pctOfLevel(level)),
          direction: dir,
        };
      }
      // ---- L2 plan (only for an L1 lesson)
      let l2p: L2Plan | null = null;
      if (l1a.grade === "L1" && sc.windows && l2) {
        const b2 = windowBounds(sc.windows.l2);
        const label = `L2 window ${b2.start} to ${b2.end}, split v${String(sc.splitVersion)}`;
        const s2 = cellStats(t, t.select(l2.rows, subject), l2.sessionOf);
        const n2 = s2 ? s2.n : 0;
        const blocks2 = Math.floor(l2.sessionCount / sc.block);
        if (!s2 || n2 < L.lessonL1MinN) {
          const next = input.nextRollD ?? null;
          l2p = {
            status: "unreachable",
            n: n2,
            blocks: blocks2,
            estimate: s2 ? s2.estimate : null,
            stateText: `${STATE_L2_UNREACHABLE} — n = ${String(n2)} < ${String(L.lessonL1MinN)} rows in the ${label}${next ? `; next roll ${next}` : ""}`,
            reachableD: next,
          };
        } else {
          const boot = bootstrapCell(
            s2,
            l2.sessionCount,
            sc.block,
            B,
            `lesson:${id}:${String(sc.splitVersion)}:l2`,
            master,
          );
          l2p = {
            status: "ready",
            n: n2,
            blocks: blocks2,
            estimate: s2.estimate,
            p: studentisedDiffP(boot, l1a.direction),
            B,
            windowLabel: label,
          };
        }
      }
      out.push({
        id,
        lesson: {
          id,
          market: input.market,
          scope: t.scope,
          lineage_id: sc.lineage ? sc.lineage.lineageId : null,
          template_id: t.id,
          template_version: t.version,
          subject_json: canonicalJson(subject),
          rule_version: sc.ruleVersion,
          metric: t.metric,
          direction: dir,
          param_hint: t.paramHint(subject, sc.family),
        },
        template: t,
        subject,
        family: sc.family,
        pool: sc.pool,
        splitVersion: sc.splitVersion,
        windowKey: `${sc.lineage ? sc.lineage.lineageId : `${input.market}:*`}:s${String(sc.splitVersion)}:l2`,
        l1: l1a,
        l2: l2p,
      });
    }
  }
  out.sort((x, y) => cmp(x.pool, y.pool) || cmp(x.id, y.id));
  return { candidates: out, splits };
}

// ---- grade chain -----------------------------------------------------------------------------------------

/** The content of one `lesson_grade` row (without seq, run and date). */
export type GradeTarget = {
  readonly grade: "L0" | "L1" | "L2";
  readonly window: "l1" | "l2" | null;
  readonly n: number;
  readonly blocks: number;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly p: number | null;
  readonly alphaJ: number | null;
  readonly B: number;
  readonly stateText: string;
  readonly reachableD: string | null;
};

export type AlphaResult =
  | { readonly kind: "exhausted" }
  | { readonly kind: "tested"; readonly rejected: boolean; readonly alphaJ: number };

/** The grade rows a candidate stands for at its split version (the L1 row, then the L2 row). */
export function gradeChain(c: LessonCandidate, alpha: AlphaResult | null): GradeTarget[] {
  const a = c.l1;
  const first: GradeTarget = {
    grade: a.grade,
    window: c.l1.stateText === STATE_DEFERRED ? null : "l1",
    n: a.n,
    blocks: a.blocks,
    estimate: a.estimate,
    lower: a.lower,
    upper: a.upper,
    p: null,
    alphaJ: null,
    B: a.B,
    stateText: a.stateText,
    reachableD: null,
  };
  const chain = [first];
  if (a.grade !== "L1" || !c.l2) return chain;
  const l2 = c.l2;
  if (l2.status === "unreachable") {
    chain.push({
      grade: "L1",
      window: "l2",
      n: l2.n,
      blocks: l2.blocks,
      estimate: l2.estimate,
      lower: null,
      upper: null,
      p: null,
      alphaJ: null,
      B: 0,
      stateText: l2.stateText,
      reachableD: l2.reachableD,
    });
    return chain;
  }
  if (!alpha || alpha.kind === "exhausted") {
    chain.push({
      grade: "L1",
      window: "l2",
      n: l2.n,
      blocks: l2.blocks,
      estimate: l2.estimate,
      lower: null,
      upper: null,
      p: l2.p,
      alphaJ: null,
      B: l2.B,
      stateText: STATE_ALPHA_EXHAUSTED,
      reachableD: null,
    });
    return chain;
  }
  chain.push({
    grade: alpha.rejected ? "L2" : "L1",
    window: "l2",
    n: l2.n,
    blocks: l2.blocks,
    estimate: l2.estimate,
    lower: null,
    upper: null,
    p: l2.p,
    alphaJ: alpha.alphaJ,
    B: l2.B,
    stateText: alpha.rejected ? stateL2Passed(l2.windowLabel) : stateL2NotPassed(l2.windowLabel),
    reachableD: null,
  });
  return chain;
}

// ---- persistence -----------------------------------------------------------------------------------------

export type LessonRunReport = {
  candidates: number;
  lessonsCreated: number;
  gradesWritten: number;
  gradesUnchanged: number;
  testsWritten: number;
  testsExisting: number;
  exhausted: number;
  retired: number;
  skippedRetired: number;
};

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function gradeRowOf(r: Record<string, unknown>): LessonGradeRow {
  return {
    lesson_id: String(r.lesson_id),
    seq: Number(r.seq),
    grade: String(r.grade) as LessonGradeRow["grade"],
    split_version: Number(r.split_version),
    window: str(r.window) as LessonGradeRow["window"],
    n: Number(r.n),
    blocks: Number(r.blocks),
    estimate: num(r.estimate),
    lower: num(r.lower),
    upper: num(r.upper),
    p: num(r.p),
    alpha_j: num(r.alpha_j),
    B: Number(r.B),
    state_text: String(r.state_text),
    reachable_d: str(r.reachable_d),
    run_id: String(r.run_id),
    d: String(r.d),
    corrects_seq: num(r.corrects_seq),
  };
}

function sameContent(row: LessonGradeRow, t: GradeTarget): boolean {
  return (
    row.grade === t.grade &&
    row.window === t.window &&
    row.n === t.n &&
    row.blocks === t.blocks &&
    row.estimate === t.estimate &&
    row.lower === t.lower &&
    row.upper === t.upper &&
    row.p === t.p &&
    row.alpha_j === t.alphaJ &&
    row.B === t.B &&
    row.state_text === t.stateText &&
    row.reachable_d === t.reachableD
  );
}

async function gradeRows(tx: Exec, id: string): Promise<LessonGradeRow[]> {
  const r = await tx.execute({
    sql: "SELECT * FROM lesson_grade WHERE lesson_id = ? ORDER BY seq",
    args: [id],
  });
  return r.rows.map((x) => gradeRowOf(x as unknown as Record<string, unknown>));
}

async function insertGrade(
  tx: Exec,
  id: string,
  seq: number,
  split: number,
  t: Omit<GradeTarget, "grade"> & { grade: LessonGradeRow["grade"] },
  runId: string,
  d: string,
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, estimate, lower,
            upper, p, alpha_j, B, state_text, reachable_d, run_id, d)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      seq,
      t.grade,
      split,
      t.window,
      t.n,
      t.blocks,
      t.estimate,
      t.lower,
      t.upper,
      t.p,
      t.alphaJ,
      t.B,
      t.stateText,
      t.reachableD,
      runId,
      d,
    ],
  });
}

/**
 * Bring the stored grade chain of one lesson at one split version to `target`. Rows of this engine are
 * those of the split with grade L0 / L1 / L2 and no correction; provisional rows superseded by a later
 * row are ignored. Returns the number of rows written.
 */
async function reconcile(
  tx: Exec,
  id: string,
  split: number,
  target: readonly GradeTarget[],
  runId: string,
  d: string,
): Promise<{ written: number; unchanged: number }> {
  const all = await gradeRows(tx, id);
  const mine = all.filter(
    (r) =>
      r.split_version === split &&
      r.corrects_seq === null &&
      (r.grade === "L0" || r.grade === "L1" || r.grade === "L2"),
  );
  const effective = mine.filter((r, i) => !isProvisional(r.state_text) || i === mine.length - 1);
  let written = 0;
  let unchanged = 0;
  let nextSeq = all.length === 0 ? 1 : all[all.length - 1]!.seq + 1;
  for (let i = 0; i < target.length; i += 1) {
    const t = target[i]!;
    const have = effective[i];
    if (have && sameContent(have, t)) {
      unchanged += 1;
      continue;
    }
    if (have && !isProvisional(have.state_text)) {
      throw new LessonError(
        "grade_conflict",
        `lesson ${id} split ${String(split)}: stored grade row ${String(have.seq)} differs from the recomputation`,
      );
    }
    await insertGrade(tx, id, nextSeq, split, t, runId, d);
    nextSeq += 1;
    written += 1;
  }
  if (effective.length > target.length) {
    const extra = effective[target.length]!;
    throw new LessonError(
      "grade_conflict",
      `lesson ${id} split ${String(split)}: stored row ${String(extra.seq)} has no counterpart in the recomputation`,
    );
  }
  return { written, unchanged };
}

type LatestRow = {
  id: string;
  scope: string;
  lineage_id: string | null;
  template_id: string;
  template_version: number;
  rule_version: string;
  direction: number;
  grade: LessonGradeRow["grade"];
  split_version: number;
};

async function latestLessons(tx: Exec, market: string): Promise<LatestRow[]> {
  const r = await tx.execute({
    sql: `SELECT l.id, l.scope, l.lineage_id, l.template_id, l.template_version, l.rule_version,
                 l.direction, g.grade, g.split_version
          FROM lesson l JOIN lesson_grade g ON g.lesson_id = l.id
           AND g.seq = (SELECT MAX(seq) FROM lesson_grade WHERE lesson_id = l.id)
          WHERE l.market = ? ORDER BY l.id`,
    args: [market],
  });
  return r.rows.map((x) => ({
    id: String(x.id),
    scope: String(x.scope),
    lineage_id: str(x.lineage_id),
    template_id: String(x.template_id),
    template_version: Number(x.template_version),
    rule_version: String(x.rule_version),
    direction: Number(x.direction),
    grade: String(x.grade) as LatestRow["grade"],
    split_version: Number(x.split_version),
  }));
}

/** Reasons to retire existing lessons before this run's grades are written (ARN-063 retired rules). */
export function retirementReasons(
  existing: readonly LatestRow[],
  input: LessonRunInput,
  candidates: ReadonlyMap<string, LessonCandidate>,
  splits: ReadonlyMap<string, number>,
): Map<string, { reason: string; split: number | null }> {
  const out = new Map<string, { reason: string; split: number | null }>();
  for (const e of existing) {
    if (e.grade === "retired") continue;
    const current = splits.get(e.lineage_id ?? "*") ?? null;
    if (input.retiredRuleVersions?.has(e.rule_version)) {
      out.set(e.id, { reason: `rule version ${e.rule_version} retired`, split: current });
      continue;
    }
    if (
      input.withdrawnTemplates?.has(templateKey({ id: e.template_id, version: e.template_version }))
    ) {
      out.set(e.id, {
        reason: `template ${e.template_id} v${String(e.template_version)} withdrawn`,
        split: current,
      });
      continue;
    }
    const aboveL0 = e.grade === "L1" || e.grade === "L2" || e.grade === "L3";
    if (aboveL0 && current !== null && current > e.split_version) {
      const c = candidates.get(e.id);
      const stillL1 = c !== undefined && c.l1.grade === "L1" && c.l1.direction === e.direction;
      if (!stillL1) {
        out.set(e.id, {
          reason: `re-frozen L1 window (split v${String(current)}) no longer meets L1`,
          split: current,
        });
      }
    }
  }
  return out;
}

async function withTx<T>(db: Client, fn: (tx: Exec) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

/**
 * Grade the lessons of a run and write them. One transaction per pool (candidates in lesson-id order, so
 * the alpha-investing sequence is deterministic) plus one for the retirements. Re-running the same input
 * writes nothing.
 */
export async function runLessons(db: Client, input: LessonRunInput): Promise<LessonRunReport> {
  const { candidates, splits } = buildCandidates(input);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const report: LessonRunReport = {
    candidates: candidates.length,
    lessonsCreated: 0,
    gradesWritten: 0,
    gradesUnchanged: 0,
    testsWritten: 0,
    testsExisting: 0,
    exhausted: 0,
    retired: 0,
    skippedRetired: 0,
  };
  const existing = await latestLessons(db, input.market);
  const retire = retirementReasons(existing, input, byId, splits);
  const latest = new Map(existing.map((e) => [e.id, e]));
  const pools = [...new Set(candidates.map((c) => c.pool))].sort(cmp);
  for (const pool of pools) {
    await withTx(db, async (tx) => {
      for (const c of candidates.filter((x) => x.pool === pool)) {
        const prior = latest.get(c.id);
        if (retire.has(c.id) || prior?.grade === "retired") {
          report.skippedRetired += 1;
          continue;
        }
        const made = await tx.execute({
          sql: `INSERT INTO lesson (id, market, scope, lineage_id, template_id, template_version, subject_json,
                  rule_version, metric, direction, param_hint, created_d, created_run)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          args: [
            c.lesson.id,
            c.lesson.market,
            c.lesson.scope,
            c.lesson.lineage_id,
            c.lesson.template_id,
            c.lesson.template_version,
            c.lesson.subject_json,
            c.lesson.rule_version,
            c.lesson.metric,
            c.lesson.direction,
            c.lesson.param_hint,
            input.d,
            input.runId,
          ],
        });
        if (made.rowsAffected > 0) report.lessonsCreated += 1;
        // The lesson's stored direction wins: an opposite estimate at a later split is no L1.
        let cand = c;
        if (prior && prior.direction !== c.l1.direction && c.l1.grade === "L1") {
          cand = {
            ...c,
            l1: {
              ...c.l1,
              grade: "L0",
              lower: null,
              upper: null,
              stateText: stateDirectionChanged(prior.direction),
            },
            l2: null,
          };
        }
        let alpha: AlphaResult | null = null;
        if (cand.l1.grade === "L1" && cand.l2?.status === "ready") {
          const t = await recordAlphaTest(tx, {
            pool: cand.pool,
            lessonId: cand.id,
            windowKey: cand.windowKey,
            p: cand.l2.p,
            runId: input.runId,
            params: input.params,
          });
          if (t.kind === "exhausted") {
            alpha = { kind: "exhausted" };
            report.exhausted += 1;
          } else {
            alpha = { kind: "tested", rejected: t.row.rejected, alphaJ: t.row.alpha_j };
            if (t.kind === "tested") report.testsWritten += 1;
            else report.testsExisting += 1;
          }
        }
        const r = await reconcile(
          tx,
          cand.id,
          cand.splitVersion,
          gradeChain(cand, alpha),
          input.runId,
          input.d,
        );
        report.gradesWritten += r.written;
        report.gradesUnchanged += r.unchanged;
      }
    });
  }
  if (retire.size > 0) {
    await withTx(db, async (tx) => {
      for (const [id, why] of [...retire].sort((a, b) => cmp(a[0], b[0]))) {
        const e = latest.get(id)!;
        const c = byId.get(id);
        const rows = await gradeRows(tx, id);
        const split = why.split ?? e.split_version;
        await insertGrade(
          tx,
          id,
          rows[rows.length - 1]!.seq + 1,
          split,
          {
            grade: "retired",
            window: null,
            n: c ? c.l1.n : 0,
            blocks: c ? c.l1.blocks : 0,
            estimate: c ? c.l1.estimate : null,
            lower: null,
            upper: null,
            p: null,
            alphaJ: null,
            B: 0,
            stateText: `retired: ${why.reason}`,
            reachableD: null,
          },
          input.runId,
          input.d,
        );
        report.retired += 1;
      }
    });
  }
  return report;
}

// ---- wording of a stored lesson ----------------------------------------------------------------------------

/** The statement of a stored lesson at a stored grade (KB-020), from its structured fields only. */
export function statementOf(
  lesson: Pick<LessonRow, "template_id" | "subject_json" | "lineage_id">,
  grade: Pick<
    LessonGradeRow,
    "grade" | "n" | "estimate" | "lower" | "upper" | "p" | "alpha_j" | "state_text"
  >,
  params: AgentParams,
  family: string | null,
): string {
  const template = templateById(lesson.template_id);
  if (!template) throw new LessonError("unknown_template", lesson.template_id);
  return renderStatement({
    template,
    subject: JSON.parse(lesson.subject_json) as Subject,
    family,
    grade: grade.grade,
    n: grade.n,
    estimate: grade.estimate,
    lower: grade.lower,
    upper: grade.upper,
    p: grade.p,
    alphaJ: grade.alpha_j,
    intervalPct: intervalPct(params),
    stateText: grade.state_text,
  });
}

/** Level of a pool's next test, for display ("next L2 level"). */
export const nextAlphaLevel = alphaLevel;

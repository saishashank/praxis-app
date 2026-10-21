// A6 output as the Evening Review reads it (M6 T11; docs/M6_design.md 4.1 and 4.2, EML-012 sections 4-6,
// EML-037; D-123). Everything here is READ from the rows the `learn` phase (and the weekly learning
// run) wrote, bounded by the review date D: lessons graded since the previous `learn` run, the Lane-A
// changes effective at the next session, the challengers with the earliest date they could first be
// promoted, the plan of D and the review of the previous plan, the nightly comparisons of D, and the
// attributions that became final on D. No model, no clock, no write.
//
// `learnLines` turns the facts into the facts-only sentences ("written without AI", EML-014); the R5
// router may reword them from the same facts but cannot add a number (LLM-034).
import type { Client } from "@libsql/client";
import { nextTradingDay, type CalendarRow } from "@/lib/data/calendar";
import type { AgentParams } from "@/lib/agents/params";
import { loadAgentParams } from "@/lib/agents/params";
import { labelNoDetectableDifference, LABEL_DESCRIPTIVE } from "./comparisons";
import { LessonError, statementOf } from "./lessons";
import type { LessonGradeRow, LessonRow } from "./schema";

export const LEARN_JOB = "arena-learn";
/** `arena-learn:<market>:<d>`: the concurrency key of the `learn` phase (cf. `arena-3:<market>:<d>`). */
export const learnKey = (market: string, d: string): string => `arena-learn:${market}:${d}`;
export const WORDS_JOB = "arena-words";
/** `arena-words:<market>:<d>`: the concurrency key of the `words` phase. */
export const wordsKey = (market: string, d: string): string => `arena-words:${market}:${d}`;

/** Items listed per section group in the review (the rest are counted). */
const LIST_CAP = 5; // threshold-ok: review list length, not a rule threshold

export type LessonFact = {
  readonly id: string;
  readonly grade: string;
  readonly n: number;
  readonly statement: string;
};

export type LaneAFact = {
  readonly agent: string;
  readonly playbookN: number;
  readonly effectiveD: string;
  readonly added: number;
  readonly removed: number;
};

export type ChallengerFact = {
  readonly id: string;
  readonly state: string;
  readonly ready: boolean;
  readonly shakedownOk: number;
  readonly shakedownTarget: number;
  /** Earliest date the challenger could reach `review` (shakedown only), else null. */
  readonly earliestReviewD: string | null;
  readonly note: string;
};

export type PlanFact = {
  readonly rank: number;
  readonly kind: string;
  readonly reason: string;
  readonly lessonId: string | null;
  readonly lane: string;
  readonly metric: string;
  readonly threshold: string | number;
  readonly checkD: string;
};

export type PlanReviewFact = {
  readonly rank: number;
  readonly planD: string;
  readonly outcome: string;
  readonly reason: string;
};

export type ComparisonFact = {
  readonly pairId: string;
  readonly n: number;
  readonly label: string;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
};

export type FindingFact = {
  readonly pairId: string;
  readonly kind: string;
  readonly label: string;
  readonly estimate: number | null;
  readonly p: number | null;
  readonly n: number;
};

export type LearnFacts = {
  readonly d: string;
  /** The `learn` run of D was partial or degraded (its predecessor was missing or a step failed). */
  readonly partial: boolean;
  readonly lessons: readonly LessonFact[];
  readonly lessonsMore: number;
  readonly laneA: readonly LaneAFact[];
  readonly challengers: readonly ChallengerFact[];
  readonly plan: readonly PlanFact[];
  readonly planReview: readonly PlanReviewFact[];
  readonly comparisons: readonly ComparisonFact[];
  readonly comparisonsNotEnough: number;
  readonly findings: readonly FindingFact[];
  readonly attribution: {
    readonly finalToday: number;
    readonly byExit: readonly { readonly reason: string; readonly n: number }[];
  };
};

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v ?? 0); // money-float-ok: a count read from SQL
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The nth trading session after `d` (n >= 1). */
export function advanceSessions(d: string, n: number, calendar: readonly CalendarRow[]): string {
  let x = d;
  for (let i = 0; i < n; i += 1) x = nextTradingDay(x, calendar);
  return x;
}

/** The trading session after `d`, or null when the calendar has none within its search limit. */
export function nextSessionAfter(d: string, calendar: readonly CalendarRow[]): string | null {
  try {
    return nextTradingDay(d, calendar);
  } catch {
    return null;
  }
}

/** The date of the previous finished `learn` run before `d` (success or degraded), or null. */
export async function previousLearnD(
  db: Client,
  market: string,
  d: string,
): Promise<string | null> {
  const rs = await db.execute({
    sql: `SELECT MAX(scheduled_for) AS d FROM run_record
          WHERE job = ? AND market = ? AND status IN ('success', 'degraded') AND scheduled_for < ?`,
    args: [LEARN_JOB, market, d],
  });
  return rs.rows.length === 0 || rs.rows[0]!.d === null ? null : str(rs.rows[0]!.d);
}

function lessonRow(r: Record<string, unknown>): LessonRow {
  return {
    id: str(r.id),
    market: str(r.market),
    scope: str(r.scope) as LessonRow["scope"],
    lineage_id: r.lineage_id === null ? null : str(r.lineage_id),
    template_id: str(r.template_id),
    template_version: num(r.template_version),
    subject_json: str(r.subject_json),
    rule_version: str(r.rule_version),
    metric: str(r.metric),
    direction: num(r.direction) < 0 ? -1 : 1,
    param_hint: r.param_hint === null ? null : str(r.param_hint),
    created_d: str(r.created_d),
    created_run: str(r.created_run),
  };
}

function gradeRow(r: Record<string, unknown>): LessonGradeRow {
  return {
    lesson_id: str(r.lesson_id),
    seq: num(r.seq),
    grade: str(r.grade) as LessonGradeRow["grade"],
    split_version: num(r.split_version),
    window: r.window === null ? null : (str(r.window) as "l1" | "l2"),
    n: num(r.n),
    blocks: num(r.blocks),
    estimate: numOrNull(r.estimate),
    lower: numOrNull(r.lower),
    upper: numOrNull(r.upper),
    p: numOrNull(r.p),
    alpha_j: numOrNull(r.alpha_j),
    B: num(r.B),
    state_text: str(r.state_text),
    reachable_d: r.reachable_d === null ? null : str(r.reachable_d),
    run_id: str(r.run_id),
    d: str(r.d),
    corrects_seq: numOrNull(r.corrects_seq),
  };
}

const GRADE_RANK: Readonly<Record<string, number>> = { L3: 4, L2: 3, L1: 2, L0: 1, retired: 0 }; // threshold-ok: ordering rank

/** The stored lesson's wording; a lesson whose template is gone is shown by grade, never failing the review. */
function statementText(
  lesson: LessonRow,
  grade: LessonGradeRow,
  params: AgentParams,
  family: string | null,
): string {
  try {
    return statementOf(lesson, grade, params, family);
  } catch (error) {
    if (error instanceof LessonError)
      return `graded ${grade.grade}; its wording template is no longer available.`;
    throw error;
  }
}

async function lessonFacts(
  db: Client,
  market: string,
  d: string,
  afterD: string | null,
  params: AgentParams,
): Promise<{ lessons: LessonFact[]; more: number }> {
  const rs = await db.execute({
    sql: `SELECT l.*, g.lesson_id, g.seq, g.grade, g.split_version, g.window, g.n, g.blocks, g.estimate,
                 g.lower, g.upper, g.p, g.alpha_j, g.B, g.state_text, g.reachable_d, g.run_id, g.d,
                 g.corrects_seq
          FROM lesson l JOIN lesson_grade g ON g.lesson_id = l.id
          WHERE l.market = ? AND g.d <= ? AND (? IS NULL OR g.d > ?)
            AND g.seq = (SELECT MAX(seq) FROM lesson_grade x WHERE x.lesson_id = l.id AND x.d <= ?)
          ORDER BY l.id`,
    args: [market, d, afterD, afterD, d],
  });
  const all = rs.rows
    .map((r) => ({
      lesson: lessonRow(r as Record<string, unknown>),
      grade: gradeRow(r as Record<string, unknown>),
    }))
    .filter((x) => x.grade.grade !== "L0")
    .sort(
      (a, b) =>
        (GRADE_RANK[b.grade.grade] ?? 0) - (GRADE_RANK[a.grade.grade] ?? 0) ||
        (a.lesson.id < b.lesson.id ? -1 : 1),
    );
  const shown = all.slice(0, LIST_CAP).map((x): LessonFact => {
    const family =
      x.lesson.lineage_id === null ? null : (x.lesson.lineage_id.split(":")[1] ?? null);
    return {
      id: x.lesson.id,
      grade: x.grade.grade,
      n: x.grade.n,
      statement: statementText(x.lesson, x.grade, params, family),
    };
  });
  return { lessons: shown, more: all.length - shown.length };
}

async function laneAFacts(
  db: Client,
  market: string,
  d: string,
  calendar: readonly CalendarRow[],
): Promise<LaneAFact[]> {
  const next = nextSessionAfter(d, calendar);
  if (next === null) return [];
  const rs = await db.execute({
    sql: `SELECT target, after_json, lesson_ids_json, effective_d FROM change_ledger
          WHERE market = ? AND kind = 'lane_a_playbook' AND effective_d > ? AND effective_d <= ?
          ORDER BY id`,
    args: [market, d, next],
  });
  return rs.rows.map((r) => {
    const after = JSON.parse(str(r.after_json)) as { n?: number };
    const ids = JSON.parse(str(r.lesson_ids_json)) as { added?: string[]; removed?: string[] };
    return {
      agent: str(r.target).replace(/^playbook\//, ""),
      playbookN: num(after.n),
      effectiveD: str(r.effective_d),
      added: (ids.added ?? []).length,
      removed: (ids.removed ?? []).length,
    };
  });
}

async function challengerFacts(
  db: Client,
  d: string,
  calendar: readonly CalendarRow[],
  params: AgentParams,
): Promise<ChallengerFact[]> {
  const rs = await db.execute({
    sql: `SELECT id, state, ready, shakedown_ok_sessions FROM challenger
          WHERE state IN ('proposed','replay','shakedown','review','approved') AND state_d <= ?
          ORDER BY id`,
    args: [d],
  });
  const target = params.learning.shakedownSessions;
  return rs.rows.slice(0, LIST_CAP).map((r): ChallengerFact => {
    const state = str(r.state);
    const ok = num(r.shakedown_ok_sessions);
    const ready = num(r.ready) === 1;
    let earliest: string | null = null;
    let note: string;
    if (state === "shakedown") {
      const left = Math.max(0, target - ok);
      earliest = left === 0 ? d : advanceSessions(d, left, calendar);
      note = `${ok} of ${target} shakedown sessions; it could reach review on ${earliest}, then needs your approval and the next group restart before promotion`;
    } else if (state === "review") {
      note = ready
        ? "all Critic checks pass; waiting for your approval, then promotion at the next group restart"
        : "waiting for the Critic checks to pass and for your approval before promotion";
    } else if (state === "approved") {
      note = "approved; promotion at the next group restart";
    } else {
      note = "waiting for enough validation entries and its evidence run";
    }
    return {
      id: str(r.id),
      state,
      ready,
      shakedownOk: ok,
      shakedownTarget: target,
      earliestReviewD: earliest,
      note,
    };
  });
}

async function planFacts(db: Client, market: string, d: string): Promise<PlanFact[]> {
  const rs = await db.execute({
    sql: "SELECT rank, kind, reason, lesson_id, lane, measure_json FROM plan_item WHERE market = ? AND d = ? ORDER BY rank",
    args: [market, d],
  });
  return rs.rows.map((r) => {
    const m = JSON.parse(str(r.measure_json)) as {
      metric: string;
      threshold: string | number;
      check_d: string;
    };
    return {
      rank: num(r.rank),
      kind: str(r.kind),
      reason: str(r.reason),
      lessonId: r.lesson_id === null ? null : str(r.lesson_id),
      lane: str(r.lane),
      metric: m.metric,
      threshold: m.threshold,
      checkD: m.check_d,
    };
  });
}

async function planReviewFacts(db: Client, market: string, d: string): Promise<PlanReviewFact[]> {
  const rs = await db.execute({
    sql: `SELECT r.rank, r.plan_d, r.outcome, p.reason FROM plan_review r
          JOIN plan_item p ON p.market = r.market AND p.d = r.plan_d AND p.rank = r.rank
          WHERE r.market = ? AND r.reviewed_d = ? ORDER BY r.plan_d, r.rank`,
    args: [market, d],
  });
  return rs.rows.map((r) => ({
    rank: num(r.rank),
    planD: str(r.plan_d),
    outcome: str(r.outcome),
    reason: str(r.reason),
  }));
}

async function comparisonFacts(
  db: Client,
  market: string,
  d: string,
): Promise<{ rows: ComparisonFact[]; notEnough: number; findings: FindingFact[] }> {
  const rs = await db.execute({
    sql: `SELECT kind, pair_id, n_a, n_b, estimate, lower, upper, p, discovery, label
          FROM comparison_result WHERE market = ? AND d = ? ORDER BY kind, pair_id`,
    args: [market, d],
  });
  const rows: ComparisonFact[] = [];
  const findings: FindingFact[] = [];
  let notEnough = 0;
  for (const r of rs.rows) {
    const kind = str(r.kind);
    const n = Math.min(num(r.n_a), num(r.n_b));
    if (kind === "nightly") {
      if (r.estimate === null) {
        notEnough += 1;
        continue;
      }
      rows.push({
        pairId: str(r.pair_id),
        n,
        label: str(r.label),
        estimate: numOrNull(r.estimate),
        lower: numOrNull(r.lower),
        upper: numOrNull(r.upper),
      });
    } else if (kind === "look" || num(r.discovery) === 1) {
      findings.push({
        pairId: str(r.pair_id),
        kind,
        label: str(r.label),
        estimate: numOrNull(r.estimate),
        p: numOrNull(r.p),
        n,
      });
    }
  }
  return { rows, notEnough, findings };
}

async function attributionFacts(
  db: Client,
  market: string,
  d: string,
): Promise<LearnFacts["attribution"]> {
  const rs = await db.execute({
    sql: `SELECT COALESCE(json_extract(tags_json, '$.exit.reason'), 'no exit recorded') AS reason, COUNT(*) AS n
          FROM attribution WHERE market = ? AND d = ? AND final = 1 AND subject_kind IN ('trade', 'ledger_row')
          GROUP BY 1 ORDER BY 2 DESC, 1`,
    args: [market, d],
  });
  const byExit = rs.rows.map((r) => ({ reason: str(r.reason), n: num(r.n) }));
  return { finalToday: byExit.reduce((s, x) => s + x.n, 0), byExit };
}

/** The A6 facts of D, or null when the market has no `learn` run record for D. */
export async function readLearnFacts(
  db: Client,
  o: { market: string; d: string; calendar: readonly CalendarRow[]; params?: AgentParams },
): Promise<LearnFacts | null> {
  const run = await db.execute({
    sql: `SELECT status FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded')
          ORDER BY id DESC LIMIT 1`,
    args: [learnKey(o.market, o.d)],
  });
  if (run.rows.length === 0) return null;
  const params = o.params ?? (await loadAgentParams(db));
  const afterD = await previousLearnD(db, o.market, o.d);
  const les = await lessonFacts(db, o.market, o.d, afterD, params);
  const cmp = await comparisonFacts(db, o.market, o.d);
  return {
    d: o.d,
    partial: str(run.rows[0]!.status) === "degraded",
    lessons: les.lessons,
    lessonsMore: les.more,
    laneA: await laneAFacts(db, o.market, o.d, o.calendar),
    challengers: await challengerFacts(db, o.d, o.calendar, params),
    plan: await planFacts(db, o.market, o.d),
    planReview: await planReviewFacts(db, o.market, o.d),
    comparisons: cmp.rows.slice(0, LIST_CAP),
    comparisonsNotEnough: cmp.notEnough,
    findings: cmp.findings.slice(0, LIST_CAP),
    attribution: await attributionFacts(db, o.market, o.d),
  };
}

// ---- sentences (the facts-only lists) ---------------------------------------------------------------------------

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

export type LearnLines = { s4: string[]; s5: string[]; s6: string[] };

const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  done: "done",
  not_done: "not done",
  met: "measure met",
  not_met: "measure not met",
  not_yet_due: "not yet due",
};

/** Sections 4-6 lines from the A6 facts: grades with their wording, Lane A, challengers, findings, plan. */
export function learnLines(f: LearnFacts): LearnLines {
  const s4: string[] = [];
  const s5: string[] = [];
  const s6: string[] = [];
  if (f.partial) s4.push("Tonight's learning step ran on partial inputs.");
  if (f.lessons.length === 0) s4.push("No lesson was graded or changed since the previous review.");
  for (const l of f.lessons) s4.push(`Lesson ${l.id} (${l.grade}, n = ${l.n}): ${l.statement}`);
  if (f.lessonsMore > 0) {
    s4.push(
      `${f.lessonsMore} more ${plural(f.lessonsMore, "lesson")} changed; see the lessons list.`,
    );
  }
  for (const a of f.laneA) {
    s4.push(
      `Playbook ${a.agent} changes from ${a.effectiveD} (version ${a.playbookN}; ${a.added} ${plural(a.added, "lesson")} added, ${a.removed} removed).`,
    );
  }
  if (f.laneA.length === 0) s4.push("No agent playbook changes at the next session.");
  for (const c of f.challengers) s4.push(`Challenger ${c.id} is in ${c.state}: ${c.note}.`);

  for (const x of f.findings) {
    s5.push(
      x.kind === "look"
        ? `${x.pairId}: ${x.label} (estimate ${x.estimate}, p = ${x.p}, n = ${x.n}).`
        : `${x.pairId}: ${x.label} (p = ${x.p}, n = ${x.n}); one confirmation look follows.`,
    );
  }
  for (const c of f.comparisons) {
    const excludes = c.lower !== null && c.upper !== null && (c.lower > 0 || c.upper < 0);
    s5.push(
      excludes
        ? `${c.pairId}: ${LABEL_DESCRIPTIVE} — difference ${c.estimate} (interval ${c.lower} to ${c.upper}, n = ${c.n}).`
        : `${c.pairId}: ${labelNoDetectableDifference(c.n)}.`,
    );
  }
  if (f.comparisonsNotEnough > 0) {
    s5.push(
      `${f.comparisonsNotEnough} ${plural(f.comparisonsNotEnough, "comparison")}: not enough data yet.`,
    );
  }
  if (f.attribution.finalToday > 0) {
    const by = f.attribution.byExit.map((x) => `${x.reason} ${x.n}`).join(", ");
    s5.push(
      f.attribution.finalToday === 1
        ? `1 position finished and was attributed today (exits: ${by}).`
        : `${f.attribution.finalToday} positions finished and were attributed today (exits: ${by}).`,
    );
  } else {
    s5.push("No position finished today, so no new attribution is final.");
  }

  for (const r of f.planReview) {
    s6.push(
      `Plan of ${r.planD}, item ${r.rank} (${r.reason}): ${OUTCOME_TEXT[r.outcome] ?? r.outcome}.`,
    );
  }
  if (f.plan.length === 0) s6.push("No plan items for the next session.");
  for (const p of f.plan) {
    s6.push(
      `Plan item ${p.rank} (${p.lane}): ${p.reason}; measure ${p.metric} ${p.threshold} by ${p.checkD}.`,
    );
  }
  return { s4, s5, s6 };
}

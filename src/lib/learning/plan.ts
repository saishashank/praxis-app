// The nightly plan and its review (M6 T11; ARN-066, docs/M6_design.md 4.2 step 7, decision 36; D-123).
//
// Candidates come from the stored state of D in a fixed priority:
//   1 Lane-A changes effective at the next session      (lane A,  measure: the playbook version is in force)
//   2 challenger steps due (review, approved)           (lane B,  measure: the challenger left that state)
//   3 lessons whose L2 test becomes reachable           (lane A,  measure: the lesson has a newer grade row)
//   4 open data weaknesses (quality flags, sources off) (lane ops, measure: fewer open flags / source on)
//   5 open candidate findings with their look date      (lane A,  measure: the finding left `candidate`)
// The first `PLAN_MAX_ITEMS` by (priority, id) are written as `plan_item` rows (rank 1..5); each item
// carries its reason, the lesson id (or `no-lesson:<kind>` in the reason), the lane and a success
// measure {metric, threshold, check_d}. The NEXT night every item of the latest earlier plan gets one
// `plan_review` row: the measure is evaluated when its check date has come (done / not_done for
// the Lane-A items, met / not_met for the rest), else `not_yet_due`. Both tables are append-only, so a
// `not_yet_due` row is the final review of that item (D-123).
//
// Pure selection; DB reads bounded by D; writes are `ON CONFLICT DO NOTHING` (idempotent re-runs).
import type { Client } from "@libsql/client";
import type { CalendarRow } from "@/lib/data/calendar";
import { nextSessionAfter } from "./learnFacts";

/** ARN-066: at most five items (also the CHECK of `plan_item.rank`). */
export const PLAN_MAX_ITEMS = 5; // threshold-ok: ARN-066 plan size, fixed by the table's rank CHECK

export type PlanKind =
  "lane_a_change" | "challenger_step" | "l2_reachable" | "data_weakness" | "finding_look";

export type PlanMeasure = {
  readonly metric: string;
  readonly threshold: string | number;
  readonly check_d: string;
  /** Kind-specific reference the evaluation needs (state at planning time, playbook version, ...). */
  readonly ref: Readonly<Record<string, string | number | null>>;
};

export type PlanCandidate = {
  readonly priority: number;
  /** Stable tie-break inside a priority. */
  readonly id: string;
  readonly kind: PlanKind;
  readonly reason: string;
  readonly lessonId: string | null;
  readonly lane: "A" | "B" | "ops";
  readonly measure: PlanMeasure;
};

const PRIORITY: Readonly<Record<PlanKind, number>> = {
  lane_a_change: 1,
  challenger_step: 2,
  l2_reachable: 3, // threshold-ok: ARN-066 fixed priority order
  data_weakness: 4, // threshold-ok: ARN-066 fixed priority order
  finding_look: 5, // threshold-ok: ARN-066 fixed priority order
};

const str = (v: unknown): string => String(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (v: unknown): number => Number(v ?? 0); // money-float-ok: a count read from SQL

/** The first `PLAN_MAX_ITEMS` candidates by (priority, id), ranked from 1. Pure. */
export function selectPlan(cands: readonly PlanCandidate[]): PlanCandidate[] {
  return [...cands]
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, PLAN_MAX_ITEMS);
}

/** The reason text of an item without a lesson starts with `no-lesson:<kind>` (table CHECK). */
export function reasonFor(kind: PlanKind, lessonId: string | null, text: string): string {
  return lessonId === null ? `no-lesson:${kind}: ${text}` : text;
}

export type CandidateInput = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** The Lane-A changes this run wrote (effective at the next session). */
  readonly laneAChanges: readonly {
    readonly agent: string;
    readonly playbookN: number;
    readonly effectiveD: string;
    readonly addedLessonIds: readonly string[];
    readonly removedLessonIds: readonly string[];
  }[];
};

function candidate(
  kind: PlanKind,
  id: string,
  lessonId: string | null,
  lane: PlanCandidate["lane"],
  text: string,
  measure: PlanMeasure,
): PlanCandidate {
  return {
    priority: PRIORITY[kind],
    id,
    kind,
    reason: reasonFor(kind, lessonId, text),
    lessonId,
    lane,
    measure,
  };
}

/** All candidates of D from the stored state, unordered. */
export async function planCandidates(db: Client, i: CandidateInput): Promise<PlanCandidate[]> {
  const out: PlanCandidate[] = [];
  const next = nextSessionAfter(i.d, i.calendar);
  const checkD = next ?? i.d;

  // one item for all playbooks that change tonight (six agents must not crowd out the other items)
  if (i.laneAChanges.length > 0) {
    const changes = [...i.laneAChanges].sort((x, y) => (x.agent < y.agent ? -1 : 1));
    const lessonId =
      changes.flatMap((c) => [...c.addedLessonIds, ...c.removedLessonIds]).sort(cmp)[0] ?? null;
    const effective = changes[0]!.effectiveD;
    const agents = changes.map((c) => c.agent).join(", ");
    out.push(
      candidate(
        "lane_a_change",
        "playbooks",
        lessonId,
        "A",
        `playbook ${agents} change${changes.length === 1 ? "s" : ""} on ${effective}`,
        {
          metric: "playbook_in_force",
          threshold: changes.length,
          check_d: effective,
          ref: { changes: changes.map((c) => `${c.agent}:${c.playbookN}`).join(",") },
        },
      ),
    );
  }

  const ch = await db.execute({
    sql: `SELECT id, state, lesson_ids_json FROM challenger WHERE state IN ('review','approved')
            AND state_d <= ? AND lineage_id LIKE ? ORDER BY id`,
    args: [i.d, `${i.market}:%`],
  });
  for (const r of ch.rows) {
    const lessons = JSON.parse(str(r.lesson_ids_json)) as string[];
    const state = str(r.state);
    out.push(
      candidate(
        "challenger_step",
        str(r.id),
        lessons[0] ?? null,
        "B",
        state === "review"
          ? `challenger ${str(r.id)} in review is waiting for the Critic checks and the Owner's approval`
          : `challenger ${str(r.id)} is approved and is promoted at the next group restart`,
        {
          metric: "challenger_left_state",
          threshold: state,
          check_d: checkD,
          ref: { challenger: str(r.id), state },
        },
      ),
    );
  }

  const ls = await db.execute({
    sql: `SELECT g.lesson_id, g.seq, g.reachable_d FROM lesson_grade g JOIN lesson l ON l.id = g.lesson_id
          WHERE l.market = ? AND g.d <= ? AND g.grade = 'L1' AND g.reachable_d IS NOT NULL
            AND g.reachable_d <= ?
            AND g.seq = (SELECT MAX(seq) FROM lesson_grade x WHERE x.lesson_id = l.id AND x.d <= ?)
          ORDER BY g.lesson_id`,
    args: [i.market, i.d, checkD, i.d],
  });
  for (const r of ls.rows) {
    out.push(
      candidate(
        "l2_reachable",
        str(r.lesson_id),
        str(r.lesson_id),
        "A",
        `the L2 test of lesson ${str(r.lesson_id)} becomes reachable on ${str(r.reachable_d)}`,
        {
          metric: "lesson_grade_seq",
          threshold: num(r.seq) + 1,
          check_d: checkD,
          ref: { lesson: str(r.lesson_id) },
        },
      ),
    );
  }

  const fl = await db.execute({
    sql: `SELECT check_id, COUNT(*) AS n FROM data_quality_flag
          WHERE market = ? AND d <= ? AND cleared_at IS NULL GROUP BY check_id ORDER BY check_id`,
    args: [i.market, i.d],
  });
  for (const r of fl.rows) {
    const n = num(r.n);
    out.push(
      candidate(
        "data_weakness",
        `flags:${str(r.check_id)}`,
        null,
        "ops",
        `${n} open data-quality ${n === 1 ? "flag" : "flags"} of check ${str(r.check_id)}`,
        {
          metric: `open_quality_flags:${str(r.check_id)}`,
          threshold: n - 1,
          check_d: checkD,
          ref: { check: str(r.check_id) },
        },
      ),
    );
  }
  const so = await db.execute({
    sql: "SELECT source, mode FROM source_status WHERE mode <> 'on' ORDER BY source",
    args: [],
  });
  for (const r of so.rows) {
    out.push(
      candidate(
        "data_weakness",
        `source:${str(r.source)}`,
        null,
        "ops",
        `source ${str(r.source)} is ${str(r.mode)}`,
        {
          metric: `source_mode:${str(r.source)}`,
          threshold: "on",
          check_d: checkD,
          ref: { source: str(r.source) },
        },
      ),
    );
  }

  const fi = await db.execute({
    sql: `SELECT id, pair_id, look_due_d FROM comparison_finding
          WHERE state = 'candidate' AND detected_d <= ? ORDER BY id`,
    args: [i.d],
  });
  for (const r of fi.rows) {
    out.push(
      candidate(
        "finding_look",
        str(r.id),
        null,
        "A",
        `candidate finding on ${str(r.pair_id)} waits for its confirmation look due ${str(r.look_due_d)}`,
        {
          metric: "finding_state",
          threshold: "confirmed_or_discarded",
          check_d: str(r.look_due_d),
          ref: { finding: str(r.id) },
        },
      ),
    );
  }
  return out;
}

/** Writes the plan of D; a plan that already exists is left alone (one plan per market and day). */
export async function writePlan(
  db: Client,
  market: string,
  d: string,
  items: readonly PlanCandidate[],
): Promise<number> {
  if (items.length === 0) return 0;
  const existing = await db.execute({
    sql: "SELECT 1 FROM plan_item WHERE market = ? AND d = ? LIMIT 1",
    args: [market, d],
  });
  if (existing.rows.length > 0) return 0;
  await db.batch(
    items.map((c, idx) => ({
      sql: `INSERT INTO plan_item (market, d, rank, kind, reason, lesson_id, lane, measure_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [market, d, idx + 1, c.kind, c.reason, c.lessonId, c.lane, JSON.stringify(c.measure)],
    })),
    "write",
  );
  return items.length;
}

// ---- the review of the previous plan ------------------------------------------------------------------

export type ReviewOutcome = "done" | "not_done" | "met" | "not_met" | "not_yet_due";

export type PlanReviewResult = {
  readonly planD: string | null;
  readonly written: number;
  readonly byOutcome: Readonly<Record<string, number>>;
};

type ItemRow = { rank: number; kind: PlanKind; measure: PlanMeasure };

async function openFlags(db: Client, market: string, d: string, check: string): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM data_quality_flag
          WHERE market = ? AND d <= ? AND check_id = ? AND (cleared_at IS NULL)`,
    args: [market, d, check],
  });
  return num(r.rows[0]!.n);
}

/** Evaluates one item at `reviewedD`; reads only rows that existed by then. */
export async function evaluateItem(
  db: Client,
  market: string,
  reviewedD: string,
  item: ItemRow,
): Promise<{ outcome: ReviewOutcome; evidence: Record<string, unknown> }> {
  const m = item.measure;
  if (m.check_d > reviewedD) {
    return { outcome: "not_yet_due", evidence: { check_d: m.check_d } };
  }
  switch (item.kind) {
    case "lane_a_change": {
      const wanted = str(m.ref.changes)
        .split(",")
        .map((x) => x.split(":") as [string, string]);
      const inForce: Record<string, number> = {};
      let done = true;
      for (const [agent, n] of wanted) {
        const r = await db.execute({
          sql: `SELECT MAX(n) AS n FROM playbook_version
                WHERE market = ? AND agent = ? AND effective_d <= ?`,
          args: [market, agent, reviewedD],
        });
        inForce[agent] = r.rows[0]!.n === null ? 0 : num(r.rows[0]!.n);
        if (inForce[agent]! < Number(n)) done = false;
      }
      return {
        outcome: done ? "done" : "not_done",
        evidence: { in_force: inForce, wanted: m.ref.changes },
      };
    }
    case "challenger_step": {
      const r = await db.execute({
        sql: "SELECT state FROM challenger WHERE id = ? AND state_d <= ?",
        args: [str(m.ref.challenger), reviewedD],
      });
      const state = r.rows.length === 0 ? str(m.threshold) : str(r.rows[0]!.state);
      return {
        outcome: state !== str(m.threshold) ? "met" : "not_met",
        evidence: { state, was: m.threshold },
      };
    }
    case "l2_reachable": {
      const r = await db.execute({
        sql: "SELECT MAX(seq) AS s FROM lesson_grade WHERE lesson_id = ? AND d <= ?",
        args: [str(m.ref.lesson), reviewedD],
      });
      const seq = r.rows[0]!.s === null ? 0 : num(r.rows[0]!.s);
      return {
        outcome: seq >= num(m.threshold) ? "met" : "not_met",
        evidence: { seq, wanted: m.threshold },
      };
    }
    case "data_weakness": {
      if (m.metric.startsWith("source_mode:")) {
        const r = await db.execute({
          sql: "SELECT mode FROM source_status WHERE source = ?",
          args: [str(m.ref.source)],
        });
        const mode = r.rows.length === 0 ? "unknown" : str(r.rows[0]!.mode);
        return { outcome: mode === m.threshold ? "met" : "not_met", evidence: { mode } };
      }
      const open = await openFlags(db, market, reviewedD, str(m.ref.check));
      return {
        outcome: open <= num(m.threshold) ? "met" : "not_met",
        evidence: { open, at_most: m.threshold },
      };
    }
    case "finding_look": {
      const r = await db.execute({
        sql: "SELECT state FROM comparison_finding WHERE id = ?",
        args: [str(m.ref.finding)],
      });
      const state = r.rows.length === 0 ? "candidate" : str(r.rows[0]!.state);
      return {
        outcome: state !== "candidate" ? "met" : "not_met",
        evidence: { state },
      };
    }
  }
}

/**
 * Reviews the latest plan before `d` that has no review yet (normally yesterday's). One row per item;
 * a review that exists is never rewritten.
 */
export async function reviewPreviousPlan(
  db: Client,
  market: string,
  d: string,
): Promise<PlanReviewResult> {
  const prev = await db.execute({
    sql: `SELECT MAX(d) AS d FROM plan_item p WHERE p.market = ? AND p.d < ?
            AND NOT EXISTS (SELECT 1 FROM plan_review r WHERE r.market = p.market AND r.plan_d = p.d)`,
    args: [market, d],
  });
  const planD = prev.rows[0]!.d === null ? null : str(prev.rows[0]!.d);
  if (planD === null) return { planD: null, written: 0, byOutcome: {} };
  const items = await db.execute({
    sql: "SELECT rank, kind, measure_json FROM plan_item WHERE market = ? AND d = ? ORDER BY rank",
    args: [market, planD],
  });
  const byOutcome: Record<string, number> = {};
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (const r of items.rows) {
    const item: ItemRow = {
      rank: num(r.rank),
      kind: str(r.kind) as PlanKind,
      measure: JSON.parse(str(r.measure_json)) as PlanMeasure,
    };
    const ev = await evaluateItem(db, market, d, item);
    byOutcome[ev.outcome] = (byOutcome[ev.outcome] ?? 0) + 1;
    stmts.push({
      sql: `INSERT INTO plan_review (market, plan_d, rank, reviewed_d, outcome, evidence_json)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [market, planD, item.rank, d, ev.outcome, JSON.stringify(ev.evidence)],
    });
  }
  if (stmts.length > 0) await db.batch(stmts, "write");
  return { planD, written: stmts.length, byOutcome };
}

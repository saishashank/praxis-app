// Lane A (ARN-064, KB-030..032, AGT-042, M6 design 2.6, decisions 9-12, 22 / D-110, D-118 draft).
// Lane A changes only agent playbook text (and records Owner notes in the ledger). It never touches a
// rule, parameter, filter, watch-list or breaker input (KB-030): the only tables it writes are
// change_ledger, playbook_version and lesson_grade (the L2 -> L3 row). Nightly steps:
//   1. read each lesson's current grade, its latest Critic result and any Owner force-apply;
//   2. eligibility: L2/L3 with passing checks -> Guidance; L1 with passing checks -> Unproven notes;
//      L0 never automatic; a failed check blocks, except an Owner force-apply -> Unproven notes
//      labelled "forced by Owner", grade unchanged, never L3 (decision 22);
//   3. renderPlaybook per agent (template-only, token cap, injection checks);
//   4. changed text -> one change_ledger row per playbook (effective next session, actor A6) and a
//      playbook_version, written in one atomic batch; unchanged text writes nothing;
//   5. each L2 lesson stated under Guidance gets an L3 grade row (adoption).
// The KB version (`kb-<latest context-changing ledger id>`) moves with the ledger rows (kbVersion.ts).
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import { PLAYBOOK_AGENTS, type LessonGradeRow, type LessonRow, type PlaybookAgent } from "./schema";
import {
  renderPlaybook,
  sha256Hex,
  unifiedDiff,
  type PlaybookItem,
  type RenderParams,
  type RenderedPlaybook,
} from "./playbook";
import type { InjectionEvent } from "./injectionChecks";

export const LANE_A_ACTOR = "A6";

export class LaneAError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneAError";
  }
}

/** The AgentParams subset Lane A reads (every threshold is a registry key). */
export function laneAParams(p: AgentParams): RenderParams {
  return {
    playbookMaxTokens: p.learning.playbookMaxTokens,
    injectionPhrases: p.llm.injectionPhrases,
  };
}

/** What the Critic said about a lesson, as far as Lane A needs. */
export type LessonStanding = {
  lesson: LessonRow;
  grade: LessonGradeRow;
  /** Latest Critic result (`critique.passed`); null when the Critic has not run. */
  criticPassed: boolean | null;
  forcedByOwner: boolean;
};

/** Lane-A eligibility: the section a lesson is stated under, or null (not applied). */
export function eligibleSection(s: LessonStanding): "guidance" | "unproven" | null {
  const g = s.grade.grade;
  if (g === "retired") return null;
  if (s.criticPassed === true) {
    if (g === "L2" || g === "L3") return "guidance";
    if (g === "L1") return "unproven";
    // L0 is never applied automatically (decision 12); an Owner force still may.
  }
  return s.forcedByOwner ? "unproven" : null;
}

/** The items for one agent from the lessons; `agentsFor` defaults to every playbook agent. */
export function itemsFor(
  agent: PlaybookAgent,
  standings: readonly LessonStanding[],
  agentsFor: (l: LessonRow) => readonly PlaybookAgent[] = () => PLAYBOOK_AGENTS,
): PlaybookItem[] {
  const out: PlaybookItem[] = [];
  for (const s of standings) {
    if (!agentsFor(s.lesson).includes(agent)) continue;
    const section = eligibleSection(s);
    if (section === null) continue;
    // A forced lesson that also passes the automatic rule is stated as the automatic rule says.
    const auto = s.criticPassed === true && s.grade.grade !== "L0";
    out.push({
      lesson: s.lesson,
      grade: s.grade,
      section,
      forcedByOwner: s.forcedByOwner && !auto,
    });
  }
  return out;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function lessonOf(r: Row): LessonRow {
  return {
    id: str(r.id),
    market: str(r.market),
    scope: str(r.scope) as LessonRow["scope"],
    lineage_id: r.lineage_id === null ? null : str(r.lineage_id),
    template_id: str(r.template_id),
    template_version: Number(r.template_version),
    subject_json: str(r.subject_json),
    rule_version: str(r.rule_version),
    metric: str(r.metric),
    direction: Number(r.direction) as 1 | -1,
    param_hint: r.param_hint === null ? null : str(r.param_hint),
    created_d: str(r.created_d),
    created_run: str(r.created_run),
  };
}

function gradeOf(r: Row): LessonGradeRow {
  return {
    lesson_id: str(r.lesson_id),
    seq: Number(r.seq),
    grade: str(r.grade) as LessonGradeRow["grade"],
    split_version: Number(r.split_version),
    window: r.window === null ? null : (str(r.window) as "l1" | "l2"),
    n: Number(r.n),
    blocks: Number(r.blocks),
    estimate: numOrNull(r.estimate),
    lower: numOrNull(r.lower),
    upper: numOrNull(r.upper),
    p: numOrNull(r.p),
    alpha_j: numOrNull(r.alpha_j),
    B: Number(r.B),
    state_text: str(r.state_text),
    reachable_d: r.reachable_d === null ? null : str(r.reachable_d),
    run_id: str(r.run_id),
    d: str(r.d),
    corrects_seq: numOrNull(r.corrects_seq),
  };
}

/** Lesson ids with an Owner lesson force-apply in the ledger (market). */
export async function forcedLessonIds(db: Client, market: string): Promise<Set<string>> {
  const res = await db.execute({
    sql: `SELECT lesson_ids_json FROM change_ledger WHERE market = ? AND kind = 'lesson_force'`,
    args: [market],
  });
  const out = new Set<string>();
  for (const r of res.rows)
    for (const id of JSON.parse(str(r.lesson_ids_json)) as string[]) out.add(id);
  return out;
}

/** Every lesson of the market with its current grade, latest Critic result and force flag. */
export async function loadStandings(db: Client, market: string): Promise<LessonStanding[]> {
  const lessons = await db.execute({
    sql: `SELECT * FROM lesson WHERE market = ? ORDER BY id`,
    args: [market],
  });
  const forced = await forcedLessonIds(db, market);
  const out: LessonStanding[] = [];
  for (const lr of lessons.rows) {
    const lesson = lessonOf(lr as Row);
    const g = await db.execute({
      sql: `SELECT * FROM lesson_grade WHERE lesson_id = ? ORDER BY seq DESC LIMIT 1`,
      args: [lesson.id],
    });
    if (g.rows.length === 0) continue;
    const c = await db.execute({
      sql: `SELECT passed FROM critique WHERE subject_kind = 'lesson' AND subject_id = ?
            ORDER BY d DESC, run_id DESC LIMIT 1`,
      args: [lesson.id],
    });
    out.push({
      lesson,
      grade: gradeOf(g.rows[0] as Row),
      criticPassed: c.rows.length === 0 ? null : Number(c.rows[0].passed) === 1,
      forcedByOwner: forced.has(lesson.id),
    });
  }
  return out;
}

export type LaneAChange = {
  agent: PlaybookAgent;
  changeId: number;
  playbookN: number;
  sha: string;
  addedLessonIds: string[];
  removedLessonIds: string[];
};

export type LaneAResult = {
  changes: LaneAChange[];
  /** Lessons moved L2 -> L3 by this run. */
  adopted: string[];
  /** Injection events to log (KB-061). */
  events: InjectionEvent[];
  rendered: RenderedPlaybook[];
};

export type LaneAInput = {
  market: string;
  /** The run date (the grade rows' `d`). */
  d: string;
  runId: string;
  /** The next session date: a Lane-A change is effective then (ARN-064). */
  effectiveD: string;
  now: string;
  params: RenderParams;
  agentsFor?: (l: LessonRow) => readonly PlaybookAgent[];
};

async function currentPlaybook(
  db: Client,
  market: string,
  agent: string,
): Promise<{ n: number; content: string; sha: string } | null> {
  const r = await db.execute({
    sql: `SELECT n, content, content_sha FROM playbook_version
          WHERE market = ? AND agent = ? ORDER BY n DESC LIMIT 1`,
    args: [market, agent],
  });
  const row = r.rows[0];
  return row ? { n: Number(row.n), content: str(row.content), sha: str(row.content_sha) } : null;
}

/** Statements of one playbook change: the ledger row, then the version that points at it. */
function changeStatements(
  input: LaneAInput,
  p: RenderedPlaybook,
  prev: { n: number; content: string; sha: string } | null,
  added: string[],
  removed: string[],
  adopted: string[],
) {
  const target = `playbook/${p.agent}`;
  const n = (prev?.n ?? 0) + 1;
  const before = prev ? JSON.stringify({ n: prev.n, sha: prev.sha }) : null;
  const after = JSON.stringify({
    n,
    sha: p.sha,
    tokens: p.tokens,
    included: p.included,
    dropped: p.dropped,
    excluded: p.excluded.map((e) => ({ lesson: e.lessonId, kinds: e.findings.map((f) => f.kind) })),
    adopted,
  });
  return [
    {
      sql: `INSERT INTO change_ledger (market, kind, target, before_json, after_json, diff_text,
              lesson_ids_json, effective_d, actor, created_at)
            VALUES (?, 'lane_a_playbook', ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.market,
        target,
        before,
        after,
        unifiedDiff(prev?.content ?? "", p.content),
        JSON.stringify({ added, removed }),
        input.effectiveD,
        LANE_A_ACTOR,
        input.now,
      ],
    },
    {
      sql: `INSERT INTO playbook_version (market, agent, n, content, content_sha, tokens_est,
              change_id, effective_d)
            VALUES (?, ?, ?, ?, ?, ?, last_insert_rowid(), ?)`,
      args: [input.market, p.agent, n, p.content, p.sha, p.tokens, input.effectiveD],
    },
  ];
}

/** Lesson ids listed in the ledger row's `lesson_ids_json` shape {added, removed}. */
function idsOfContent(content: string): string[] {
  return [...content.matchAll(/^- (L-[^ ]+) /gm)].map((m) => m[1]);
}

/**
 * The nightly Lane-A step. Idempotent: a second run on the same lesson state computes the same
 * playbook text and writes nothing. The write is one atomic batch.
 */
export async function runLaneA(db: Client, input: LaneAInput): Promise<LaneAResult> {
  const standings = await loadStandings(db, input.market);
  const rendered: RenderedPlaybook[] = [];
  const events: InjectionEvent[] = [];
  const stmts: { sql: string; args: (string | number | null)[] }[] = [];
  const changes: LaneAChange[] = [];
  const adopted: string[] = [];
  const adoptable = new Map<string, LessonGradeRow>();

  const pending: { p: RenderedPlaybook; prev: Awaited<ReturnType<typeof currentPlaybook>> }[] = [];
  for (const agent of PLAYBOOK_AGENTS) {
    const items = itemsFor(agent, standings, input.agentsFor);
    const p = renderPlaybook(agent, items, input.params);
    rendered.push(p);
    events.push(...p.excluded);
    for (const it of items) {
      if (it.section === "guidance" && it.grade.grade === "L2" && p.included.includes(it.lesson.id))
        adoptable.set(it.lesson.id, it.grade);
    }
    const prev = await currentPlaybook(db, input.market, agent);
    if (prev === null ? p.included.length === 0 : prev.sha === p.sha) continue;
    pending.push({ p, prev });
  }

  // Adoption is listed on the first ledger row written in this run.
  const adoptIds = [...adoptable.keys()].sort();
  let first = true;
  for (const { p, prev } of pending) {
    const before = idsOfContent(prev?.content ?? "");
    const now = idsOfContent(p.content);
    const added = now.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !now.includes(id));
    stmts.push(...changeStatements(input, p, prev, added, removed, first ? adoptIds : []));
    first = false;
    changes.push({
      agent: p.agent,
      changeId: 0,
      playbookN: (prev?.n ?? 0) + 1,
      sha: p.sha,
      addedLessonIds: added,
      removedLessonIds: removed,
    });
  }
  for (const id of adoptIds) {
    const g = adoptable.get(id) as LessonGradeRow;
    stmts.push({
      sql: `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks,
              estimate, lower, upper, p, alpha_j, B, state_text, reachable_d, run_id, d, corrects_seq)
            VALUES (?, ?, 'L3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      args: [
        id,
        g.seq + 1,
        g.split_version,
        g.window,
        g.n,
        g.blocks,
        g.estimate,
        g.lower,
        g.upper,
        g.p,
        g.alpha_j,
        g.B,
        "adopted via Lane A (all checks passed)",
        g.reachable_d,
        input.runId,
        input.d,
      ],
    });
    adopted.push(id);
  }
  if (stmts.length > 0) {
    await db.batch(stmts, "write");
    for (const c of changes) {
      const r = await db.execute({
        sql: `SELECT change_id FROM playbook_version WHERE market = ? AND agent = ? AND n = ?`,
        args: [input.market, c.agent, c.playbookN],
      });
      c.changeId = Number(r.rows[0].change_id);
    }
  }
  return { changes, adopted, events, rendered };
}

export type ForceApplyInput = {
  market: string;
  lessonId: string;
  /** Owner identity; only the Owner may force-apply (ROL-102), enforced by the caller's route. */
  actor: string;
  /** Reference to the audit-log entry of the action (required). */
  auditRef: string;
  effectiveD: string;
  now: string;
};

/**
 * Owner force-apply of a lesson whose Critic check failed (decision 22): the lesson appears under
 * "Unproven notes" with "forced by Owner", keeps its grade, never becomes L3. Writes one
 * `lesson_force` ledger row (context-changing, so the KB version moves); idempotent per lesson.
 * Returns the ledger id.
 */
export async function forceApplyLesson(db: Client, input: ForceApplyInput): Promise<number> {
  if (input.actor.trim() === "") throw new LaneAError("force-apply needs the Owner as actor");
  if (input.auditRef.trim() === "") throw new LaneAError("force-apply needs an audit reference");
  const standing = (await loadStandings(db, input.market)).find(
    (s) => s.lesson.id === input.lessonId,
  );
  if (!standing) throw new LaneAError(`unknown lesson ${input.lessonId}`);
  if (standing.grade.grade === "retired") throw new LaneAError("a retired lesson cannot be forced");
  const existing = await db.execute({
    sql: `SELECT id FROM change_ledger WHERE market = ? AND kind = 'lesson_force' AND target = ?`,
    args: [input.market, `lesson/${input.lessonId}`],
  });
  if (existing.rows.length > 0) return Number(existing.rows[0].id);
  if (standing.criticPassed !== false && standing.grade.grade !== "L0")
    throw new LaneAError("force-apply is for a lesson whose Critic check failed (or an L0 lesson)");
  const res = await db.execute({
    sql: `INSERT INTO change_ledger (market, kind, target, after_json, lesson_ids_json, effective_d,
            actor, audit_ref, created_at)
          VALUES (?, 'lesson_force', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.market,
      `lesson/${input.lessonId}`,
      JSON.stringify({
        label: "forced by Owner",
        grade: standing.grade.grade,
        section: "Unproven notes",
      }),
      JSON.stringify([input.lessonId]),
      input.effectiveD,
      input.actor,
      input.auditRef,
      input.now,
    ],
  });
  return Number(res.lastInsertRowid);
}

export { sha256Hex };

// "What the system learned" detail loaders (UX-070/071/071a, KB-070, UXN-200/201/208; docs/M7_design.md
// 3 rows 21-24; M7 T18). SERVER ONLY. Families with version history and diffs, lesson cards, one lesson,
// one challenger, the champion/challenger comparison, the change ledger, hypotheses and annotations.
// Masking (DAT-124, UX-009): a masked user (Editor/Viewer without a grant) gets rules-only content: no
// stock code or name (strings go through maskText), no exact date (ISO week), no actor ids, no free
// text written by the Critic's language model, no ledger diffs. The Owner and an unmasked user see the
// stored values. Nothing here writes; the Owner's actions stay in `learning/ownerActions` (D-125).
import "server-only";
import { paramBounds } from "@/lib/agents/families/ruleSchema";
import { readDocument } from "@/lib/learning/readers";
import { LearningMasker } from "@/lib/learning/mask";
import { formatDate, isoWeek } from "@/lib/view/format";
import { loadMaskLookup, maskText, StockAliases } from "@/lib/view/mask";
import { listChallengers } from "@/lib/learning/ownerActions";
import { marketOf, type LoaderEnv, type LoaderState } from "./shell";

export const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;
export type FamilyId = (typeof FAMILIES)[number];
export const isFamilyId = (s: string): s is FamilyId => (FAMILIES as readonly string[]).includes(s);

/** KB-040 lifecycle names, shown as stored (UXN-208). */
export const STAGES = [
  "proposed",
  "replay",
  "shakedown",
  "review",
  "approved",
  "promoted",
  "rejected",
  "retired",
] as const;

const COMPARE_MIN = 2; // threshold-ok: UXN-208 selects 2 to 5 items
const COMPARE_MAX = 5; // threshold-ok: UXN-208 selects 2 to 5 items
const MAX_ID = 200; // threshold-ok: id length guard (as the routes)
const LEDGER_ROWS = 30; // threshold-ok: rows of the change ledger shown
const HYPOTHESES_SHOWN = 20; // threshold-ok: hypotheses shown at once
const DIFF_CHARS = 300; // threshold-ok: characters of a ledger diff shown
const ID_RE = /^[^\s\u0000-\u001f]+$/;
const SIG = 4; // threshold-ok: significant digits of a reported statistic

/** A calendar day for display: the exact date, or its ISO week for a masked user. */
export function dayText(d: string | null | undefined, masked: boolean): string {
  if (d === null || d === undefined) return "n/a";
  return masked ? (isoWeek(d) ?? "n/a") : formatDate(d);
}

const num = (v: unknown): number => Number(v); // money-float-ok: a count or ordinal read from SQL
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const ratio = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v); // money-float-ok: a stored statistic

/** Masks one string: unknown codes become "Another stock" (empty active set). */
async function textMasker(env: LoaderEnv): Promise<(s: string) => string> {
  if (!env.mask.masked) return (s) => s;
  const lookup = await loadMaskLookup(env.main, marketOf(env));
  const none = new StockAliases([]);
  return (s) => maskText(s, none, lookup);
}

// ---- grades (UXN-200) --------------------------------------------------------------------------------------------

export const GRADE_TEXT: Readonly<Record<string, string>> = {
  L0: "Observation only",
  L1: "Held up in the first two-thirds of the history",
  L2: "Held up in the last third that was kept aside",
  L3: "Adopted",
  retired: "Retired",
};

export type LessonCard = {
  id: string;
  headline: string;
  family: string;
  grade: string | null;
  gradeText: string;
  metric: string;
  n: number | null;
  createdDay: string;
};

type LessonQuery = { grade?: string; family?: string; q?: string };

/** Lesson cards with the latest grade row's n (UXN-200): headline, grade badge, metric, n. */
export async function loadLessonCards(env: LoaderEnv, q: LessonQuery): Promise<LessonCard[]> {
  const args: (string | number)[] = [marketOf(env)];
  let where = "l.market = ?";
  if (q.family !== undefined) {
    where += " AND l.rule_version LIKE ?";
    args.push(`${q.family}.%`);
  }
  if (q.q !== undefined) {
    const esc = "ESCAPE '\\'";
    where += ` AND (lower(l.id) LIKE ? ${esc} OR lower(l.template_id) LIKE ? ${esc} OR lower(l.metric) LIKE ? ${esc})`;
    const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like);
  }
  const rs = await env.main.execute({
    sql: `SELECT l.id, l.template_id, l.rule_version, l.metric, l.created_d,
                 (SELECT g.grade FROM lesson_grade g WHERE g.lesson_id = l.id ORDER BY g.seq DESC LIMIT 1) AS grade,
                 (SELECT g.n FROM lesson_grade g WHERE g.lesson_id = l.id ORDER BY g.seq DESC LIMIT 1) AS n
          FROM lesson l WHERE ${where} ORDER BY l.created_d DESC, l.id LIMIT 200`,
    args,
  });
  const masked = env.mask.masked;
  return rs.rows
    .map((r) => {
      const grade = optStr(r.grade);
      return {
        id: str(r.id),
        headline: headlineOf(str(r.template_id)),
        family: str(r.rule_version).split(".")[0] ?? "",
        grade,
        gradeText: grade === null ? "No grade yet" : (GRADE_TEXT[grade] ?? "No grade yet"),
        metric: str(r.metric).replace(/_/g, " "),
        n: r.n === null || r.n === undefined ? null : num(r.n),
        createdDay: dayText(str(r.created_d), masked),
      };
    })
    .filter((x) => q.grade === undefined || x.grade === q.grade);
}

function headlineOf(template: string): string {
  const t = template.replace(/[_-]+/g, " ").trim();
  return t.length === 0 ? "Lesson" : t.charAt(0).toUpperCase() + t.slice(1);
}

// ---- families (UX-070) -------------------------------------------------------------------------------------------

export type ParamRow = { key: string; value: string; min: number | null; max: number | null };
export type ParamChange = { key: string; from: string; to: string };
export type VersionRow = {
  id: string;
  n: number;
  origin: string;
  parent: string | null;
  registeredDay: string;
  status: string;
  /** True when the version was live at some time (a rollback target). */
  wasLive: boolean;
  params: ParamRow[];
  changes: ParamChange[];
};
export type FamilyView = {
  family: FamilyId;
  state: LoaderState;
  masked: boolean;
  liveId: string | null;
  versions: VersionRow[];
  lessons: LessonCard[];
  challengers: ChallengerCard[];
  document: { title: string; body: string } | null;
};
export type ChallengerCard = {
  id: string;
  family: string;
  state: string;
  stateDay: string;
  origin: string;
  ready: boolean;
};

function paramMap(json: unknown): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(str(json));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
const shownValue = (v: unknown): string =>
  typeof v === "number" || typeof v === "string" || typeof v === "boolean"
    ? String(v)
    : JSON.stringify(v);

function diffParams(parent: Record<string, unknown>, own: Record<string, unknown>): ParamChange[] {
  const keys = [...new Set([...Object.keys(parent), ...Object.keys(own)])].sort();
  return keys
    .filter((k) => JSON.stringify(parent[k]) !== JSON.stringify(own[k]))
    .map((k) => ({
      key: k,
      from: k in parent ? shownValue(parent[k]) : "not set",
      to: k in own ? shownValue(own[k]) : "not set",
    }));
}

function toChallengerCard(env: LoaderEnv, x: Record<string, unknown>): ChallengerCard {
  return {
    id: str(x.id),
    family: str(x.family),
    state: str(x.state),
    stateDay: dayText(str(x.state_d), env.mask.masked),
    origin: str(x.origin),
    ready: Number(x.ready) === 1,
  };
}

/** Every rule version of a family: status, parameters with their bounds, and what changed from the parent. */
export async function loadFamilyVersions(env: LoaderEnv, family: FamilyId): Promise<VersionRow[]> {
  const rs = await env.main.execute({
    sql: `SELECT r.id, r.n, r.origin, r.parent, r.registered_d, r.params_json,
                 (SELECT s.status FROM rule_version_status s WHERE s.rule_version_id = r.id
                  ORDER BY s.seq DESC LIMIT 1) AS status,
                 EXISTS (SELECT 1 FROM rule_version_status w WHERE w.rule_version_id = r.id
                         AND w.status = 'live') AS was_live
          FROM rule_version r WHERE r.market = ? AND r.family = ? ORDER BY r.n DESC LIMIT 100`,
    args: [marketOf(env), family],
  });
  const params = new Map(rs.rows.map((r) => [str(r.id), paramMap(r.params_json)]));
  return rs.rows.map((r) => {
    const own = params.get(str(r.id)) ?? {};
    const parent = optStr(r.parent);
    const base = parent === null ? null : (params.get(parent) ?? null);
    return {
      id: str(r.id),
      n: num(r.n),
      origin: str(r.origin),
      parent,
      registeredDay: dayText(str(r.registered_d), env.mask.masked),
      status: optStr(r.status) ?? "registered",
      wasLive: Number(r.was_live) === 1,
      params: Object.keys(own)
        .sort()
        .map((k) => {
          const b = paramBounds(k);
          return {
            key: k,
            value: shownValue(own[k]),
            min: b === null ? null : b[0],
            max: b === null ? null : b[1],
          };
        }),
      changes: base === null ? [] : diffParams(base, own),
    };
  });
}

/** The index cards: the live version of each family and how much is known about it. */
export type FamilySummary = {
  family: FamilyId;
  liveId: string | null;
  versions: number;
  lessons: number;
  challengers: number;
};
export async function loadFamilySummaries(env: LoaderEnv): Promise<FamilySummary[]> {
  const [v, l, c] = await Promise.all([
    env.main.execute({
      sql: `SELECT r.family, COUNT(*) AS n,
                   (SELECT x.id FROM rule_version x WHERE x.market = r.market AND x.family = r.family
                      AND (SELECT s.status FROM rule_version_status s WHERE s.rule_version_id = x.id
                           ORDER BY s.seq DESC LIMIT 1) = 'live' ORDER BY x.n DESC LIMIT 1) AS live
            FROM rule_version r WHERE r.market = ? GROUP BY r.family`,
      args: [marketOf(env)],
    }),
    env.main.execute({
      sql: `SELECT substr(rule_version, 1, instr(rule_version, '.') - 1) AS family, COUNT(*) AS n
            FROM lesson WHERE market = ? AND instr(rule_version, '.') > 0 GROUP BY 1`,
      args: [marketOf(env)],
    }),
    listChallengers(env.main),
  ]);
  return FAMILIES.map((f) => {
    const vr = v.rows.find((r) => str(r.family) === f);
    return {
      family: f,
      liveId: vr ? optStr(vr.live) : null,
      versions: vr ? num(vr.n) : 0,
      lessons: num(l.rows.find((r) => str(r.family) === f)?.n ?? 0),
      challengers: c.filter((x) => str(x.family) === f).length,
    };
  });
}

export async function loadFamily(env: LoaderEnv, family: FamilyId): Promise<FamilyView> {
  const [versions, lessons, all, doc] = await Promise.all([
    loadFamilyVersions(env, family),
    loadLessonCards(env, { family }),
    listChallengers(env.main),
    readDocument(env.main, {
      market: marketOf(env),
      path: `knowledge/${marketOf(env).toLowerCase()}/families/${family}.md`,
    }),
  ]);
  let document: FamilyView["document"] = null;
  if (doc !== null) {
    const shown = env.mask.masked
      ? await new LearningMasker(env.main, marketOf(env)).document(doc)
      : doc;
    const front = shown.front as { title?: unknown } | null;
    document = {
      title: typeof front?.title === "string" ? front.title : `Family ${family}`,
      body: shown.body,
    };
  }
  const challengers = all
    .filter((x) => str(x.family) === family)
    .map((x) => toChallengerCard(env, x));
  return {
    family,
    state: versions.length + lessons.length + challengers.length > 0 ? "ok" : "empty",
    masked: env.mask.masked,
    liveId: versions.find((v) => v.status === "live")?.id ?? null,
    versions,
    lessons,
    challengers,
    document,
  };
}

// ---- challengers and lessons -------------------------------------------------------------------------------------

export type CheckLine = { n: number; name: string; state: string; detail: string };
export type CritiqueView = {
  day: string;
  passed: boolean;
  checks: CheckLine[];
  /** Language-model notes; the Owner and unmasked users only (free text). */
  notes: { kind: string; text: string }[];
} | null;

async function loadCritique(
  env: LoaderEnv,
  kind: "lesson" | "challenger",
  id: string,
): Promise<CritiqueView> {
  const mask = await textMasker(env);
  const [c, notes] = await Promise.all([
    env.main.execute({
      sql: `SELECT checks_json, passed, d FROM critique WHERE subject_kind = ? AND subject_id = ?
            ORDER BY d DESC, run_id DESC LIMIT 1`,
      args: [kind, id],
    }),
    env.mask.masked
      ? Promise.resolve({ rows: [] as Record<string, unknown>[] })
      : env.main.execute({
          sql: `SELECT kind, text FROM critique_note WHERE subject_kind = ? AND subject_id = ?
                ORDER BY run_id DESC, kind`,
          args: [kind, id],
        }),
  ]);
  const row = c.rows[0];
  if (row === undefined) return null;
  let checks: CheckLine[] = [];
  try {
    const parsed: unknown = JSON.parse(str(row.checks_json));
    const list = Array.isArray(parsed) ? parsed : [];
    checks = list.map((x, i) => {
      const o = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
      return {
        n: typeof o.n === "number" ? o.n : i + 1,
        name: mask(typeof o.name === "string" ? o.name : "Check"),
        state: typeof o.state === "string" ? o.state : "pending",
        detail: mask(typeof o.detail === "string" ? o.detail : ""),
      };
    });
  } catch {
    checks = [];
  }
  return {
    day: dayText(str(row.d), env.mask.masked),
    passed: Number(row.passed) === 1,
    checks,
    notes: notes.rows.map((n) => ({ kind: str(n.kind), text: str(n.text) })),
  };
}

export type LessonView = {
  id: string;
  family: string;
  headline: string;
  metric: string;
  template: string;
  ruleVersion: string;
  createdDay: string;
  grade: string | null;
  gradeText: string;
  history: { seq: number; grade: string; day: string; n: number; text: string }[];
  critique: CritiqueView;
  masked: boolean;
  retired: boolean;
};

export async function loadLesson(env: LoaderEnv, id: string): Promise<LessonView | null> {
  if (id.length === 0 || id.length > MAX_ID || !ID_RE.test(id)) return null;
  const l = await env.main.execute({
    sql: `SELECT id, template_id, rule_version, metric, created_d FROM lesson WHERE id = ? AND market = ?`,
    args: [id, marketOf(env)],
  });
  const row = l.rows[0];
  if (row === undefined) return null;
  const [grades, critique] = await Promise.all([
    env.main.execute({
      sql: "SELECT seq, grade, d, n, state_text FROM lesson_grade WHERE lesson_id = ? ORDER BY seq",
      args: [id],
    }),
    loadCritique(env, "lesson", id),
  ]);
  const mask = await textMasker(env);
  const masked = env.mask.masked;
  const last = grades.rows.at(-1);
  const grade = last === undefined ? null : str(last.grade);
  return {
    id,
    family: str(row.rule_version).split(".")[0] ?? "",
    headline: headlineOf(str(row.template_id)),
    metric: str(row.metric).replace(/_/g, " "),
    template: str(row.template_id),
    ruleVersion: str(row.rule_version),
    createdDay: dayText(str(row.created_d), masked),
    grade,
    gradeText: grade === null ? "No grade yet" : (GRADE_TEXT[grade] ?? "No grade yet"),
    history: grades.rows.map((g) => ({
      seq: num(g.seq),
      grade: str(g.grade),
      day: dayText(str(g.d), masked),
      n: num(g.n),
      text: mask(str(g.state_text)),
    })),
    critique,
    masked,
    retired: grade === "retired",
  };
}

export type ChallengerView = {
  id: string;
  family: string;
  state: string;
  stateDay: string;
  origin: string;
  ready: boolean;
  ruleVersionId: string;
  incumbentId: string;
  shakedownSessions: number;
  shadowViewedDay: string | null;
  events: {
    seq: number;
    day: string;
    from: string | null;
    to: string;
    actor: string | null;
    reason: string;
  }[];
  changes: ParamChange[];
  critique: CritiqueView;
  masked: boolean;
};

export async function loadChallengerView(
  env: LoaderEnv,
  id: string,
): Promise<ChallengerView | null> {
  if (id.length === 0 || id.length > MAX_ID || !ID_RE.test(id)) return null;
  const c = await env.main.execute({
    sql: `SELECT c.id, v.family, c.state, c.state_d, c.origin, c.ready, c.shakedown_ok_sessions,
                 c.rule_version_id, c.incumbent_version_id, c.shadow_viewed_d
          FROM challenger c JOIN rule_version v ON v.id = c.rule_version_id
          WHERE c.id = ? AND v.market = ?`,
    args: [id, marketOf(env)],
  });
  const row = c.rows[0];
  if (row === undefined) return null;
  const masked = env.mask.masked;
  const mask = await textMasker(env);
  const [events, critique, own, inc] = await Promise.all([
    env.main.execute({
      sql: `SELECT seq, from_state, to_state, d, actor, reason FROM challenger_event
            WHERE challenger_id = ? ORDER BY seq`,
      args: [id],
    }),
    loadCritique(env, "challenger", id),
    env.main.execute({
      sql: "SELECT params_json FROM rule_version WHERE id = ?",
      args: [str(row.rule_version_id)],
    }),
    env.main.execute({
      sql: "SELECT params_json FROM rule_version WHERE id = ?",
      args: [str(row.incumbent_version_id)],
    }),
  ]);
  return {
    id,
    family: str(row.family),
    state: str(row.state),
    stateDay: dayText(str(row.state_d), masked),
    origin: str(row.origin),
    ready: Number(row.ready) === 1,
    ruleVersionId: str(row.rule_version_id),
    incumbentId: str(row.incumbent_version_id),
    shakedownSessions: num(row.shakedown_ok_sessions),
    shadowViewedDay:
      row.shadow_viewed_d === null ? null : dayText(str(row.shadow_viewed_d), masked),
    events: events.rows.map((e) => ({
      seq: num(e.seq),
      day: dayText(str(e.d), masked),
      from: optStr(e.from_state),
      to: str(e.to_state),
      actor: masked ? null : str(e.actor),
      reason: mask(str(e.reason)),
    })),
    changes: diffParams(
      paramMap(inc.rows[0]?.params_json ?? "{}"),
      paramMap(own.rows[0]?.params_json ?? "{}"),
    ),
    critique,
    masked,
  };
}

// ---- comparison (UXN-201, UXN-208) -------------------------------------------------------------------------------

export type TestRow = {
  test: string;
  n: number;
  estimate: string | null;
  interval: string | null;
  outcome: string;
};
export type CompareItem = {
  id: string;
  kind: "champion" | "challenger";
  family: string;
  version: string;
  /** KB-040 lifecycle name for a challenger; null for the champion (it has no stage). */
  stage: string | null;
  status: string | null;
  ready: boolean | null;
  criticPassed: number | null;
  criticTotal: number | null;
  /** UXN-201: shown instead of any p-value claim when the holdout is not confirmed. */
  holdout: "confirmed" | "not yet significant";
  tests: TestRow[];
  changes: ParamChange[];
};
export type CompareView = {
  items: CompareItem[];
  /** Ids that matched nothing. */
  missing: number;
  masked: boolean;
};

/** `?ids=a,b` or repeated `ids=a&ids=b`: 2..5 distinct ids, or null when the list is not allowed. */
export function parseCompareIds(values: string[]): string[] | null {
  const ids = [
    ...new Set(
      values
        .flatMap((v) => v.split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length < COMPARE_MIN || ids.length > COMPARE_MAX) return null;
  return ids.every((s) => s.length <= MAX_ID && ID_RE.test(s)) ? ids : null;
}

const sig = (v: number | null): string | null =>
  v === null ? null : Number(v.toPrecision(SIG)).toString();

async function testRows(env: LoaderEnv, ruleVersion: string): Promise<TestRow[]> {
  const rs = await env.main.execute({
    sql: `SELECT test, n, stat, p, lower, upper, outcome, run_id FROM validation_result
          WHERE rule_version = ? ORDER BY run_id, test`,
    args: [ruleVersion],
  });
  // Latest run per test.
  const byTest = new Map<string, Record<string, unknown>>();
  for (const r of rs.rows) byTest.set(str(r.test), r);
  return [...byTest.values()].map((r) => {
    const lo = ratio(r.lower);
    const hi = ratio(r.upper);
    return {
      test: str(r.test),
      n: num(r.n),
      estimate: sig(ratio(r.stat)),
      interval: lo !== null && hi !== null ? `${sig(lo)} to ${sig(hi)}` : null,
      outcome: str(r.outcome),
    };
  });
}

export async function loadCompare(env: LoaderEnv, ids: string[]): Promise<CompareView> {
  const items: CompareItem[] = [];
  let missing = 0;
  for (const id of ids) {
    const item = id.startsWith("C-") ? await challengerItem(env, id) : await championItem(env, id);
    if (item === null) missing += 1;
    else items.push(item);
  }
  return { items, missing, masked: env.mask.masked };
}

function holdoutOf(tests: TestRow[]): CompareItem["holdout"] {
  return tests.some((t) => t.test === "holdout" && t.outcome === "confirmed")
    ? "confirmed"
    : "not yet significant";
}

async function championItem(env: LoaderEnv, id: string): Promise<CompareItem | null> {
  const v = await env.main.execute({
    sql: `SELECT r.id, r.family, (SELECT s.status FROM rule_version_status s WHERE s.rule_version_id = r.id
                                   ORDER BY s.seq DESC LIMIT 1) AS status
          FROM rule_version r WHERE r.id = ? AND r.market = ?`,
    args: [id, marketOf(env)],
  });
  const row = v.rows[0];
  if (row === undefined) return null;
  const tests = await testRows(env, id);
  return {
    id,
    kind: "champion",
    family: str(row.family),
    version: id,
    stage: null,
    status: optStr(row.status),
    ready: null,
    criticPassed: null,
    criticTotal: null,
    holdout: holdoutOf(tests),
    tests,
    changes: [],
  };
}

async function challengerItem(env: LoaderEnv, id: string): Promise<CompareItem | null> {
  const ch = await loadChallengerView(env, id);
  if (ch === null) return null;
  const tests = await testRows(env, ch.ruleVersionId);
  const checks = ch.critique?.checks ?? [];
  return {
    id,
    kind: "challenger",
    family: ch.family,
    version: ch.ruleVersionId,
    stage: ch.state,
    status: null,
    ready: ch.ready,
    criticPassed: ch.critique === null ? null : checks.filter((c) => c.state === "pass").length,
    criticTotal: ch.critique === null ? null : checks.length,
    holdout: holdoutOf(tests),
    tests,
    changes: ch.changes,
  };
}

// ---- change ledger (UX-070) --------------------------------------------------------------------------------------

export type LedgerRow = {
  id: number;
  kind: string;
  target: string;
  day: string;
  actor: string | null;
  summary: string | null;
};

export async function loadLedger(env: LoaderEnv, family?: FamilyId): Promise<LedgerRow[]> {
  const rs = await env.main.execute({
    sql: `SELECT id, kind, target, effective_d, actor, diff_text FROM change_ledger
          WHERE market = ? ${family === undefined ? "" : "AND target LIKE ?"}
          ORDER BY id DESC LIMIT ${LEDGER_ROWS}`,
    args: family === undefined ? [marketOf(env)] : [marketOf(env), `${family}%`],
  });
  const masked = env.mask.masked;
  return rs.rows.map((r) => ({
    id: num(r.id),
    kind: str(r.kind).replace(/_/g, " "),
    target: str(r.target),
    day: dayText(str(r.effective_d), masked),
    actor: masked ? null : str(r.actor),
    summary: masked || r.diff_text === null ? null : str(r.diff_text).slice(0, DIFF_CHARS),
  }));
}

// ---- hypotheses and annotations (UX-071a) ------------------------------------------------------------------------

export type Note = {
  id: number;
  role: string;
  day: string;
  /** null when the reader may not see the text (a Viewer): the page shows "Note added by <role> on <day>". */
  text: string | null;
  edited: boolean;
  canChange: boolean;
};
export type Hypothesis = {
  id: string;
  title: string;
  day: string;
  body: string;
  notes: Note[];
};

/** Annotations of several subjects of one kind in one read; text rules as `listAnnotations`. */
export async function loadNotes(
  env: LoaderEnv,
  kind: "lesson" | "hypothesis",
  ids: string[],
): Promise<Map<string, Note[]>> {
  const out = new Map<string, Note[]>();
  if (ids.length === 0) return out;
  const rs = await env.auth.execute({
    sql: `SELECT a.id, a.subject_id, a.author_id, a.text, a.created_at, a.edited_at, u.role AS author_role
          FROM annotation a JOIN app_user u ON u.id = a.author_id
          WHERE a.subject_kind = ? AND a.subject_id IN (${ids.map(() => "?").join(",")})
            AND a.deleted_at IS NULL ORDER BY a.id`,
    args: [kind, ...ids],
  });
  const mask = await textMasker(env);
  const reads = env.user.role === "owner" || env.user.role === "editor";
  const masked = env.mask.masked;
  for (const r of rs.rows) {
    const list = out.get(str(r.subject_id)) ?? [];
    list.push({
      id: num(r.id),
      role: str(r.author_role),
      day: dayText(str(r.created_at).slice(0, 10), masked),
      text: reads ? mask(str(r.text)) : null,
      edited: r.edited_at !== null,
      canChange: num(r.author_id) === env.user.id || env.user.role === "owner",
    });
    out.set(str(r.subject_id), list);
  }
  return out;
}

export async function loadHypotheses(env: LoaderEnv): Promise<Hypothesis[]> {
  const rs = await env.main.execute({
    sql: `SELECT d1.path, d1.front_json, d1.body, d1.d, d1.doc_type FROM document d1
          WHERE d1.market = ? AND d1.doc_type = 'hypothesis'
            AND d1.version = (SELECT MAX(d2.version) FROM document d2 WHERE d2.path = d1.path)
          ORDER BY d1.d DESC, d1.path LIMIT ${HYPOTHESES_SHOWN}`,
    args: [marketOf(env)],
  });
  const masker = new LearningMasker(env.main, marketOf(env));
  const docs = [];
  for (const r of rs.rows) {
    let front: unknown = null;
    try {
      front = JSON.parse(str(r.front_json));
    } catch {
      front = null;
    }
    const base = {
      path: str(r.path),
      version: 1,
      doc_type: "hypothesis",
      d: str(r.d),
      front,
      body: str(r.body),
    };
    docs.push({ raw: base, shown: env.mask.masked ? await masker.document(base) : base });
  }
  const idOf = (path: string): string => path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  const notes = await loadNotes(
    env,
    "hypothesis",
    docs.map((d) => idOf(d.raw.path)),
  );
  return docs.map(({ raw, shown }) => {
    const title = (shown.front as { title?: unknown } | null)?.title;
    const id = idOf(raw.path);
    return {
      id,
      title: typeof title === "string" && title.length > 0 ? title : "Hypothesis",
      day: dayText(raw.d, env.mask.masked),
      body: shown.body,
      notes: notes.get(id) ?? [],
    };
  });
}

/** Link target of a stored document, when it has a page; masked users get none (paths carry ids). */
export function documentHref(path: string): string | null {
  const m = /\/(lessons|challengers|families)\/([^/]+)\.md$/.exec(path);
  if (m === null) return null;
  const id = m[2]!;
  if (m[1] === "lessons" && id.startsWith("L-"))
    return `/reviews/learned/lessons/${encodeURIComponent(id)}`;
  if (m[1] === "challengers" && id.startsWith("C-"))
    return `/reviews/learned/challengers/${encodeURIComponent(id)}`;
  if (m[1] === "families" && isFamilyId(id)) return `/reviews/learned/families/${id}`;
  return null;
}

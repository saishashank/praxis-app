// KB documents from the database (KB-001..003, EML-015; M6 T13, design 2.10, decisions 29-31, 33):
// builds every document of a market as a pure function of the stored records, and writes a new
// `document` version only when the rendered content changes. The database is authoritative; nothing
// here reads the network or the clock (the caller passes `d` and `now`).
import type { Client } from "@libsql/client";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import { FAMILY_ORDER } from "@/lib/agents/families/constants";
import { PLAYBOOK_AGENTS } from "@/lib/learning/schema";
import {
  contentSha,
  renderChallenger,
  renderFamily,
  renderLesson,
  renderPlaybook,
  renderReview,
  renderSourceRegister,
  type ChangeView,
  type CritiqueView,
  type DocFront,
  type RenderedDoc,
  type SleeveLegView,
} from "./render";

/** Evening Reviews carry no market column; the build has one live market (MKT-102). */
export const REVIEW_MARKET = "AU";

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v ?? "");
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const maxD = (xs: readonly string[]): string => xs.reduce((a, b) => (b > a ? b : a), "");
const minD = (xs: readonly string[]): string =>
  xs.reduce((a, b) => (a === "" || b < a ? b : a), "");

async function all(db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> {
  return (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
}

function parseObj(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStrings(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const scalar = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : JSON.stringify(v);

/** The label of a rule version (KB-012): UNVALIDATED until validated; forced / rollback say so. */
export function versionLabel(origin: string, parent: string | null): string {
  if (origin === "force") return "UNVALIDATED (forced by Owner)";
  if (origin === "rollback") return `UNVALIDATED (rollback of ${parent ?? "an earlier version"})`;
  return "UNVALIDATED";
}

const FAMILY_ID = /^(F[1-6])(?:$|[.:/_-])/;

export type ChangeRoute =
  | { readonly kind: "lesson"; readonly id: string }
  | { readonly kind: "challenger"; readonly id: string }
  | { readonly kind: "playbook"; readonly agent: string }
  | { readonly kind: "family"; readonly family: string };

/**
 * Which documents a change_ledger row belongs to: its challenger, each lesson it names, a playbook
 * (target = agent) or a family (target = family or rule version id). A row with no route is a gap
 * the mapping-completeness check reports.
 */
export function routeChange(row: {
  readonly target: string;
  readonly challengerId: string | null;
  readonly lessonIds: readonly string[];
}): ChangeRoute[] {
  const out: ChangeRoute[] = [];
  if (row.challengerId !== null) out.push({ kind: "challenger", id: row.challengerId });
  for (const id of row.lessonIds) out.push({ kind: "lesson", id });
  const agent = (PLAYBOOK_AGENTS as readonly string[]).find(
    (a) => row.target === a || row.target.startsWith(`${a}:`) || row.target.startsWith(`${a}/`),
  );
  if (agent !== undefined) out.push({ kind: "playbook", agent });
  const fam = FAMILY_ID.exec(row.target);
  if (fam !== null && out.length === 0) out.push({ kind: "family", family: fam[1] });
  return out;
}

type ChangeRow = ChangeView & {
  readonly challengerId: string | null;
  readonly lessonIds: readonly string[];
  readonly market: string;
};

async function loadChanges(db: Client, market: string): Promise<ChangeRow[]> {
  const rows = await all(
    db,
    `SELECT id, kind, target, effective_d, actor, challenger_id, lesson_ids_json
       FROM change_ledger WHERE market = ? ORDER BY id`,
    [market],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: str(r.kind),
    target: str(r.target),
    effectiveD: str(r.effective_d),
    actor: str(r.actor),
    challengerId: r.challenger_id === null ? null : str(r.challenger_id),
    lessonIds: parseStrings(str(r.lesson_ids_json)),
    market,
  }));
}

const asChange = (c: ChangeRow): ChangeView => ({
  id: c.id,
  kind: c.kind,
  target: c.target,
  effectiveD: c.effectiveD,
  actor: c.actor,
});

// ---------------------------------------------------------------------------------------------

function legOf(v: unknown): SleeveLegView | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown): number | string | null =>
    typeof x === "number" || typeof x === "string" ? x : null;
  return {
    leverage: typeof o.leverage === "number" ? o.leverage : null,
    sleeveTrades: n(o.sleeveTrades),
    shadowTrades: n(o.shadowTrades),
    closeouts: n(o.closeouts),
    locks: n(o.locks),
    netPlMicro: n(o.netPlMicro),
  };
}

async function buildFamilies(
  db: Client,
  market: string,
  changes: ChangeRow[],
): Promise<RenderedDoc[]> {
  const versions = await all(
    db,
    `SELECT id, family, n, parent, origin, params_json, registered_d FROM rule_version
      WHERE market = ? ORDER BY family, n`,
    [market],
  );
  const statuses = await all(
    db,
    `SELECT s.rule_version_id AS id, s.seq, s.status, s.d FROM rule_version_status s
       JOIN rule_version v ON v.id = s.rule_version_id WHERE v.market = ? ORDER BY s.rule_version_id, s.seq`,
    [market],
  );
  const lessons = await all(
    db,
    `SELECT l.id, l.rule_version,
            (SELECT g.grade FROM lesson_grade g WHERE g.lesson_id = l.id ORDER BY g.seq DESC LIMIT 1) AS grade,
            (SELECT MAX(g.d) FROM lesson_grade g WHERE g.lesson_id = l.id) AS gd
       FROM lesson l WHERE l.market = ? ORDER BY l.id`,
    [market],
  );
  const challengers = await all(
    db,
    `SELECT c.id, c.state, c.state_d, v.family FROM challenger c
       JOIN rule_version v ON v.id = c.rule_version_id WHERE v.market = ? ORDER BY c.id`,
    [market],
  );
  const out: RenderedDoc[] = [];
  for (const family of FAMILY_ORDER) {
    const vs = versions.filter((v) => v.family === family);
    if (vs.length === 0) continue;
    const st = (id: string) => statuses.filter((s) => s.id === id);
    const last = (id: string) => {
      const l = st(id);
      return l.length === 0 ? "registered" : str(l[l.length - 1].status);
    };
    const live = vs.filter((v) => last(str(v.id)) === "live");
    const cur = live.length > 0 ? live[live.length - 1] : vs[vs.length - 1];
    const params = parseObj(str(cur.params_json));
    const bounds: Record<string, readonly [number, number] | null> = {};
    for (const k of Object.keys(params)) {
      const def = (CONFIG_KEYS as Record<string, { range?: readonly [number, number] }>)[
        k as ConfigKey
      ];
      bounds[k] = def?.range ?? null;
    }
    const famLessons = lessons.filter((l) => str(l.rule_version).startsWith(`${family}.`));
    const famChallengers = challengers.filter((c) => c.family === family);
    const sleeveRow = (
      await all(
        db,
        `SELECT s.value_json FROM replay_stat s JOIN replay_run r ON r.id = s.run_id
          WHERE r.market = ? AND s.scope = ? AND s.metric = 'sleeve_leverage'
          ORDER BY s.d DESC, s.run_id DESC LIMIT 1`,
        [market, `sleeve:${family}`],
      )
    )[0];
    const sleeveObj = sleeveRow === undefined ? null : parseObj(str(sleeveRow.value_json));
    const famChanges = changes.filter((c) =>
      routeChange(c).some((r) => r.kind === "family" && r.family === family),
    );
    const sleeveDates = await all(
      db,
      `SELECT MAX(s.d) AS d FROM replay_stat s JOIN replay_run r ON r.id = s.run_id
        WHERE r.market = ? AND s.scope = ? AND s.metric = 'sleeve_leverage'`,
      [market, `sleeve:${family}`],
    );
    const dates = [
      ...vs.map((v) => str(v.registered_d)),
      ...statuses.filter((s) => str(s.id).startsWith(`${family}.`)).map((s) => str(s.d)),
      ...famLessons.map((l) => str(l.gd)),
      ...famChallengers.map((c) => str(c.state_d)),
      ...famChanges.map((c) => c.effectiveD),
      str(sleeveDates[0]?.d ?? ""),
    ].filter((x) => x !== "");
    out.push(
      renderFamily({
        market,
        family,
        created: minD(vs.map((v) => str(v.registered_d))),
        updated: maxD(dates),
        current: {
          id: str(cur.id),
          origin: str(cur.origin),
          label: versionLabel(str(cur.origin), cur.parent === null ? null : str(cur.parent)),
        },
        params,
        bounds,
        versions: vs.map((v) => ({
          id: str(v.id),
          parent: v.parent === null ? null : str(v.parent),
          origin: str(v.origin),
          registeredD: str(v.registered_d),
          status: last(str(v.id)),
        })),
        lessons: famLessons.map((l) => ({ id: str(l.id), grade: str(l.grade ?? "L0") })),
        challengers: famChallengers.map((c) => ({ id: str(c.id), state: str(c.state) })),
        sleeve:
          sleeveObj === null
            ? null
            : { levered: legOf(sleeveObj.levered), reality: legOf(sleeveObj.reality) },
        sourceIds: [
          ...vs.map((v) => `rule_version:${str(v.id)}`),
          ...statuses
            .filter((s) => str(s.id).startsWith(`${family}.`))
            .map((s) => `rule_version_status:${str(s.id)}:${Number(s.seq)}`),
          ...famChanges.map((c) => `change_ledger:${c.id}`),
        ],
      }),
    );
  }
  return out;
}

async function buildPlaybooks(
  db: Client,
  market: string,
  changes: ChangeRow[],
): Promise<RenderedDoc[]> {
  const rows = await all(
    db,
    `SELECT agent, n, content, content_sha, tokens_est, change_id, effective_d
       FROM playbook_version WHERE market = ? ORDER BY agent, n`,
    [market],
  );
  const out: RenderedDoc[] = [];
  for (const agent of PLAYBOOK_AGENTS) {
    const vs = rows.filter((r) => r.agent === agent);
    if (vs.length === 0) continue;
    const cur = vs[vs.length - 1];
    const ch = changes.filter((c) =>
      routeChange(c).some((r) => r.kind === "playbook" && r.agent === agent),
    );
    out.push(
      renderPlaybook({
        market,
        agent,
        current: {
          n: Number(cur.n),
          content: str(cur.content),
          tokensEst: Number(cur.tokens_est),
          effectiveD: str(cur.effective_d),
        },
        history: vs.map((v) => ({
          n: Number(v.n),
          effectiveD: str(v.effective_d),
          contentSha: str(v.content_sha),
          changeId: Number(v.change_id),
        })),
        created: minD(vs.map((v) => str(v.effective_d))),
        updated: maxD([...vs.map((v) => str(v.effective_d)), ...ch.map((c) => c.effectiveD)]),
        sourceIds: [
          ...vs.map((v) => `playbook_version:${agent}:${Number(v.n)}`),
          ...ch.map((c) => `change_ledger:${c.id}`),
        ],
      }),
    );
  }
  return out;
}

async function loadCritiques(
  db: Client,
  kind: "lesson" | "challenger",
  id: string,
): Promise<{ views: CritiqueView[]; ids: string[] }> {
  const rows = await all(
    db,
    `SELECT run_id, passed, d FROM critique WHERE subject_kind = ? AND subject_id = ? ORDER BY d, run_id`,
    [kind, id],
  );
  return {
    views: rows.map((r) => ({
      subjectId: id,
      runId: str(r.run_id),
      passed: Number(r.passed) === 1,
      d: str(r.d),
    })),
    ids: rows.map((r) => `critique:${kind}:${id}:${str(r.run_id)}`),
  };
}

async function buildLessons(
  db: Client,
  market: string,
  changes: ChangeRow[],
): Promise<RenderedDoc[]> {
  const lessons = await all(
    db,
    `SELECT id, template_id, subject_json, rule_version, lineage_id, metric, direction, param_hint, created_d
       FROM lesson WHERE market = ? ORDER BY id`,
    [market],
  );
  const plans = await all(
    db,
    `SELECT d, rank, kind, lane, lesson_id FROM plan_item WHERE market = ? AND lesson_id IS NOT NULL ORDER BY d, rank`,
    [market],
  );
  const planReviews = await all(
    db,
    `SELECT plan_d, rank FROM plan_review WHERE market = ? ORDER BY plan_d, rank`,
    [market],
  );
  const out: RenderedDoc[] = [];
  for (const l of lessons) {
    const id = str(l.id);
    const grades = await all(
      db,
      `SELECT seq, grade, window, n, estimate, lower, upper, p, d, corrects_seq FROM lesson_grade
        WHERE lesson_id = ? ORDER BY seq`,
      [id],
    );
    const crit = await loadCritiques(db, "lesson", id);
    const ch = changes.filter((c) =>
      routeChange(c).some((r) => r.kind === "lesson" && r.id === id),
    );
    const myPlans = plans.filter((p) => p.lesson_id === id);
    const myReviews = planReviews.filter((r) =>
      myPlans.some((p) => p.d === r.plan_d && p.rank === r.rank),
    );
    const subject = parseObj(str(l.subject_json));
    const subjectText = Object.keys(subject)
      .sort()
      .map((k) => `${k} ${scalar(subject[k])}`)
      .join(", ");
    out.push(
      renderLesson({
        market,
        id,
        templateId: str(l.template_id),
        metric: str(l.metric),
        direction: Number(l.direction),
        subjectText: subjectText === "" ? "the whole market" : subjectText,
        ruleVersion: str(l.rule_version),
        lineageId: l.lineage_id === null ? null : str(l.lineage_id),
        paramHint: l.param_hint === null ? null : str(l.param_hint),
        createdD: str(l.created_d),
        grades: grades.map((g) => ({
          seq: Number(g.seq),
          grade: str(g.grade),
          window: g.window === null ? null : str(g.window),
          n: Number(g.n),
          estimate: numOrNull(g.estimate),
          lower: numOrNull(g.lower),
          upper: numOrNull(g.upper),
          p: numOrNull(g.p),
          d: str(g.d),
          corrects: numOrNull(g.corrects_seq),
        })),
        critiques: crit.views,
        changes: ch.map(asChange),
        plan: myPlans.map((p) => ({
          d: str(p.d),
          rank: Number(p.rank),
          lane: str(p.lane),
          kind: str(p.kind),
        })),
        updated: maxD([
          str(l.created_d),
          ...grades.map((g) => str(g.d)),
          ...crit.views.map((c) => c.d),
          ...ch.map((c) => c.effectiveD),
          ...myPlans.map((p) => str(p.d)),
        ]),
        sourceIds: [
          `lesson:${id}`,
          ...grades.map((g) => `lesson_grade:${id}:${Number(g.seq)}`),
          ...crit.ids,
          ...ch.map((c) => `change_ledger:${c.id}`),
          ...myPlans.map((p) => `plan_item:${market}:${str(p.d)}:${Number(p.rank)}`),
          ...myReviews.map((r) => `plan_review:${market}:${str(r.plan_d)}:${Number(r.rank)}`),
        ],
      }),
    );
  }
  return out;
}

async function buildChallengers(
  db: Client,
  market: string,
  changes: ChangeRow[],
): Promise<RenderedDoc[]> {
  const rows = await all(
    db,
    `SELECT c.id, c.lineage_id, c.rule_version_id, c.incumbent_version_id, c.origin, c.lesson_ids_json,
            c.state, c.state_d
       FROM challenger c JOIN rule_version v ON v.id = c.rule_version_id
      WHERE v.market = ? ORDER BY c.id`,
    [market],
  );
  const out: RenderedDoc[] = [];
  for (const c of rows) {
    const id = str(c.id);
    const events = await all(
      db,
      `SELECT seq, from_state, to_state, d, actor, reason FROM challenger_event
        WHERE challenger_id = ? ORDER BY seq`,
      [id],
    );
    const crit = await loadCritiques(db, "challenger", id);
    const ch = changes.filter((x) =>
      routeChange(x).some((r) => r.kind === "challenger" && r.id === id),
    );
    const params = async (vid: string) =>
      parseObj(
        str(
          (
            await all(db, "SELECT params_json FROM rule_version WHERE id = ? AND market = ?", [
              vid,
              market,
            ])
          )[0]?.params_json ?? "{}",
        ),
      );
    const a = await params(str(c.incumbent_version_id));
    const b = await params(str(c.rule_version_id));
    const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => ({ key: k, incumbent: scalar(a[k]), challenger: scalar(b[k]) }));
    out.push(
      renderChallenger({
        market,
        id,
        lineageId: str(c.lineage_id),
        state: str(c.state),
        ruleVersionId: str(c.rule_version_id),
        incumbentVersionId: str(c.incumbent_version_id),
        origin: str(c.origin),
        lessonIds: parseStrings(str(c.lesson_ids_json)),
        paramDiff: diff,
        events: events.map((e) => ({
          seq: Number(e.seq),
          from: e.from_state === null ? null : str(e.from_state),
          to: str(e.to_state),
          d: str(e.d),
          actor: str(e.actor),
          reason: str(e.reason),
        })),
        critiques: crit.views,
        changes: ch.map(asChange),
        created: minD(events.map((e) => str(e.d))) || str(c.state_d),
        updated: maxD([
          str(c.state_d),
          ...events.map((e) => str(e.d)),
          ...crit.views.map((x) => x.d),
          ...ch.map((x) => x.effectiveD),
        ]),
        sourceIds: [
          `challenger:${id}`,
          ...events.map((e) => `challenger_event:${id}:${Number(e.seq)}`),
          ...crit.ids,
          ...ch.map((x) => `change_ledger:${x.id}`),
        ],
      }),
    );
  }
  return out;
}

async function buildReviews(db: Client, market: string): Promise<RenderedDoc[]> {
  if (market !== REVIEW_MARKET) return [];
  const rows = await all(
    db,
    `SELECT d, version, kind, markdown FROM evening_review ORDER BY d, version`,
  );
  const plans = await all(
    db,
    `SELECT d, rank, lane, kind, reason FROM plan_item WHERE market = ? AND lesson_id IS NULL ORDER BY d, rank`,
    [market],
  );
  const planReviews = await all(
    db,
    `SELECT r.plan_d, r.rank FROM plan_review r JOIN plan_item p
        ON p.market = r.market AND p.d = r.plan_d AND p.rank = r.rank
      WHERE r.market = ? AND p.lesson_id IS NULL ORDER BY r.plan_d, r.rank`,
    [market],
  );
  const dates = [...new Set(rows.map((r) => str(r.d)))];
  return dates.map((d) => {
    const vs = rows.filter((r) => r.d === d);
    const latest = vs[vs.length - 1];
    const myPlans = plans.filter((p) => p.d === d);
    return renderReview({
      market,
      d,
      version: Number(latest.version),
      kind: str(latest.kind),
      markdown: str(latest.markdown),
      plan: myPlans.map((p) => ({
        rank: Number(p.rank),
        lane: str(p.lane),
        kind: str(p.kind),
        reason: str(p.reason),
      })),
      sourceIds: [
        ...vs.map((v) => `evening_review:${d}:${Number(v.version)}`),
        ...myPlans.map((p) => `plan_item:${market}:${d}:${Number(p.rank)}`),
        ...planReviews
          .filter((r) => r.plan_d === d)
          .map((r) => `plan_review:${market}:${d}:${Number(r.rank)}`),
      ],
    });
  });
}

async function buildSourceRegister(db: Client): Promise<RenderedDoc[]> {
  const rows = await all(
    db,
    `SELECT source, terms_url, permitted_use, rate_limits, last_checked, risk, status,
            summarisation_permitted FROM source_register ORDER BY source`,
  );
  if (rows.length === 0) return [];
  const hist = await all(
    db,
    `SELECT MIN(substr(changed_at, 1, 10)) AS lo, MAX(substr(changed_at, 1, 10)) AS hi FROM source_register_history`,
  );
  const checked = rows.map((r) => str(r.last_checked).slice(0, 10)).filter((x) => x !== "");
  const lo = str(hist[0]?.lo ?? "");
  const hi = str(hist[0]?.hi ?? "");
  return [
    renderSourceRegister({
      created: minD([...checked, ...(lo === "" ? [] : [lo])]) || "1970-01-01",
      updated: maxD([...checked, ...(hi === "" ? [] : [hi])]) || "1970-01-01",
      sources: rows.map((r) => ({
        source: str(r.source),
        risk: str(r.risk),
        status: str(r.status),
        permittedUse: r.permitted_use === null ? null : str(r.permitted_use),
        rateLimits: r.rate_limits === null ? null : str(r.rate_limits),
        lastChecked: r.last_checked === null ? null : str(r.last_checked),
        summarisationPermitted: Number(r.summarisation_permitted) === 1,
        termsUrl: r.terms_url === null ? null : str(r.terms_url),
      })),
    }),
  ];
}

/** Markets that have any KB record, plus the review market. */
export async function kbMarkets(db: Client): Promise<string[]> {
  const rows = await all(
    db,
    `SELECT market FROM rule_version UNION SELECT market FROM lesson
      UNION SELECT market FROM playbook_version UNION SELECT market FROM change_ledger
      UNION SELECT market FROM plan_item`,
  );
  return [...new Set([REVIEW_MARKET, ...rows.map((r) => str(r.market))])].sort();
}

/** Every document of one market, rendered from the records, sorted by path. */
export async function buildMarketDocuments(db: Client, market: string): Promise<RenderedDoc[]> {
  const changes = await loadChanges(db, market);
  const docs = [
    ...(await buildFamilies(db, market, changes)),
    ...(await buildPlaybooks(db, market, changes)),
    ...(await buildLessons(db, market, changes)),
    ...(await buildChallengers(db, market, changes)),
    ...(await buildReviews(db, market)),
  ];
  return docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** All documents (every market plus the common source register), sorted by path. */
export async function buildAllDocuments(db: Client): Promise<RenderedDoc[]> {
  const docs: RenderedDoc[] = [];
  for (const m of await kbMarkets(db)) docs.push(...(await buildMarketDocuments(db, m)));
  docs.push(...(await buildSourceRegister(db)));
  return docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type SyncResult = {
  readonly written: readonly { readonly path: string; readonly version: number }[];
  readonly unchanged: number;
};

/**
 * Writes a `document` version for each rendered document whose content differs from its latest
 * version (none yet counts as different). One batch, so a stop leaves all or nothing. `d` is the
 * Melbourne date of the run, `now` its instant. Re-running without record changes writes nothing.
 */
export async function syncDocuments(
  db: Client,
  opts: { d: string; now: string; docs?: readonly RenderedDoc[] },
): Promise<SyncResult> {
  const docs = opts.docs ?? (await buildAllDocuments(db));
  const latest = new Map<string, { version: number; sha: string }>();
  for (const r of await all(
    db,
    `SELECT path, version, body_sha FROM document d
      WHERE version = (SELECT MAX(version) FROM document WHERE path = d.path)`,
  )) {
    latest.set(str(r.path), { version: Number(r.version), sha: str(r.body_sha) });
  }
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  const written: { path: string; version: number }[] = [];
  for (const doc of docs) {
    const sha = contentSha(doc.front, doc.body);
    const prev = latest.get(doc.path);
    if (prev !== undefined && prev.sha === sha) continue;
    const version = (prev?.version ?? 0) + 1;
    const front: DocFront = { ...doc.front, version };
    stmts.push({
      sql: `INSERT INTO document (path, version, market, doc_type, front_json, body, body_sha,
              source_ids_json, d, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        doc.path,
        version,
        doc.front.market,
        doc.front.type,
        JSON.stringify(front),
        doc.body,
        sha,
        JSON.stringify(doc.sourceIds),
        opts.d,
        opts.now,
      ],
    });
    written.push({ path: doc.path, version });
  }
  if (stmts.length > 0) await db.batch(stmts, "write");
  return { written, unchanged: docs.length - written.length };
}

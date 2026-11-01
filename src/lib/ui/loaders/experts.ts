// Expert pages loaders (M13-lite WP6; UXN-292..295, KB-074, KB-075, KB-079, D-511, D-521, D-529, D-532, D-599).
// Four views over the 0022 tables: the directory, one expert, the techniques (clusters) and the claims queue.
// Rules kept here:
//  - the directory sorts by evidence only (compareEvidence); audience never enters a sort key (PRD-034);
//  - red-flag TEXT is read only for a role that holds review_claims (Owner, Editor); a Viewer's model carries a
//    count and nothing else (D-521), so the text cannot reach a Viewer's page by mistake;
//  - every free text and every code goes through the masker (ROL-107): a masked user gets "Stock A" and
//    "[reference hidden]" in claims, summaries, red flags and call codes; names of experts are not codes;
//  - results are percentages (ppm in the model), never money; wording is descriptive (ARN-062, VAL-101);
//  - "why no result" (D-599): no screening_run for the week -> "not screened this week"; a run without a result
//    for a confirmed, screenable cluster -> "skipped (no lane or too few rows/controls/blocks)".
import { can, type Role } from "@/lib/auth/permissions";
import { getConfig } from "@/lib/config/store";
import { fitCheck, parkReason, type ParkReason } from "@/lib/experts/fit";
import { compareEvidence, NOT_ENOUGH_TESTED, scorecard } from "@/lib/experts/scorecard";
import { gapReport, gapSentence, type GapInput } from "@/lib/experts/vocabularyGaps";
import {
  CATEGORIES,
  type CallOutcomeView,
  type Category,
  type ClaimStatus,
  type ClaimType,
  type ClaimView,
  type ClusterState,
  type ExpertStatus,
  type ExternalGrade,
  type ScreeningResultView,
  type Testability,
} from "@/lib/experts/types";
import { melbourneDate } from "@/lib/view/active";
import { isoWeek } from "@/lib/view/format";
import {
  num,
  numOrNull,
  openViewer,
  str,
  strOrNull,
  type Db,
  type LoaderDeps,
  type MaskScope,
} from "./common";
import { textParam } from "./shell";

const MIN_SCORED_DEFAULT = 10; // threshold-ok: only used when the config read fails (key default, D-528)
const PERCENT = 100; // threshold-ok: percent base
const PPM = 1_000_000; // threshold-ok: parts per million

export const CAPTION = "Development split only; not a forecast.";
export const REACH_LINE =
  "Reach, not skill: audience size says nothing about whether a method works.";
export const SKIPPED_TEXT = "skipped (no lane or too few rows/controls/blocks)";
export const NOT_SCREENED_TEXT = "not screened this week";
export const PARK_TEXT: Record<ParkReason, string> = {
  needs_new_lineage: "needs a new lineage (build change)",
  overlay_only: "an overlay, not a stand-alone rule (build change)",
  vocabulary_gap: "needs an input Praxis does not have (build change)",
  not_testable: "cannot be tested from end-of-day data",
  needs_new_data: "needs data Praxis does not collect yet",
  invalid_fit: "its family fit did not pass the check",
};
export const LICENCE_WORD: Record<string, string> = {
  unchecked: "Not checked",
  registered: "Registered",
  not_registered: "Not registered",
  not_applicable: "Not applicable",
};
export const STATUS_WORD: Record<string, string> = {
  candidate: "Candidate",
  tracked: "Tracked",
  paused: "Paused",
  retired: "Retired",
};
export const CLAIM_STATUS_WORD: Record<ClaimStatus, string> = {
  extracted: "to check",
  owner_checked: "checked",
  formalised: "formalised",
  screened: "screened",
  challenger: "challenger",
  promoted: "promoted",
  rejected: "rejected",
  parked: "parked",
};

const ppmPct = (ppm: number | null): number | null =>
  ppm === null ? null : Math.round((ppm / PPM) * PERCENT * PERCENT) / PERCENT;
const wordsParam = (v: string | null): string | null | undefined => {
  const t = textParam(v, 40);
  if (t === undefined || t === null) return t;
  return /^[A-Za-z0-9_ .-]+$/.test(t) ? t : null;
};
const jsonArr = (v: unknown): string[] => {
  try {
    const a = JSON.parse(str(v)) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const jsonObj = (v: unknown): Record<string, string> => {
  try {
    const o = JSON.parse(str(v)) as unknown;
    if (typeof o !== "object" || o === null || Array.isArray(o)) return {};
    return Object.fromEntries(
      Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
};

// ---- shared reads --------------------------------------------------------------------------------------

type ClaimRow = ClaimView & { readonly expertId: string };

const CLAIM_BASE = `
  SELECT c.id, c.type, c.testability, c.cluster_id,
         r.statement, r.formalisation_text, r.vocabulary_gap_text, r.claimed_edge_text, st.status
    FROM claim c
    JOIN claim_revision r ON r.claim_id = c.id
     AND r.seq = (SELECT MAX(seq) FROM claim_revision WHERE claim_id = c.id)
    JOIN claim_status st ON st.claim_id = c.id
     AND st.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = c.id)`;

function claimOf(r: Record<string, unknown>): ClaimView {
  return {
    id: str(r.id),
    type: str(r.type) as ClaimType,
    testability: str(r.testability) as Testability,
    clusterId: strOrNull(r.cluster_id),
    status: str(r.status) as ClaimStatus,
    statement: str(r.statement),
    formalisationText: strOrNull(r.formalisation_text),
    vocabularyGapText: strOrNull(r.vocabulary_gap_text),
    claimedEdgeText: strOrNull(r.claimed_edge_text),
  };
}

/** Every claim with each expert who made it (one row per claim and expert), in id order. */
async function allClaims(db: Db): Promise<ClaimRow[]> {
  const r = await db.execute(
    `SELECT ce.expert_id, x.* FROM claim_expert ce JOIN (${CLAIM_BASE}) x ON x.id = ce.claim_id
      ORDER BY ce.expert_id, x.id`,
  );
  return r.rows.map((x) => ({
    ...claimOf(x as unknown as Record<string, unknown>),
    expertId: str(x.expert_id),
  }));
}

/** The latest screening result of each cluster (market's newest run that holds one). */
type ResultRow = ScreeningResultView & {
  readonly runD: string;
  readonly family: string;
  readonly rows: number;
  readonly blocks: number;
  readonly meanNetPpm: number;
  readonly meanExcessPpm: number | null;
  readonly lower90Ppm: number | null;
  readonly p: number;
  readonly adjustedP: number;
  readonly rank: number | null;
  readonly grade: string;
};

async function latestResults(db: Db, market: string): Promise<Map<string, ResultRow>> {
  const r = await db.execute({
    sql: `SELECT sr.*, run.d AS run_d FROM screening_result sr
            JOIN screening_run run ON run.run_id = sr.run_id AND run.market = ?
           WHERE run.d = (SELECT MAX(r2.d) FROM screening_run r2
                            JOIN screening_result s2 ON s2.run_id = r2.run_id
                           WHERE r2.market = ? AND s2.cluster_id = sr.cluster_id)`,
    args: [market, market],
  });
  return new Map(
    r.rows.map((x) => [
      str(x.cluster_id),
      {
        clusterId: str(x.cluster_id),
        survived: num(x.survived) === 1,
        runD: str(x.run_d),
        family: str(x.family),
        rows: num(x.rows),
        blocks: num(x.blocks),
        meanNetPpm: num(x.mean_net_ppm),
        meanExcessPpm: numOrNull(x.mean_excess_ppm),
        lower90Ppm: numOrNull(x.lower90_ppm),
        p: num(x.p),
        adjustedP: num(x.adjusted_p),
        rank: numOrNull(x.rank),
        grade: str(x.grade),
      },
    ]),
  );
}

async function latestRunD(db: Db, market: string): Promise<string | null> {
  const r = await db.execute({
    sql: "SELECT MAX(d) AS d FROM screening_run WHERE market = ?",
    args: [market],
  });
  return strOrNull(r.rows[0]?.d);
}

async function minScoredOf(db: Db): Promise<number> {
  try {
    const v = await getConfig(db, "expert_min_scored");
    return typeof v === "number" && Number.isFinite(v) ? v : MIN_SCORED_DEFAULT;
  } catch {
    return MIN_SCORED_DEFAULT;
  }
}

async function callOutcomes(db: Db): Promise<Map<string, CallOutcomeView>> {
  const r = await db.execute(
    "SELECT claim_id, state, vs_market_ppm, luck_pct FROM expert_call_outcome",
  );
  return new Map(
    r.rows.map((x) => [
      str(x.claim_id),
      {
        claimId: str(x.claim_id),
        state: str(x.state) as CallOutcomeView["state"],
        vsMarketPpm: numOrNull(x.vs_market_ppm),
        luckPct: numOrNull(x.luck_pct),
      },
    ]),
  );
}

/** The date whose active-code set masks free text: the newest screening run, else today (Melbourne). */
async function maskDate(db: Db, market: string, now: Date): Promise<string> {
  return (await latestRunD(db, market)) ?? melbourneDate(now.toISOString()) ?? "1970-01-01";
}

function summaryOf(card: ReturnType<typeof scorecard>): { text: string; scored: boolean } {
  if (card.state === "insufficient") return { text: NOT_ENOUGH_TESTED, scored: false };
  const p = card.passShare;
  const parts: string[] = [];
  if (p !== null) {
    const lo = Math.round(p.interval.lower * PERCENT);
    const hi = Math.round(p.interval.upper * PERCENT);
    parts.push(`${p.k} of ${p.n} tested claims passed screening (${lo}% to ${hi}%)`);
  }
  if (card.calls.n > 0) parts.push(`${card.calls.n} settled paper calls`);
  return { text: parts.join("; ") || NOT_ENOUGH_TESTED, scored: true };
}

// ---- directory (UXN-292) -------------------------------------------------------------------------------

export type ExpertQuery = { focus?: string; market?: string; status?: string; platform?: string };

/** `?focus=&market=&status=&platform=`; null when a value is not allowed. */
export function parseExpertQuery(sp: URLSearchParams): ExpertQuery | null {
  const focus = wordsParam(sp.get("focus"));
  const market = wordsParam(sp.get("market"));
  const platform = wordsParam(sp.get("platform"));
  const status = sp.get("status") || undefined;
  if (focus === null || market === null || platform === null) return null;
  if (status !== undefined && !(status in STATUS_WORD)) return null;
  return { focus, market, status, platform };
}

export type ExpertListRow = {
  id: string;
  name: string;
  platforms: string[];
  focus: string[];
  markets: string[];
  status: ExpertStatus;
  claimsByStatus: Record<ClaimStatus, number>;
  claimTotal: number;
  scoreText: string;
  scored: boolean;
  redFlags: number;
  lastItemD: string | null;
};
export type ExpertDirectory = {
  masked: boolean;
  empty: boolean;
  rows: ExpertListRow[];
  options: { focus: string[]; market: string[]; platform: string[] };
  /** Whether the viewer may open the claims queue (a link is shown). */
  canReview: boolean;
  toCheck: number;
};

export async function loadExpertDirectory(
  deps: LoaderDeps,
  query: ExpertQuery = {},
): Promise<ExpertDirectory> {
  const v = await openViewer(deps);
  const db = deps.mainDb;
  const market = v.market;
  const [experts, claims, results, outcomes, minScored, flags, items, links] = await Promise.all([
    db.execute("SELECT * FROM expert ORDER BY id"),
    allClaims(db),
    latestResults(db, market),
    callOutcomes(db),
    minScoredOf(db),
    db.execute("SELECT expert_id, COUNT(*) AS n FROM expert_red_flag GROUP BY expert_id"),
    db.execute(
      "SELECT expert_id, MAX(substr(COALESCE(published_at, ingested_at), 1, 10)) AS d FROM source_item GROUP BY expert_id",
    ),
    db.execute(
      `SELECT ce.expert_id, ce.claim_id FROM claim_expert ce JOIN expert_call k ON k.claim_id = ce.claim_id`,
    ),
  ]);
  const flagN = new Map(flags.rows.map((r) => [str(r.expert_id), num(r.n)]));
  const lastD = new Map(items.rows.map((r) => [str(r.expert_id), strOrNull(r.d)]));
  const callClaims = new Map<string, string[]>();
  for (const r of links.rows) {
    const a = callClaims.get(str(r.expert_id)) ?? [];
    a.push(str(r.claim_id));
    callClaims.set(str(r.expert_id), a);
  }
  const date = await maskDate(db, market, v.now);
  const scope = await v.masker.scope(date);

  const resultViews = [...results.values()];
  const rows: { row: ExpertListRow; card: ReturnType<typeof scorecard> }[] = [];
  for (const e of experts.rows) {
    const id = str(e.id);
    const mine = claims.filter((c) => c.expertId === id);
    const calls = (callClaims.get(id) ?? [])
      .map((cid) => outcomes.get(cid))
      .filter((o): o is CallOutcomeView => o !== undefined);
    const card = scorecard({ claims: mine, results: resultViews, calls, minScored });
    const s = summaryOf(card);
    const total = mine.length;
    rows.push({
      card,
      row: {
        id,
        name: str(e.name),
        platforms: jsonArr(e.platforms_json),
        focus: jsonArr(e.focus_json),
        markets: jsonArr(e.markets_json),
        status: str(e.status) as ExpertStatus,
        claimsByStatus: card.byStatus,
        claimTotal: total,
        scoreText: scope.text(s.text),
        scored: s.scored,
        redFlags: flagN.get(id) ?? 0,
        lastItemD: scope.day(lastD.get(id) ?? null),
      },
    });
  }
  const options = {
    focus: [...new Set(rows.flatMap((r) => r.row.focus))].sort(),
    market: [...new Set(rows.flatMap((r) => r.row.markets))].sort(),
    platform: [...new Set(rows.flatMap((r) => r.row.platforms))].sort(),
  };
  const keep = rows.filter(
    ({ row: r }) =>
      (query.focus === undefined || r.focus.includes(query.focus)) &&
      (query.market === undefined || r.markets.includes(query.market)) &&
      (query.status === undefined || r.status === query.status) &&
      (query.platform === undefined || r.platforms.includes(query.platform)),
  );
  // The only sort: evidence (PRD-034). Ties by name, then id, so the order is stable.
  keep.sort(
    (a, b) =>
      compareEvidence(a.card, b.card) ||
      (a.row.name < b.row.name ? -1 : a.row.name > b.row.name ? 1 : a.row.id < b.row.id ? -1 : 1),
  );
  const toCheck = await countToCheck(db);
  return {
    masked: v.masker.masked,
    empty: experts.rows.length === 0,
    rows: keep.map((k) => k.row),
    options,
    canReview: can(deps.user?.role as Role | undefined, "review_claims"),
    toCheck,
  };
}

async function countToCheck(db: Db): Promise<number> {
  const r = await db.execute(
    `SELECT COUNT(*) AS n FROM claim_status st
      WHERE st.status = 'extracted' AND st.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = st.claim_id)`,
  );
  return num(r.rows[0]?.n ?? 0);
}

// ---- detail (UXN-293) ----------------------------------------------------------------------------------

export type CallRowView = {
  claimId: string;
  code: string;
  market: string;
  direction: string;
  callDay: string | null;
  horizonSessions: number;
  tracked: boolean;
  stateText: string;
  vsMarketPct: number | null;
  luckPct: number | null;
};
export type ExpertClaimView = {
  id: string;
  type: ClaimType;
  statement: string;
  formalisation: string | null;
  claimedEdge: string | null;
  status: ClaimStatus;
  grade: "L0" | "L1";
  testability: Testability;
  clusters: { id: string; name: string; role: string }[];
};
export type ExpertDetail = {
  id: string;
  name: string;
  status: ExpertStatus;
  tier: string;
  noFeed: boolean;
  licence: string;
  platforms: string[];
  handles: Record<string, string>;
  homeUrls: string[];
  markets: string[];
  focus: string[];
  /** Text and link only for a role that holds review_claims; a Viewer gets the count (D-521). */
  redFlags: {
    count: number;
    items: { text: string; sourceUrl: string; notedDay: string | null }[];
  };
  redFlagsVisible: boolean;
  reach: { audienceSize: number | null; audienceDay: string | null };
  items: {
    id: string;
    title: string | null;
    url: string;
    platform: string;
    day: string | null;
    summary: string | null;
    kind: string;
  }[];
  claims: ExpertClaimView[];
  scoreText: string;
  scored: boolean;
  passShare: { k: number; n: number; lowerPct: number; upperPct: number } | null;
  calls: CallRowView[];
  caption: string;
  reachLine: string;
  claimsByStatus: Record<ClaimStatus, number>;
};

const CALL_STATE_WORD: Record<string, string> = {
  closed_target: "closed at target",
  closed_stop: "closed at stop",
  closed_horizon: "closed at horizon",
  no_bars: "no price data",
};

/** One expert, or null when there is none with that id. */
export async function loadExpertDetail(
  deps: LoaderDeps,
  id: string,
): Promise<{ masked: boolean; data: ExpertDetail } | null> {
  const v = await openViewer(deps);
  const db = deps.mainDb;
  const market = v.market;
  const er = await db.execute({ sql: "SELECT * FROM expert WHERE id = ?", args: [id] });
  const e = er.rows[0];
  if (e === undefined) return null;
  const canSeeFlags = can(deps.user?.role as Role | undefined, "review_claims");
  const [claimsRows, results, outcomes, minScored, flags, items, memberships, calls] =
    await Promise.all([
      allClaims(db),
      latestResults(db, market),
      callOutcomes(db),
      minScoredOf(db),
      canSeeFlags
        ? db.execute({
            sql: "SELECT text, source_url, noted_d FROM expert_red_flag WHERE expert_id = ? ORDER BY noted_d, id",
            args: [id],
          })
        : db.execute({
            sql: "SELECT COUNT(*) AS n FROM expert_red_flag WHERE expert_id = ?",
            args: [id],
          }),
      db.execute({
        sql: `SELECT id, title, url, platform, published_at, summary, kind FROM source_item
               WHERE expert_id = ? ORDER BY COALESCE(published_at, ingested_at) DESC, id LIMIT 200`,
        args: [id],
      }),
      db.execute(
        `SELECT cc.claim_id, cc.cluster_id, cc.role, k.name FROM claim_cluster cc
           JOIN cluster k ON k.id = cc.cluster_id ORDER BY cc.cluster_id, cc.role`,
      ),
      db.execute({
        sql: `SELECT k.claim_id, k.market, k.code, k.direction, k.call_d, k.horizon_sessions, k.tracked
                FROM expert_call k JOIN claim_expert ce ON ce.claim_id = k.claim_id
               WHERE ce.expert_id = ? ORDER BY k.call_d, k.claim_id`,
        args: [id],
      }),
    ]);
  const mine = claimsRows.filter((c) => c.expertId === id);
  const callCodes = calls.rows.map((r) => str(r.code));
  const date = await maskDate(db, market, v.now);
  const scope: MaskScope = await v.masker.scope(date, callCodes);

  const linkOf = new Map<string, { id: string; name: string; role: string }[]>();
  for (const r of memberships.rows) {
    const a = linkOf.get(str(r.claim_id)) ?? [];
    a.push({ id: str(r.cluster_id), name: scope.text(str(r.name)), role: str(r.role) });
    linkOf.set(str(r.claim_id), a);
  }
  const claimViews: ExpertClaimView[] = mine.map((c) => {
    const cl = linkOf.get(c.id) ?? [];
    const survived = cl.some((k) => k.role === "supports" && results.get(k.id)?.survived === true);
    return {
      id: c.id,
      type: c.type,
      statement: scope.text(c.statement),
      formalisation: c.formalisationText === null ? null : scope.text(c.formalisationText),
      claimedEdge: c.claimedEdgeText === null ? null : scope.text(c.claimedEdgeText),
      status: c.status,
      grade: survived ? "L1" : "L0",
      testability: c.testability,
      clusters: cl,
    };
  });
  const outcomeRows = calls.rows.map((r) => outcomes.get(str(r.claim_id)));
  const card = scorecard({
    claims: mine,
    results: [...results.values()],
    calls: outcomeRows.filter((o): o is CallOutcomeView => o !== undefined),
    minScored,
  });
  const s = summaryOf(card);
  const redItems = canSeeFlags
    ? flags.rows.map((r) => ({
        text: scope.text(str(r.text)),
        sourceUrl: str(r.source_url),
        notedDay: scope.day(str(r.noted_d)),
      }))
    : [];
  const redCount = canSeeFlags ? redItems.length : num(flags.rows[0]?.n ?? 0);
  const data: ExpertDetail = {
    id: str(e.id),
    name: str(e.name),
    status: str(e.status) as ExpertStatus,
    tier: str(e.tier),
    noFeed: num(e.no_feed) === 1,
    licence: LICENCE_WORD[str(e.licence_status)] ?? str(e.licence_status),
    platforms: jsonArr(e.platforms_json),
    handles: jsonObj(e.handles_json),
    homeUrls: jsonArr(e.home_urls_json),
    markets: jsonArr(e.markets_json),
    focus: jsonArr(e.focus_json),
    redFlags: { count: redCount, items: redItems },
    redFlagsVisible: canSeeFlags,
    reach: {
      audienceSize: numOrNull(e.audience_size),
      audienceDay: scope.day(strOrNull(e.audience_d)),
    },
    items: items.rows.map((r) => ({
      id: str(r.id),
      title: r.title === null ? null : scope.text(str(r.title)),
      url: str(r.url),
      platform: str(r.platform),
      day: scope.day(strOrNull(r.published_at)),
      summary: r.summary === null ? null : scope.text(str(r.summary)),
      kind: str(r.kind),
    })),
    claims: claimViews,
    scoreText: scope.text(s.text),
    scored: s.scored,
    passShare:
      card.passShare === null
        ? null
        : {
            k: card.passShare.k,
            n: card.passShare.n,
            lowerPct: Math.round(card.passShare.interval.lower * PERCENT),
            upperPct: Math.round(card.passShare.interval.upper * PERCENT),
          },
    calls: calls.rows.map((r, i) => {
      const o = outcomeRows[i];
      return {
        claimId: str(r.claim_id),
        code: scope.label(str(r.code)),
        market: str(r.market),
        direction: str(r.direction),
        callDay: scope.day(str(r.call_d)),
        horizonSessions: num(r.horizon_sessions),
        tracked: num(r.tracked) === 1,
        stateText:
          o !== undefined
            ? (CALL_STATE_WORD[o.state] ?? o.state)
            : num(r.tracked) === 1
              ? "waiting for the horizon"
              : "stored, not tracked",
        vsMarketPct: o === undefined ? null : ppmPct(o.vsMarketPpm),
        luckPct: o?.luckPct ?? null,
      };
    }),
    caption: CAPTION,
    reachLine: REACH_LINE,
    claimsByStatus: card.byStatus,
  };
  return { masked: v.masker.masked, data };
}

// ---- techniques (UXN-294, KB-079) ----------------------------------------------------------------------

export type TechniqueResult = {
  runDay: string | null;
  family: string;
  controlledRows: number;
  blocks: number;
  meanNetPct: number | null;
  meanExcessPct: number | null;
  lower90Pct: number | null;
  p: number;
  adjustedP: number;
  survived: boolean;
  rank: number | null;
  grade: string;
};
export type TechniqueRow = {
  id: string;
  name: string;
  category: Category;
  statement: string;
  canonicalText: string | null;
  state: ClusterState;
  testability: Testability;
  externalGrade: ExternalGrade;
  evidenceLinks: { url: string; note: string }[];
  closestFamily: string | null;
  fitFamily: string | null;
  expertsFor: { id: string; name: string }[];
  expertsAgainst: { id: string; name: string }[];
  /** Why the cluster is not screened (D-515), or null when it can be. */
  parkText: string | null;
  result: TechniqueResult | null;
  /** The word for the screening column when there is no result for this week (D-599). */
  screeningNote: string;
  proposal: { statusText: string; challengerId: string | null } | null;
};
export type Techniques = {
  masked: boolean;
  empty: boolean;
  categories: readonly Category[];
  rows: TechniqueRow[];
  gaps: { sentence: string; input: string; experts: number; clusters: string[] }[];
  /** Counts for the headline: clusters waiting for a build change. */
  parkedForBuild: number;
  runDay: string | null;
  caption: string;
};

export type TechniqueQuery = { category?: Category };
export function parseTechniqueQuery(sp: URLSearchParams): TechniqueQuery | null {
  const category = sp.get("category") || undefined;
  if (category !== undefined && !(CATEGORIES as readonly string[]).includes(category)) return null;
  return { category: category as Category | undefined };
}

const PROPOSAL_WORD: Record<string, string> = {
  created: "challenger created",
  exists: "challenger already exists",
  refused: "challenger refused",
  parked_build_change: "parked: needs a build change",
  dormant: "dormant",
};

export async function loadTechniques(
  deps: LoaderDeps,
  query: TechniqueQuery = {},
): Promise<Techniques> {
  const v = await openViewer(deps);
  const db = deps.mainDb;
  const market = v.market;
  const today = melbourneDate(v.now.toISOString()) ?? "";
  const [clusters, states, support, results, claims, proposals, expertNames] = await Promise.all([
    db.execute("SELECT * FROM cluster ORDER BY id"),
    db.execute(
      `SELECT s.cluster_id, s.state FROM cluster_state s
        WHERE s.seq = (SELECT MAX(seq) FROM cluster_state WHERE cluster_id = s.cluster_id)`,
    ),
    db.execute(
      `SELECT DISTINCT cc.cluster_id, cc.role, ce.expert_id FROM claim_cluster cc
         JOIN claim_expert ce ON ce.claim_id = cc.claim_id`,
    ),
    latestResults(db, market),
    allClaims(db),
    db.execute(
      `SELECT * FROM expert_proposal WHERE cluster_id IS NOT NULL ORDER BY d, created_at, id`,
    ),
    db.execute("SELECT id, name FROM expert"),
  ]);
  const runD = await latestRunD(db, market);
  const runThisWeek = runD !== null && isoWeek(runD) === isoWeek(today);
  const date = runD ?? today;
  const scope = await v.masker.scope(date);
  const nameOf = new Map(expertNames.rows.map((r) => [str(r.id), str(r.name)]));
  const stateOf = new Map(
    states.rows.map((r) => [str(r.cluster_id), str(r.state) as ClusterState]),
  );
  const forOf = new Map<string, Set<string>>();
  const againstOf = new Map<string, Set<string>>();
  for (const r of support.rows) {
    const m = str(r.role) === "supports" ? forOf : againstOf;
    const s = m.get(str(r.cluster_id)) ?? new Set<string>();
    s.add(str(r.expert_id));
    m.set(str(r.cluster_id), s);
  }
  const propOf = new Map(proposals.rows.map((r) => [str(r.cluster_id), r]));
  const people = (set: Set<string> | undefined) =>
    [...(set ?? [])]
      .sort()
      .map((id) => ({ id, name: nameOf.get(id) ?? id }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));

  const rows: TechniqueRow[] = [];
  let parkedForBuild = 0;
  for (const k of clusters.rows) {
    const id = str(k.id);
    const state = stateOf.get(id) ?? "proposed";
    if (state === "merged") continue;
    const fitRaw =
      k.family_fit_json === null ? null : (JSON.parse(str(k.family_fit_json)) as unknown);
    const fit = fitRaw === null ? null : fitCheck(fitRaw);
    const testability = str(k.testability) as Testability;
    const park = parkReason({
      testability,
      closestFamily: strOrNull(k.closest_family),
      vocabularyGaps: num(k.vocabulary_gaps),
      familyFit: fitRaw,
    });
    const res = results.get(id) ?? null;
    if (park === "needs_new_lineage" && state === "confirmed" && testability === "testable_eod")
      parkedForBuild += 1;
    let note: string;
    if (state === "proposed") note = "waiting for a person to confirm the group";
    else if (state === "parked") note = "parked by a person";
    else if (park !== null) note = PARK_TEXT[park];
    else if (!runThisWeek) note = NOT_SCREENED_TEXT;
    else if (res === null || res.runD !== runD) note = SKIPPED_TEXT;
    else note = "screened this week";
    const p = propOf.get(id);
    const links = (() => {
      try {
        const a = JSON.parse(str(k.evidence_links_json)) as unknown;
        return Array.isArray(a)
          ? a
              .filter(
                (x): x is { url: string; note?: string } =>
                  typeof x === "object" &&
                  x !== null &&
                  typeof (x as { url?: unknown }).url === "string",
              )
              .map((x) => ({ url: x.url, note: scope.text(x.note ?? "") }))
          : [];
      } catch {
        return [];
      }
    })();
    rows.push({
      id,
      name: scope.text(str(k.name)),
      category: str(k.category) as Category,
      statement: scope.text(str(k.statement)),
      canonicalText: k.canonical_text === null ? null : scope.text(str(k.canonical_text)),
      state,
      testability,
      externalGrade: str(k.external_grade) as ExternalGrade,
      evidenceLinks: links,
      closestFamily: strOrNull(k.closest_family),
      fitFamily: fit !== null && fit.ok ? fit.family : null,
      expertsFor: people(forOf.get(id)),
      expertsAgainst: people(againstOf.get(id)),
      parkText: park === null ? null : PARK_TEXT[park],
      result:
        res === null
          ? null
          : {
              runDay: scope.day(res.runD),
              family: res.family,
              controlledRows: res.rows,
              blocks: res.blocks,
              meanNetPct: ppmPct(res.meanNetPpm),
              meanExcessPct: ppmPct(res.meanExcessPpm),
              lower90Pct: ppmPct(res.lower90Ppm),
              p: res.p,
              adjustedP: res.adjustedP,
              survived: res.survived,
              rank: res.rank,
              grade: res.grade,
            },
      screeningNote: note,
      proposal:
        p === undefined
          ? null
          : {
              statusText:
                PROPOSAL_WORD[str(p.status)] +
                (p.reason === null || p.reason === undefined
                  ? ""
                  : `: ${scope.text(str(p.reason))}`),
              challengerId: strOrNull(p.challenger_id),
            },
    });
  }

  // KB-079: the gap report, one row per input the experts rely on and Praxis lacks.
  const clustersOfClaim = new Map<string, Set<string>>();
  const links = await db.execute("SELECT claim_id, cluster_id FROM claim_cluster");
  for (const r of links.rows) {
    const s = clustersOfClaim.get(str(r.claim_id)) ?? new Set<string>();
    s.add(str(r.cluster_id));
    clustersOfClaim.set(str(r.claim_id), s);
  }
  const byClaim = new Map<string, GapInput & { expertIds: string[] }>();
  for (const c of claims) {
    const g = byClaim.get(c.id) ?? {
      claimId: c.id,
      expertIds: [],
      clusterIds: [...(clustersOfClaim.get(c.id) ?? [])],
      vocabularyGapText: c.vocabularyGapText,
    };
    g.expertIds.push(c.expertId);
    byClaim.set(c.id, g);
  }
  const gaps = gapReport([...byClaim.values()]).map((g) => ({
    sentence: scope.text(gapSentence(g)),
    input: scope.text(g.input),
    experts: g.experts,
    clusters: [...g.clusters],
  }));
  const shown =
    query.category === undefined ? rows : rows.filter((r) => r.category === query.category);
  return {
    masked: v.masker.masked,
    empty: clusters.rows.length === 0,
    categories: CATEGORIES,
    rows: shown,
    gaps,
    parkedForBuild,
    runDay: scope.day(runD),
    caption: CAPTION,
  };
}

// ---- the claims queue (UXN-295) ------------------------------------------------------------------------

export type QueueClaim = {
  id: string;
  type: ClaimType;
  statement: string;
  formalisation: string | null;
  claimedEdge: string | null;
  vocabularyGap: string | null;
  sources: { url: string; title: string | null }[];
  clusterId: string | null;
};
export type QueueExpert = { id: string; name: string; claims: QueueClaim[] };
export type QueueCluster = {
  id: string;
  name: string;
  category: Category;
  statement: string;
  state: ClusterState;
  /** Whether confirming formalises the checked claims (a valid family fit). */
  validFit: boolean;
  fitFamily: string | null;
  supporters: number;
};
export type Queue = {
  masked: boolean;
  total: number;
  experts: QueueExpert[];
  /** Groups a person has not confirmed yet (state proposed or parked). */
  toConfirm: QueueCluster[];
  /** Groups a claim may be merged into: not merged away. */
  targets: { id: string; name: string; state: ClusterState }[];
};

export async function loadQueue(deps: LoaderDeps): Promise<Queue> {
  const v = await openViewer(deps);
  const db = deps.mainDb;
  const market = v.market;
  const date = await maskDate(db, market, v.now);
  const scope = await v.masker.scope(date);
  const [claims, experts, sources, clusters, states, supporters] = await Promise.all([
    allClaims(db),
    db.execute("SELECT id, name FROM expert ORDER BY name, id"),
    db.execute(
      `SELECT ci.claim_id, s.url, s.title FROM claim_item ci JOIN source_item s ON s.id = ci.item_id
        ORDER BY ci.claim_id, s.url`,
    ),
    db.execute("SELECT * FROM cluster ORDER BY id"),
    db.execute(
      `SELECT s.cluster_id, s.state FROM cluster_state s
        WHERE s.seq = (SELECT MAX(seq) FROM cluster_state WHERE cluster_id = s.cluster_id)`,
    ),
    db.execute(
      `SELECT cluster_id, COUNT(DISTINCT claim_id) AS n FROM claim_cluster WHERE role = 'supports' GROUP BY cluster_id`,
    ),
  ]);
  const srcOf = new Map<string, { url: string; title: string | null }[]>();
  for (const r of sources.rows) {
    const a = srcOf.get(str(r.claim_id)) ?? [];
    a.push({ url: str(r.url), title: r.title === null ? null : scope.text(str(r.title)) });
    srcOf.set(str(r.claim_id), a);
  }
  const stateOf = new Map(
    states.rows.map((r) => [str(r.cluster_id), str(r.state) as ClusterState]),
  );
  const supN = new Map(supporters.rows.map((r) => [str(r.cluster_id), num(r.n)]));
  const out: QueueExpert[] = [];
  let total = 0;
  for (const e of experts.rows) {
    const mine = claims
      .filter((c) => c.expertId === str(e.id) && c.status === "extracted")
      .map<QueueClaim>((c) => ({
        id: c.id,
        type: c.type,
        statement: scope.text(c.statement),
        formalisation: c.formalisationText === null ? null : scope.text(c.formalisationText),
        claimedEdge: c.claimedEdgeText === null ? null : scope.text(c.claimedEdgeText),
        vocabularyGap: c.vocabularyGapText === null ? null : scope.text(c.vocabularyGapText),
        sources: srcOf.get(c.id) ?? [],
        clusterId: c.clusterId,
      }));
    if (mine.length === 0) continue;
    total += mine.length;
    out.push({ id: str(e.id), name: str(e.name), claims: mine });
  }
  const view = (k: Record<string, unknown>): QueueCluster => {
    const raw = k.family_fit_json === null ? null : (JSON.parse(str(k.family_fit_json)) as unknown);
    const fit = raw === null ? null : fitCheck(raw);
    return {
      id: str(k.id),
      name: scope.text(str(k.name)),
      category: str(k.category) as Category,
      statement: scope.text(str(k.statement)),
      state: stateOf.get(str(k.id)) ?? "proposed",
      validFit: fit !== null && fit.ok,
      fitFamily: fit !== null && fit.ok ? fit.family : null,
      supporters: supN.get(str(k.id)) ?? 0,
    };
  };
  const all = clusters.rows.map((k) => view(k as unknown as Record<string, unknown>));
  return {
    masked: v.masker.masked,
    total,
    experts: out,
    toConfirm: all.filter((k) => k.state === "proposed" || k.state === "parked"),
    targets: all
      .filter((k) => k.state === "confirmed")
      .map((k) => ({ id: k.id, name: k.name, state: k.state })),
  };
}

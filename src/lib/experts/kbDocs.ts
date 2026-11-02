// KB mirror of the expert data (M13-lite WP7; KB-071, D-523, D-641). Pure function of the stored records:
// one document per expert and per technique cluster plus the vocabulary-gap report, under
// knowledge/common/experts/ and knowledge/common/techniques/ (the archive allow-list is a security control,
// so the spec's knowledge/experts/ is realised under `common`). Every document is `hypothesis` (an expert
// idea is untested, PRD-034). Documents are readable by every role, so they carry NO red-flag text, NO
// licence detail and NO audience figure (the directory shows those to the roles that may see them), and no
// claim wording from a source: claims appear as counts by status, clusters by their own-words statement.
// Nothing here reads the network or the clock; `syncExpertDocs` writes through the KB's own `syncDocuments`.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { type RenderedDoc } from "@/lib/kb/render";
import { currentClusterState, claimsOf } from "./store";
import { scorecard, NOT_ENOUGH_TESTED } from "./scorecard";
import { gapReport, gapSentence, type GapInput } from "./vocabularyGaps";
import type { CallOutcomeView, CallState, ClaimView } from "./types";

export const EXPERT_DOC_DIR = "knowledge/common/experts";
export const TECHNIQUE_DOC_DIR = "knowledge/common/techniques";
export const GAPS_DOC_PATH = `${EXPERT_DOC_DIR}/vocabulary-gaps.md`;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,32}$/;
const PPM_PER_PERCENT = 10_000; // threshold-ok: ppm per percent
const PPM = 1_000_000; // threshold-ok: parts per million
const NOT_A_FORECAST = "Development split only; not a forecast.";

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v ?? "");
const day = (v: unknown): string => str(v).slice(0, 10);
const maxD = (xs: readonly string[]): string => xs.reduce((a, b) => (b > a ? b : a), "");
const minD = (xs: readonly string[]): string =>
  xs.reduce((a, b) => (a === "" || b < a ? b : a), "");
const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const pct = (ppm: number | null): string =>
  ppm === null ? "n/a" : `${String(Number((ppm / PPM_PER_PERCENT).toPrecision(4)))} %`;
const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const bullets = (xs: readonly string[]): string =>
  xs.length === 0 ? "_None._\n" : `${xs.map((x) => `- ${x}`).join("\n")}\n`;

async function all(db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> {
  return (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
}

function words(json: unknown): string[] {
  try {
    const v: unknown = JSON.parse(str(json));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

type ResultRow = {
  readonly clusterId: string;
  readonly survived: boolean;
  readonly grade: string;
  readonly rows: number;
  readonly meanExcessPpm: number | null;
  readonly lower90Ppm: number | null;
  readonly runD: string;
};

/** The latest screening result of each cluster. */
async function latestResults(db: Client): Promise<Map<string, ResultRow>> {
  const rs = await all(
    db,
    `SELECT r.cluster_id, r.survived, r.grade, r.rows, r.mean_excess_ppm, r.lower90_ppm, u.d AS run_d
       FROM screening_result r JOIN screening_run u ON u.run_id = r.run_id
      ORDER BY u.d, r.run_id, r.cluster_id`,
  );
  const out = new Map<string, ResultRow>();
  for (const r of rs) {
    out.set(str(r.cluster_id), {
      clusterId: str(r.cluster_id),
      survived: Number(r.survived) === 1,
      grade: str(r.grade),
      rows: Number(r.rows),
      meanExcessPpm: r.mean_excess_ppm === null ? null : Number(r.mean_excess_ppm),
      lower90Ppm: r.lower90_ppm === null ? null : Number(r.lower90_ppm),
      runD: str(r.run_d),
    });
  }
  return out;
}

type OutcomeRow = CallOutcomeView & { readonly settledD: string };

async function outcomesByExpert(db: Client): Promise<Map<string, OutcomeRow[]>> {
  const rs = await all(
    db,
    `SELECT ce.expert_id, o.claim_id, o.state, o.vs_market_ppm, o.luck_pct, o.settled_d
       FROM expert_call_outcome o JOIN claim_expert ce ON ce.claim_id = o.claim_id
      ORDER BY ce.expert_id, o.claim_id`,
  );
  const out = new Map<string, OutcomeRow[]>();
  for (const r of rs) {
    const list = out.get(str(r.expert_id)) ?? [];
    list.push({
      claimId: str(r.claim_id),
      state: str(r.state) as CallState,
      vsMarketPpm: r.vs_market_ppm === null ? null : Number(r.vs_market_ppm),
      luckPct: r.luck_pct === null ? null : Number(r.luck_pct),
      settledD: str(r.settled_d),
    });
    out.set(str(r.expert_id), list);
  }
  return out;
}

async function minScored(db: Client): Promise<number> {
  try {
    const v = await getConfig(db, "expert_min_scored");
    return typeof v === "number" ? v : 10; // threshold-ok: registry default if the stored value is unusable
  } catch {
    return 10; // threshold-ok: registry default
  }
}

function renderExpert(x: {
  readonly row: Row;
  readonly claims: readonly ClaimView[];
  readonly results: ReadonlyMap<string, ResultRow>;
  readonly outcomes: readonly OutcomeRow[];
  readonly items: readonly Row[];
  readonly minScored: number;
  readonly claimDates: readonly string[];
}): RenderedDoc {
  const id = str(x.row.id);
  const card = scorecard({
    claims: x.claims,
    results: x.claims.flatMap((c) => {
      const r = c.clusterId === null ? undefined : x.results.get(c.clusterId);
      return r === undefined ? [] : [{ clusterId: r.clusterId, survived: r.survived }];
    }),
    calls: x.outcomes,
    minScored: x.minScored,
  });
  const clusters = sortedUnique(
    x.claims.flatMap((c) => (c.clusterId === null ? [] : [c.clusterId])),
  );
  const statusRows = Object.entries(card.byStatus)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `| ${s} | ${n} |`);
  const scoreLine =
    card.state === "insufficient"
      ? `${NOT_ENOUGH_TESTED} (${card.scored} of ${x.minScored} needed).`
      : card.passShare === null
        ? `${card.scored} tested; no claim has a screening result yet.`
        : `${card.passShare.k} of ${card.passShare.n} tested claims passed screening ` +
          `(90 % interval ${pct(Math.round(card.passShare.interval.lower * PPM))} to ${pct(Math.round(card.passShare.interval.upper * PPM))}).`;
  const callLine =
    card.calls.n === 0
      ? "No settled paper calls."
      : `${card.calls.n} settled paper calls (no costs); median versus the market ${pct(card.calls.medianPpm)}` +
        (card.calls.luckMedianPct === null
          ? "."
          : `; median luck share ${card.calls.luckMedianPct} % of the universe did better.`);
  const body = [
    `# ${str(x.row.name)}`,
    "",
    "An expert in the Praxis seed: a source of untested ideas. Nothing here is advice, a pick or an order.",
    "",
    "## Profile",
    "",
    `- Status: ${str(x.row.status)} (${str(x.row.tier)})`,
    `- Platforms: ${words(x.row.platforms_json).join(", ") || "none listed"}`,
    `- Focus: ${words(x.row.focus_json).join(", ") || "none listed"}`,
    `- Markets: ${words(x.row.markets_json).join(", ") || "none listed"}`,
    "",
    "## Claims by status",
    "",
    statusRows.length === 0
      ? "_None._\n"
      : ["| Status | Claims |", "| --- | --- |", ...statusRows].join("\n") + "\n",
    "## Scorecard",
    "",
    `${scoreLine} ${NOT_A_FORECAST}`,
    "",
    callLine,
    "",
    "## Techniques",
    "",
    bullets(clusters.map((k) => `[${k}](../techniques/${k}.md)`)),
    "## Source links",
    "",
    bullets(x.items.map((i) => `${esc(str(i.platform))}: ${esc(str(i.url))}`)),
  ].join("\n");
  return {
    path: `${EXPERT_DOC_DIR}/${id}.md`,
    front: {
      id,
      market: "common",
      type: "hypothesis",
      created: day(x.row.created_at),
      updated: maxD([
        day(x.row.updated_at),
        ...x.claimDates,
        ...x.outcomes.map((o) => o.settledD),
        ...x.claims.flatMap((c) => {
          const r = c.clusterId === null ? undefined : x.results.get(c.clusterId);
          return r === undefined ? [] : [r.runD];
        }),
      ]),
      grade: null,
      related: clusters,
    },
    body,
    sourceIds: sortedUnique([`expert:${id}`]),
  };
}

function renderTechnique(x: {
  readonly row: Row;
  readonly state: string;
  readonly mergedInto: string | null;
  readonly result: ResultRow | undefined;
  readonly proposal: Row | undefined;
  readonly claimCount: number;
  readonly experts: readonly { readonly id: string; readonly name: string }[];
  readonly updated: string;
}): RenderedDoc {
  const id = str(x.row.id);
  const resultLines =
    x.result === undefined
      ? "Not screened yet."
      : [
          `Latest screening ${x.result.runD}: ${x.result.survived ? "passed (grade L1, may hold)" : "did not pass (grade L0, was observed)"}; ` +
            `${x.result.rows} development trades, mean excess over matched controls ${pct(x.result.meanExcessPpm)}, ` +
            `lower 90 % bound ${pct(x.result.lower90Ppm)}.`,
          NOT_A_FORECAST,
        ].join(" ");
  const proposalLine =
    x.proposal === undefined
      ? "No proposal yet."
      : `Latest proposal ${day(x.proposal.d)}: ${str(x.proposal.kind)} ${str(x.proposal.status)}` +
        (x.proposal.challenger_id === null ? "" : ` (${str(x.proposal.challenger_id)})`) +
        ".";
  const body = [
    `# ${str(x.row.name)}`,
    "",
    "A technique cluster: similar ideas from one or more experts. It is a hypothesis until a test says otherwise.",
    "",
    "## Idea",
    "",
    str(x.row.statement),
    "",
    ...(x.row.canonical_text === null ? [] : [str(x.row.canonical_text), ""]),
    "## Facts",
    "",
    `- Category: ${str(x.row.category)}`,
    `- Testability: ${str(x.row.testability)}`,
    `- External evidence: ${str(x.row.external_grade)}`,
    `- Closest rule family (a hint only): ${x.row.closest_family === null ? "none" : str(x.row.closest_family)}`,
    `- State: ${x.state}${x.mergedInto === null ? "" : ` into ${x.mergedInto}`}`,
    `- Claims: ${x.claimCount}`,
    `- Experts: ${x.experts.map((e) => `${e.id} (${esc(e.name)})`).join(", ") || "none"}`,
    "",
    "## Screening",
    "",
    resultLines,
    "",
    proposalLine,
    "",
  ].join("\n");
  return {
    path: `${TECHNIQUE_DOC_DIR}/${id}.md`,
    front: {
      id,
      market: "common",
      type: "hypothesis",
      created: day(x.row.created_at),
      updated: x.updated,
      grade: x.result === undefined ? null : x.result.survived ? "L1" : "L0",
      related: sortedUnique(x.mergedInto === null ? [] : [x.mergedInto]),
    },
    body,
    sourceIds: [`cluster:${id}`],
  };
}

/**
 * Every expert document, technique document and the vocabulary-gap report, sorted by path. Empty when the
 * database holds no expert and no cluster (a world without the seed gets no new document).
 */
export async function buildExpertDocuments(db: Client): Promise<RenderedDoc[]> {
  const experts = (await all(db, "SELECT * FROM expert ORDER BY id")).filter((e) =>
    SAFE_ID.test(str(e.id)),
  );
  const clusters = (await all(db, "SELECT * FROM cluster ORDER BY id")).filter((k) =>
    SAFE_ID.test(str(k.id)),
  );
  if (experts.length === 0 && clusters.length === 0) return [];

  const results = await latestResults(db);
  const outcomes = await outcomesByExpert(db);
  const min = await minScored(db);
  const items = await all(
    db,
    "SELECT expert_id, platform, url FROM source_item ORDER BY expert_id, url, platform",
  );
  const docs: RenderedDoc[] = [];

  const gaps: GapInput[] = [];
  const claimExperts = new Map<string, Set<string>>();
  for (const e of experts) {
    const claims = await claimsOf(db, str(e.id));
    for (const c of claims) {
      const set = claimExperts.get(c.id) ?? new Set<string>();
      set.add(str(e.id));
      claimExperts.set(c.id, set);
    }
    const dates = (
      await all(
        db,
        `SELECT MAX(s.at) AS at FROM claim_status s JOIN claim_expert ce ON ce.claim_id = s.claim_id
          WHERE ce.expert_id = ?`,
        [str(e.id)],
      )
    ).map((r) => day(r.at));
    docs.push(
      renderExpert({
        row: e,
        claims,
        results,
        outcomes: outcomes.get(str(e.id)) ?? [],
        items: items.filter((i) => str(i.expert_id) === str(e.id)),
        minScored: min,
        claimDates: dates.filter((x) => x !== ""),
      }),
    );
  }

  const links = await all(
    db,
    "SELECT claim_id, cluster_id FROM claim_cluster ORDER BY claim_id, cluster_id",
  );
  const claimRows = await all(
    db,
    `SELECT c.id, c.cluster_id, c.created_at,
            (SELECT r.vocabulary_gap_text FROM claim_revision r WHERE r.claim_id = c.id
              ORDER BY r.seq DESC LIMIT 1) AS gap,
            (SELECT r.at FROM claim_revision r WHERE r.claim_id = c.id
              ORDER BY r.seq DESC LIMIT 1) AS rev_at
       FROM claim c ORDER BY c.id`,
  );
  for (const c of claimRows) {
    const id = str(c.id);
    gaps.push({
      claimId: id,
      expertIds: [...(claimExperts.get(id) ?? [])].sort(),
      clusterIds: sortedUnique([
        ...(c.cluster_id === null ? [] : [str(c.cluster_id)]),
        ...links.filter((l) => str(l.claim_id) === id).map((l) => str(l.cluster_id)),
      ]),
      vocabularyGapText: c.gap === null ? null : str(c.gap),
    });
  }

  const proposals = await all(
    db,
    `SELECT cluster_id, d, kind, status, challenger_id FROM expert_proposal
      WHERE cluster_id IS NOT NULL ORDER BY d, id`,
  );
  const expertNames = new Map(experts.map((e) => [str(e.id), str(e.name)]));
  for (const k of clusters) {
    const id = str(k.id);
    const st = await currentClusterState(db, id);
    const mine = claimRows.filter(
      (c) =>
        str(c.cluster_id) === id ||
        links.some((l) => str(l.claim_id) === str(c.id) && str(l.cluster_id) === id),
    );
    const ids = sortedUnique(mine.flatMap((c) => [...(claimExperts.get(str(c.id)) ?? [])]));
    const result = results.get(id);
    const proposal = proposals.filter((p) => str(p.cluster_id) === id).pop();
    const stateDates = await all(
      db,
      "SELECT MAX(at) AS at FROM cluster_state WHERE cluster_id = ?",
      [id],
    );
    docs.push(
      renderTechnique({
        row: k,
        state: st?.state ?? "proposed",
        mergedInto: st?.mergedInto ?? null,
        result,
        proposal,
        claimCount: mine.length,
        experts: ids.map((e) => ({ id: e, name: expertNames.get(e) ?? e })),
        updated: maxD([
          day(k.created_at),
          day(stateDates[0]?.at),
          result?.runD ?? "",
          proposal === undefined ? "" : day(proposal.d),
        ]),
      }),
    );
  }

  if (docs.length === 0) return [];
  const report = gapReport(gaps);
  const withGap = claimRows.filter((c) => c.gap !== null);
  const gapClusters = sortedUnique(report.flatMap((r) => r.clusters)).filter((k) =>
    SAFE_ID.test(k),
  );
  docs.push({
    path: GAPS_DOC_PATH,
    front: {
      id: "common-vocabulary-gaps",
      market: "common",
      type: "hypothesis",
      // dated by the claims it summarises, so the report changes only when a gap text changes
      created:
        minD(withGap.map((c) => day(c.created_at))) || minD(docs.map((d) => d.front.created)),
      updated: maxD(withGap.map((c) => day(c.rev_at))) || maxD(docs.map((d) => d.front.updated)),
      grade: null,
      related: gapClusters,
    },
    body: [
      "# Vocabulary gaps",
      "",
      "Inputs the experts rely on that Praxis does not have. Adding one is an Owner-approved build change.",
      "",
      bullets(
        report.map((r) => `${gapSentence(r)}; ${r.claims} ${r.claims === 1 ? "claim" : "claims"}`),
      ),
    ].join("\n"),
    sourceIds: gapClusters.map((k) => `cluster:${k}`),
  });
  return docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

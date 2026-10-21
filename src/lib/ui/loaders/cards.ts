// Loader of the Decision Card page and of the card links the other loaders hand out (M7 T7, T13;
// docs/M7_design.md 3 rows 6 and 16; D-128, D-129, D-135 draft).
//
// A card id is `card:<signal id>:<execution>` and the signal id carries the stock code, so a masked
// viewer must never see or follow it: `cardRef` gives such a viewer an opaque `ck:` reference instead
// and `resolveCardRef` maps it back on the server (the same idea as the `mk:` alert keys). A masked
// viewer can only address a card by that reference: a real id answers "not found", exactly like an
// unknown id (D-135). The page body is the existing masked `cardViewModel`; T13 adds the explainer
// parts (src/lib/ui/loaders/cardParts.ts: "Based on", past setups, factors, checklist, headwinds,
// scenario rows, "Why?", afterwards) and the notes, all built from stored facts and masked here.
import "server-only";
import { loadScenarioInput, type DecisionCard } from "@/lib/agents/cards";
import { opaqueDigest } from "@/lib/view/opaqueRef";
import { getConfig } from "@/lib/config/store";
import { wilsonInterval } from "@/lib/stats/binomial";
import { cardViewModel, type CardView } from "@/lib/view/cards";
import {
  afterwards,
  basedOn,
  checklist,
  evidenceLine,
  factorItems,
  headwinds,
  netPpm,
  pastSetups,
  scenarioRows,
  whyLines,
  type Afterwards,
  type BasedOnItem,
  type ChecklistRow,
  type FactorBucketRow,
  type Factors,
  type Headwind,
  type PastSetups,
  type ScenarioRow,
} from "./cardParts";
import {
  loaded,
  num,
  openViewer,
  soft,
  str,
  strOrNull,
  type Db,
  type Loaded,
  type LoaderDeps,
} from "./common";

const OPAQUE_PREFIX = "ck:";
const OPAQUE_RE = /^ck:([0-9a-f]{16})$/;
const MAX_ID = 300; // threshold-ok: id length guard
const WINDOW_DAYS = 120; // threshold-ok: how far back an opaque reference can still be resolved
const DAY_MS = 86_400_000; // threshold-ok: unit conversion
const MAX_CARDS_SCANNED = 20_000; // threshold-ok: bound of the resolve scan
const MAX_BREAKER_ROWS = 60; // threshold-ok: bound of the breaker history read
const MAX_FACTOR_ROWS = 400; // threshold-ok: bound of the factor bucket read
const MAX_NOTES = 100; // threshold-ok: bound of the annotations read
const DEFAULT_FACTOR_MIN_N = 30; // threshold-ok: registry default of factor_min_bucket_n
const DEFAULT_CONFIDENCE = 0.9; // threshold-ok: registry default of cif_confidence

/** `ck:` plus the keyed digest of the stored card id. */
export function cardRef(id: string): string {
  return OPAQUE_PREFIX + opaqueDigest("ck", id);
}

export const isCardRef = (ref: string): boolean => OPAQUE_RE.test(ref);

/** The id a viewer is shown: the stored id for an unmasked viewer, the opaque reference otherwise. */
export const publicCardId = (id: string, masked: boolean): string => (masked ? cardRef(id) : id);

/** The page link of a card: never contains a code for a masked viewer. */
export const cardHref = (id: string, masked: boolean): string =>
  `/cards/${encodeURIComponent(publicCardId(id, masked))}`;

/** The stored card id behind a reference (null if none matches); any other id is returned as given. */
export async function resolveCardRef(
  db: Db,
  ref: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!OPAQUE_RE.test(ref)) return ref.length > 0 && ref.length <= MAX_ID ? ref : null;
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const r = await db.execute({
    sql: "SELECT id FROM decision_card WHERE decided_at >= ? ORDER BY id LIMIT ?",
    args: [since, MAX_CARDS_SCANNED],
  });
  for (const x of r.rows) if (cardRef(str(x.id)) === ref) return str(x.id);
  return null;
}

export type BreakerCheck = {
  id: string;
  status: "green" | "amber" | "red";
  /** Date of the check: exact, or the ISO week for a masked viewer. */
  day: string | null;
  phase: string;
  value: string;
  trigger: string;
};

/** A note on the card. A masked viewer gets the role and date only, never the text (D-125, decision 10). */
export type CardNote = {
  id: number;
  role: string;
  /** Date the note was added (YYYY-MM-DD). */
  day: string;
  /** Null for a masked viewer: "Note added by <role> on <date>". */
  text: string | null;
};

export type CardPage = {
  /** False when the card does not exist (the page answers "not found"). */
  found: boolean;
  execution: string | null;
  family: string | null;
  regime: string | null;
  taken: boolean | null;
  view: CardView | null;
  /** Latest result per thesis-breaker, ordered by id. */
  breakers: BreakerCheck[];
  /** "Based on": two or three one-line reasons (UXN-037). */
  basedOn: BasedOnItem[];
  evidenceLine: string;
  /** The validation label (ARN-086) of the strategy; "UNVALIDATED" when none is stored. */
  validation: string;
  past: PastSetups | null;
  factors: Factors | null;
  checklist: ChecklistRow[];
  headwinds: Headwind[];
  scenarioRows: ScenarioRow[] | null;
  /** The rules-only "Why?" lines (UXN-102). */
  why: string[];
  afterwards: Afterwards | null;
  notes: CardNote[];
  /** Back-links; none contains a code. */
  links: { home: string; strategy: string | null };
};

const NOT_FOUND: CardPage = {
  found: false,
  execution: null,
  family: null,
  regime: null,
  taken: null,
  view: null,
  breakers: [],
  basedOn: [],
  evidenceLine: "",
  validation: "UNVALIDATED",
  past: null,
  factors: null,
  checklist: [],
  headwinds: [],
  scenarioRows: null,
  why: [],
  afterwards: null,
  notes: [],
  links: { home: "/", strategy: null },
};

type Config = Parameters<typeof getConfig>[0];

/** `idOrRef` is the id from the URL: a stored id (Owner / unmasked viewer), or a `ck:` reference. */
export async function loadCardPage(deps: LoaderDeps, idOrRef: string): Promise<Loaded<CardPage>> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const notFound = () =>
    loaded<CardPage>(null, v.now, masked, NOT_FOUND, "This card was not found.");
  if (idOrRef.length === 0 || idOrRef.length > MAX_ID) return notFound();
  // A masked viewer may only address a card by its opaque reference; a real id gets the same answer as
  // an unknown one, so the page cannot be used to test which ids exist (D-135).
  if (masked && !isCardRef(idOrRef)) return notFound();
  const id = await resolveCardRef(deps.mainDb, idOrRef, v.now);
  if (id === null) return notFound();

  const row = await deps.mainDb.execute({
    sql: "SELECT card_json, signal_id FROM decision_card WHERE id = ?",
    args: [id],
  });
  if (row.rows.length === 0) return notFound();
  const card = JSON.parse(str(row.rows[0]!.card_json)) as DecisionCard;
  const signalId = str(row.rows[0]!.signal_id);
  const noteRow = await deps.mainDb.execute({
    sql: "SELECT text, provider FROM card_note WHERE card_id = ? AND kind = 'summary'",
    args: [id],
  });
  const note =
    noteRow.rows.length > 0
      ? { text: str(noteRow.rows[0]!.text), provider: strOrNull(noteRow.rows[0]!.provider) }
      : null;
  const bk = await deps.mainDb.execute({
    sql: `SELECT breaker_id, status, d, phase, value_text, trigger_text FROM thesis_breaker_eval
          WHERE card_id = ? ORDER BY d DESC, seq DESC, breaker_id LIMIT ?`,
    args: [id, MAX_BREAKER_ROWS],
  });

  const { aliases, lookup } = await v.masker.parts(card.d, [card.code]);
  const scope = await v.masker.scope(card.d, [card.code]);
  const view = cardViewModel(card, note, v.masker.ctx, aliases, lookup);
  const seen = new Set<string>();
  const breakers: BreakerCheck[] = [];
  for (const x of bk.rows) {
    const bid = str(x.breaker_id);
    if (seen.has(bid)) continue;
    seen.add(bid);
    const status = str(x.status);
    breakers.push({
      id: scope.text(bid),
      status: status === "red" || status === "amber" ? status : "green",
      day: scope.day(str(x.d)),
      phase: str(x.phase),
      value: scope.text(str(x.value_text)),
      trigger: scope.text(str(x.trigger_text)),
    });
  }
  breakers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // The explainer (UXN-037, 120 to 123, 126). Every stored text goes through the viewer's scope.
  const t = (x: string): string => scope.text(x);
  const label = await soft(
    async () => {
      const r = await deps.mainDb.execute({
        sql: "SELECT label FROM label WHERE execution_id = ? ORDER BY d DESC, id DESC LIMIT 1",
        args: [card.execution],
      });
      return r.rows.length === 0 ? null : str(r.rows[0]!.label);
    },
    null as string | null,
  );
  const minN = await soft(async () => {
    const x = await getConfig(deps.mainDb as Config, "factor_min_bucket_n");
    return typeof x === "number" ? x : DEFAULT_FACTOR_MIN_N;
  }, DEFAULT_FACTOR_MIN_N);
  const buckets = await soft<FactorBucketRow[]>(async () => {
    if (card.scenario.split_version === null) return [];
    const r = await deps.mainDb.execute({
      sql: `SELECT factor, bucket, edges_json, n, median_net_ppm, family_median_ppm
            FROM factor_bucket_stat
            WHERE market = ? AND family = ? AND rule_version = ? AND split_version = ?
            ORDER BY factor, bucket LIMIT ?`,
      args: [
        card.market,
        card.family,
        card.rule_version,
        card.scenario.split_version,
        MAX_FACTOR_ROWS,
      ],
    });
    return r.rows.map((x) => ({
      factor: str(x.factor),
      bucket: num(x.bucket),
      edges: (JSON.parse(str(x.edges_json)) as unknown[]).map((e) => Number(e)),
      n: num(x.n),
      medianNetPpm: x.median_net_ppm === null ? null : num(x.median_net_ppm),
      familyMedianPpm: x.family_median_ppm === null ? null : num(x.family_median_ppm),
    }));
  }, []);
  const factors = buckets.length === 0 ? null : factorItems(card, buckets, minN, t);

  // Share of past similar trades that made money, with a Wilson interval (exact bigint nets).
  const profitable = await soft(async () => {
    if (card.scenario.insufficient_history) return null;
    const input = await loadScenarioInput(deps.mainDb, {
      market: card.market,
      family: card.family,
      ruleVersion: card.rule_version,
      variant: card.variant,
    });
    if (input.nets.length === 0) return null;
    const k = input.nets.filter((x) => x.num > 0n).length;
    const level = await soft(async () => {
      const c = await getConfig(deps.mainDb as Config, "cif_confidence");
      return typeof c === "number" ? c : DEFAULT_CONFIDENCE;
    }, DEFAULT_CONFIDENCE);
    const ci = wilsonInterval(k, input.nets.length, level);
    return { k, n: input.nets.length, lower: ci.lower, upper: ci.upper, level };
  }, null);

  const warnings = breakers.map((b) => ({ id: b.id, status: b.status, value: b.value }));
  const rows = checklist(card, t);

  // How it turned out: the forward ledger row of the signal (net after costs, exact).
  const led = await soft(async () => {
    const r = await deps.mainDb.execute({
      sql: `SELECT qty, qty_out, fill_in_micro, fill_out_micro, brok_in_micro, brok_out_micro,
                   dividend_micro, exit_d FROM ledger_row WHERE signal_id = ? AND forward = 1
            ORDER BY id LIMIT 1`,
      args: [signalId],
    });
    return r.rows[0] ?? null;
  }, null);
  let closed: { net: number; day: string | null } | null = null;
  if (led !== null && led.exit_d !== null) {
    const cost =
      BigInt(str(led.qty)) * BigInt(str(led.fill_in_micro)) + BigInt(str(led.brok_in_micro));
    const proceeds =
      BigInt(str(led.qty_out)) * BigInt(str(led.fill_out_micro)) -
      BigInt(str(led.brok_out_micro)) +
      BigInt(str(led.dividend_micro));
    const net = netPpm(proceeds, cost);
    if (net !== null) closed = { net, day: scope.day(str(led.exit_d)) };
  }

  // Notes (auth DB). A masked viewer sees who added one and when, never the text.
  const notes = await soft<CardNote[]>(async () => {
    const r = await deps.authDb.execute({
      sql: `SELECT a.id, a.text, a.created_at, u.role AS author_role
            FROM annotation a JOIN app_user u ON u.id = a.author_id
            WHERE a.subject_kind = 'card' AND a.subject_id = ? AND a.deleted_at IS NULL
            ORDER BY a.id LIMIT ?`,
      args: [id, MAX_NOTES],
    });
    return r.rows.map((x) => ({
      id: num(x.id),
      role: str(x.author_role),
      day: str(x.created_at).slice(0, 10),
      text: masked ? null : str(x.text),
    }));
  }, []);

  // A stored card is history, not a live feed: it is never "stale".
  return {
    state: "ok",
    asOf: card.d,
    text: "",
    masked,
    data: {
      found: true,
      execution: card.execution,
      family: card.family,
      regime: card.regime,
      taken: card.taken,
      view,
      breakers,
      // Company news is hidden from a masked viewer (UX-009), so no news link either.
      basedOn: basedOn(card, t, factors?.effectByRule).map((b) => ({
        ...b,
        newsId: masked ? null : b.newsId,
      })),
      evidenceLine: evidenceLine(label),
      validation: label ?? "UNVALIDATED",
      past: pastSetups(card, label, profitable),
      factors:
        factors === null
          ? null
          : { up: factors.up, down: factors.down, notEnough: factors.notEnough },
      checklist: rows,
      headwinds: headwinds(card, label, warnings, t),
      scenarioRows: scenarioRows(card),
      why: whyLines(card, rows, warnings, t),
      afterwards: afterwards(card, closed, led !== null),
      notes,
      links: { home: "/", strategy: `/strategies/${encodeURIComponent(card.execution)}` },
    },
  };
}

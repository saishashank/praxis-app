// Loader of the Decision Card page and of the card links the other loaders hand out (M7 T7;
// docs/M7_design.md 3 rows 6 and 16; D-128, D-129, D-135 draft).
//
// A card id is `card:<signal id>:<execution>` and the signal id carries the stock code, so a masked
// viewer must never see or follow it: `cardRef` gives such a viewer an opaque `ck:` reference instead
// and `resolveCardRef` maps it back on the server (the same idea as the `mk:` alert keys). The page
// body is the existing masked `cardViewModel`; this loader adds the breaker checks and the links.
import "server-only";
import { createHash } from "node:crypto";
import type { DecisionCard } from "@/lib/agents/cards";
import { cardViewModel, type CardView } from "@/lib/view/cards";
import {
  loaded,
  openViewer,
  str,
  strOrNull,
  type Db,
  type Loaded,
  type LoaderDeps,
} from "./common";

const OPAQUE_PREFIX = "ck:";
const OPAQUE_RE = /^ck:([0-9a-f]{16})$/;
const HEX_LENGTH = 16; // threshold-ok: key digest length
const MAX_ID = 300; // threshold-ok: id length guard
const WINDOW_DAYS = 120; // threshold-ok: how far back an opaque reference can still be resolved
const DAY_MS = 86_400_000; // threshold-ok: unit conversion
const MAX_CARDS_SCANNED = 20_000; // threshold-ok: bound of the resolve scan
const MAX_BREAKER_ROWS = 60; // threshold-ok: bound of the breaker history read

/** `ck:` plus 16 hex of SHA-256 of the stored card id. */
export function cardRef(id: string): string {
  return OPAQUE_PREFIX + createHash("sha256").update(id).digest("hex").slice(0, HEX_LENGTH);
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
  links: { home: "/", strategy: null },
};

/** `idOrRef` is the id from the URL: a stored id, or a `ck:` reference. */
export async function loadCardPage(deps: LoaderDeps, idOrRef: string): Promise<Loaded<CardPage>> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const notFound = () =>
    loaded<CardPage>(null, v.now, masked, NOT_FOUND, "This card was not found.");
  if (idOrRef.length === 0 || idOrRef.length > MAX_ID) return notFound();
  const id = await resolveCardRef(deps.mainDb, idOrRef, v.now);
  if (id === null) return notFound();

  const row = await deps.mainDb.execute({
    sql: "SELECT card_json FROM decision_card WHERE id = ?",
    args: [id],
  });
  if (row.rows.length === 0) return notFound();
  const card = JSON.parse(str(row.rows[0]!.card_json)) as DecisionCard;
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
      links: { home: "/", strategy: `/strategies/${encodeURIComponent(card.execution)}` },
    },
  };
}

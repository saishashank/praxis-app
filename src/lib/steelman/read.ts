// UI reader for the Decision Card steelman (M11-lite WP6; D-497/D-498, D-534). Read-only: it selects
// from the stored pack, its shown points and the night row, and returns plain data. Masking is done by
// the caller (the cards loader), never here.
import {
  readNight,
  readOpenSuggestions,
  readPack,
  readPackForCard,
  readPoint,
  readPoints,
  type Exec,
  type PackItemRow,
  type PointRow,
} from "./store";
import type { NotWrittenReason } from "./write";

export type PointView = { text: string; citations: string[]; monitorable: boolean };
export type SteelmanView = {
  state: "written" | "not_written";
  reason?: NotWrittenReason;
  bull: PointView[];
  bear: PointView[];
  /** The pack items cited by the shown points, in id order. */
  cited: PackItemRow[];
};

const view = (p: PointRow): PointView => ({
  text: p.text,
  citations: p.citations,
  monitorable: p.monitorable,
});

/** The only reason the night row can name on its own: exactly one not-written counter is non-zero. */
async function nightReason(
  db: Exec,
  market: string,
  d: string,
): Promise<NotWrittenReason | undefined> {
  const n = await readNight(db, market, d);
  if (n === null) return undefined;
  const c: Array<[NotWrittenReason, number]> = [
    ["daily_limit", n.notWrittenLimit],
    ["budget", n.notWrittenBudget],
    ["no_model", n.notWrittenNoModel],
    ["critic_unavailable", n.notWrittenCritic],
  ];
  const on = c.filter(([, v]) => v > 0);
  return on.length === 1 ? on[0]![0] : undefined;
}

/**
 * The steelman of a card. null = the stage never stored a pack for it (nothing to show, no heading).
 * A pack with no shown points is `not_written`; the reason is read from the night row when it is
 * unambiguous, or "rejected" when points exist but none is shown.
 */
export async function readSteelmanForCard(db: Exec, cardId: string): Promise<SteelmanView | null> {
  const pack = await readPackForCard(db, cardId);
  if (pack === null) return null;
  const all = await readPoints(db, pack.packId);
  const shown = all.filter((p) => p.state === "shown");
  const bull = shown.filter((p) => p.side === "bull").map(view);
  const bear = shown.filter((p) => p.side === "bear").map(view);
  if (bull.length === 0 && bear.length === 0) {
    const reason = all.length > 0 ? "rejected" : await nightReason(db, pack.market, pack.d);
    return { state: "not_written", ...(reason ? { reason } : {}), bull: [], bear: [], cited: [] };
  }
  const ids = new Set(shown.flatMap((p) => p.citations));
  const cited = pack.items.filter((i) => ids.has(i.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  return { state: "written", bull, bear, cited };
}

export type SuggestionView = {
  suggestionId: string;
  d: string;
  code: string;
  cardId: string | null;
  family: string;
  /** The bear point the suggestion comes from. */
  text: string;
  cited: PackItemRow[];
};

/** Open suggestions with their bear point and cited evidence (Owner `/review`; never masked, D-497). */
export async function readSuggestionViews(db: Exec, market: string): Promise<SuggestionView[]> {
  const out: SuggestionView[] = [];
  for (const s of await readOpenSuggestions(db, market)) {
    const pt = await readPoint(db, s.pointId);
    if (pt === null) continue;
    const pack = await readPack(db, pt.packId);
    const ids = new Set(pt.citations);
    out.push({
      suggestionId: s.suggestionId,
      d: s.d,
      code: s.code,
      cardId: s.cardId,
      family: s.family,
      text: pt.text,
      cited: (pack?.items ?? [])
        .filter((i) => ids.has(i.id))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    });
  }
  return out;
}

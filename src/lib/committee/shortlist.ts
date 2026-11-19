// Committee shortlist (M22 C1; AGT-132, D-1417). The top `committee_shortlist` NEW signals of the session, by rank score,
// ties by code (then by signal id so the order is total). A signal in the `signal` table has passed the ARN-011 filters
// (a blocked entry never becomes a signal). Read-only over the decision tables, bounded by the limit, no paging offset.
// Deterministic: the same stored rows give the same list, whatever order the database returns them in.
import type { Exec } from "./store";

export type ShortlistItem = {
  signalId: string;
  code: string;
  /** The decision card of the signal (the evidence pack is built from it), or null when it has none. */
  cardId: string | null;
  rankScore: number;
};

/** The most signals a shortlist may hold (the key's upper bound, committee_shortlist 0-5). */
export const SHORTLIST_MAX = 5; // threshold-ok: key bound, AGT-132

export async function shortlist(
  db: Exec,
  market: string,
  d: string,
  count: number,
): Promise<ShortlistItem[]> {
  const limit = Math.max(0, Math.min(Math.trunc(count), SHORTLIST_MAX));
  if (!Number.isFinite(limit) || limit === 0) return [];
  // rows-ok: signal index (market, d, family) for one session, LIMIT committee_shortlist (at most 5), no paging
  const r = await db.execute({
    sql: `SELECT s.id AS id, s.code AS code, s.rank_score AS rank_score,
                 (SELECT MIN(c.id) FROM decision_card c WHERE c.signal_id = s.id) AS card_id
            FROM signal s
           WHERE s.market = ? AND s.d = ?
           ORDER BY CAST(s.rank_score AS REAL) DESC, s.code, s.id
           LIMIT ?`,
    args: [market, d, limit],
  });
  return r.rows.map((x) => ({
    signalId: String(x.id),
    code: String(x.code),
    cardId: x.card_id === null || x.card_id === undefined ? null : String(x.card_id),
    rankScore: Number(x.rank_score),
  }));
}

// Readers of the written pick reflections (M22 C3; AGT-146, D-1425). The only code outside the writer that names
// `pick_reflection`, so the steelman boundary (tests/security/steelmanBoundary.test.ts) keeps every table name inside this
// folder: the track record loader and the Evening Review section import these two functions. Reads only; a `not_written`
// row is never returned (it shows nothing).
import type { Exec } from "./store";

export type WrittenReflection = {
  d: string;
  profile: string;
  rank: number;
  code: string;
  text: string;
};

/** Written reflections of one profile for picks published between `fromD` and `toD` (newest first), at most `limit`. */
export async function readWrittenForProfile(
  db: Exec,
  q: { market: string; profile: string; fromD: string; toD: string; limit: number },
): Promise<{ d: string; rank: number; text: string }[]> {
  // rows-ok: pick_reflection primary-key range on (market, d), one profile, LIMIT bound by the caller (the rows listed), no OFFSET
  const r = await db.execute({
    sql: `SELECT d, rank, text FROM pick_reflection
           WHERE market = ? AND d >= ? AND d <= ? AND profile = ? AND state = 'written'
           ORDER BY d DESC, rank LIMIT ?`,
    args: [q.market, q.fromD, q.toD, q.profile, Math.max(0, Math.trunc(q.limit))],
  });
  return r.rows.map((x) => ({ d: String(x.d), rank: Number(x.rank), text: String(x.text) }));
}

/**
 * Written reflections created in [`createdFrom`, `createdTo`) for picks published in [`fromD`, `toD`), oldest first, at most
 * `limit`, with the pick's code (the monthly "Unproven notes" of the Evening Review).
 */
export async function readWrittenCreatedBetween(
  db: Exec,
  q: {
    market: string;
    fromD: string;
    toD: string;
    createdFrom: string;
    createdTo: string;
    limit: number;
  },
): Promise<WrittenReflection[]> {
  // rows-ok: pick_reflection primary-key range on (market, d) over the caller's window, written rows created in the month only, LIMIT 10, no OFFSET
  const r = await db.execute({
    sql: `SELECT r.d AS d, r.profile AS profile, r.rank AS rank, r.text AS text, p.code AS code
            FROM pick_reflection r JOIN pick p ON p.market = r.market AND p.d = r.d AND p.profile = r.profile AND p.rank = r.rank
           WHERE r.market = ? AND r.d >= ? AND r.d < ? AND r.state = 'written' AND r.created_at >= ? AND r.created_at < ?
           ORDER BY r.created_at, r.d, r.profile, r.rank LIMIT ?`,
    args: [q.market, q.fromD, q.toD, q.createdFrom, q.createdTo, Math.max(0, Math.trunc(q.limit))],
  });
  return r.rows.map((x) => ({
    d: String(x.d),
    profile: String(x.profile),
    rank: Number(x.rank),
    code: String(x.code),
    text: String(x.text),
  }));
}

// D-915 (Owner 2026-11-10): a strategy's change today from the delayed quotes already stored in
// `quote_latest` (D-900), shared by the Home summary and the Strategies page so both show the same
// figure. Shares held at the last close (`nav_daily_pos`) times (quote - that close), for every holding
// whose quote is from a later day than the close; cash does not move. Display only: the books, exits
// and statistics keep the close (ARN-021). No request is made to any source.
import { newerThanClose, readLatestQuotes, type LatestQuote } from "@/lib/data/quotes/latest";

type Exec = {
  execute: (q: {
    sql: string;
    args: (string | number)[];
  }) => Promise<{ rows: Record<string, unknown>[] }>;
};

/** null when no holding has a quote newer than the close (outside the session). */
export function liveDayChange(
  positions: ReadonlyArray<{ code: string; qty: number; closeMicro: number }>,
  quotes: ReadonlyMap<string, LatestQuote>,
  navD: string,
): { changeMicro: number; at: string } | null {
  let change = 0;
  let at: string | null = null;
  for (const p of positions) {
    const q = newerThanClose(quotes.get(p.code), navD);
    if (q === null) continue;
    change += p.qty * (Number(q.lastMicro) - p.closeMicro); // money-float-ok: micro-AUD within 2^53
    if (at === null || q.quoteAt > at) at = q.quoteAt;
  }
  return at === null ? null : { changeMicro: change, at };
}

/**
 * The live change of each cohort at its newest valued day (`d`), read in two bounded queries. A
 * cohort without a fresher quote is absent from the map; `anyAt` is the newest quote time used.
 */
export async function liveDayByCohort(
  db: Exec,
  market: string,
  cohorts: ReadonlyArray<{ cohortId: string; d: string }>,
): Promise<{ byCohort: Map<string, { changeMicro: number; at: string }>; anyAt: string | null }> {
  const byCohort = new Map<string, { changeMicro: number; at: string }>();
  if (cohorts.length === 0) return { byCohort, anyAt: null };
  const pos = await db.execute({
    sql: `SELECT cohort_id, code, qty, close_micro FROM nav_daily_pos
          WHERE ${cohorts.map(() => "(cohort_id = ? AND d = ?)").join(" OR ")}`,
    args: cohorts.flatMap((c) => [c.cohortId, c.d]),
  });
  const rows = pos.rows.map((p) => ({
    cohortId: String(p.cohort_id),
    code: String(p.code),
    qty: Number(p.qty), // money-float-ok: share count
    closeMicro: Number(p.close_micro), // money-float-ok: micro-AUD within 2^53
  }));
  const quotes = await readLatestQuotes(db as never, market, [...new Set(rows.map((r) => r.code))]);
  let anyAt: string | null = null;
  for (const c of cohorts) {
    const r = liveDayChange(
      rows.filter((p) => p.cohortId === c.cohortId),
      quotes,
      c.d,
    );
    if (r === null) continue;
    byCohort.set(c.cohortId, r);
    if (anyAt === null || r.at > anyAt) anyAt = r.at;
  }
  return { byCohort, anyAt };
}

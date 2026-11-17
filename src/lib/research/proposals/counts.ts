// The Owner's proposal counts for the Cortex page (M23 M4, D-1643, D-1766): kept for review and refused, as two numbers. Counts only:
// no rule, text, model name or id is read. This module lives in the proposals folder because AT-73 allows only that folder (and
// names.ts) to name the proposal table.
import type { Client } from "@libsql/client";

/** Owner only: model-written proposals kept for review and refused (counts, never a rule or a text). */
export async function proposalCounts(
  db: Client,
  market: string,
): Promise<{ kept: number; refused: number }> {
  // rows-ok: angle_proposal index (market, month): the market's proposals, a few a month, grouped to two numbers
  const r = await db.execute({
    sql: "SELECT state = 'stored' AS kept, COUNT(*) AS n FROM angle_proposal WHERE market = ? GROUP BY kept",
    args: [market],
  });
  let kept = 0;
  let refused = 0;
  for (const x of r.rows) {
    if (Number(x.kept) === 1) kept += Number(x.n);
    else refused += Number(x.n);
  }
  return { kept, refused };
}

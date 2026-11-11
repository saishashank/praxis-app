// System Health data-feed lines (Owner only, counts only; DAT-251 b, DAT-252 (2)).
//   "News: n items waiting for assessment"                       the Sentinel queue beyond this call's cap
//   "Company list: ASX fetch failed n runs; the Wikidata fallback is off (Data sources)"
// No code, name or URL is ever in a line.
import type { Client } from "@libsql/client";
import { FALLBACK_REGISTER_ROW, LIST_SOURCE } from "@/lib/data/codeHistory";
import { countUnassessed } from "@/lib/sentinel/ingest";

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Pure: the news line, or null when nothing waits. */
export function newsWaitingLine(n: number): string | null {
  if (!Number.isInteger(n) || n <= 0) return null;
  return `News: ${n} ${plural(n, "item", "items")} waiting for assessment`;
}

/** Pure: the company-list line, or null while the list fetch is healthy. */
export function companyListLine(failures: number, fallbackOn: boolean): string | null {
  if (!Number.isInteger(failures) || failures <= 0) return null;
  const fb = fallbackOn
    ? "the Wikidata fallback is on"
    : "the Wikidata fallback is off (Data sources)";
  return `Company list: ASX fetch failed ${failures} ${plural(failures, "run", "runs")}; ${fb}`;
}

/** The lines for the Owner. rows-ok: three single-row reads and one bounded count (48 h of announcements). */
export async function dataFeedLines(db: Client, now: Date): Promise<string[]> {
  const lines: string[] = [];
  const news = newsWaitingLine(await countUnassessed(db, now.toISOString()));
  if (news !== null) lines.push(news);
  const s = await db.execute({
    sql: "SELECT consecutive_failures AS n FROM source_fetch_status WHERE source = ?",
    args: [LIST_SOURCE],
  });
  const r = await db.execute({
    sql: "SELECT status FROM source_register WHERE source = ?",
    args: [FALLBACK_REGISTER_ROW],
  });
  const company = companyListLine(
    s.rows.length > 0 ? Number(s.rows[0]!.n) : 0,
    r.rows.length > 0 && String(r.rows[0]!.status) === "enabled",
  );
  if (company !== null) lines.push(company);
  return lines;
}

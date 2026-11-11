// System Health data-feed lines (Owner only, counts only; DAT-251 b, DAT-252 (2)).
//   "News: n items waiting for assessment"                       the Sentinel queue beyond this call's cap
//   "Company list: ASX fetch failed n runs; the Wikidata fallback is off (Data sources)"
// No code, name or URL is ever in a line.
import type { Client } from "@libsql/client";
import { FALLBACK_REGISTER_ROW, LIST_SOURCE } from "@/lib/data/codeHistory";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { CARRY_WINDOW_H } from "@/lib/sentinel/ingest";

const HOUR_MS = 3_600_000; // threshold-ok: unit conversion

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

/**
 * The lines for the Owner, from ONE statement (System Health reads inside a call budget).
 * rows-ok: two single-row reads and one bounded count (the 48 h carry window, same predicate as countUnassessed).
 */
export async function dataFeedLines(db: Client, now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - CARRY_WINDOW_H * HOUR_MS).toISOString();
  const r = await db.execute({
    sql:
      "SELECT (SELECT COUNT(*) FROM announcement a WHERE a.source = ? AND a.market = 'AU' AND a.ingested_at >= ? " +
      "AND a.published_at >= ? AND NOT EXISTS (SELECT 1 FROM item_assessment s WHERE s.source = a.source AND s.ann_id = a.ann_id)) AS news, " +
      "(SELECT consecutive_failures FROM source_fetch_status WHERE source = ?) AS fails, " +
      "(SELECT status FROM source_register WHERE source = ?) AS reg",
    args: [ASX_SOURCE, since, since, LIST_SOURCE, FALLBACK_REGISTER_ROW],
  });
  const x = r.rows[0];
  const lines: string[] = [];
  const news = newsWaitingLine(Number(x?.news ?? 0));
  if (news !== null) lines.push(news);
  const company = companyListLine(Number(x?.fails ?? 0), String(x?.reg ?? "") === "enabled");
  if (company !== null) lines.push(company);
  return lines;
}

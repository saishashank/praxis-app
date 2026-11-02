// M17 WP5: today's Sentinel catalysts (AGT-141a). Read only: `item_assessment` joined to `announcement`
// (and `event` for the category) for items published on the session date, up to `beforeIso`, with
// materiality 2 or more. One catalyst per code: the highest materiality, then the latest publication.
import { localToUtc } from "@/lib/data/calendar";
import type { Exec } from "@/lib/cortex/store/common";

export type Catalyst = {
  source: string;
  annId: string;
  title: string;
  publishedAt: string;
  category: string | null;
  materiality: 2 | 3;
  polarity: -1 | 0 | 1;
};

export const CATALYST_MIN_MATERIALITY = 2; // threshold-ok: AGT-141a "materiality 2 or more"
const MARKET_TZ = "Australia/Melbourne";

export async function todayCatalysts(
  db: Exec,
  market: string,
  d: string,
  beforeIso: string,
): Promise<Map<string, Catalyst>> {
  const fromIso = localToUtc(d, "00:00", MARKET_TZ).toISOString();
  const r = await db.execute({
    sql:
      "SELECT a.code AS code, i.source AS source, i.ann_id AS ann_id, a.title AS title, " +
      "a.published_at AS published_at, COALESCE(e.category, a.type) AS category, " +
      "i.materiality AS materiality, i.polarity AS polarity " +
      "FROM item_assessment i " +
      "JOIN announcement a ON a.source = i.source AND a.ann_id = i.ann_id " +
      "LEFT JOIN event e ON e.market = i.market AND e.source = i.source AND e.ann_id = i.ann_id " +
      "WHERE i.market = ? AND i.materiality >= ? AND a.published_at >= ? AND a.published_at <= ? " +
      "ORDER BY a.code, i.materiality DESC, a.published_at DESC, i.ann_id",
    args: [market, CATALYST_MIN_MATERIALITY, fromIso, beforeIso],
  });
  const out = new Map<string, Catalyst>();
  for (const row of r.rows) {
    const code = String(row.code);
    if (out.has(code)) continue; // rows are ordered best first
    const m = Number(row.materiality);
    const p = Number(row.polarity);
    out.set(code, {
      source: String(row.source),
      annId: String(row.ann_id),
      title: String(row.title),
      publishedAt: String(row.published_at),
      category: row.category === null ? null : String(row.category),
      materiality: m >= 3 ? 3 : 2, // threshold-ok: materiality scale 0..3
      polarity: p > 0 ? 1 : p < 0 ? -1 : 0,
    });
  }
  return out;
}

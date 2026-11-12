// US filings -> announcements (M20 US1; DAT-245, DAT-246, D-1108, D-1166, D-1125's rule for the US too: headline and
// link, never a body). One `announcement` row per filing of a form the category map knows (8-K, 10-Q, 10-K and their
// amendments), keyed by the accession number, `published_at` = the EDGAR ACCEPTANCE instant (known time), `type` =
// `8-K:<items>` for an 8-K (every item the filing lists) or the form itself, `title` = the filing's own description
// (or the form and items), `url` = the filing index page. The category is the one the pure first-match map gives
// (`classify`, never an LLM, AGT-011a); `price_sensitive` is 1 when its materiality is 2 or more (the US has no
// exchange flag, so the map's AGT-011 materiality stands in, D-1183). A filing with no acceptance instant is skipped
// and counted (its known time would be a guess).
import { assertMarketEnabled } from "../../../market/guard.mjs";
import { filingIndexUrl } from "./edgar.mjs";

export const FILINGS_SOURCE = "us_edgar";
/** The forms read from `submissions`: the 8-K family and the periodic reports (Form 4 and 13D/G have their own parsers). */
const FORM_RE = /^(?:8-K(?:\/A)?|10-Q(?:\/A)?|10-K(?:\/A)?)$/i;

/**
 * @typedef {{ accession: string, form: string, filedDate: string, acceptedAt: string | null, items: string[],
 *             description: string | null }} Filing
 * @typedef {{ annId: string, code: string, publishedAt: string, type: string, title: string, url: string,
 *             form: string, items: string[] }} AnnouncementCandidate
 */

/**
 * @param {{ cik: string, filings: Filing[] }} subs @param {string} code
 * @param {{ since?: string }} [o] `since`: ISO instant, only filings accepted at or after it
 * @returns {{ rows: AnnouncementCandidate[], skippedNoTime: number, skippedForm: number }}
 */
export function announcementsFromSubmissions(subs, code, o = {}) {
  /** @type {AnnouncementCandidate[]} */
  const rows = [];
  let skippedNoTime = 0;
  let skippedForm = 0;
  for (const f of subs.filings) {
    if (!FORM_RE.test(f.form)) {
      skippedForm += 1;
      continue;
    }
    if (f.acceptedAt === null) {
      skippedNoTime += 1;
      continue;
    }
    if (o.since !== undefined && f.acceptedAt < o.since) continue;
    const eight = /^8-K/i.test(f.form);
    const type = eight && f.items.length > 0 ? `8-K:${f.items.join(",")}` : f.form;
    const title =
      f.description ?? (f.items.length > 0 ? `${f.form} items ${f.items.join(", ")}` : f.form);
    rows.push({
      annId: f.accession,
      code,
      publishedAt: f.acceptedAt,
      type,
      title,
      url: filingIndexUrl(subs.cik, f.accession),
      form: f.form,
      items: f.items,
    });
  }
  rows.sort((a, b) =>
    a.publishedAt < b.publishedAt
      ? -1
      : a.publishedAt > b.publishedAt
        ? 1
        : a.annId < b.annId
          ? -1
          : 1,
  );
  return { rows, skippedNoTime, skippedForm };
}

/**
 * Write announcements and their categories. `classify(item)` is the pure map (`classify(map, item)` bound by the
 * caller); one batch per call, ON CONFLICT DO NOTHING (a re-run adds nothing, the first classification stays).
 * @param {{ batch: Function }} db @param {string} market @param {AnnouncementCandidate[]} rows
 * @param {{ classify: (item: { type: string, item: string[], form: string, title: string }) => { category: string, materiality: number, verifiable: boolean, mapVersion: string }, now: string }} o
 * @returns {Promise<{ inserted: number, categories: number }>}
 */
export async function writeAnnouncements(db, market, rows, o) {
  await assertMarketEnabled(db, market);
  if (rows.length === 0) return { inserted: 0, categories: 0 };
  /** @type {{ sql: string, args: (string | number | null)[] }[]} */
  const ann = [];
  /** @type {{ sql: string, args: (string | number | null)[] }[]} */
  const cat = [];
  for (const r of rows) {
    const c = o.classify({ type: r.type, item: r.items, form: r.form, title: r.title });
    ann.push({
      // rows-ok: one insert per new filing of the night (the covered universe, a few hundred), ignored when present
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, ann_id) DO NOTHING`,
      args: [
        market,
        r.code,
        r.annId,
        r.publishedAt,
        o.now,
        r.type,
        c.materiality >= 2 ? 1 : 0,
        r.title,
        r.url,
        FILINGS_SOURCE,
      ],
    });
    cat.push({
      // rows-ok: one insert per new filing, keyed by (market, source, ann_id), the first classification stays
      sql: `INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (market, source, ann_id) DO NOTHING`,
      args: [
        market,
        FILINGS_SOURCE,
        r.annId,
        c.category,
        c.materiality,
        c.verifiable ? 1 : 0,
        c.mapVersion,
      ],
    });
  }
  const res = await db.batch([...ann, ...cat], "write");
  const inserted = res.slice(0, ann.length).reduce((a, x) => a + x.rowsAffected, 0);
  const categories = res.slice(ann.length).reduce((a, x) => a + x.rowsAffected, 0);
  return { inserted, categories };
}

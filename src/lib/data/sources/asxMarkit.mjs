// The ASX announcements feed as the ASX website itself serves it (D-194): JSON from
// asx.api.markitdigital.com (the market-wide list and the per-company list), recorded 2026-10-26.
// It replaces the documented synthetic shape the first parser waited for (src/lib/data/sources/
// asx.ts, a [VERIFY] that was never resolved). Pure ESM: the GitHub fetch step and the app share it.
//
// Market list:  GET /asx-research/1.0/markets/announcements?page=N&itemsPerPage=M
//   { data: { items: [ { announcementTypes: [string], symbol: string, date: ISO Z,
//     documentKey: "2924-<idsId>-<hash>", headline: string, isPriceSensitive: boolean, url: "" } ] } }
// Company list: GET /asx-research/1.0/companies/<CODE>/announcements
//   { data: { symbol: string, items: [ { announcementType: string, date, documentKey, headline,
//     isPriceSensitive } ] } }  (the code is on `data`, not on each item)
// Metadata and a link only (DAT-122): the link is the ASX's own announcement page for the idsId.

export const MARKIT_BASE = "https://asx.api.markitdigital.com/asx-research/1.0";
export const marketFeedUrl = (page, perPage) =>
  `${MARKIT_BASE}/markets/announcements?page=${page}&itemsPerPage=${perPage}`;
export const companyFeedUrl = (code) =>
  `${MARKIT_BASE}/companies/${encodeURIComponent(code)}/announcements`;

const CODE_RE = /^[A-Z0-9]{1,6}$/;
const KEY_RE = /^\d+-(\d{6,10})-[0-9A-Z]+$/i;

/** The ASX page of one announcement, from its documentKey; null when the key has no idsId. */
export function announcementLink(documentKey) {
  const m = KEY_RE.exec(documentKey);
  return m === null
    ? null
    : `https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=${m[1]}`;
}

/**
 * Items of either list (or of a merged body `{ data: { items } }` whose items carry `symbol`).
 * Never throws; an entry without a code, key, time or headline is skipped and counted.
 * @param {string} body
 * @returns {{ items: { annId: string, code: string, publishedAt: string, type: string | null,
 *   priceSensitive: boolean, title: string, url: string | null }[], skipped: number } | null}
 */
export function parseMarkitFeed(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const data = json?.data;
  if (data === null || typeof data !== "object" || !Array.isArray(data.items)) return null;
  const listCode = typeof data.symbol === "string" ? data.symbol.toUpperCase() : null;
  const seen = new Set();
  const items = [];
  let skipped = 0;
  for (const it of data.items) {
    const code = (typeof it?.symbol === "string" ? it.symbol : (listCode ?? "")).toUpperCase();
    const key = typeof it?.documentKey === "string" ? it.documentKey : "";
    const date = typeof it?.date === "string" ? Date.parse(it.date) : Number.NaN;
    const title = typeof it?.headline === "string" ? it.headline.trim() : "";
    if (!CODE_RE.test(code) || key === "" || Number.isNaN(date) || title === "" || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const type = Array.isArray(it.announcementTypes)
      ? (it.announcementTypes[0] ?? null)
      : typeof it.announcementType === "string"
        ? it.announcementType
        : null;
    items.push({
      annId: key,
      code,
      publishedAt: new Date(date).toISOString(),
      type: typeof type === "string" && type.trim() !== "" ? type.trim() : null,
      priceSensitive: it.isPriceSensitive === true,
      title: title.slice(0, 300),
      url: announcementLink(key),
    });
  }
  return { items, skipped };
}

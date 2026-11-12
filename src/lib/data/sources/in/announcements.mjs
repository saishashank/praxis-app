// NSE and BSE corporate announcement lists (M20 IN1; DAT-243 c, D-1125, D-1108): HEADLINE and LINK only, never a body.
// `price_sensitive` is always 0 (the exchanges publish no such flag; AU's comes from the ASX). `type` is the exchange's
// own subject, which the category map matches on (`announcement_category`, written by `writeAnnouncementCategory`).
// The fetch step never calls the source while its register row is `disabled` (the day module checks the row and
// ignores a file it was handed); these parsers run only on a file the polite client fetched or a recorded fixture.
//
// NSE (`/api/corporate-announcements`): rows `{ symbol, desc, attchmntText, attchmntFile, an_dt, seq_id }`.
// BSE (`AnnSubCategoryGetData`): `{ Table: [{ NEWSID, SCRIP_CD, NEWS_DT, HEADLINE, CATEGORYNAME, ATTACHMENTNAME }] }`;
// a BSE row names its scrip by number, so the caller passes `codeOfScrip` (scrip number -> NSE symbol) and a row whose
// scrip it does not know is dropped.
import { istToUtcIso, nseDateTime } from "./parse.mjs";

export const NSE_SOURCE = "in_nse_announcements";
export const BSE_SOURCE = "in_bse_announcements";
const TITLE_MAX = 300;
const URL_MAX = 500;

/** Only an https link on the exchange's own hosts is kept; anything else is stored as no link. @param {unknown} u */
function safeUrl(u) {
  if (typeof u !== "string") return null;
  try {
    const x = new URL(u.trim());
    if (x.protocol !== "https:") return null;
    if (!/(^|\.)(nseindia\.com|bseindia\.com)$/i.test(x.hostname)) return null;
    return x.href.slice(0, URL_MAX);
  } catch {
    return null;
  }
}

/**
 * @typedef {{ market: string, code: string, annId: string, publishedAt: string, type: string, title: string,
 *   url: string | null, source: string, priceSensitive: 0 }} Announcement
 */

/**
 * @param {unknown} json @param {{ market: string }} o
 * @returns {{ items: Announcement[], rejected: number }}
 */
export function parseNseAnnouncements(json, o) {
  const list = Array.isArray(json) ? json : [];
  /** @type {Announcement[]} */
  const items = [];
  let rejected = 0;
  for (const r of list) {
    const when = nseDateTime(String(r?.an_dt ?? ""));
    const code = typeof r?.symbol === "string" ? r.symbol.trim() : "";
    const annId = r?.seq_id === undefined || r.seq_id === null ? "" : String(r.seq_id).trim();
    if (when === null || code === "" || annId === "") {
      rejected += 1;
      continue;
    }
    const subject = String(r.desc ?? "").trim();
    const headline = String(r.attchmntText ?? "").trim();
    items.push({
      market: o.market,
      code,
      annId,
      publishedAt: istToUtcIso(when.d, when.time),
      type: subject.slice(0, 120),
      title: (headline === "" ? subject : headline).slice(0, TITLE_MAX),
      url: safeUrl(r.attchmntFile),
      source: NSE_SOURCE,
      priceSensitive: 0,
    });
  }
  return { items, rejected };
}

/**
 * @param {unknown} json @param {{ market: string, codeOfScrip: (scrip: string) => string | null }} o
 * @returns {{ items: Announcement[], rejected: number }}
 */
export function parseBseAnnouncements(json, o) {
  const list = /** @type {any} */ (json)?.Table;
  /** @type {Announcement[]} */
  const items = [];
  let rejected = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const dt = String(r?.NEWS_DT ?? "").trim(); // "2026-11-12T18:30:10"
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(dt);
    const code = o.codeOfScrip(String(r?.SCRIP_CD ?? "").trim());
    const annId = String(r?.NEWSID ?? "").trim();
    if (m === null || code === null || annId === "") {
      rejected += 1;
      continue;
    }
    const subject = String(r.CATEGORYNAME ?? "").trim();
    const headline = String(r.HEADLINE ?? "").trim();
    items.push({
      market: o.market,
      code,
      annId,
      publishedAt: istToUtcIso(m[1], m[2]),
      type: subject.slice(0, 120),
      title: (headline === "" ? subject : headline).slice(0, TITLE_MAX),
      url: r.ATTACHMENTNAME
        ? safeUrl(`https://www.bseindia.com/xml-data/corpfiling/AttachLive/${r.ATTACHMENTNAME}`)
        : null,
      source: BSE_SOURCE,
      priceSensitive: 0,
    });
  }
  return { items, rejected };
}

/**
 * `announcement` rows in the table's column order (id is the table's own).
 * @param {Announcement[]} items @param {string} ingestedAt
 */
export function announcementRows(items, ingestedAt) {
  return items.map((a) => [
    a.market,
    a.code,
    a.annId,
    a.publishedAt,
    ingestedAt,
    a.type === "" ? null : a.type,
    a.priceSensitive,
    a.title,
    a.url,
    a.source,
  ]);
}

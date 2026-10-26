// Sentinel feed parser seam (M5 T5; docs/M5_design.md 4.2 step 2, D-058, D-100 draft).
//
// The Worker hands over the raw body of the ASX announcements list. Which shape that body has is
// NOT pinned by the spec: TODO(fixtures) [VERIFY] until a recorded real feed exists in the private
// fixtures repo. Until then the one parser, `asxFeedV1`, wraps the documented synthetic JSON shape
// of src/lib/data/sources/asx.ts (`{ "data": [ { id, code, time, type, price_sensitive, title,
// url } ] }`). A recorded real format means writing a second `FeedParser` and switching
// `ACTIVE_FEED_PARSER`; nothing else in the Sentinel changes (the route, the classification and
// the tables only see `FeedItem`).
import { parseAnnouncementList } from "@/lib/data/sources/asx";
import { parseMarkitFeed } from "@/lib/data/sources/asxMarkit.mjs";

export type FeedItem = {
  annId: string;
  code: string;
  /** ISO-8601 UTC with milliseconds and Z. */
  publishedAt: string;
  type: string | null;
  priceSensitive: boolean;
  title: string;
  url: string | null;
};

export type ParsedFeed = {
  items: FeedItem[];
  /** Entries of the list that were skipped as malformed or duplicate. */
  skipped: number;
};

export type FeedParser = {
  /** Recorded with the parser's output so a format change is visible in the data. */
  id: string;
  /** Null when the body is not a feed of this format (never throws). */
  parse: (body: string) => ParsedFeed | null;
};

/** More list entries than this are not trusted (a 256 KB body cannot hold more than ~2,000). */
export const MAX_FEED_ITEMS = 5000;

export const asxFeedV1: FeedParser = {
  id: "asxFeedV1",
  parse(body) {
    try {
      const { items, skipped } = parseAnnouncementList(body);
      if (items.length > MAX_FEED_ITEMS) return null;
      return {
        items: items.map((i) => ({
          annId: i.annId,
          code: i.code,
          publishedAt: i.publishedAt,
          type: i.type.trim() === "" ? null : i.type,
          priceSensitive: i.priceSensitive,
          title: i.title,
          url: i.pdfUrl,
        })),
        skipped,
      };
    } catch {
      return null;
    }
  },
};

/**
 * D-194: the real ASX format, recorded 2026-10-26 (the JSON the ASX website reads from
 * asx.api.markitdigital.com, market-wide and per company). See src/lib/data/sources/asxMarkit.mjs.
 */
export const asxMarkitV1: FeedParser = {
  id: "asxMarkitV1",
  parse(body) {
    const r = parseMarkitFeed(body);
    if (r === null || r.items.length > MAX_FEED_ITEMS) return null;
    return r;
  },
};

/** The adapter seam: the real ASX format first, the documented synthetic shape as the fallback. */
export const ACTIVE_FEED_PARSER: FeedParser = {
  id: "asxMarkitV1|asxFeedV1",
  parse: (body) => asxMarkitV1.parse(body) ?? asxFeedV1.parse(body),
};

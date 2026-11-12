export const NSE_SOURCE: "in_nse_announcements";
export const BSE_SOURCE: "in_bse_announcements";
export type Announcement = {
  market: string;
  code: string;
  annId: string;
  publishedAt: string;
  type: string;
  title: string;
  url: string | null;
  source: string;
  priceSensitive: 0;
};
export function parseNseAnnouncements(
  json: unknown,
  o: { market: string },
): { items: Announcement[]; rejected: number };
export function parseBseAnnouncements(
  json: unknown,
  o: { market: string; codeOfScrip: (scrip: string) => string | null },
): { items: Announcement[]; rejected: number };
export function announcementRows(
  items: Announcement[],
  ingestedAt: string,
): (string | number | null)[][];

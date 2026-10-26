export const MARKIT_BASE: string;
export function marketFeedUrl(page: number, perPage: number): string;
export function companyFeedUrl(code: string): string;
export function announcementLink(documentKey: string): string | null;
export type MarkitItem = {
  annId: string;
  code: string;
  publishedAt: string;
  type: string | null;
  priceSensitive: boolean;
  title: string;
  url: string | null;
};
export function parseMarkitFeed(body: string): { items: MarkitItem[]; skipped: number } | null;

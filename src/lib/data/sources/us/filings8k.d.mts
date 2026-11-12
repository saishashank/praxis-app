import type { Filing } from "./submissions.mjs";
export const FILINGS_SOURCE: string;
export type AnnouncementCandidate = {
  annId: string;
  code: string;
  publishedAt: string;
  type: string;
  title: string;
  url: string;
  form: string;
  items: string[];
};
export function announcementsFromSubmissions(
  subs: { cik: string; filings: Filing[] },
  code: string,
  o?: { since?: string },
): { rows: AnnouncementCandidate[]; skippedNoTime: number; skippedForm: number };
export function writeAnnouncements(
  db: { batch: (...a: never[]) => unknown; execute: (...a: never[]) => unknown },
  market: string,
  rows: AnnouncementCandidate[],
  o: {
    classify: (item: { type: string; item: string[]; form: string; title: string }) => {
      category: string;
      materiality: number;
      verifiable: boolean;
      mapVersion: string;
    };
    now: string;
  },
): Promise<{ inserted: number; categories: number }>;

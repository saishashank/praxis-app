export type Filing = {
  accession: string;
  form: string;
  filedDate: string;
  acceptedAt: string | null;
  items: string[];
  description: string | null;
};
export type Submissions = {
  cik: string;
  name: string | null;
  sic: string | null;
  tickers: string[];
  filings: Filing[];
};
export function acceptanceInstant(v: unknown): string | null;
export function parseSubmissions(json: unknown): Submissions;
export function acceptanceByAccession(s: Submissions): Record<string, string>;
export function sicGroup(sic: string | null): string | null;
export function writeSicGroup(
  db: { execute: (...a: never[]) => unknown },
  market: string,
  code: string,
  sic: string | null,
): Promise<boolean>;

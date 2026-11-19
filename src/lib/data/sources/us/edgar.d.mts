export const EDGAR_SOURCE: string;
export const EDGAR_HOSTS: readonly string[];
export const EDGAR_CONTACT_ENV: string;
export const EDGAR_PRODUCT: string;
export class EdgarContactMissing extends Error {}
export class EdgarHostRefused extends Error {}
export class EdgarHttpError extends Error {
  status: number;
  constructor(status: number);
}
export function edgarUserAgent(env: Record<string, string | undefined>, version?: string): string;
export function createEdgarClient(o: {
  db: { execute: (...a: never[]) => unknown };
  market: string;
  env?: Record<string, string | undefined>;
  version?: string;
  fetchImpl?: typeof fetch;
  gate?: (row: never) => unknown;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  siteOf?: (host: string) => never;
  sourceOf?: (id: string) => never;
  log?: (e: { host: string; status: number | string }) => void;
}): {
  getText(url: string): Promise<string>;
  getJson(url: string): Promise<unknown>;
};
export function submissionsUrl(cik: string | number): string;
export function companyFactsUrl(cik: string | number): string;
export function filingIndexUrl(cik: string | number, accession: string): string;

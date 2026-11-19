export const SESSIONS: readonly string[];
export const SOURCE: string;
export const COMPANIES: readonly {
  code: string;
  cik: string;
  name: string;
  sic: string;
  px: number;
  vol: number;
}[];
export function buildUsFixtures(): {
  sessions: readonly string[];
  companies: typeof COMPANIES;
  files: Record<string, string>;
};
export function writeUsFixtures(dir: string): number;
export function accession(n: number): string;

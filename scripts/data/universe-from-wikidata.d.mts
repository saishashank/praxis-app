export const HEADER: string;
export const MAX_NAME: number;
export const MAX_INDUSTRY: number;
export type WikidataRecord = { code: string; name: string; industry: string };
export function extractRecords(json: unknown): WikidataRecord[] | null;
export function convert(json: unknown):
  | {
      ok: true;
      csv: string;
      stats: { input: number; written: number; skipped: number; duplicates: number };
    }
  | { ok: false; error: "unrecognised_format" };
export function main(argv?: string[], out?: (s: string) => void): number;

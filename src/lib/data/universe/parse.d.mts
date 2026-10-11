export const MAX_CSV_CHARS: number;
export const MAX_RECORDS: number;
export const MAX_NAME: number;
export const MAX_INDUSTRY: number;
export const MAX_PREAMBLE: number;
export const MAX_SKIPPED_RATIO: number;

export type ListedCompany = { code: string; name: string; industry: string | null };
export type ParseStats = {
  records: number;
  valid: number;
  duplicates: number;
  badCodes: number;
  malformed: number;
};
export type ParseResult =
  | { ok: true; rows: ListedCompany[]; stats: ParseStats }
  | { ok: false; error: "unrecognised_format" };

export function splitCsv(text: string): string[][];
export function parseListedCompanies(text: unknown): ParseResult;

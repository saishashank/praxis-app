export const ROOT: string;
export const OUT: string;
export const REPORT_DIR: string;
export const HEADING: string;
export const GATE_ROLES: readonly string[];
export const ROLE_CATEGORIES: Readonly<Record<string, readonly string[]>>;
export type ParsedReport = {
  run: string | null;
  date: string | null;
  table: { role: string; model: string; result: string }[] | null;
  sections: Map<string, { trains: boolean; rows: { category: string; check: string }[] }>;
};
export function parseReport(text: string): ParsedReport | null;
export function roleResults(report: ParsedReport): Record<string, string[]>;
export type IndexEntry = {
  verdict: "PASS" | "FAIL";
  date: string;
  run: string;
  report: string;
  models: string[];
};
export function buildIndex(files: { file: string; text: string }[]): Record<string, IndexEntry>;
export function readReports(root?: string): { file: string; text: string }[];
export function render(root?: string, files?: { file: string; text: string }[]): Promise<string>;

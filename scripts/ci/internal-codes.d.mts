export const PATTERNS: Readonly<Record<string, RegExp>>;
export const ROOTS: string[];
export function matchPatterns(text: string): string[];
export function scanText(
  text: string,
  rel: string,
): { line: number; pattern: string; text: string }[];
export function listFiles(root: string): string[];
export function readAllow(root: string): { problems: string[]; entries: unknown[] };
export function scanTree(root: string): {
  hits: { file: string; line: number; pattern: string; text: string }[];
  allowed: number;
  files: number;
  stale: string[];
  problems: string[];
};

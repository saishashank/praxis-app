export const CLASSES: Readonly<Record<string, RegExp>>;
export type AllowEntry = {
  file?: string;
  dir?: string;
  classes?: string[];
  includes?: string;
  reason: string;
};
export const EXTRA_ALLOW: readonly AllowEntry[];
export type LiteralHit = { line: number; cls: string; text: string };
export function readSeedAllow(root: string): string[];
export function stripComments(text: string, kind: "js" | "hash"): string;
export function scanText(text: string, rel: string): LiteralHit[];
export function listFiles(root: string): string[];
export function scanTree(root: string): {
  hits: (LiteralHit & { file: string })[];
  allowed: number;
  files: number;
  quotedFiles: string[];
  stale: string[];
};

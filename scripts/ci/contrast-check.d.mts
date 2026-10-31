export type PairKind = "text" | "ui";
export type ContrastResult = {
  theme: string;
  fg: string;
  bg: string;
  kind: PairKind;
  ratio: number;
  need: number;
  ok: boolean;
};
export const PAIRS: [string, string, PairKind][];
export const V2_HUES: string[];
export const V2_PAIRS: [string, string, PairKind][];
export const THEME_NAMES: string[];
export function threshold(theme: string, kind: PairKind): number;
export function parseHex(hex: string): [number, number, number];
export function luminance(hex: string): number;
export function ratio(a: string, b: string): number;
export function parseThemes(css: string): Record<string, Record<string, string>>;
export function mixHex(base: string, top: string, pct: number): string;
export function resolveBg(t: Record<string, string>, spec: string): string | null;
export function check(css: string): {
  themes: Record<string, Record<string, string>>;
  results: ContrastResult[];
  failures: string[];
};

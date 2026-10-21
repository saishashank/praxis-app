// Honesty rules for every number and sentence the UI shows (UX-041, UX-102, UXN-272, UXN-048;
// docs/M7_design.md 2.10 and 4.1). Fixed texts live here so a page cannot soften or drop them, and a
// small-sample rule keeps a figure from looking firmer than its evidence.
import { formatCount } from "./format";

export const NOT_ADVICE_FOOTER = "Simulation for personal information only — not financial advice";
export const SCENARIO_CAPTION = "Historical range, not a forecast";
export const AI_SUMMARY_NOTICE =
  "AI summary of public information — may be incomplete or out of date. Not financial advice.";
export const DELAYED_PRICE_LABEL = "Delayed about 20 min";
export const PRICES_PAUSED_TEXT = "Prices paused";
export const END_OF_DAY_LABEL = "End-of-day price";
export const NOTHING_YET = "Not measured yet";

export type SampleCheck = { enough: boolean; text: string };

/**
 * A statistic needs `min` observations before it is shown as a number. Below that the page shows the
 * text instead of the figure (never 0, never a rounded-up guess).
 */
export function sampleCheck(n: number | null | undefined, min: number): SampleCheck {
  const have = typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (have >= min) return { enough: true, text: `Based on ${formatCount(have)} cases` };
  return {
    enough: false,
    text: `${NOTHING_YET}: ${formatCount(have)} of ${formatCount(min)} cases so far`,
  };
}

/** The labelled phrase for a figure with a source of its own words: "name: value (basis)". */
export function withBasis(value: string, basis: string): string {
  return `${value} (${basis})`;
}

/** Words a page must not use for a historical range or an estimate (UX-041). Checked in tests. */
export const FORBIDDEN_CLAIMS: readonly RegExp[] = [
  /\bguarantee[sd]?\b/i,
  /\bwill (?:rise|gain|profit|make)\b/i,
  /\bsure thing\b/i,
  /\brisk[- ]free\b/i,
];

/** True when a sentence makes a claim the product never makes. */
export function hasForbiddenClaim(text: string): boolean {
  return FORBIDDEN_CLAIMS.some((re) => re.test(text));
}

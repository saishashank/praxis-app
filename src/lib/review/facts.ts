// Evening Review facts model (M5 T9; docs/M5_design.md 2.6 and 4.6; EML-011/012/014/035/037).
// Pure helpers shared by the section readers (sections.ts) and the assembler (assemble.ts): the
// section names, the run keys the readers look up, the partial map (which inputs a section needs),
// canonical JSON and the facts hash. No database access and no clock here.
//
// The fact types themselves are the renderer's (src/lib/email/templates/review.ts): the readers
// produce exactly `ReviewFacts`, so what is rendered is what was read.
import { createHash } from "node:crypto";
import type { ReviewFacts, ReviewVariant } from "@/lib/email/templates/review";

export type { ReviewFacts, ReviewVariant };

/** The ten headings of EML-012, in order (the renderer prints the same names). */
export const REVIEW_SECTION_NAMES: readonly string[] = [
  "Headline scorecard",
  "Investments made today",
  "Profit / loss",
  "What was learned today",
  "What worked better and why",
  "What needs improving for tomorrow",
  "Overall picture — success %",
  "Sentinel recap",
  "System & quota health",
  "Footer",
];

export type StoredKind = "full" | "partial" | "minimal" | "non_trading";
export type NarrativeKind = "rules" | "llm" | "mock";
export type Missing = { n: number; name: string };

/** Run keys (the same strings as closeBooksKey, signalsKey and reviewKey; a test pins them). */
export const runKeys = {
  close: (market: string, d: string): string => `arena-2a:${market}:${d}`,
  signals: (market: string, d: string): string => `arena-2b:${market}:${d}`,
  review: (market: string, d: string): string => `arena-3:${market}:${d}`,
};

/** replay_stat scope of the R5 narrative row: written by batch 3, read by the review. */
export const narrativeScope = (market: string, d: string): string => `review:${market}:${d}`;
export const NARRATIVE_METRIC = "narrative";

export type Availability = {
  /** Mode `full` (arena jobs expected to run). In data-only mode sections 1-7 are not partial. */
  arenaActive: boolean;
  tradingDay: boolean;
  /** The completion marker (`data` on a trading day, `non-trading` otherwise) for the date. */
  marker: boolean;
  closeOk: boolean;
  signalsOk: boolean;
  reviewOk: boolean;
};

/**
 * The partial map (design 2.6): the sections whose expected input is missing for the date. An
 * input is expected only on a trading day of a market in `full` mode. A missing marker takes
 * sections 1-7 with it (EML-035: never yesterday's numbers). Sections 8-10 need nothing.
 */
export function missingSections(a: Availability): Missing[] {
  if (!a.arenaActive || !a.tradingDay) return [];
  const gone = new Set<number>();
  if (!a.marker) for (let n = 1; n <= 7; n += 1) gone.add(n);
  if (!a.closeOk) for (const n of [1, 2, 3]) gone.add(n);
  if (!a.signalsOk) gone.add(2);
  if (!a.reviewOk) for (const n of [4, 5, 6, 7]) gone.add(n);
  return [...gone].sort((x, y) => x - y).map((n) => ({ n, name: REVIEW_SECTION_NAMES[n - 1]! }));
}

/** The stored kind of a review (evening_review.kind). */
export function storedKind(variant: ReviewVariant): StoredKind {
  return variant === "nonTrading" ? "non_trading" : variant;
}

// ---- canonical JSON and the hash ----------------------------------------------------------------

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, canon(o[k])]),
    );
  }
  return v;
}

/** Canonical JSON: keys sorted, undefined dropped. The same facts always give the same text. */
export const canonicalFacts = (facts: unknown): string => JSON.stringify(canon(facts));

export const factsSha = (facts: unknown): string =>
  createHash("sha256").update(canonicalFacts(facts)).digest("hex");

// ---- number helpers (all money in the facts is whole cents) -------------------------------------

export const big = (v: unknown): bigint => BigInt(v as bigint | number | string);

const MICRO_PER_CENT = 10_000n; // 1 cent = 10,000 micro-units (1 AUD = 1e6 micro = 100 cents)
const HALF = 2n;

/** Micro-units to whole cents, rounded half away from zero. */
export function microToCents(m: bigint): number {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const r = (a + MICRO_PER_CENT / HALF) / MICRO_PER_CENT;
  return Number(neg ? -r : r);
}

/** Whole percent of num/den, clamped to 0..100 (progress bars). */
export function clampPct(num: bigint, den: bigint): number {
  if (den <= 0n) return 0;
  const v = (num * 100n) / den;
  return Number(v < 0n ? 0n : v > 100n ? 100n : v);
}

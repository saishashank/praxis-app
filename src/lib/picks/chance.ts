// UXN-308 confidence display (M17 WP7). A night pick shows "Chance of a net gain" only for an allowed or
// live-tested family whose calibration slope passes the monitor; everything else says "Not enough history yet"
// and no number. `hideBelow` is the existing `cortex_slope_hide_ub` key (1.0, D-257/D-390). p, lo, hi are
// fractions 0..1. Pure: no I/O. The text comes from the Cortex phrase table (similarLine).
import { similarLine, type CardBlock } from "@/lib/cortex/phrases";

export type ChanceStatus = "shadow" | "allowed" | "suspended" | "live-tested";

export type ChanceInput = {
  readonly status: ChanceStatus;
  readonly p: number | null;
  readonly lo: number | null;
  readonly hi: number | null;
  readonly nEff: number | null;
  readonly slopeUb: number | null;
  readonly hideBelow: number;
};

export type ChanceDisplay =
  | {
      readonly kind: "chance";
      readonly pct: number;
      readonly lo: number | null;
      readonly hi: number | null;
      readonly n: number;
    }
  | { readonly kind: "no_history" };

export const NO_HISTORY_TEXT = "Not enough history yet";

const PCT = 100; // threshold-ok: percent scale
const PPM = 1_000_000; // threshold-ok: parts per million
const MIN_SHOWN_N = 1; // threshold-ok: at least one setup behind a shown number

const pctOf = (x: number | null): number | null => (x === null ? null : Math.round(x * PCT));

export function chanceDisplay(x: ChanceInput): ChanceDisplay {
  const allowed = x.status === "allowed" || x.status === "live-tested";
  if (!allowed) return { kind: "no_history" };
  if (x.p === null || x.nEff === null || x.nEff < MIN_SHOWN_N) return { kind: "no_history" };
  // A missing slope bound cannot prove the calibration: hide (fail closed). A bound below the key hides p.
  if (x.slopeUb === null || x.slopeUb < x.hideBelow) return { kind: "no_history" };
  return {
    kind: "chance",
    pct: Math.round(x.p * PCT),
    lo: pctOf(x.lo),
    hi: pctOf(x.hi),
    n: Math.round(x.nEff),
  };
}

/** The plain line from the phrase table ("About N in 10 similar past setups ...") or the no-history text. */
export function chanceLine(d: ChanceDisplay): string {
  if (d.kind === "no_history") return NO_HISTORY_TEXT;
  const block: CardBlock = {
    similar: {
      p_ppm: (d.pct / PCT) * PPM,
      lo_ppm: d.lo === null ? null : (d.lo / PCT) * PPM,
      hi_ppm: d.hi === null ? null : (d.hi / PCT) * PPM,
      n: d.n,
    },
    break_even: [],
    reasons_for: [],
    reasons_against: [],
    would_have_stopped: null,
    independent_sources: [],
    cost_per_order_ppm: 0,
    abstain: null,
  };
  return similarLine(block);
}

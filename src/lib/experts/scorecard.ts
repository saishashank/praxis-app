// Expert scorecard (KB-074, D-532). Pure, deterministic, never an LLM. Below `minScored` tested claims the card
// reads "not enough tested claims". Audience never enters (PRD-034): the directory sorts by evidenceSortKey only.
// The calls summary mirrors src/lib/picks/vsMarket's shape but does not import it: the isolation test allows
// only reviewed importers of src/lib/picks (WP7 owns that line for calls.ts).
import { wilsonInterval, type Interval } from "@/lib/stats/binomial";
import { CI_LEVEL } from "@/lib/stats/stationaryBootstrap";
import {
  CLAIM_STATUSES,
  type CallOutcomeView,
  type ClaimStatus,
  type ClaimView,
  type ScreeningResultView,
} from "./types";

export const NOT_ENOUGH_TESTED = "not enough tested claims";
const SCORED_TYPES = new Set(["method", "risk_rule", "event_link"]);
const PERCENT = 100; // threshold-ok: percent base

export type CallsSummary = {
  readonly n: number;
  readonly medianPpm: number | null;
  readonly beatingPct: number | null;
  readonly insufficient: boolean;
  readonly luckMedianPct: number | null;
};
export type Scorecard = {
  readonly byStatus: Readonly<Record<ClaimStatus, number>>;
  readonly scored: number;
  readonly passShare: {
    readonly k: number;
    readonly n: number;
    readonly interval: Interval;
  } | null;
  readonly calls: CallsSummary;
  readonly state: "scored" | "insufficient";
};

const median = (v: readonly number[]): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

export function scorecard(x: {
  claims: readonly ClaimView[];
  results: readonly ScreeningResultView[];
  calls: readonly CallOutcomeView[];
  minScored: number;
}): Scorecard {
  const byStatus = Object.fromEntries(CLAIM_STATUSES.map((s) => [s, 0])) as Record<
    ClaimStatus,
    number
  >;
  for (const c of x.claims) byStatus[c.status] += 1;

  const survived = new Map(x.results.map((r) => [r.clusterId, r.survived]));
  let n = 0;
  let k = 0;
  for (const c of x.claims) {
    if (!SCORED_TYPES.has(c.type) || c.testability !== "testable_eod" || c.clusterId === null)
      continue;
    const s = survived.get(c.clusterId);
    if (s === undefined) continue;
    n += 1;
    if (s) k += 1;
  }

  const settled = x.calls.filter((c) => c.state !== "no_bars");
  const vs = settled.map((c) => c.vsMarketPpm).filter((v): v is number => v !== null);
  const luck = settled.map((c) => c.luckPct).filter((v): v is number => v !== null);
  const beating = vs.filter((v) => v > 0).length;
  const calls: CallsSummary = {
    n: vs.length,
    medianPpm: median(vs),
    beatingPct:
      vs.length === 0 ? null : Math.floor((2 * PERCENT * beating + vs.length) / (2 * vs.length)),
    insufficient: vs.length < x.minScored,
    luckMedianPct: median(luck),
  };

  const scored = n + settled.length;
  return {
    byStatus,
    scored,
    passShare: n === 0 ? null : { k, n, interval: wilsonInterval(k, n, CI_LEVEL) },
    calls,
    state: scored < x.minScored ? "insufficient" : "scored",
  };
}

const NONE = -Number.MAX_SAFE_INTEGER;

/** Larger is better, compare lexicographically: state, pass-share lower bound, calls vs-market median, n. */
export function evidenceSortKey(card: Scorecard): number[] {
  return [
    card.state === "scored" ? 1 : 0,
    card.passShare === null ? NONE : card.passShare.interval.lower,
    card.calls.medianPpm ?? NONE,
    card.scored,
  ];
}

/** Comparator for the directory: best evidence first. Ties are the caller's (e.g. by name). */
export function compareEvidence(a: Scorecard, b: Scorecard): number {
  const ka = evidenceSortKey(a);
  const kb = evidenceSortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i]! !== kb[i]!) return kb[i]! - ka[i]!;
  }
  return 0;
}

// Ch.16 picks: shared types (M6 T17; AGT-112, AGT-113, ARN-095; D-122 draft).
// Picks are decision support. NOTHING in src/lib/picks is read by ranking, sizing or any other
// trading module (a test pins the imports and the table reads); the arrow only points one way:
// picks read the signals, cards, bars and learning tables, never the other way round.
import type { Family } from "@/lib/agents/schema";

export type { Family };
export type Tier = "U1" | "U2" | "U3";

/** One factor row of a pick (AGT-112): today's bucket, its n and its effect in ppm. */
export type FactorLine = {
  readonly factor: string;
  readonly value: string;
  readonly bucket: number;
  readonly n: number;
  /** median net outcome of the bucket minus the family median, ppm; null when not stored. */
  readonly effectPpm: number | null;
  /** false = "not enough history": no bar is shown (UXN-121, n < factor_min_bucket_n). */
  readonly enough: boolean;
};

/** What one of tonight's signals offers the generator. All figures are stored or exact. */
export type PickInput = {
  readonly signalId: string;
  readonly cardId: string | null;
  readonly family: Family;
  readonly ruleVersion: string;
  readonly variant: string;
  readonly code: string;
  readonly tier: Tier;
  /** Signal rank score as stored (`a/b|c/d|unknown`), higher first. */
  readonly rankScore: string;
  /** Validation label of the family's rule version (ARN-086). */
  readonly label: string;
  readonly referenceMicro: bigint;
  /** The family's own initial stop converted to a price; null = none stated. */
  readonly stopMicro: bigint | null;
  readonly advValueMicro: bigint;
  /** Float volatility of daily log returns (ordering only, never a price). */
  readonly vol: number | null;
  /** Development-split percentiles of past similar trades; null when n < scenario_min_n. */
  readonly scenario: {
    readonly n: number;
    readonly badPpm: number;
    readonly typicalPpm: number;
    readonly goodPpm: number;
  } | null;
  /** Share of past similar trades that reached the good-case return, ppm. */
  readonly aimReachPpm: number | null;
  /** Median holding time of past similar trades in sessions (entry session = 1). */
  readonly holdMedianSessions: number | null;
  /** Median drop-from-peak of past similar trades, ppm (attribution MAE); null = unknown. */
  readonly medianDropPpm: number | null;
  readonly factors: readonly FactorLine[];
  readonly basedOn: readonly string[];
};

/** The universe of the night: used for the volatility third and for the luck-check twin. */
export type UniverseCode = {
  readonly code: string;
  readonly tier: Tier;
  readonly vol: number | null;
};

/** A pick as published (one pick row, ARN-095: never edited afterwards). */
export type Pick = {
  readonly market: string;
  readonly d: string;
  readonly profile: string;
  readonly rank: number;
  readonly code: string;
  readonly family: Family;
  readonly tier: Tier;
  readonly ruleVersion: string;
  readonly signalId: string;
  readonly cardId: string | null;
  readonly label: string;
  readonly referenceMicro: bigint;
  readonly buyMaxMicro: bigint;
  readonly validUntilD: string;
  readonly stopMicro: bigint;
  readonly aimMicro: bigint;
  readonly aimReachPpm: number | null;
  readonly nSimilar: number;
  readonly badPpm: number;
  readonly typicalPpm: number;
  readonly goodPpm: number;
  readonly timeFrameSessions: number;
  readonly sizeMicro: bigint;
  readonly riskMicro: bigint;
  readonly factors: readonly FactorLine[];
  readonly basedOn: readonly string[];
  readonly pickSha: string;
  readonly createdAt: string;
  /** The luck-check twin: a random other company of the profile universe (ARN-095). */
  readonly luckCode: string | null;
};

export class PicksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PicksError";
  }
}

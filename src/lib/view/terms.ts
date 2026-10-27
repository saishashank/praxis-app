// Friendly names with the official term kept in the hover text (UXN-031, UXN-039; docs/M7_design.md
// section 6 decision 4). One table for the whole UI, so a page never invents its own wording. The
// official term stays in exports, logs and the spec; the UI shows `shown` and puts `official` and
// `hover` in the hover / tap / focus text. Pure data and lookups.

export type Term = { official: string; shown: string; hover: string };

export const TERMS: readonly Term[] = [
  {
    official: "Execution / Arena",
    shown: "Strategy / My strategies",
    hover: "One of 6 practice strategies, each starting with A$600 of pretend money.",
  },
  {
    official: "NAV",
    shown: "Value",
    hover: "What the strategy's pretend holdings and cash are worth now.",
  },
  {
    official: "Seed / Target / Bust",
    shown: "Starting money / Goal / Loss limit",
    hover: "Starts at A$600, aims for A$1,200, stops and restarts if it falls to A$300.",
  },
  {
    official: "Cohort",
    shown: "Round",
    hover:
      "One attempt, from the start until it reaches the goal, hits the loss limit or runs out of time.",
  },
  {
    official: "Unlevered / Leverage sleeve",
    shown: "Own money / With borrowed money",
    hover: "Borrowed money (leverage) makes gains and losses bigger. Here it is only simulated.",
  },
  {
    official: "Regime",
    shown: "Market mood",
    hover:
      "How the overall market is behaving, from the index trend and how much prices are jumping around.",
  },
  {
    official: "Validation label",
    shown: "Evidence",
    hover: "How much evidence there is that this strategy does better than luck.",
  },
  {
    official: "Thesis-breaker",
    shown: "Warning signs",
    hover: "Things that would mean the reason for the trade no longer holds.",
  },
  {
    official: "Signal / Decision Card",
    shown: "Trade idea / Why this trade",
    hover: "What the strategy plans to do, and why.",
  },
  {
    official: "Control portfolio",
    shown: "Luck check",
    hover: "A strategy that picks at random, so we can see whether ours beat luck.",
  },
  {
    official: "Drawdown",
    shown: "Drop from peak",
    hover: "How far the value has fallen from its highest point.",
  },
  {
    official: "Slippage / Brokerage",
    shown: "Price slip / Trading fee",
    hover: "Price slip: paying a little more, or getting a little less, than the quoted price.",
  },
  {
    official: "Scenario table (10th / 50th / 90th)",
    shown: "Bad case / Typical / Good case",
    hover: "From this strategy's own past similar trades. Not a forecast.",
  },
  {
    official: "P0 / P1 / P2",
    shown: "Urgent / Important / FYI",
    hover: "How quickly you should look at it.",
  },
  {
    official: "Model success",
    shown: "Model success",
    hover:
      "Share of closed picks that made money after costs; not yet measured until `pick_success_min_n` picks have closed.",
  },
];

const BY_OFFICIAL = new Map(TERMS.map((t) => [t.official.toLowerCase(), t]));

/** The row for an official term (case-insensitive), or null. */
export function termFor(official: string): Term | null {
  return BY_OFFICIAL.get(official.trim().toLowerCase()) ?? null;
}

export type Friendly = { shown: string; official: string; hover: string };

// ---- validation labels (ARN-086; decision 4: both texts are visible in the badge) -------------

const VALIDATION: Readonly<Record<string, string>> = {
  UNVALIDATED: "Not proven yet",
  "PASSED-BACKTEST": "Worked on past data",
  "CONSISTENT-FORWARD": "Working in live practice",
  FAILED: "Didn't work",
  "NOT-DEMONSTRATED": "No real edge found",
  UNVALIDATABLE: "Can't be tested yet",
  "insufficient evidence": "Not enough evidence yet",
  "possible luck": "Possibly luck",
};

/** Friendly text first, the exact ARN-086 label as the visible second line, the hover from the term table. */
export function validationLabel(official: string): Friendly {
  const shown = Object.hasOwn(VALIDATION, official) ? VALIDATION[official]! : "Not proven yet";
  return {
    shown,
    official,
    hover: termFor("Validation label")!.hover,
  };
}

// ---- market mood, warning signs, alert tiers, money type ---------------------------------------

const REGIME: Readonly<Record<string, string>> = {
  "RISK-ON": "Calm and rising",
  NEUTRAL: "Mixed",
  "RISK-OFF": "Nervous",
  SHOCK: "Shock",
  unknown: "Not enough history yet",
};

export function regimeLabel(official: string): Friendly {
  return {
    shown: Object.hasOwn(REGIME, official) ? REGIME[official]! : REGIME.unknown!,
    official,
    hover: termFor("Regime")!.hover,
  };
}

const BREAKER: Readonly<Record<string, string>> = {
  green: "None",
  amber: "Watch",
  red: "Triggered",
};

export function breakerLabel(status: string): Friendly {
  return {
    shown: Object.hasOwn(BREAKER, status) ? BREAKER[status]! : "Not available",
    official: status,
    hover: termFor("Thesis-breaker")!.hover,
  };
}

const TIER: Readonly<Record<string, string>> = { P0: "Urgent", P1: "Important", P2: "FYI" };

export function alertTierLabel(tier: string): Friendly {
  return {
    shown: Object.hasOwn(TIER, tier) ? TIER[tier]! : "FYI",
    official: tier,
    hover: termFor("P0 / P1 / P2")!.hover,
  };
}

export function moneyTypeLabel(leveraged: boolean): string {
  return leveraged ? "With borrowed money" : "Own money";
}

// ---- strategy names (UXN-039) -------------------------------------------------------------------

export type StrategyNameRow = {
  name: string;
  one_liner: string;
  buys: string;
  sells: string;
  works_best: string;
  main_risk: string;
};
export type StrategyNames = Readonly<Record<string, StrategyNameRow>>;

/** "Buy the dip — Own money"; an unknown family falls back to the family code (never a number-only name). */
export function strategyDisplayName(
  names: StrategyNames,
  family: string,
  leveraged: boolean,
): string {
  const row = Object.hasOwn(names, family) ? names[family] : undefined;
  return `${row?.name ?? family} — ${moneyTypeLabel(leveraged)}`;
}

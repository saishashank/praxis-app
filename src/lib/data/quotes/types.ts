// M17 WP1: delayed intraday quote types (design "Quote source", D-381, D-398). Prices are
// micro-AUD bigint like `pick`, never floats. No I/O here.

/** The source-register id of the delayed quote feed; the Owner must accept it first (D-398). */
export const QUOTE_SOURCE_ID = "yahoo_delayed";

export type DelayedQuote = {
  code: string;
  /** Last price, micro-AUD. */
  lastMicro: bigint;
  /** Time of the last trade as the source reports it, ISO UTC. */
  quoteAt: string;
  prevCloseMicro: bigint | null;
  /** Cumulative session volume; null = unknown (fail-closed: volume condition fails, D-382). */
  cumVolume: number | null;
  /** Null = unknown; the chart meta does not carry it [VERIFY at build]. */
  halted: boolean | null;
  fetchedAt: string;
};

export type QuoteReject = { reject: string };

/** Why a fetch run was refused before any request (D-398). */
export type QuoteRefusal = "source_not_accepted" | "source_off" | "dispatch_off" | "gate_error";

/** What the existing source-status API says about `yahoo_delayed` (read by the caller, injected). */
export type QuoteSourceState = {
  /** `source_register.status`; null = no row. */
  register: "pending" | "enabled" | "disabled" | null;
  /** `source_status.mode`; null = no row. */
  mode: string | null;
  /** `dispatch_enabled` switch. */
  dispatchEnabled: boolean;
};

export type QuoteBudget = {
  perRunMax: number;
  dayMax: number;
  usedToday: number;
};

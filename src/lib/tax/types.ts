// Shared shapes of the paper tax report (M21 B3; ARN-122, D-1222). Every amount is a bigint in micro units of the
// market's own currency; nothing here is a float. A "disposal" is one sale matched to one lot.
import type { Rational } from "@/lib/money/rational";

export const PAPER_WORDS = "Paper results, not tax advice";
export const LOG_HEADING = "Your own trade log (typed by you), not the paper books";

/** One execution of a stock: a buy or a sell, with the fee of that leg. `id` sorts as text (the log pads its ids). */
export type TaxFill = {
  readonly id: string;
  readonly d: string;
  readonly code: string;
  readonly side: "buy" | "sell";
  readonly qty: bigint;
  /** Gross value of the fill (quantity x price), before the fee. */
  readonly valueMicro: bigint;
  readonly feeMicro: bigint;
};

/** A quantity re-base on an ex-date (split, bonus issue): new shares per held share, as an exact ratio. */
export type Split = {
  readonly code: string;
  readonly exD: string;
  readonly ratio: Rational;
  /**
   * Set for a cash merger, scrip merger or delisting (ratio zero): the holding closes on the ex-date and the cash the
   * books settled for it (0 when none) is the sale proceeds, spread over the open lots by share count.
   */
  readonly closure?: { readonly actionId: string; readonly proceedsMicro: bigint };
};

export type Disposal = {
  readonly code: string;
  /** The fill id of the sale and of the buy that made the lot. */
  readonly sellId: string;
  readonly lotId: string;
  readonly buyD: string;
  readonly sellD: string;
  /** Shares sold out of this lot (today's share count, after any split). */
  readonly qty: bigint;
  readonly costMicro: bigint;
  readonly proceedsMicro: bigint;
  readonly gainMicro: bigint;
  /** True only when the sale date is after the 12-month anniversary of the buy date. */
  readonly over12Months: boolean;
};

/** A sale with no (or too few) earlier buys to take shares from: no cost is invented, no gain is computed. */
export type Unmatched = {
  readonly code: string;
  readonly sellId: string;
  readonly sellD: string;
  readonly qty: bigint;
};

/** Shares a consolidation removed (a zero result): the cost leaves with them, no sale and no gain. */
export type WrittenOff = {
  readonly code: string;
  readonly lotId: string;
  readonly exD: string;
  readonly costMicro: bigint;
};

export type Totals = {
  readonly costMicro: bigint;
  readonly proceedsMicro: bigint;
  readonly gainMicro: bigint;
  readonly gainsMicro: bigint;
  readonly lossesMicro: bigint;
  readonly gainOver12Micro: bigint;
  readonly gain12OrLessMicro: bigint;
};

/** One paper trade as the books hold it. */
export type BookTrade = {
  readonly tradeId: string;
  readonly cohortId: string;
  readonly executionId: string;
  readonly code: string;
  readonly entry: TaxFill;
  /** null for an open trade and for a `legacy` close (no sale price recorded). */
  readonly exit: TaxFill | null;
  readonly legacy: boolean;
  /** For a legacy close: the date the cohort moved it to the legacy ledger (cohort terminal_d), else null. */
  readonly legacyD?: string | null;
};

export type DividendRow = {
  readonly executionId: string;
  readonly code: string;
  readonly d: string;
  /** Negative for a reversed payment. */
  readonly amountMicro: bigint;
  /** The franking the corporate action recorded, or null for "not recorded". */
  readonly frankingPct: string | null;
  readonly frankingCreditMicro: bigint | null;
};

export type ClosedWithoutPrice = {
  readonly executionId: string;
  readonly code: string;
  readonly buyD: string;
  /** The date it was closed (the cohort's terminal date); the buy date when the books do not say. */
  readonly closedD: string;
  readonly costMicro: bigint;
};

export type Section = { readonly disposals: readonly Disposal[]; readonly totals: Totals };

export type ExecutionReport = {
  readonly id: string;
  readonly specific: Section;
  readonly fifo: Section;
};

export type TaxReport = {
  readonly market: string;
  readonly fy: number;
  readonly fyLabel: string;
  readonly fyStart: string;
  readonly fyEnd: string;
  readonly source: "book" | "log";
  /** The fixed words, always the first thing a reader or an export shows. */
  readonly words: string;
  readonly heading: string;
  /** Plain statements about what the figures do and do not cover. */
  readonly notes: readonly string[];
  readonly executions: readonly ExecutionReport[];
  readonly total: { readonly specific: Totals; readonly fifo: Totals };
  /** With the log: the log records no lot choice, so the specific-lot column is the FIFO one. */
  readonly specificEqualsFifo: boolean;
  readonly closedWithoutPrice: readonly ClosedWithoutPrice[];
  readonly unmatched: readonly (Unmatched & { readonly executionId: string })[];
  readonly writtenOff: readonly (WrittenOff & { readonly executionId: string })[];
  readonly dividends: readonly DividendRow[];
  readonly dividendTotalMicro: bigint;
  /** True when a read stopped at its page cap: the figures are incomplete and the page says so. */
  readonly truncated: boolean;
};

// FAM-007 ex-date stop input (M14, D-219; docs/M14_design.md 2.1). WP0 SIGNATURE STUB: WP2 fills it in.
// Until then no dividend is ever returned, so `fillIntradayStop` behaves as in v1.
//
// WP2 contract: `exDividendOn` sums the CONFIRMED `cash_dividend` / `special_dividend` corporate
// actions of `code` whose ex-date is `d` and whose `known_at` (GL-02) is no later than the cut-off of
// the previous session. It reads the same records that credit the dividend (corpActions.ts); there is
// no `vendor_action` fallback (the replay snapshot has no vendor table, so replay would differ from
// live). The result is per share in micro units, 0n when none. Live and replay call this one function.
import type { Micro } from "@/lib/money/micro";

/** A confirmed corporate action reduced to what the ex-date stop reads. */
export type ExDividendAction = {
  readonly code: string;
  readonly type: string;
  readonly exDate: string;
  /** When the action was first confirmed (GL-02); null = known since before the column existed. */
  readonly knownAt: string | null;
  /** Cash per share, micro units (0n for a non-dividend action). */
  readonly amountMicro: Micro;
};

/**
 * Dividend per share going ex on session `d`, known by `cutoffOfPrevSession` (an ISO instant).
 * STUB: always 0n.
 */
export function exDividendOn(
  actions: readonly ExDividendAction[],
  code: string,
  d: string,
  cutoffOfPrevSession: string,
): Micro {
  void actions;
  void code;
  void d;
  void cutoffOfPrevSession;
  return 0n;
}

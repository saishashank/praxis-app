// FAM-007 ex-date stop input (M14, D-219; docs/M14_design.md 2.1). `exDividendOn` is the one function
// live (closeBooks.ts) and replay (replay/returns.ts, picks/track.ts, cohortReplay.ts) call.
//
// It sums the CONFIRMED `cash_dividend` / `special_dividend` corporate actions of `code` whose ex-date
// is `d` and whose `known_at` (GL-02) is no later than the cut-off of the previous session. It reads the
// same records that credit the dividend (corpActions.ts); there is no `vendor_action` fallback (the
// replay snapshot has no vendor table, so replay would differ from live). The result is per share in
// micro units, 0n when none.
import { parseDividend, type CorpActionRecord } from "./corpActions";
import { roundHalfAwayFromZero } from "@/lib/money/round";
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

const DIVIDEND_TYPES: ReadonlySet<string> = new Set(["cash_dividend", "special_dividend"]);

/**
 * Dividend per share going ex on session `d`, known by `cutoffOfPrevSession` (an ISO instant).
 * An action confirmed after the cut-off (or with an unreadable `known_at`) is not used (GL-02).
 */
export function exDividendOn(
  actions: readonly ExDividendAction[],
  code: string,
  d: string,
  cutoffOfPrevSession: string,
): Micro {
  const cut = Date.parse(cutoffOfPrevSession);
  let sum = 0n;
  for (const a of actions) {
    if (a.code !== code || a.exDate !== d || !DIVIDEND_TYPES.has(a.type)) continue;
    if (a.knownAt !== null) {
      const k = Date.parse(a.knownAt);
      if (!Number.isFinite(k) || !Number.isFinite(cut) || k > cut) continue;
    }
    if (a.amountMicro > 0n) sum += a.amountMicro;
  }
  return sum;
}

/**
 * The confirmed corporate-action records reduced to ex-date dividends (non-dividend types dropped).
 * The amount is the same `dps` the dividend credit uses (`parseDividend`), rounded half away from zero
 * to whole micro once.
 */
export function toExDividendActions(records: readonly CorpActionRecord[]): ExDividendAction[] {
  const out: ExDividendAction[] = [];
  for (const r of records) {
    if (!DIVIDEND_TYPES.has(r.type)) continue;
    out.push({
      code: r.code,
      type: r.type,
      exDate: r.exDate,
      knownAt: r.knownAt ?? null,
      amountMicro: roundHalfAwayFromZero(parseDividend(r).dpsMicro),
    });
  }
  return out;
}

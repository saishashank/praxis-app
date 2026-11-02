// Adjustment view of one code (CTX-050 method; docs/M15_design.md 3c "Adjustment"). One function
// builds the `CodeSeries` every producer serves: prices and volume through the existing `adjustBars`
// (candidates.ts: OHLC / split ratio, volume x ratio, exact money) and a separate cumulative dividend
// factor that is a float statistic, never money. The caller passes the splits and dividends known on
// the basis date (splitsKnownOn / knownBy); nothing here reads a clock or a store.
import { adjustBars, type SplitAction } from "@/lib/agents/candidates";
import type { ViewBar } from "@/lib/agents/decisionView";
import { parseDividend, type CorpActionRecord } from "@/lib/arena/corpActions";
import type { Rational } from "@/lib/money/rational";
import type { CodeSeries } from "./types";

export type DividendTerm = { readonly exDate: string; readonly dpsMicro: Rational };

const DIVIDEND_TYPES: ReadonlySet<string> = new Set(["cash_dividend", "special_dividend"]);

/** The dividend terms among confirmed actions; a record whose payload does not parse is skipped. */
export function dividendTermsOf(actions: readonly CorpActionRecord[]): DividendTerm[] {
  const out: DividendTerm[] = [];
  for (const a of actions) {
    if (!DIVIDEND_TYPES.has(a.type)) continue;
    try {
      out.push({ exDate: a.exDate, dpsMicro: parseDividend(a).dpsMicro });
    } catch {
      // unreadable payload: the dividend factor stays 1 for that action (the price series is untouched)
    }
  }
  return out;
}

function ratToFloat(r: Rational): number {
  return Number(r.num) / Number(r.den);
}

/**
 * Cumulative dividend factor per bar: the product over dividends with ex-date after the bar of
 * (1 - dps / close before the ex-date), the close being the last raw close strictly before the
 * ex-date. A dividend with no earlier close, or one whose term is not in (0, 1), contributes 1.
 */
export function dividendFactors(
  bars: readonly ViewBar[],
  dividends: readonly DividendTerm[],
): number[] {
  const n = bars.length;
  const factors = new Array<number>(n).fill(1);
  if (n === 0 || dividends.length === 0) return factors;
  // Per dividend, the term and the index of the last bar before the ex-date.
  const terms: { idx: number; term: number }[] = [];
  for (const dv of dividends) {
    let idx = -1;
    for (let i = 0; i < n; i += 1) {
      if (bars[i]!.d < dv.exDate) idx = i;
      else break;
    }
    if (idx < 0) continue;
    const close = Number(bars[idx]!.close);
    if (!(close > 0)) continue;
    const term = 1 - ratToFloat(dv.dpsMicro) / close;
    if (!(term > 0 && term < 1)) continue;
    terms.push({ idx, term });
  }
  // Bars at or before `idx` carry the term (their ex-date is after them).
  for (const { idx, term } of terms) {
    for (let i = 0; i <= idx; i += 1) factors[i] = factors[i]! * term;
  }
  return factors;
}

/**
 * The adjusted series of `code` from its raw bars on the basis of the given splits and dividends.
 * Bars must be oldest first; the result has one entry per bar.
 */
export function buildCodeSeries(
  code: string,
  raw: readonly ViewBar[],
  splits: readonly SplitAction[],
  dividends: readonly DividendTerm[],
): CodeSeries {
  for (let i = 1; i < raw.length; i += 1) {
    if (!(raw[i - 1]!.d < raw[i]!.d))
      throw new RangeError(`bars of ${code} not increasing at ${i}`);
  }
  const adj = adjustBars(raw, splits);
  return {
    code,
    d: raw.map((b) => b.d),
    raw,
    adj,
    adjClose: adj.map((b) => b.close),
    adjVolume: adj.map((b) => b.volume),
    divFactor: dividendFactors(raw, dividends),
  };
}

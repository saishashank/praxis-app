// GL-10 (O-51, DAT-235, ARN-095/103): the market benchmark of comparisons is a TOTAL-RETURN series.
// The S&P/ASX 200 price index has no dividends of its own, so the series is built from the index
// closes (`index_bar`, ^AXJO) with the dividends of the C1 broad-index ETF (`c1_etf_code`, the
// closest stored proxy of the index's cash yield) reinvested on each ex-date: on the ex-date the
// level is multiplied by (1 + dividend / the ETF close of the session before). The vendor dividend
// rows are `vendor_action` (DAT-231, Yahoo). Pure maths first; a small database reader after it.
// Coverage rule: until the vendor rows reach back to the start of the comparison window the series
// is "Price only" (no dividends applied); once they do, "Total return".
import type { Client } from "@libsql/client";
import { makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { C1_ETF_PLACEHOLDER } from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { readVendorActions } from "@/lib/data/vendorActions/vendorActions.mjs";
import { priceMicro } from "@/lib/arena/marketData";

export type BenchBasis = "price_only" | "total_return";
export type LevelBar = { readonly d: string; readonly closeMicro: bigint };
export type DividendRow = { readonly exDate: string; readonly amountMicro: bigint };
export type TotalReturnPoint = { readonly d: string; readonly levelMicro: bigint };

export const TOTAL_RETURN_BASIS_LABEL = "Total return — dividends reinvested.";
export const PRICE_ONLY_BASIS_LABEL = "Price only — dividends not included.";
export const benchmarkLabel = (basis: BenchBasis): string =>
  basis === "total_return" ? TOTAL_RETURN_BASIS_LABEL : PRICE_ONLY_BASIS_LABEL;

const ratio = (num: bigint, den: bigint): bigint => roundHalfAwayFromZero(makeRational(num, den));

/**
 * The total-return level series: the first index close is the start level; each later session
 * multiplies by index close / previous index close and, on the session of an ex-date (the first
 * session on or after it), by (1 + dividend / the ETF close of the session before). Dividends dated
 * on or before the first session are ignored (already inside the start level). A dividend without a
 * prior ETF close is skipped. With no dividends the series equals the index closes.
 * `etfBars` and `indexBars` are oldest first.
 */
export function totalReturnSeries(
  indexBars: readonly LevelBar[],
  dividends: readonly DividendRow[],
  etfBars: readonly LevelBar[],
): TotalReturnPoint[] {
  const out: TotalReturnPoint[] = [];
  if (indexBars.length === 0) return out;
  const divs = [...dividends].sort((a, b) =>
    a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0,
  );
  let next = 0;
  let level = indexBars[0]!.closeMicro;
  out.push({ d: indexBars[0]!.d, levelMicro: level });
  const firstD = indexBars[0]!.d;
  while (next < divs.length && divs[next]!.exDate <= firstD) next += 1;
  for (let i = 1; i < indexBars.length; i += 1) {
    const prev = indexBars[i - 1]!;
    const cur = indexBars[i]!;
    level = ratio(level * cur.closeMicro, prev.closeMicro);
    while (next < divs.length && divs[next]!.exDate <= cur.d) {
      const div = divs[next]!;
      next += 1;
      let etfPrior: bigint | null = null;
      for (const b of etfBars) {
        if (b.d < div.exDate) etfPrior = b.closeMicro;
        else break;
      }
      if (etfPrior === null || etfPrior <= 0n || div.amountMicro <= 0n) continue;
      level = ratio(level * (etfPrior + div.amountMicro), etfPrior);
    }
    out.push({ d: cur.d, levelMicro: level });
  }
  return out;
}

/**
 * The basis of a comparison over [fromD, toD]: "total_return" only when vendor dividend data
 * demonstrably reaches back to the window start (the earliest stored vendor row is on or before
 * `fromD`) and at least one dividend is stored; otherwise "price_only".
 */
export function benchmarkBasis(
  windowFromD: string,
  earliestVendorExDate: string | null,
  dividendCount: number,
): BenchBasis {
  return earliestVendorExDate !== null && earliestVendorExDate <= windowFromD && dividendCount > 0
    ? "total_return"
    : "price_only";
}

/** The basis for [fromD, toD] from the database; any missing piece gives "price_only". */
export async function loadBenchmarkBasis(
  db: Client,
  market: string,
  fromD: string,
  toD: string,
): Promise<BenchBasis> {
  try {
    const code = String(await getConfig(db, "c1_etf_code"));
    if (code === "" || code === C1_ETF_PLACEHOLDER) return "price_only";
    const rows = await readVendorActions(db, code, "0000-01-01", toD, market);
    const divs = rows.filter((r) => r.kind === "dividend");
    const earliest = rows.length > 0 ? rows[0]!.exDate : null;
    return benchmarkBasis(fromD, earliest, divs.length);
  } catch {
    return "price_only";
  }
}

/** The series for [fromD, toD] from the database, with the basis it was built on. */
export async function loadTotalReturnSeries(
  db: Client,
  market: string,
  indexCode: string,
  fromD: string,
  toD: string,
): Promise<{ basis: BenchBasis; series: TotalReturnPoint[] }> {
  const idx = await db.execute({
    sql: `SELECT d, c_micro FROM index_bar WHERE market = ? AND index_code = ? AND d >= ? AND d <= ? ORDER BY d`,
    args: [market, indexCode, fromD, toD],
  });
  const indexBars = idx.rows.map((r) => ({
    d: String(r.d),
    closeMicro: BigInt(String(r.c_micro)),
  }));
  const basis = await loadBenchmarkBasis(db, market, fromD, toD);
  if (basis === "price_only") return { basis, series: totalReturnSeries(indexBars, [], []) };
  const code = String(await getConfig(db, "c1_etf_code"));
  const acts = await readVendorActions(db, code, fromD, toD, market);
  const dividends = acts
    .filter((a) => a.kind === "dividend" && a.amountMicro !== null)
    .map((a) => ({ exDate: a.exDate, amountMicro: a.amountMicro! }));
  const bars = await db.execute({
    sql: `SELECT d, c FROM price_bar WHERE market = ? AND code = ? AND d <= ? ORDER BY d`,
    args: [market, code, toD],
  });
  const etfBars = bars.rows.map((r) => ({ d: String(r.d), closeMicro: priceMicro(r.c) }));
  return { basis, series: totalReturnSeries(indexBars, dividends, etfBars) };
}

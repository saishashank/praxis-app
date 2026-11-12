// The starting capital of a market's book (ARN-001 per market; M20 A4, D-1107). AU is fixed (A$600). IN and US are
// the AU amount times the RBA daily AUD/INR or AUD/USD close of the activation day (the day `full` is set,
// D-1100), rounded half-up to Rs 1,000 / US$10. Exact rationals and bigint micro; no float anywhere.
import type { MarketProfile } from "@/lib/market/profileCore.mjs";
import type { Micro } from "@/lib/money/micro";
import { makeRational, mulRat, parseRational, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";

const MICRO = 1_000_000n;

/** The RBA daily row the seed converts with: the `macro_series` close of the activation day. */
export type FxRow = {
  /** Foreign currency per one unit of the `from_currency` (AUD), decimal text, e.g. "55.123". */
  readonly rate: string;
  /** The date of the close (YYYY-MM-DD). */
  readonly date: string;
  /** The series, e.g. the `FXRINR` / `FXRUSD` row of the RBA source. */
  readonly source: string;
};

/** What the ledger's first posting records (snake case, as stored). */
export type SeedRecord = {
  readonly seed_micro: string;
  readonly fx_rate: string;
  readonly fx_date: string | null;
  readonly fx_source: string | null;
};

export type SeedResult = {
  readonly seedMicro: Micro;
  readonly fxRate: Rational;
  readonly fx: FxRow | null;
  readonly record: SeedRecord;
};

type SeedAmount =
  | { readonly kind: "fixed"; readonly amount: number }
  | {
      readonly kind: "fx_rounded";
      readonly from_amount: number;
      readonly from_currency: string;
      readonly fx_source: string;
      readonly round_to: number;
    };

/**
 * seed = round(from_amount x rate, round_to), half-up (half away from zero), in whole currency units; `fixed`
 * (AU) returns the amount with rate 1 and no FX row. A market that converts needs `fxRow`; without it this throws
 * (never a guess). The rate must be positive.
 */
export function seedForMarket(
  profile: Pick<MarketProfile, "fields" | "code">,
  fxRow: FxRow | null = null,
): SeedResult {
  const amount = profile.fields.seed_amount?.value as SeedAmount | undefined;
  if (amount === undefined) throw new Error(`market ${profile.code} has no seed_amount`);
  if (amount.kind === "fixed") {
    const seedMicro = BigInt(amount.amount) * MICRO;
    return {
      seedMicro,
      fxRate: makeRational(1n),
      fx: null,
      record: { seed_micro: seedMicro.toString(), fx_rate: "1", fx_date: null, fx_source: null },
    };
  }
  if (fxRow === null) {
    throw new RangeError(
      `market ${profile.code} seeds from an FX close: the ${amount.fx_source} row is required`,
    );
  }
  const rate = parseRational(fxRow.rate);
  if (rate.num <= 0n) throw new RangeError("the FX rate must be positive");
  const converted = mulRat(makeRational(BigInt(amount.from_amount)), rate);
  const unit = BigInt(amount.round_to);
  const units = roundHalfAwayFromZero(mulRat(converted, makeRational(1n, unit))) * unit;
  const seedMicro = units * MICRO;
  return {
    seedMicro,
    fxRate: rate,
    fx: fxRow,
    record: {
      seed_micro: seedMicro.toString(),
      fx_rate: fxRow.rate,
      fx_date: fxRow.date,
      fx_source: fxRow.source,
    },
  };
}

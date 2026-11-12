// Survivorship and the data limits of a market's reports (M20 A5; CXA-012, CXA-013, D-1115, D-1132). A history that
// only holds the codes listed today overstates what an investor earned: the codes that fell and were delisted are
// missing. `haircut` states that bias in percentage points per year (the share of codes delisted each year times the
// assumed loss on a delisting, 50 % by default), shown beside the unadjusted figure; `reportCaveats` returns the
// caveats a report of a market must carry (the US survivorship caveat on every US report until its own snapshots
// satisfy ARN-082; India's "measured on the bhavcopy archive"; the home market: none, its reports are unchanged).
// Pure: a profile and the coverage facts in, plain values out.
import type { MarketProfile } from "@/lib/market/profileCore.mjs";
import { dataLimitsOf } from "@/lib/market/seed/dataLimits.mjs";
import { parseRational, subRat, mulRat, makeRational, type Rational } from "@/lib/money/rational";

/** The assumed mean loss on a delisting, in percent (D-1115: assumed, not measured, and labelled so). */
export const ASSUMED_DELISTING_LOSS_PCT = 50;

export type Haircut = {
  readonly delistedSharePerYearPct: string;
  readonly meanLossPct: string;
  /** Percentage points per year taken off a survivorship-biased figure (exact). */
  readonly ppPerYear: Rational;
  /** The same as decimal text, e.g. `1.5`. */
  readonly ppPerYearText: string;
};

function exactText(r: Rational): string {
  // the exact decimal text of a Rational with a terminating expansion (denominators of 2 and 5 only), else 6 places
  const neg = r.num < 0n;
  let num = neg ? -r.num : r.num;
  const den = r.den;
  const whole = num / den;
  num = num % den;
  if (num === 0n) return `${neg ? "-" : ""}${whole}`;
  let frac = "";
  for (let i = 0; i < 6 && num !== 0n; i += 1) {
    num *= 10n;
    frac += (num / den).toString();
    num = num % den;
  }
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

const asText = (v: number | string, name: string): string => {
  const t = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new RangeError(`${name} must be a plain non-negative number`);
  return t;
};

/**
 * CXA-012: the survivorship haircut in percentage points per year = delisted share per year (percent) x mean loss on
 * a delisting (percent) / 100. Known answer: 3 % delisted per year x 50 % loss = 1.5 points per year.
 */
export function haircut(input: {
  readonly delistedSharePerYear: number | string;
  readonly meanLossPct?: number | string;
}): Haircut {
  const share = asText(input.delistedSharePerYear, "delistedSharePerYear");
  const loss = asText(input.meanLossPct ?? ASSUMED_DELISTING_LOSS_PCT, "meanLossPct");
  if (parseRational(share).num > 100n * parseRational(share).den) {
    throw new RangeError("delistedSharePerYear is a percent, at most 100");
  }
  const pp = mulRat(mulRat(parseRational(share), parseRational(loss)), makeRational(1n, 100n));
  return {
    delistedSharePerYearPct: share,
    meanLossPct: loss,
    ppPerYear: pp,
    ppPerYearText: exactText(pp),
  };
}

/** A yearly return with and without the haircut (CXA-012 reports both, side by side). */
export function withAndWithout(
  annualReturnPp: string,
  h: Haircut,
): { readonly without: string; readonly with: string } {
  const r = parseRational(annualReturnPp);
  return { without: exactText(r), with: exactText(subRat(r, h.ppPerYear)) };
}

/** What a report knows about its own data (the caller reads it from the snapshot and coverage tables). */
export type SurvivorshipCoverage = {
  /** ARN-082: the market's own daily snapshots now cover the lookback the report needs. */
  readonly ownSnapshotsSatisfyArn082?: boolean;
  /** Delisted codes per year as a percent of the universe, when measured; null/absent = not measured. */
  readonly delistedSharePerYear?: number | string | null;
};

export type ReportCaveat = {
  readonly id: string;
  /** The spec lines the caveat comes from. */
  readonly ref: string;
  readonly text: string;
  /** The haircut shown with it, when the delisted share is known. */
  readonly haircut: Haircut | null;
  /** How the matched controls read: `matched`, or `unmatched` (no delisted codes to match against). */
  readonly matchedControls: "matched" | "unmatched";
};

/**
 * The caveats a market's report must carry (D-1115). The home market has none. A market whose limit lapses with
 * its own snapshots (US, `until_own_snapshots`) drops it once `coverage.ownSnapshotsSatisfyArn082` is true.
 */
export function reportCaveats(
  profile: Pick<MarketProfile, "code">,
  coverage: SurvivorshipCoverage = {},
): readonly ReportCaveat[] {
  const limits = dataLimitsOf(profile.code);
  if (limits === undefined) return [];
  const s = limits.survivorship;
  if (s.until_own_snapshots && coverage.ownSnapshotsSatisfyArn082 === true) return [];
  const share = coverage.delistedSharePerYear;
  return [
    {
      id: s.id,
      ref: s.ref,
      text: s.text,
      haircut:
        share === undefined || share === null ? null : haircut({ delistedSharePerYear: share }),
      matchedControls: s.matched_controls,
    },
  ];
}

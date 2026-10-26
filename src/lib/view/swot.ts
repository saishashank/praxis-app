// A SWOT from our own stored data (D-196, Owner 2026-10-26: "When I click on a company no SWOT. Why?").
// Pure and rules-based, not an AI text: each line is one fact from the end-of-day bars, the ASIC
// short positions and the stored announcements, with its number, so it can be checked. A company
// description needs a profile source the app does not have yet; it is not invented. Display only:
// nothing here feeds a decision (the families read their own facts).

export type SwotInput = {
  /** Closes, oldest first (up to about a year of sessions). */
  readonly closes: readonly number[];
  /** Volumes on the same sessions. */
  readonly volumes: readonly number[];
  /** Latest and previous ASIC short positions, parts per million of the shares; null = none. */
  readonly shortPpm: number | null;
  readonly shortPrevPpm: number | null;
  /** Price-sensitive announcements of the last 30 days. */
  readonly priceSensitive30d: number;
  /** Large / Mid / Small, or null when unknown or below the floor. */
  readonly sizeGroup: string | null;
};

export type Swot = {
  readonly strengths: string[];
  readonly weaknesses: string[];
  readonly opportunities: string[];
  readonly threats: string[];
};

/** Sessions needed for a SWOT (the 200-session trend line and a year of range). */
export const SWOT_MIN_SESSIONS = 200; // threshold-ok: the 200-session average below needs them
const TREND = 200; // threshold-ok: the common 200-day trend line
const VOL_WINDOW = 20; // threshold-ok: one month of daily moves
const QUARTER = 63; // threshold-ok: about three months of sessions
const YEAR = 252; // threshold-ok: about a year of sessions
const SESSIONS_PER_YEAR = 252; // threshold-ok: annualising daily volatility
const NEAR_HIGH = 0.05; // threshold-ok: within 5 % of the 52-week high
const NEAR_LOW = 0.1; // threshold-ok: within 10 % of the 52-week low
const BIG_MOVE = 0.2; // threshold-ok: a 20 % three-month move
const CALM_VOL = 0.25; // threshold-ok: below 25 % a year is a steady price
const WILD_VOL = 0.6; // threshold-ok: above 60 % a year is very volatile
const HIGH_SHORT_PPM = 50_000; // threshold-ok: more than 5 % of the shares sold short
const VOLUME_SPIKE = 2; // threshold-ok: twice the usual daily volume

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function buildSwot(i: SwotInput): Swot | null {
  const c = i.closes;
  if (c.length < SWOT_MIN_SESSIONS) return null;
  const s: Swot = { strengths: [], weaknesses: [], opportunities: [], threats: [] };
  const last = c[c.length - 1]!;

  const avg = mean(c.slice(-TREND));
  if (last >= avg)
    s.strengths.push(`In an uptrend: ${pct(last / avg - 1)} above its 200-day average.`);
  else s.weaknesses.push(`In a downtrend: ${pct(1 - last / avg)} below its 200-day average.`);

  const year = c.slice(-YEAR);
  const hi = Math.max(...year);
  const lo = Math.min(...year);
  if (last >= hi * (1 - NEAR_HIGH)) s.strengths.push("Trading near its 52-week high.");
  if (last <= lo * (1 + NEAR_LOW)) s.threats.push("Trading near its 52-week low.");

  const q = c[c.length - 1 - QUARTER];
  if (q !== undefined && q > 0) {
    const move = last / q - 1;
    if (move >= BIG_MOVE) s.opportunities.push(`Strong momentum: up ${pct(move)} in three months.`);
    if (move <= -BIG_MOVE) s.threats.push(`Falling hard: down ${pct(-move)} in three months.`);
  }

  const rets: number[] = [];
  for (let k = c.length - VOL_WINDOW; k < c.length; k += 1) {
    const a = c[k - 1]!;
    if (a > 0) rets.push(Math.log(c[k]! / a));
  }
  if (rets.length > 1) {
    const m = mean(rets);
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
    const annual = sd * Math.sqrt(SESSIONS_PER_YEAR);
    if (annual <= CALM_VOL)
      s.strengths.push(`Steady price: about ${pct(annual)} a year of swings.`);
    if (annual >= WILD_VOL) s.threats.push(`Very volatile: about ${pct(annual)} a year of swings.`);
  }

  if (i.sizeGroup === "Large") s.strengths.push("Heavily traded: easy to buy and sell (Large).");
  if (i.sizeGroup === "Small") s.weaknesses.push("Thinly traded: harder to buy and sell (Small).");

  const v = i.volumes;
  if (v.length > VOL_WINDOW) {
    const usual = mean(v.slice(-VOL_WINDOW - 1, -1));
    const today = v[v.length - 1]!;
    if (usual > 0 && today >= usual * VOLUME_SPIKE) {
      s.opportunities.push(
        `Unusual interest: ${(today / usual).toFixed(1)} times the usual volume today.`,
      );
    }
  }

  if (i.shortPpm !== null) {
    if (i.shortPpm >= HIGH_SHORT_PPM) {
      s.threats.push(
        `Many investors bet against it: ${pct(i.shortPpm / 1e6)} of the shares sold short.`,
      );
    }
    if (
      i.shortPrevPpm !== null &&
      i.shortPpm < i.shortPrevPpm &&
      i.shortPrevPpm >= HIGH_SHORT_PPM
    ) {
      s.opportunities.push("Short selling is falling from a high level.");
    }
  }

  if (i.priceSensitive30d > 0) {
    s.opportunities.push(
      `${i.priceSensitive30d} price-sensitive announcement${i.priceSensitive30d === 1 ? "" : "s"} in the last 30 days: worth reading.`,
    );
  }
  return s;
}

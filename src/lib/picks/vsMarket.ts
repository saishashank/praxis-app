// ARN-103/104 (M11-lite WP5, D-490, D-491): a settled pick against the market. The market side is the
// TOTAL-RETURN series of ./benchmark.ts (never the raw index table; O-51/GL-10 beat the older price-return
// wording) with its basis label. The index has closes only, so a window runs from the level at the last
// session BEFORE the fill session to the level at the exit session (the same approximation as D-463).
// A missed pick stores the would-be window (first session after publication to the earlier of its
// `valid_until_d` and the night it was withdrawn), with the pick side and the difference NULL.
// Pure maths first; the one INSERT statement joins the settlement batch of ./track.ts. Rows are fixed.
import { makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import type { BenchBasis, TotalReturnPoint } from "./benchmark";
import type { Outcome } from "./track";

export const BENCH_INDEX = "AXJO";
/** ARN-104 / D-491: fewer settled, filled picks than this shows "insufficient history". */
export const VS_MARKET_MIN_N = 30; // threshold-ok: ARN-104 fixes n < 30 as insufficient history
const PPM = 1_000_000n; // threshold-ok: parts per million
const HUNDRED = 100; // threshold-ok: percent base

export type MarketWindow = {
  readonly fromMicro: bigint;
  readonly toMicro: bigint;
  readonly retPpm: number;
};

/** Level at the last session before `fromD` to the level at the last session on or before `toD`. */
export function windowReturnPpm(
  series: readonly TotalReturnPoint[],
  fromD: string,
  toD: string,
): MarketWindow | null {
  if (toD < fromD) return null;
  let from: TotalReturnPoint | null = null;
  let to: TotalReturnPoint | null = null;
  for (const p of series) {
    if (p.d < fromD) from = p;
    if (p.d <= toD) to = p;
  }
  if (from === null || to === null || from.levelMicro <= 0n || to.d < fromD) return null;
  const ret = roundHalfAwayFromZero(
    makeRational((to.levelMicro - from.levelMicro) * PPM, from.levelMicro),
  );
  return { fromMicro: from.levelMicro, toMicro: to.levelMicro, retPpm: Number(ret) }; // money-float-ok: ppm fits a safe integer
}

export const vsMarketPpm = (pickNetPpm: number, marketRetPpm: number): number =>
  pickNetPpm - marketRetPpm;

/** The window of a settled outcome: filled picks entry..exit; missed picks the would-be window. */
export function pickMarketWindow(
  sim: Outcome,
  series: readonly TotalReturnPoint[],
  x: { pubD: string; validUntilD: string; withdrawnNight: string | null },
): { fromD: string; toD: string } | null {
  if (sim.state === "closed" && sim.entryD !== null && sim.exitD !== null) {
    return { fromD: sim.entryD, toD: sim.exitD };
  }
  if (sim.state !== "missed") return null;
  const first = series.find((p) => p.d > x.pubD);
  if (first === undefined) return null;
  const end =
    x.withdrawnNight !== null && x.withdrawnNight < x.validUntilD
      ? x.withdrawnNight
      : x.validUntilD;
  return { fromD: first.d, toD: end };
}

/** The `pick_market` INSERT for a closed or missed outcome; null when the index has no data for the window. */
export function pickMarketStatement(x: {
  key: readonly (string | number)[]; // market, d, profile, rank, kind
  sim: Outcome;
  basis: BenchBasis;
  series: readonly TotalReturnPoint[];
  validUntilD: string;
  withdrawnNight: string | null;
  settledD: string;
}): { sql: string; args: (string | number | bigint | null)[] } | null {
  const [market, pubD, profile, rank, kind] = x.key;
  const w = pickMarketWindow(x.sim, x.series, {
    pubD: String(pubD),
    validUntilD: x.validUntilD,
    withdrawnNight: x.withdrawnNight,
  });
  if (w === null) return null;
  const m = windowReturnPpm(x.series, w.fromD, w.toD);
  if (m === null) return null;
  const missed = x.sim.state === "missed";
  const net = missed ? null : x.sim.netPpm;
  return {
    sql: `INSERT INTO pick_market (market, d, profile, rank, kind, window_from_d, window_to_d, index_code,
            basis, index_from_micro, index_to_micro, market_ret_ppm, pick_net_ppm, vs_market_ppm, missed, settled_d)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      market!,
      pubD!,
      profile!,
      rank!,
      kind!,
      w.fromD,
      w.toD,
      BENCH_INDEX,
      x.basis,
      m.fromMicro,
      m.toMicro,
      m.retPpm,
      net,
      net === null ? null : vsMarketPpm(net, m.retPpm),
      missed ? 1 : 0,
      x.settledD,
    ],
  };
}

export type VsMarketSummary = {
  readonly n: number;
  readonly medianPpm: number | null;
  readonly beatingPct: number | null;
  readonly insufficient: boolean;
};

/** ARN-104: median vs market and share beating it over filled, settled picks (missed excluded). */
export function vsMarketSummary(rows: readonly { vsMarketPpm: number | null }[]): VsMarketSummary {
  const v = rows
    .map((r) => r.vsMarketPpm)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { n, medianPpm: null, beatingPct: null, insufficient: true };
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
  const beating = v.filter((p) => p > 0).length;
  return {
    n,
    medianPpm: median,
    beatingPct: Math.floor((2 * HUNDRED * beating + n) / (2 * n)),
    insufficient: n < VS_MARKET_MIN_N,
  };
}

// Screening statistics (D-518). Pure and deterministic: a stationary block bootstrap of the mean excess over
// matched controls (mean net when too few rows have a control), a one-sided p, split-half means, and one
// Benjamini-Hochberg pass over all clusters of the run through measuredCells. Grade is at most L1 (KB-076).
import { percentile } from "@/lib/stats/bootstrap";
import { measuredCells } from "@/lib/stats/multiplicity";
import { scopedPrng } from "@/lib/stats/rng";
import { meanStatistic, stationaryBlockBootstrap } from "@/lib/stats/stationaryBootstrap";
import type { DevelopmentSample } from "./devView";

export type StatOptions = {
  readonly replicates: number;
  /** Fewest development rows a cluster needs (min_trades). */
  readonly minRows: number;
  /** Fewest populated blocks a cluster needs (min_blocks). */
  readonly minBlocks: number;
};

export type ClusterStat = {
  readonly rows: number;
  readonly blocks: number;
  /** True when the tested series is the excess over matched controls; false = mean net fallback. */
  readonly controls: boolean;
  readonly meanNet: number;
  readonly meanExcess: number | null;
  /** The tested series' mean, its one-sided 90 % lower bound and one-sided p (share of centred replicates at or above it). */
  readonly mean: number;
  readonly lower90: number;
  readonly p: number;
  readonly firstHalf: number;
  readonly secondHalf: number;
};

export type Insufficient = { readonly insufficient: "rows" | "blocks" };
export const isInsufficient = (x: ClusterStat | Insufficient): x is Insufficient =>
  "insufficient" in x;

const avg = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * `seed` scopes the PRNG (same sample + seed + options = identical output, so a rerun is idempotent).
 * p = (1 + #{centred replicates >= observed}) / (R + 1): never exactly 0, one-sided toward a positive mean.
 */
export function clusterStatistic(
  sample: DevelopmentSample,
  seed: string,
  opts: StatOptions,
): ClusterStat | Insufficient {
  const all = sample.rows;
  if (all.length < opts.minRows) return { insufficient: "rows" };
  const withControl = all.filter((r) => r.excess !== null);
  const controls = withControl.length >= opts.minRows;
  const used = controls ? withControl : all;
  if (sample.blocks < opts.minBlocks) return { insufficient: "blocks" };
  const valueOf = (r: (typeof all)[number]): number => (controls ? r.excess! : r.net);
  const values = used.map(valueOf);
  const mean = avg(values);
  const boot = stationaryBlockBootstrap(
    { sessions: used.map((r) => r.session), sessionCount: sample.sessionCount },
    meanStatistic(values),
    scopedPrng(`expscreen:${seed}`),
    { expectedBlock: sample.blockSessions, replicates: opts.replicates },
  ).values;
  const reps = Array.from(boot);
  let atOrAbove = 0;
  for (const v of reps) if (v - mean >= mean) atOrAbove += 1;
  const half = sample.sessionCount / 2;
  return {
    rows: all.length,
    blocks: sample.blocks,
    controls,
    meanNet: avg(all.map((r) => r.net)),
    meanExcess: controls ? mean : null,
    mean,
    lower90: percentile(reps, 0.1),
    p: (1 + atOrAbove) / (reps.length + 1),
    firstHalf: avg(used.filter((r) => r.session < half).map(valueOf)),
    secondHalf: avg(used.filter((r) => r.session >= half).map(valueOf)),
  };
}

export type ScreeningRow = {
  readonly id: string;
  readonly p: number;
  readonly adjustedP: number;
  readonly bhRejected: boolean;
  readonly signAgrees: boolean;
  readonly survived: boolean;
  /** 1-based among survivors by lower 90 % bound, ties by p then id; null for non-survivors. */
  readonly rank: number | null;
  readonly grade: "L0" | "L1";
};

/** BH once over every tested cluster of the run (PRDS), survived = BH-rejected and split-half sign agreement. */
export function screenRun(
  stats: readonly { readonly id: string; readonly stat: ClusterStat }[],
  q: number,
): ScreeningRow[] {
  if (stats.length === 0) return [];
  const { cells } = measuredCells(
    stats.map((s) => ({
      id: s.id,
      p: s.stat.p,
      firstHalf: s.stat.firstHalf,
      secondHalf: s.stat.secondHalf,
    })),
    q,
    "prds",
  );
  const by = new Map(stats.map((s) => [s.id, s.stat]));
  const ranked = cells
    .filter((x) => x.measured)
    .sort(
      (a, b) =>
        by.get(b.id)!.lower90 - by.get(a.id)!.lower90 ||
        a.p - b.p ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const rank = new Map(ranked.map((x, i) => [x.id, i + 1]));
  return cells.map((x) => ({
    id: x.id,
    p: x.p,
    adjustedP: x.adjustedP,
    bhRejected: x.bhRejected,
    signAgrees: x.signAgrees,
    survived: x.measured,
    rank: rank.get(x.id) ?? null,
    grade: x.measured ? "L1" : "L0",
  }));
}

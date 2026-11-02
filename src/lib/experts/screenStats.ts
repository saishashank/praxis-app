// Screening statistics (D-518, D-595). Pure and deterministic: a stationary block bootstrap of the mean
// excess over matched C2 controls (never mean net: a cluster with too few controlled rows is insufficient),
// a one-sided p, split-half means, and one Benjamini-Hochberg pass over all clusters of the run through
// measuredCells. Grade is at most L1 (KB-076).
import { percentile, studentisedTest } from "@/lib/stats/bootstrap";
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
  /** Tested rows: development rows that carry a matched C2 control (D-595). */
  readonly rows: number;
  /** Populated blocks of `blockSessions` sessions among the tested rows. */
  readonly blocks: number;
  /** Mean net of every closed development row (descriptive only; not tested). */
  readonly meanNet: number;
  /** The tested series: mean excess over matched controls, its 10th-percentile bootstrap bound and one-sided p. */
  readonly meanExcess: number;
  readonly lower90: number;
  readonly p: number;
  readonly firstHalf: number;
  readonly secondHalf: number;
};

/**
 * `rows`: fewer than `minRows` closed development rows; `controls`: fewer than `minRows` of them carry a
 * matched control (the excess series is the only one tested, D-595); `blocks`: too few populated blocks.
 */
export type Insufficient = { readonly insufficient: "rows" | "controls" | "blocks" };
export const isInsufficient = (x: ClusterStat | Insufficient): x is Insufficient =>
  "insufficient" in x;

const avg = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * `seed` scopes the PRNG (same sample + seed + options = identical output, so a rerun is idempotent).
 * p = (1 + #{centred replicates >= observed}) / (R + 1): never exactly 0, one-sided toward a positive mean.
 * Every insufficiency is a matter of data volume (row, control and block counts), never of the outcome, so
 * leaving an insufficient cluster out of the run's BH family does not bias the correction (D-596).
 */
export function clusterStatistic(
  sample: DevelopmentSample,
  seed: string,
  opts: StatOptions,
): ClusterStat | Insufficient {
  const all = sample.rows;
  if (all.length < opts.minRows) return { insufficient: "rows" };
  const used = all.filter((r) => r.excess !== null);
  if (used.length < opts.minRows) return { insufficient: "controls" };
  const blocks = new Set(used.map((r) => Math.floor(r.session / sample.blockSessions))).size;
  if (blocks < opts.minBlocks) return { insufficient: "blocks" };
  const values = used.map((r) => r.excess!);
  const mean = avg(values);
  const boot = stationaryBlockBootstrap(
    { sessions: used.map((r) => r.session), sessionCount: sample.sessionCount },
    meanStatistic(values),
    scopedPrng(`expscreen:${seed}`),
    { expectedBlock: sample.blockSessions, replicates: opts.replicates },
  ).values;
  // ARN-081's test (as VAL-110 and the lessons use it): t* = centred replicate / se against t = mean / se,
  // which is #{replicate - mean >= mean}; the se cancels, so this is the centred percentile p of D-593.
  const half = sample.sessionCount / 2;
  return {
    rows: used.length,
    blocks,
    meanNet: avg(all.map((r) => r.net)),
    meanExcess: mean,
    lower90: percentile(boot, 0.1),
    p: studentisedTest(mean, boot).p,
    firstHalf: avg(used.filter((r) => r.session < half).map((r) => r.excess!)),
    secondHalf: avg(used.filter((r) => r.session >= half).map((r) => r.excess!)),
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

// Weekly re-weighting of the learning Cortex (cortex_learning_architecture B.2 "Finding", C.7; D-928).
// The only place a learner weight goes UP. Per scored angle, over the 20-session rows of the window:
//
//   1. shrunk IC = (n·mean + n0·prior) / (n + n0), prior = development IC × haircut (James–Stein /
//      empirical Bayes toward what was already known; McLean–Pontiff decay haircut);
//   2. a two-sided p that honours the overlap (n_eff = n / 20 non-overlapping observations, Student's
//      t with n_eff − 1 df), Benjamini–Hochberg at q across the angles, and one-sided 90 % bounds of
//      the mean from a stationary block bootstrap (block = the 20-session overlap); a FINDING is a BH
//      rejection whose bootstrap bound agrees in sign (lo90 > 0 up, hi90 < 0 down);
//   3. target ∝ max(0, shrunk) (IC weighting, rescaled to the current mean); only findings move — plus
//      angles with a checkpoint fall alarm since the last run, DOWN only — and only `maxStep` of the
//      way (trust region); thin angles (SPIBB: fewer than `minNights` defined out-of-results-season
//      nights) keep their weight;
//   4. mean angle weight 1, floor `weightFloor` (× equal weight), cluster weight = the mean of its
//      angles' weights with the cluster share capped at `clusterWeightMax` (water-filling);
//   5. rebalancing band: written only when some weight moves more than `bandPp` points.
//
// `placebo` is the coin-flip twin (B.3 check 5): the same learner on the same rows with each block of
// nights' IC sign-flipped by a seeded PRNG. A session-order permutation alone would leave every window
// mean unchanged (and so every target), so the block sign flip is used as the permutation null of the
// mean (decision recorded in the build report). Pure: rows in, weights out; randomness only from the
// Prng argument; iteration in sorted id order, so the same inputs give the same bytes.
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { percentile } from "@/lib/stats/bootstrap";
import { benjaminiHochberg } from "@/lib/stats/multiplicity";
import type { Prng } from "@/lib/stats/rng";
import { uniform01 } from "@/lib/stats/rng";
import { meanStatistic, stationaryBlockBootstrap } from "@/lib/stats/stationaryBootstrap";
import { studentTTwoSided } from "@/lib/stats/studentT";
import type { LearnConfig } from "./config";
import { reweightWords } from "./learnWords";
import type { AngleDayRow, LearnerWeights } from "./types";

/** What the development run knew about one scored angle (passport / ledger cell). */
export type DevPriorEntry = {
  readonly devIc: number;
  readonly cluster: string;
  /** Plain name for the words (never the id). */
  readonly name: string;
};
/** The scored set of the learner: angle id → its development prior. */
export type DevPrior = Readonly<Record<string, DevPriorEntry>>;

export type Finding = "up" | "down";

export type AngleEvidence = {
  /** Mean 20-session IC over the window's defined nights (null when none). */
  readonly ic20: number | null;
  /** Bootstrap one-sided 90 % bounds of the mean; drawn only for a BH rejection (else null). */
  readonly lo90: number | null;
  readonly hi90: number | null;
  readonly nights: number;
  readonly shrunk: number;
  /** Two-sided overlap-honouring t-test p (null when thin). */
  readonly p: number | null;
  /** Its t statistic (null when thin). */
  readonly t: number | null;
  readonly finding: Finding | null;
  /** Moved down on a checkpoint fall alarm rather than a weekly finding. */
  readonly viaAlarm: boolean;
  readonly thin: boolean;
  readonly from: number;
  readonly to: number;
};

export type ReweightInput = {
  /** cortex_angle_day rows of the window (both horizons may be passed; only horizon 20 is read). */
  readonly angleDays60: readonly AngleDayRow[];
  readonly devPrior: DevPrior;
  readonly current: LearnerWeights;
  readonly config: LearnConfig;
  readonly prng: Prng;
  /**
   * Angles with a checkpoint FALL alarm since the last weekly run (cap / watch / rollback events). The
   * alarm, already tested at its own null-calibrated level, stands in for the down-finding: the angle
   * may move DOWN toward its target without a weekly finding; never up.
   */
  readonly fallAlarms?: readonly string[];
};

export type ReweightResult = {
  readonly weights: LearnerWeights;
  readonly weightsHash: string;
  readonly evidence: Readonly<Record<string, AngleEvidence>>;
  readonly words: readonly string[];
  readonly changed: boolean;
  /** Largest relative move of an angle weight, |to − from| / from (0 when unchanged). */
  readonly maxMove: number;
  /** The angle whose weight rose the most (null when none rose): read by checkpoint rollback. */
  readonly raisedMost: string | null;
  readonly loweredMost: string | null;
  /** True when K × cluster cap < 1 (the cap cannot hold; clusters stay equal). */
  readonly clusterCapInfeasible: boolean;
};

const WEIGHT_DECIMALS = 1e6; // threshold-ok: weights stored to 6 decimals so the hash is over stored bytes
const PP = 100; // threshold-ok: percentage points to weight units
const LOWER_Q = 0.1; // threshold-ok: one-sided 90 % bounds (CI_LEVEL)
const UPPER_Q = 0.9; // threshold-ok: one-sided 90 % bounds (CI_LEVEL)
const FLOOR_PASSES = 50; // threshold-ok: iteration cap of the floor / cap fixed point (converges in ≤ K passes)

const round6 = (x: number) => Math.round(x * WEIGHT_DECIMALS) / WEIGHT_DECIMALS;

/** sha256 of the canonical JSON of the weights (C.2 `weights_hash`). */
export function weightsHash(weights: LearnerWeights): string {
  return sha256Hex(canonicalJson({ angle: weights.angle, cluster: weights.cluster }));
}

/** The PRNG scope of the weekly placebo twin (B.3 check 5). */
export function placeboScope(market: string, isoWeek: string): string {
  return `cortex-learn-placebo:${market}:${isoWeek}`;
}

/** The PRNG scope of the weekly reweight bootstrap. */
export function reweightScope(market: string, isoWeek: string): string {
  return `cortex-learn-reweight:${market}:${isoWeek}`;
}

type Series = { readonly ic: number[]; readonly outOfSeason: number };

function seriesOf(rows: readonly AngleDayRow[], ids: readonly string[], window: number) {
  const by = new Map<string, AngleDayRow[]>();
  for (const id of ids) by.set(id, []);
  for (const r of rows) {
    if (r.horizon !== 20 || r.ic === null || !Number.isFinite(r.ic)) continue; // threshold-ok: the 20-session horizon
    by.get(r.angleId)?.push(r);
  }
  const out = new Map<string, Series>();
  for (const [id, list] of by) {
    const sorted = [...list].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const tail = sorted.slice(Math.max(0, sorted.length - window));
    out.set(id, {
      ic: tail.map((r) => r.ic as number),
      outOfSeason: tail.filter((r) => r.resultsSeason === 0).length,
    });
  }
  return out;
}

function meanOf(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return xs.length === 0 ? 0 : s / xs.length;
}

/** Mean-1 normalisation with a floor, as a fixed point (floored weights stay at the floor). */
function normaliseWithFloor(w: Map<string, number>, floor: number): Map<string, number> {
  const ids = [...w.keys()];
  const out = new Map(w);
  const n = ids.length;
  if (n === 0) return out;
  const floored = new Set<string>();
  for (let pass = 0; pass < FLOOR_PASSES; pass += 1) {
    let free = 0;
    for (const id of ids) if (!floored.has(id)) free += out.get(id)!;
    const room = n - floored.size * floor;
    if (free <= 0 || room <= 0) {
      for (const id of ids) out.set(id, 1);
      return out;
    }
    const k = room / free;
    let added = false;
    for (const id of ids) {
      if (floored.has(id)) {
        out.set(id, floor);
        continue;
      }
      const v = out.get(id)! * k;
      if (v < floor) {
        floored.add(id);
        added = true;
      }
      out.set(id, v);
    }
    if (!added) return out;
  }
  return out;
}

/** Cluster shares capped at `cap` by water-filling, returned as mean-1 weights. */
function capClusters(
  raw: Map<string, number>,
  cap: number,
): { weights: Map<string, number>; infeasible: boolean } {
  const ids = [...raw.keys()];
  const K = ids.length;
  const out = new Map<string, number>();
  if (K === 0) return { weights: out, infeasible: false };
  if (K * cap < 1) {
    for (const id of ids) out.set(id, 1);
    return { weights: out, infeasible: true };
  }
  const total = ids.reduce((s, id) => s + Math.max(0, raw.get(id)!), 0);
  const share = new Map<string, number>();
  for (const id of ids) share.set(id, total > 0 ? Math.max(0, raw.get(id)!) / total : 1 / K);
  const capped = new Set<string>();
  for (let pass = 0; pass < FLOOR_PASSES; pass += 1) {
    let over = false;
    for (const id of ids) {
      if (!capped.has(id) && share.get(id)! > cap) {
        capped.add(id);
        over = true;
      }
    }
    if (!over) break;
    const rest = 1 - capped.size * cap;
    let free = 0;
    for (const id of ids) if (!capped.has(id)) free += share.get(id)!;
    for (const id of ids) {
      if (capped.has(id)) share.set(id, cap);
      else share.set(id, free > 0 ? (share.get(id)! / free) * rest : rest / (K - capped.size));
    }
  }
  for (const id of ids) out.set(id, share.get(id)! * K);
  return { weights: out, infeasible: false };
}

function bootstrapBounds(ic: readonly number[], config: LearnConfig, prng: Prng) {
  const n = ic.length;
  const layout = { sessions: ic.map((_, i) => i), sessionCount: n };
  const boot = stationaryBlockBootstrap(layout, meanStatistic(ic), prng, {
    expectedBlock: Math.min(config.bootBlockSessions, n),
    replicates: config.replicates,
  });
  return { lo90: percentile(boot.values, LOWER_Q), hi90: percentile(boot.values, UPPER_Q) };
}

/**
 * Two-sided p of the window mean with the overlap honoured. The 20-session rows are treated as a
 * moving average of `block` independent nights: n_eff = n / block for the mean, the variance about the
 * mean corrected for the overlap (× n_eff / (n_eff − 1)), and Student's t with the Bartlett degrees of
 * freedom of that variance, n / (1 + 2 Σ_{k<block} (1 − k/block)²) − 1 (≈ 3.5 on 60 rows). The
 * bootstrap percentiles alone, with about three independent blocks in a 60-session window, were
 * anti-conservative (LRN-AT-4 failed by ~9×); this test errs the other way (on pure noise its
 * false-finding rate is below nominal), which is the side the design asks for (B.3 "tell noise").
 */
function overlapP(ic: readonly number[], m: number, block: number): { t: number; p: number } {
  const n = ic.length;
  const L = Math.max(1, block);
  const nEff = n / L;
  let rho2 = 0;
  for (let k = 1; k < L; k += 1) rho2 += (1 - k / L) ** 2;
  const df = n / (1 + 2 * rho2) - 1;
  if (nEff <= 1 || !(df > 0)) return { t: 0, p: 1 };
  let ss = 0;
  for (const x of ic) ss += (x - m) ** 2;
  const s2 = (ss / n) * (nEff / (nEff - 1));
  if (!(s2 > 0)) return { t: m === 0 ? 0 : Math.sign(m) * Infinity, p: m === 0 ? 1 : 0 };
  const t = m / Math.sqrt(s2 / nEff);
  return { t, p: studentTTwoSided(t, df) };
}

/** The weekly re-weighting (B.2 "Finding"); see the header for the steps. */
export function reweight(input: ReweightInput): ReweightResult {
  const { devPrior, current, config, prng } = input;
  const ids = Object.keys(devPrior).sort();
  const series = seriesOf(input.angleDays60, ids, config.windowSessions);
  const cur = new Map<string, number>();
  for (const id of ids) {
    const v = current.angle[id];
    cur.set(id, typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 1);
  }

  type Work = {
    ic20: number | null;
    lo90: number | null;
    hi90: number | null;
    nights: number;
    shrunk: number;
    p: number | null;
    t?: number;
    thin: boolean;
  };
  const work = new Map<string, Work>();
  for (const id of ids) {
    const s = series.get(id)!;
    const n = s.ic.length;
    const m = n > 0 ? meanOf(s.ic) : null;
    const prior = devPrior[id]!.devIc * config.devHaircut;
    const shrunk = (n * (m ?? 0) + config.shrinkN0 * prior) / (n + config.shrinkN0);
    const thin = s.outOfSeason < config.minNights || n < 2;
    if (thin) {
      work.set(id, { ic20: m, lo90: null, hi90: null, nights: n, shrunk, p: null, thin });
      continue;
    }
    const q = overlapP(s.ic, m!, config.bootBlockSessions);
    work.set(id, { ic20: m, lo90: null, hi90: null, nights: n, shrunk, p: q.p, t: q.t, thin });
  }

  const tested = ids.filter((id) => !work.get(id)!.thin);
  const bh =
    tested.length > 0
      ? benjaminiHochberg(
          tested.map((id) => work.get(id)!.p!),
          config.fdrQ,
        )
      : null;
  const finding = new Map<string, Finding | null>();
  // The bootstrap bounds confirm a BH rejection's sign; drawn for the rejected angles only, in id order.
  tested.forEach((id, i) => {
    const w = work.get(id)!;
    let f: Finding | null = null;
    if (bh!.rejected[i]) {
      const b = bootstrapBounds(series.get(id)!.ic, config, prng);
      w.lo90 = b.lo90;
      w.hi90 = b.hi90;
      if (b.lo90 > 0) f = "up";
      else if (b.hi90 < 0) f = "down";
    }
    finding.set(id, f);
  });
  const alarmed = new Set(input.fallAlarms ?? []);

  // Targets ∝ max(0, shrunk), rescaled to the mean current weight of the tested angles.
  const rawMean = meanOf(tested.map((id) => Math.max(0, work.get(id)!.shrunk)));
  const curMean = meanOf(tested.map((id) => cur.get(id)!));
  const stepped = new Map<string, number>();
  const viaAlarm = new Set<string>();
  for (const id of ids) {
    const c = cur.get(id)!;
    let proposal = c;
    if (rawMean > 0 && !work.get(id)!.thin) {
      const target = (Math.max(0, work.get(id)!.shrunk) * curMean) / rawMean;
      if (finding.get(id)) proposal = target;
      else if (alarmed.has(id) && target < c) {
        proposal = target;
        viaAlarm.add(id);
      }
    }
    stepped.set(id, c + config.maxStep * (proposal - c));
  }
  const norm = normaliseWithFloor(stepped, config.weightFloor);

  // Cluster weights: mean of the angle weights of the cluster, share-capped.
  const clusterIds = [...new Set(ids.map((id) => devPrior[id]!.cluster))].sort();
  const clusterRaw = new Map<string, number>();
  for (const c of clusterIds) {
    clusterRaw.set(
      c,
      meanOf(ids.filter((id) => devPrior[id]!.cluster === c).map((id) => norm.get(id)!)),
    );
  }
  const capped = capClusters(clusterRaw, config.clusterWeightMax);

  const band = config.bandPp / PP;
  const nextAngle: Record<string, number> = {};
  const curAngle: Record<string, number> = {};
  for (const id of ids) {
    nextAngle[id] = round6(norm.get(id)!);
    curAngle[id] = round6(cur.get(id)!);
  }
  const nextCluster: Record<string, number> = {};
  const curCluster: Record<string, number> = {};
  for (const c of clusterIds) {
    nextCluster[c] = round6(capped.weights.get(c)!);
    const v = current.cluster[c];
    curCluster[c] = round6(typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 1);
  }
  const moved =
    ids.some((id) => Math.abs(nextAngle[id]! - curAngle[id]!) > band) ||
    clusterIds.some((c) => Math.abs(nextCluster[c]! - curCluster[c]!) > band);

  const weights: LearnerWeights = moved
    ? { angle: nextAngle, cluster: nextCluster }
    : { angle: curAngle, cluster: curCluster };

  let maxMove = 0;
  let raisedMost: string | null = null;
  let loweredMost: string | null = null;
  let bestUp = 0;
  let bestDown = 0;
  const evidence: Record<string, AngleEvidence> = {};
  for (const id of ids) {
    const w = work.get(id)!;
    const from = curAngle[id]!;
    const to = weights.angle[id]!;
    const delta = to - from;
    if (moved) {
      const rel = from > 0 ? Math.abs(delta) / from : Math.abs(delta);
      if (rel > maxMove) maxMove = rel;
      if (delta > bestUp) {
        bestUp = delta;
        raisedMost = id;
      }
      if (-delta > bestDown) {
        bestDown = -delta;
        loweredMost = id;
      }
    }
    evidence[id] = {
      ic20: w.ic20,
      lo90: w.lo90,
      hi90: w.hi90,
      nights: w.nights,
      shrunk: w.shrunk,
      p: w.p,
      t: w.t ?? null,
      finding: finding.get(id) ?? null,
      viaAlarm: viaAlarm.has(id),
      thin: w.thin,
      from,
      to,
    };
  }

  const up = ids.filter((id) => moved && weights.angle[id]! - curAngle[id]! > band);
  const down = ids.filter((id) => moved && curAngle[id]! - weights.angle[id]! > band);
  const words = [
    reweightWords({
      changed: moved,
      up: up.map((id) => devPrior[id]!.name),
      down: down.map((id) => devPrior[id]!.name),
      maxStep: config.maxStep,
      realMove: maxMove,
      placeboMove: null,
    }),
  ];

  return {
    weights,
    weightsHash: weightsHash(weights),
    evidence,
    words,
    changed: moved,
    maxMove,
    raisedMost,
    loweredMost,
    clusterCapInfeasible: capped.infeasible,
  };
}

/**
 * The coin-flip twin (B.3 check 5): the same learner on rows whose IC is sign-flipped per block of
 * `bootBlockSessions` consecutive nights (one flip per block for every angle, so the cross-angle
 * dependence is kept). `prng` must come from `placeboScope(market, week)`.
 */
export function placebo(input: ReweightInput): ReweightResult {
  const nights = [...new Set(input.angleDays60.map((r) => r.d))].sort();
  const block = Math.max(1, input.config.bootBlockSessions);
  const flips: number[] = [];
  for (let b = 0; b * block < nights.length; b += 1)
    flips.push(uniform01(input.prng) < 0.5 ? -1 : 1); // threshold-ok: fair coin
  const sign = new Map<string, number>();
  nights.forEach((d, i) => sign.set(d, flips[Math.floor(i / block)]!));
  const rows = input.angleDays60.map((r) =>
    r.ic === null ? r : { ...r, ic: r.ic * (sign.get(r.d) ?? 1) },
  );
  return reweight({ ...input, angleDays60: rows });
}

/** True when the real learner's largest move sits inside the placebo's (the words say "within chance"). */
export function withinChance(real: ReweightResult, twin: ReweightResult): boolean {
  return real.maxMove <= twin.maxMove;
}

/** The weekly words with the placebo line attached (C.11). */
export function weeklyWords(
  real: ReweightResult,
  twin: ReweightResult,
  devPrior: DevPrior,
  config: LearnConfig,
): string {
  const band = config.bandPp / PP;
  const ids = Object.keys(real.evidence).sort();
  const up = ids.filter((id) => real.evidence[id]!.to - real.evidence[id]!.from > band);
  const down = ids.filter((id) => real.evidence[id]!.from - real.evidence[id]!.to > band);
  return reweightWords({
    changed: real.changed,
    up: up.map((id) => devPrior[id]?.name ?? ""),
    down: down.map((id) => devPrior[id]?.name ?? ""),
    maxStep: config.maxStep,
    realMove: real.maxMove,
    placeboMove: twin.maxMove,
  });
}

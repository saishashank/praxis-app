// Matched-setup cells and the economic gate statistic (M15 C2; spec ch. 17 CTX-012 "Outcome model",
// CTX-021, CTX-022b; D-276 cell_min_blocks = 20; AT-52 "the 40/60 setup fails the gate").
//
//   Cell key = family rule × score band × volatility bucket × liquidity tier. The gate's matched cell is
//   the pre-registered POOLED TOP-3 score band of the family (deciles 8–10 of S within the family), never
//   a 10-way search over deciles. Setups the limit order would not have filled are excluded from the cell
//   and their share is reported (CTX-022b).
//
//   Gate statistic: the lower one-sided 90 % stationary-block-bootstrap bound of the mean realised net
//   outcome (`bootstrapMean`, stationaryBootstrap.ts). The cell must hold ≥ `cell_min_setups` (60)
//   setups and ≥ `cell_min_blocks` (20) populated blocks with n_eff defined; otherwise "not enough
//   history". Regime fail-closed: the family may trade in a regime only if the cell holds ≥ 30 setups
//   from that regime with mean net ≥ 0.
//
// Money arrives as micro-dollar integers (`netMicro`, `grossMicro`, `notionalMicro`) and is converted
// to float fractions once, at `setupReturns`; everything after is float. Pure; Prng explicit.
import { averageRanks, median } from "./rankIc";
import type { Prng } from "./rng";
import {
  type BootCi,
  type BootstrapOptions,
  bootstrapMean,
  isUndefined,
  type StatUndefined,
} from "./stationaryBootstrap";

/** `cell_min_setups` default (CTX-021). */
export const DEFAULT_CELL_MIN_SETUPS = 60;
/** `cell_min_blocks` for the frozen development split (D-276: min(20, floor(22 years × 2)) = 20). */
export const DEFAULT_CELL_MIN_BLOCKS = 20;
/** Setups a regime needs in the cell before the family may trade in it (CTX-021 fail-closed). */
export const REGIME_MIN_SETUPS = 30;
export const SCORE_BANDS = 10;
/** The pre-registered pooled band: the top three deciles. */
export const TOP3_BANDS: readonly number[] = [8, 9, 10];
export const TOP3_BAND_KEY = "top3";

/** One realised setup of the development split (or a live would-have outcome). */
export type CellSetup = {
  readonly family: string;
  readonly code: string;
  /** Entry session index within the window (0..S−1). */
  readonly session: number;
  /** Score band 1..SCORE_BANDS within the family (`scoreBands`). */
  readonly band: number;
  readonly volBucket: string;
  readonly liqTier: string;
  readonly regime: string;
  /** Realised net outcome after all costs, micro-dollars (negative = loss). */
  readonly netMicro: bigint;
  /** Entry notional, micro-dollars (> 0). */
  readonly notionalMicro: bigint;
  /** The limit order would have filled (CTX-022b: unfilled setups are excluded from the cell). */
  readonly filled: boolean;
  /** Adverse overnight gap of the setup as a fraction (≥ 0), for gap95 (CTX-022b). */
  readonly adverseGap: number;
};

/**
 * Deciles of S within one family: band 1 (lowest) … `bands` (highest), ties by average rank. This is
 * the development-split banding; LIVE score bands must be cut on the frozen development S quantiles
 * (the band edges stored with the map), not re-ranked within a night's candidates — C3a's job.
 */
export function scoreBands(s: readonly number[], bands: number = SCORE_BANDS): number[] {
  if (!Number.isInteger(bands) || bands < 1)
    throw new RangeError("bands must be a positive integer");
  const n = s.length;
  if (n === 0) return [];
  const ranks = averageRanks(s);
  return ranks.map((r) => Math.min(bands, Math.max(1, Math.ceil((r / n) * bands - 1e-12))));
}

export function isTop3Band(band: number): boolean {
  return TOP3_BANDS.includes(band);
}

/** `family|band|volBucket|liqTier`; `band` is a decile number or `TOP3_BAND_KEY` for the pooled cell. */
export function cellKey(
  family: string,
  band: number | string,
  volBucket: string,
  liqTier: string,
): string {
  return `${family}|${band}|${volBucket}|${liqTier}`;
}

/** Float net return of a setup (the money → statistics boundary). */
export function netReturnFromMicro(netMicro: bigint, notionalMicro: bigint): number {
  if (notionalMicro <= 0n) throw new RangeError("notional must be positive");
  // Micro amounts are far inside 2^53 for any arena notional; the ratio is a plain float.
  return Number(netMicro) / Number(notionalMicro);
}

export type CellStatistic = {
  readonly cellKey: string;
  /** Filled setups in the cell. */
  readonly n: number;
  /** Populated calendar blocks (see `effectiveN`). */
  readonly blocks: number;
  readonly nEff: number | undefined;
  /** Mean realised net return (fraction). */
  readonly meanNet: number;
  /** Lower one-sided 90 % block-bootstrap bound of the mean (NaN when undefined). */
  readonly lower90: number;
  /** The full interval, or why it is undefined. */
  readonly bound: BootCi | StatUndefined;
  /** Median realised loss magnitude among losing setups (fraction; 0 when none), CTX-022 L_real. */
  readonly lReal: number;
  /** 95th percentile of the adverse overnight gap (fraction). */
  readonly gap95: number;
  readonly byRegime: Readonly<Record<string, { readonly n: number; readonly meanNet: number }>>;
  /** Share of the cell's setups excluded because the limit order would not have filled. */
  readonly excludedUnfilledShare: number;
};

export type CellOptions = BootstrapOptions & {
  /** Sessions S in the window; default max session + 1. */
  readonly sessionCount?: number;
};

/** The statistics of one cell from its setups (filled and unfilled; the unfilled are excluded here). */
export function cellStatistic(
  key: string,
  setups: readonly CellSetup[],
  prng: Prng,
  opts: CellOptions = {},
): CellStatistic {
  const filled = setups.filter((s) => s.filled);
  const excludedUnfilledShare = setups.length > 0 ? 1 - filled.length / setups.length : 0;
  const net = filled.map((s) => netReturnFromMicro(s.netMicro, s.notionalMicro));
  const byRegime: Record<string, { n: number; meanNet: number }> = {};
  const regimeSums = new Map<string, { n: number; sum: number }>();
  filled.forEach((s, i) => {
    const r = regimeSums.get(s.regime) ?? { n: 0, sum: 0 };
    r.n += 1;
    r.sum += net[i]!;
    regimeSums.set(s.regime, r);
  });
  for (const [regime, r] of [...regimeSums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    byRegime[regime] = { n: r.n, meanNet: r.sum / r.n };
  }
  const losses = net.filter((v) => v < 0).map((v) => -v);
  const lReal = median(losses) ?? 0;
  const gaps = filled.map((s) => s.adverseGap);
  const gap95 = gaps.length > 0 ? percentileOf(gaps, 0.95) : 0;
  if (filled.length === 0) {
    return {
      cellKey: key,
      n: 0,
      blocks: 0,
      nEff: undefined,
      meanNet: NaN,
      lower90: NaN,
      bound: { undefined: "no filled setups" },
      lReal,
      gap95,
      byRegime,
      excludedUnfilledShare,
    };
  }
  const sessionCount = opts.sessionCount ?? maxSession(filled) + 1;
  const bound = bootstrapMean(
    {
      sessions: filled.map((s) => s.session),
      sessionCount,
      codes: filled.map((s) => s.code),
    },
    net,
    prng,
    opts,
  );
  let meanNet = 0;
  for (const v of net) meanNet += v;
  meanNet /= net.length;
  return {
    cellKey: key,
    n: filled.length,
    blocks: isUndefined(bound) ? 0 : bound.blocks,
    nEff: isUndefined(bound) ? undefined : bound.nEff,
    meanNet,
    lower90: isUndefined(bound) ? NaN : bound.oneSidedLo,
    bound,
    lReal,
    gap95,
    byRegime,
    excludedUnfilledShare,
  };
}

/** Largest session index by a plain loop (`Math.max(...arr)` overflows the stack above ~125k setups). */
function maxSession(setups: readonly CellSetup[]): number {
  let m = -Infinity;
  for (const s of setups) if (s.session > m) m = s.session;
  return m;
}

/** Nearest-rank percentile of a plain array (local to keep `percentile`'s Float64 sort semantics). */
function percentileOf(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length - 1e-9) - 1));
  return sorted[idx]!;
}

/**
 * Build every cell of a setups table: one per (family, band, volBucket, liqTier) and one pooled
 * top-3 cell per (family, volBucket, liqTier) under `TOP3_BAND_KEY`. Each cell draws from
 * `prngFor(cellKey)` so results do not depend on iteration order. Keys are returned sorted.
 */
export function buildCells(
  setups: readonly CellSetup[],
  prngFor: (cellKey: string) => Prng,
  opts: CellOptions = {},
): Map<string, CellStatistic> {
  const groups = new Map<string, CellSetup[]>();
  const add = (key: string, s: CellSetup) => {
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  };
  for (const s of setups) {
    add(cellKey(s.family, s.band, s.volBucket, s.liqTier), s);
    if (isTop3Band(s.band)) add(cellKey(s.family, TOP3_BAND_KEY, s.volBucket, s.liqTier), s);
  }
  const sessionCount = opts.sessionCount ?? (setups.length > 0 ? maxSession(setups) + 1 : 1);
  const out = new Map<string, CellStatistic>();
  for (const key of [...groups.keys()].sort()) {
    out.set(key, cellStatistic(key, groups.get(key)!, prngFor(key), { ...opts, sessionCount }));
  }
  return out;
}

export type GateOptions = {
  readonly cellMinSetups?: number;
  readonly cellMinBlocks?: number;
  readonly regimeMinSetups?: number;
};

export type EconomicGateResult =
  | { readonly pass: true; readonly lower90: number }
  | {
      readonly pass: false;
      /** `not_enough_history`: n, blocks or n_eff short; `bound_not_positive`; `regime_blocked`. */
      readonly reason: "not_enough_history" | "bound_not_positive" | "regime_blocked";
      readonly detail: string;
    };

/**
 * CTX-021 on one pooled top-3 cell for the night's regime. The caller (C3c `G04_economic`) maps the
 * reason to the plain label of the gate table.
 */
export function economicGate(
  cell: CellStatistic,
  regime: string,
  opts: GateOptions = {},
): EconomicGateResult {
  const minSetups = opts.cellMinSetups ?? DEFAULT_CELL_MIN_SETUPS;
  const minBlocks = opts.cellMinBlocks ?? DEFAULT_CELL_MIN_BLOCKS;
  const regimeMin = opts.regimeMinSetups ?? REGIME_MIN_SETUPS;
  if (cell.n < minSetups) {
    return { pass: false, reason: "not_enough_history", detail: `${cell.n} setups < ${minSetups}` };
  }
  if (isUndefined(cell.bound) || cell.nEff === undefined) {
    const why = isUndefined(cell.bound) ? cell.bound.undefined : "n_eff undefined";
    return { pass: false, reason: "not_enough_history", detail: why };
  }
  if (cell.blocks < minBlocks) {
    return {
      pass: false,
      reason: "not_enough_history",
      detail: `${cell.blocks} blocks < ${minBlocks}`,
    };
  }
  if (!(cell.lower90 > 0)) {
    return {
      pass: false,
      reason: "bound_not_positive",
      detail: `lower 90 % bound ${cell.lower90.toFixed(6)} <= 0`,
    };
  }
  const r = cell.byRegime[regime];
  if (!r || r.n < regimeMin || !(r.meanNet >= 0)) {
    return {
      pass: false,
      reason: "regime_blocked",
      detail: r
        ? `${regime}: ${r.n} setups, mean net ${r.meanNet.toFixed(6)}`
        : `${regime}: no setups`,
    };
  }
  return { pass: true, lower90: cell.lower90 };
}

// L0 integrity predicates (CTX-010, CTX-050 "quota-degrade", D-289): the night-level and row-level
// checks that decide an abstain-all before any angle runs. Pure functions of plain inputs so the
// stage (P2), the replay driver (P3) and the offline tools apply one rule.

/** A row with a null, missing or non-positive adjusted close is rejected (CTX-010, GL-04 reversed). */
export function hasNullClose(row: { readonly adjClose: unknown }): boolean {
  const v = row.adjClose;
  if (v === null || v === undefined) return true;
  if (typeof v === "bigint") return v <= 0n;
  if (typeof v === "number") return !Number.isFinite(v) || v <= 0;
  return true;
}

/** Splits bar rows into the ones kept and the ones rejected for a null close; order is preserved. */
export function partitionNullClose<T extends { readonly adjClose: unknown }>(
  rows: readonly T[],
): { readonly kept: T[]; readonly rejected: T[] } {
  const kept: T[] = [];
  const rejected: T[] = [];
  for (const r of rows) (hasNullClose(r) ? rejected : kept).push(r);
  return { kept, rejected };
}

export type LateBarInputs = {
  /** The session being decided. */
  readonly d: string;
  /** Date of the latest benchmark (^AXJO) bar in the night's snapshot; null = none. */
  readonly benchmarkBarD: string | null;
  /** Number of universe codes with a bar dated `d` in the snapshot. */
  readonly universeBarsOnD: number;
};

/**
 * CTX-010: "if the D bar is not published by the cut-off, the night is an abstain-all". The D bar is
 * late when the benchmark has no bar dated D or no universe code has one. No retry window.
 */
export function isLateBarNight(i: LateBarInputs): boolean {
  return i.benchmarkBarD !== i.d || i.universeBarsOnD <= 0;
}

export type QuotaInputs = {
  /** Wall-clock minutes the stage has used so far (the caller measures; the core never reads a clock). */
  readonly elapsedMinutes: number;
  /** `cortex_stage_minutes` (default 15, bounds 5-60; V2-I9). */
  readonly stageMinutes: number;
  /** Share in [0, 1] of universe codes without a D bar. */
  readonly staleShare: number;
  /** `stale_universe_max_share`. */
  readonly staleUniverseMaxShare: number;
};

export type QuotaReason = "quota" | "universe_incomplete";

/**
 * D-289: the stage records `abstain_all` with reason `quota` when its wall-clock exceeds the stage
 * budget, else `universe_incomplete` when the stale share exceeds its cap; null = run the night.
 * Both thresholds are strict ("exceeds"): equal to the bound still runs.
 */
export function quotaDegrade(i: QuotaInputs): QuotaReason | null {
  for (const [k, v] of Object.entries(i)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new RangeError(`quotaDegrade: ${k} must be a finite non-negative number`);
  }
  if (i.elapsedMinutes > i.stageMinutes) return "quota";
  if (i.staleShare > i.staleUniverseMaxShare) return "universe_incomplete";
  return null;
}

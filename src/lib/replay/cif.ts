// Competing-risk cumulative incidence (M4 T14; design 4.11; ARN-071, ARN-053; decision 25).
// Four mutually exclusive ends of a cohort: target, bust, stalled, timeout; a cohort that has not
// ended when the data (or the live clock) stops is CENSORED at the sessions observed. Estimators:
//
//   aalenJohansen      the Aalen-Johansen estimator of CIF_k(t) with the delta-method
//                      (Greenwood-type) variance, exact on ties and on censoring;
//   cifProportions     resolved NON-OVERLAPPING cohorts (M3 `effectiveN`) -> proportions with
//                      Wilson intervals (replay cohorts are uncensored by construction: timeout);
//   cifBootstrap       percentile intervals from a seeded circular block bootstrap of the cohorts
//                      (blocks of consecutive start dates), the same `src/lib/stats` PRNG and
//                      percentile as every other interval in the app;
//   nonOverlapping     the greedy effective-N selection, reported next to every figure.
// Pure and deterministic: no clock, no Math.random; sorted iteration, fixed summation order.
import { effectiveN, type EffectiveNCohort } from "@/lib/arena/cohort";
import {
  belowInt,
  percentile,
  scopedPrng,
  wilsonInterval,
  type Interval,
  type Prng,
} from "@/lib/stats";

export const CAUSES = ["target", "bust", "stalled", "timeout"] as const;
export type Cause = (typeof CAUSES)[number];

/** ARN-071: the CIF is shown at 3, 6 and 12 months = 63, 126 and 252 sessions. */
export const CIF_HORIZONS: readonly number[] = [63, 126, 252]; // threshold-ok: ARN-071 3/6/12 months (no registry key yet, D-091)
/** "All intervals in the app are 90 %" (ARN-070). */
export const INTERVAL_CONFIDENCE = 0.9; // threshold-ok: ARN-070 all intervals are 90 %

/** One cohort as the estimator sees it: time in sessions, the cause, or null = censored there. */
export type CifObservation = { readonly time: number; readonly cause: Cause | null };

export type CifEstimate = {
  readonly horizon: number;
  /** Cohorts in the estimate. */
  readonly n: number;
  readonly events: Readonly<Record<Cause, number>>;
  readonly censored: number;
  readonly cif: Readonly<Record<Cause, number>>;
  /** Delta-method (Greenwood-type) standard error of each CIF. */
  readonly se: Readonly<Record<Cause, number>>;
  /** Overall survival (no event yet) at the horizon. */
  readonly survival: number;
};

const zeroCauses = (): Record<Cause, number> => ({ target: 0, bust: 0, stalled: 0, timeout: 0 });

type Step = {
  readonly t: number;
  readonly n: number;
  readonly d: number;
  readonly dk: Readonly<Record<Cause, number>>;
  /** S(t-): survival just before t. */
  readonly sPrev: number;
  /** CIF_k just after t. */
  readonly f: Readonly<Record<Cause, number>>;
};

function steps(obs: readonly CifObservation[], maxHorizon: number): Step[] {
  const sorted = [...obs].sort((a, b) => a.time - b.time);
  const out: Step[] = [];
  const f = zeroCauses();
  let s = 1;
  let atRisk = sorted.length;
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i]!.time;
    let j = i;
    const dk = zeroCauses();
    let d = 0;
    while (j < sorted.length && sorted[j]!.time === t) {
      const c = sorted[j]!.cause;
      if (c !== null) {
        dk[c] += 1;
        d += 1;
      }
      j += 1;
    }
    if (t > maxHorizon) break;
    if (d > 0) {
      const sPrev = s;
      for (const c of CAUSES) f[c] += (sPrev * dk[c]) / atRisk;
      s = sPrev * (1 - d / atRisk);
      out.push({ t, n: atRisk, d, dk: { ...dk }, sPrev, f: { ...f } });
    }
    atRisk -= j - i; // ties: events and censorings at t were all at risk at t
    i = j;
  }
  return out;
}

/** Variance of CIF_k at `horizon` from the event steps up to it (see the module header). */
function variance(st: readonly Step[], horizon: number, k: Cause, fAt: number): number {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const x of st) {
    if (x.t > horizon) break;
    const gap = fAt - x.f[k];
    if (gap !== 0 && x.n > x.d) a += (gap * gap * x.d) / (x.n * (x.n - x.d));
    const dk = x.dk[k];
    if (dk > 0) {
      b += (x.sPrev * x.sPrev * dk * (x.n - dk)) / (x.n * x.n * x.n);
      if (gap !== 0 && x.n > x.d)
        c += (gap * x.sPrev * dk * (x.n - dk)) / (x.n * x.n * (x.n - x.d));
    }
  }
  const v = a + b - 2 * c;
  return v > 0 ? v : 0;
}

/**
 * Aalen-Johansen cumulative incidence at each horizon. At an event time the at-risk set is every
 * cohort with time >= t (a censoring at the same time is still at risk); events before censorings.
 */
export function aalenJohansen(
  obs: readonly CifObservation[],
  horizons: readonly number[] = CIF_HORIZONS,
): CifEstimate[] {
  const maxH = horizons.reduce((m, h) => (h > m ? h : m), 0);
  const st = steps(obs, maxH);
  return horizons.map((horizon) => {
    const upto = st.filter((x) => x.t <= horizon);
    const last = upto[upto.length - 1];
    const cif = last === undefined ? zeroCauses() : { ...last.f };
    const events = zeroCauses();
    for (const x of upto) for (const c of CAUSES) events[c] += x.dk[c];
    const se = zeroCauses();
    for (const c of CAUSES) se[c] = Math.sqrt(variance(st, horizon, c, cif[c]));
    const censored = obs.filter((o) => o.cause === null && o.time <= horizon).length;
    return {
      horizon,
      n: obs.length,
      events,
      censored,
      cif,
      se,
      survival: last === undefined ? 1 : last.sPrev * (1 - last.d / last.n),
    };
  });
}

// ---- resolved non-overlapping cohorts: proportions with Wilson intervals --------------------------------------

export type ResolvedCohort = EffectiveNCohort & {
  /** Sessions from the start to the terminal close (null while unresolved). */
  readonly ttdSessions: number | null;
};

/** The ARN-053 selection: resolved cohorts that do not overlap an already counted one, in start order. */
export function nonOverlapping<T extends EffectiveNCohort>(cohorts: readonly T[]): T[] {
  const picked = new Set(effectiveN(cohorts).counted);
  return cohorts.filter((c) => picked.has(c.id));
}

export type CifProportion = {
  readonly horizon: number;
  readonly n: number;
  readonly counts: Readonly<Record<Cause, number>>;
  readonly cif: Readonly<Record<Cause, number>>;
  readonly interval: Readonly<Record<Cause, Interval>>;
};

/** CIF at each horizon = share of the N non-overlapping resolved cohorts that ended in that cause by then. */
export function cifProportions(
  cohorts: readonly ResolvedCohort[],
  horizons: readonly number[] = CIF_HORIZONS,
  confidence: number = INTERVAL_CONFIDENCE,
): CifProportion[] {
  const chosen = nonOverlapping(cohorts);
  const n = chosen.length;
  return horizons.map((horizon) => {
    const counts = zeroCauses();
    for (const c of chosen) {
      if (c.terminalKind !== null && c.ttdSessions !== null && c.ttdSessions <= horizon) {
        counts[c.terminalKind as Cause] += 1;
      }
    }
    const cif = zeroCauses();
    const interval = {} as Record<Cause, Interval>;
    for (const c of CAUSES) {
      cif[c] = n === 0 ? 0 : counts[c] / n;
      interval[c] = wilsonInterval(counts[c], n, confidence);
    }
    return { horizon, n, counts, cif, interval };
  });
}

// ---- bootstrap intervals -------------------------------------------------------------------------------------------

export type BootstrapCif = {
  readonly horizon: number;
  readonly replicates: number;
  readonly interval: Readonly<Record<Cause, Interval>>;
};

/**
 * Seeded circular block bootstrap of the cohorts: `obs` must be ordered by start date; a replicate
 * draws ceil(n / block) block starts uniformly and takes `block` consecutive cohorts from each
 * (wrapping), then re-estimates the AJ CIF. Percentile (1 - confidence) / 2 and its mirror.
 */
export function cifBootstrap(
  obs: readonly CifObservation[],
  horizons: readonly number[],
  block: number,
  replicates: number,
  scope: string,
  confidence: number = INTERVAL_CONFIDENCE,
  rng: Prng = scopedPrng(scope),
): BootstrapCif[] {
  const n = obs.length;
  if (n === 0) throw new RangeError("at least one cohort is required");
  if (!Number.isInteger(block) || block < 1)
    throw new RangeError("block must be a positive integer");
  if (!Number.isInteger(replicates) || replicates < 1) {
    throw new RangeError("replicates must be a positive integer");
  }
  const draws = Math.ceil(n / block);
  const values = horizons.map(() => CAUSES.map(() => new Float64Array(replicates)));
  for (let b = 0; b < replicates; b += 1) {
    const sample: CifObservation[] = [];
    for (let k = 0; k < draws; k += 1) {
      const start = belowInt(rng, n);
      for (let o = 0; o < block; o += 1) sample.push(obs[(start + o) % n]!);
    }
    const est = aalenJohansen(sample, horizons);
    est.forEach((e, h) => CAUSES.forEach((c, ci) => (values[h]![ci]![b] = e.cif[c])));
  }
  const lowQ = (1 - confidence) / 2;
  return horizons.map((horizon, h) => {
    const interval = {} as Record<Cause, Interval>;
    CAUSES.forEach((c, ci) => {
      interval[c] = {
        lower: percentile(values[h]![ci]!, lowQ),
        upper: percentile(values[h]![ci]!, 1 - lowQ),
      };
    });
    return { horizon, replicates, interval };
  });
}

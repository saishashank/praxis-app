// Shared synthetic builders for the T13 tests (splits, VAL-110, labels, survivorship, feasibility).
// Everything is generated from a seeded PRNG: no real market data, no clock.
import { defaultAgentParams } from "../../../src/lib/agents/params";
import { scopedPrng, uniform01 } from "../../../src/lib/stats/rng";
import type { SignalRow } from "../../../src/lib/stats/val110";
import {
  trialLedgerRow,
  type LineageSplitRecord,
  type TrialKind,
  type TrialLedgerRow,
} from "../../../src/lib/stats/splits";

export const PARAMS = defaultAgentParams().stats;
export const LINEAGE = "ASX:F1";

/** `count` weekday dates from 2015-01-05 (a Monday), ISO text. */
export function weekdayCalendar(count: number, start = "2015-01-05"): string[] {
  const out: string[] = [];
  const t = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const wd = t.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}

function gauss(rng: ReturnType<typeof scopedPrng>): number {
  // Sum of 12 uniforms minus 6: mean 0, sd 1 (Irwin-Hall), deterministic.
  let s = 0;
  for (let i = 0; i < 12; i += 1) s += uniform01(rng);
  return s - 6;
}

/**
 * n rows spread over S entry sessions. excess ~ edge + sd * noise; net = excess + netShift (the matched
 * controls' own mean net); stress = net - stressCost.
 */
export function makeRows(opts: {
  n: number;
  S: number;
  edge: number;
  sd?: number;
  netShift?: number;
  stressCost?: number;
  seed?: string;
}): SignalRow[] {
  const rng = scopedPrng(opts.seed ?? "t13:rows");
  const sd = opts.sd ?? 0.03;
  const rows: SignalRow[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    const excess = opts.edge + sd * gauss(rng);
    const net = excess + (opts.netShift ?? 0.01);
    rows.push({
      id: `row:${i}`,
      entrySession: Math.floor((i * opts.S) / opts.n),
      net,
      stress: net - (opts.stressCost ?? 0.005),
      excess,
    });
  }
  return rows;
}

export function accessRow(
  kind: TrialKind,
  split: Pick<LineageSplitRecord, "version">,
  over: Partial<TrialLedgerRow> = {},
): TrialLedgerRow {
  return trialLedgerRow({
    market: "ASX",
    lineage_id: LINEAGE,
    split_version: split.version,
    kind,
    rule_version: "1",
    variant: "primary",
    run_id: "run-1",
    d: "2026-10-19",
    ...over,
  });
}

/** Seeded weekly matrix: `variants` columns, variant 0 better by `lead` per week. */
export function weeklyMatrix(weeks: number, variants: number, lead: number, seed = "t13:pbo") {
  const rng = scopedPrng(seed);
  const out: number[][] = [];
  for (let t = 0; t < weeks; t += 1) {
    const row: number[] = [];
    for (let n = 0; n < variants; n += 1) row.push((n === 0 ? lead : 0) + 0.01 * gauss(rng));
    out.push(row);
  }
  return out;
}

export function dailyReturns(n: number, mean: number, sd: number, seed = "t13:daily"): number[] {
  const rng = scopedPrng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(mean + sd * gauss(rng));
  return out;
}

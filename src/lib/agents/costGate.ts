// FAM-005 cost gate (M14, D-214, D-215; docs/M14_design.md 2.1).
//
// Contract:
//   costGateTable(rows)    median gross return per (family, rule version, variant) from CLOSED signal-
//                          ledger rows of the development split (gross = ledger_row.gross_num/den, before
//                          brokerage and slippage). Fewer than `cost_gate_min_rows` (30) rows gives
//                          "unmeasured".
//   roundTripCost(...)     2 x the cost profile's brokerage at the fixed A$600 notional + 2 x the ARN-032
//                          bucket bps of the signal's 20-session ADV, as a fraction of the notional.
//   passesCostGate(...)    median >= k x cost, exact (`cost_gate_k`, default 2).
//   loadCostGateTable(...) the live loader (same rows as the AGT-110 scenario table in cards.ts).
// The gate applies to E executions only: never to the signal ledger and never to the C2/C3 controls.
// An unmeasured signal passes and the card carries the flag `cost_gate_unmeasured`.
import type { Client } from "@libsql/client";
import { feeFor, type CostProfile } from "@/lib/arena/costs";
import { bucketBpsFor } from "@/lib/arena/slippage";
import type { Micro } from "@/lib/money/micro";
import {
  addRat,
  cmpRat,
  divRat,
  makeRational,
  mulRat,
  ratFromInt,
  type Rational,
} from "@/lib/money/rational";
import { lineageId, splitFromRow, splitOf, type LineageSplitRecord } from "@/lib/stats/splits";
import type { Family } from "./schema";

/** One closed development-split ledger row, reduced to what the gate reads. */
export type CostGateRow = {
  readonly family: Family;
  readonly ruleVersion: string;
  readonly variant: string;
  /** Gross return (before brokerage and slippage) as an exact fraction. */
  readonly grossNum: bigint;
  readonly grossDen: bigint;
};

/** The median gross return of one (family, rule version, variant), or null when unmeasured. */
export type CostGateEntry = {
  readonly rows: number;
  /** null = fewer than `cost_gate_min_rows` rows: the gate is not applied. */
  readonly median: Rational | null;
};

/** Key of a table entry: `${family}|${ruleVersion}|${variant}`. */
export type CostGateTable = ReadonlyMap<string, CostGateEntry>;

export const costGateKey = (family: Family, ruleVersion: string, variant: string): string =>
  `${family}|${ruleVersion}|${variant}`;

/** The result of the gate for one signal. */
export type CostGateVerdict = "pass" | "skip" | "unmeasured";

/** The fixed notional of the round trip (D-215): A$600 in micro units. */
export const COST_GATE_NOTIONAL_MICRO: Micro = 600_000_000n; // threshold-ok: spec FAM-005 fixed A$600
const BPS_DEN = 10_000n; // threshold-ok: basis points per unit

/** Exact median of rationals (mean of the two middle values when the count is even). */
function medianOf(values: readonly Rational[]): Rational {
  const sorted = [...values].sort((a, b) => cmpRat(a, b));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return divRat(addRat(sorted[mid - 1]!, sorted[mid]!), ratFromInt(2n));
}

/**
 * Medians per (family, rule version, variant), keyed by `costGateKey`. A group with fewer than
 * `minRows` rows (`cost_gate_min_rows`) has `median: null` (unmeasured). Rows with a zero
 * denominator are ignored. Order of the rows does not matter.
 */
export function costGateTable(
  rows: readonly CostGateRow[],
  minRows = 30, // threshold-ok: `cost_gate_min_rows` default; callers pass the key
): CostGateTable {
  const groups = new Map<string, Rational[]>();
  for (const r of rows) {
    if (r.grossDen <= 0n) continue;
    const key = costGateKey(r.family, r.ruleVersion, r.variant);
    const list = groups.get(key) ?? [];
    list.push(makeRational(r.grossNum, r.grossDen));
    groups.set(key, list);
  }
  const out = new Map<string, CostGateEntry>();
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!;
    out.set(key, { rows: list.length, median: list.length < minRows ? null : medianOf(list) });
  }
  return out;
}

/**
 * Round-trip cost as a fraction of the notional: 2 x brokerage of the profile at A$600 plus 2 x the
 * ARN-032 bucket bps of the 20-session ADV (exact).
 */
export function roundTripCost(profile: CostProfile, advMicro: Micro): Rational {
  const fee =
    feeFor(profile, COST_GATE_NOTIONAL_MICRO, "buy") +
    feeFor(profile, COST_GATE_NOTIONAL_MICRO, "sell");
  const fees = makeRational(fee, COST_GATE_NOTIONAL_MICRO);
  const slip = mulRat(makeRational(2n), divRat(bucketBpsFor(advMicro), makeRational(BPS_DEN)));
  return addRat(fees, slip);
}

/** median >= k x cost, exact. */
export function passesCostGate(median: Rational, cost: Rational, k: Rational): boolean {
  return cmpRat(median, mulRat(k, cost)) >= 0;
}

/** The gate for one signal: unmeasured passes; a missing table entry is unmeasured. */
export function costGateVerdict(
  table: CostGateTable | undefined,
  family: Family,
  ruleVersion: string,
  variant: string,
  cost: Rational,
  k: Rational,
): CostGateVerdict {
  const entry = table?.get(costGateKey(family, ruleVersion, variant));
  if (entry === undefined || entry.median === null) return "unmeasured";
  return passesCostGate(entry.median, cost, k) ? "pass" : "skip";
}

/** A closed or open ledger row of one lineage, reduced to what the development filter reads. */
export type CostGateLedgerRow = {
  readonly family: Family;
  readonly ruleVersion: string;
  readonly variant: string;
  readonly entryD: string;
  readonly exitD: string | null;
  readonly grossNum: bigint | null;
  readonly grossDen: bigint | null;
};

/**
 * D-282: the one rule for which ledger rows feed the cost-gate table, live and replay. Rows of ONE
 * lineage, with that lineage's split: closed rows with a gross return whose ENTRY date falls in the
 * development split (the ledger's split rule, `splitOf`); no rows at all while the split is deferred
 * or missing (the signal is then `cost_gate_unmeasured`).
 */
export function costGateRowsOf(
  rows: readonly CostGateLedgerRow[],
  split: LineageSplitRecord | null,
): CostGateRow[] {
  if (split === null || split.deferred_until_d !== null) return [];
  const out: CostGateRow[] = [];
  for (const r of rows) {
    if (r.exitD === null || r.grossNum === null || r.grossDen === null) continue;
    if (splitOf(split, r.entryD) !== "development") continue;
    out.push({
      family: r.family,
      ruleVersion: r.ruleVersion,
      variant: r.variant,
      grossNum: r.grossNum,
      grossDen: r.grossDen,
    });
  }
  return out;
}

/**
 * The live loader of the table for a market: the stored (newest) split of each lineage and its
 * ledger rows through `costGateRowsOf`, the same function the replay runner uses (D-282).
 */
export async function loadCostGateTable(
  db: Client,
  market: string,
  minRows = 30, // threshold-ok: `cost_gate_min_rows` default; callers pass the key
): Promise<CostGateTable> {
  const res = await db.execute({
    sql: `SELECT s.family, s.rule_version, s.variant, l.entry_d, l.exit_d, l.gross_num, l.gross_den
          FROM ledger_row l JOIN signal s ON s.id = l.signal_id
          WHERE s.market = ? ORDER BY l.id`,
    args: [market],
  });
  const byFamily = new Map<Family, CostGateLedgerRow[]>();
  for (const r of res.rows) {
    const family = String(r.family) as Family;
    const list = byFamily.get(family) ?? [];
    const big = (v: unknown): bigint | null =>
      v === null || v === undefined ? null : BigInt(String(v));
    list.push({
      family,
      ruleVersion: String(r.rule_version),
      variant: String(r.variant),
      entryD: String(r.entry_d),
      exitD: r.exit_d === null ? null : String(r.exit_d),
      grossNum: big(r.gross_num),
      grossDen: big(r.gross_den),
    });
    byFamily.set(family, list);
  }
  const rows: CostGateRow[] = [];
  for (const family of [...byFamily.keys()].sort()) {
    const sp = await db.execute({
      sql: "SELECT * FROM lineage_split WHERE lineage_id = ? ORDER BY version DESC LIMIT 1",
      args: [lineageId(market, family)],
    });
    const split =
      sp.rows.length === 0 ? null : splitFromRow(sp.rows[0]! as Record<string, unknown>);
    rows.push(...costGateRowsOf(byFamily.get(family)!, split));
  }
  return costGateTable(rows, minRows);
}

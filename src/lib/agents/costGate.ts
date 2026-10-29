// FAM-005 cost gate (M14, D-214, D-215; docs/M14_design.md 2.1). WP0 SIGNATURE STUB: WP1 fills it in.
// Until then the gate is open (every signal passes) and every table is empty, so entries are as in v1.
//
// WP1 contract:
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
import type { CostProfile } from "@/lib/arena/costs";
import type { Micro } from "@/lib/money/micro";
import { makeRational, type Rational } from "@/lib/money/rational";
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

/** Medians per (family, rule version, variant). STUB: empty, so every signal is unmeasured. */
export function costGateTable(
  rows: readonly CostGateRow[],
  minRows = 30, // threshold-ok: `cost_gate_min_rows` default, WP1 passes the key
): CostGateTable {
  void rows;
  void minRows;
  return new Map();
}

/** Round-trip cost as a fraction of the notional. STUB: zero. */
export function roundTripCost(profile: CostProfile, advMicro: Micro): Rational {
  void profile;
  void advMicro;
  return makeRational(0n);
}

/** median >= k x cost, exact. STUB: always true. */
export function passesCostGate(median: Rational, cost: Rational, k: Rational): boolean {
  void median;
  void cost;
  void k;
  return true;
}

/** The live loader of the table for a market. STUB: an empty table. */
export async function loadCostGateTable(db: Client, market: string): Promise<CostGateTable> {
  void db;
  void market;
  return new Map();
}

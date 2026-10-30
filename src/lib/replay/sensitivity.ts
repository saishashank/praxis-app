// Descriptive sensitivities of the signal ledger (M14; docs/M14_design.md 2.1). Pure and exact where
// money is involved; the only float is the final return summary.
//
//   ARN-107 (D-223) `oneTickAdverse`: every closed row re-priced with ONE more adverse tick per side
//     (`tickFor`), brokerage recomputed with `feeFor`, exits unchanged (they depend on prices, not on
//     fills). Descriptive, no random draw, a post-hoc change of the fills only.
//   ARN-108 (D-224) `developmentNet`: n, mean net and the one-sided 90 % lower bound of a set of
//     development rows under P5 (the ARN-081 circular block bootstrap with the lineage's frozen block),
//     and the absolute-gate result. It is shared by the generator's view and the stability table.
import type { CostProfile } from "@/lib/arena/costs";
import { feeFor } from "@/lib/arena/costs";
import { bootstrapSeries } from "@/lib/stats/bootstrap";
import { scopedPrng } from "@/lib/stats/rng";
import { absoluteGatePasses } from "@/lib/stats/gates";
import { MIN_PRICE_MICRO, tickFor } from "@/lib/money/tick";
import type { StatsParams } from "@/lib/agents/params";
import type { LedgerEntry } from "./ledger";
import type { Fraction } from "./returns";

const CORP_ACTION_EXIT = "corp_action:"; // stated terms of a corporate-action exit: no fill to move

/**
 * Net return of a closed row with `ticks` extra adverse ticks per side (0 reproduces the ledger's
 * net exactly). A corporate-action exit has stated terms, so only its entry moves. Null while open.
 */
export function repricedNet(
  e: LedgerEntry,
  profile: CostProfile,
  ticks: number = 1, // threshold-ok: ARN-107 is one tick per side
): Fraction | null {
  const r = e.row;
  if (r.fill_out_micro === null || r.brok_out_micro === null || r.qty_out === null) return null;
  const t = BigInt(ticks);
  const qty = BigInt(r.qty);
  const qtyOut = BigInt(r.qty_out);
  const fillIn = r.fill_in_micro + t * tickFor(r.fill_in_micro);
  const brokIn = feeFor(profile, qty * fillIn, "buy");
  const corp = e.exitRule?.startsWith(CORP_ACTION_EXIT) === true;
  let fillOut = r.fill_out_micro;
  let proceeds = qtyOut * fillOut - r.brok_out_micro;
  if (!corp) {
    fillOut = r.fill_out_micro - t * tickFor(r.fill_out_micro);
    if (fillOut < MIN_PRICE_MICRO) fillOut = MIN_PRICE_MICRO; // D-184: the lowest price on the grid
    proceeds = qtyOut * fillOut - feeFor(profile, qtyOut * fillOut, "sell");
  }
  const cost = qty * fillIn + brokIn;
  return { num: proceeds + r.dividend_micro - cost, den: cost };
}

export type SlipRow = { readonly id: string; readonly net: Fraction };

/** ARN-107: the closed rows with one more adverse tick per side, in the input order. */
export function oneTickAdverse(entries: readonly LedgerEntry[], profile: CostProfile): SlipRow[] {
  const out: SlipRow[] = [];
  for (const e of entries) {
    const net = repricedNet(e, profile, 1);
    if (net !== null) out.push({ id: e.row.id, net });
  }
  return out;
}

export type DevelopmentNet = {
  readonly n: number;
  readonly blocks: number;
  readonly meanNet: number | null;
  /** One-sided 90 % lower bound of the mean net under P5; null when the rows or blocks are too few. */
  readonly netLower90: number | null;
  /** The absolute gate (ARN-081): enough rows and blocks and a lower bound above zero. */
  readonly passesAbsoluteGate: boolean;
};

export type NetRow = { readonly session: number; readonly net: number };

/**
 * Mean net and the absolute-gate result of development rows. `session` is the entry-session index
 * within the development window of `sessionCount` sessions. Seeded by `scope`: the same rows give the
 * same bound.
 */
export function developmentNet(
  rows: readonly NetRow[],
  sessionCount: number,
  block: number,
  stats: Pick<StatsParams, "bootstrapReplicationsMin" | "minTrades" | "minBlocks">,
  scope: string,
): DevelopmentNet {
  const n = rows.length;
  const blocks = block > 0 ? sessionCount / block : 0;
  if (n === 0) {
    return { n, blocks, meanNet: null, netLower90: null, passesAbsoluteGate: false };
  }
  const meanNet = rows.reduce((a, r) => a + r.net, 0) / n;
  if (n < stats.minTrades || blocks < stats.minBlocks || sessionCount < 1) {
    return { n, blocks, meanNet, netLower90: null, passesAbsoluteGate: false };
  }
  const b = bootstrapSeries(
    rows.map((r) => r.session),
    rows.map((r) => r.net),
    sessionCount,
    block,
    stats.bootstrapReplicationsMin,
    scopedPrng(`stability:${scope}`),
  );
  return {
    n,
    blocks,
    meanNet,
    netLower90: b.lower90,
    passesAbsoluteGate: absoluteGatePasses(b.lower90),
  };
}

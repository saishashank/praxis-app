// FIFO lot matching for one stream of fills (one code in one book, or one code of the Owner's log). M21 B3, D-1222.
// Exact integer micro arithmetic. Fills run in (date, id) order; a split or bonus issue on an ex-date is applied
// first on that date (it changes quantity, never cost, like `replayCostBasis`). A sale takes the oldest open shares
// first. A partly used lot gives up round_half_away(cost x shares taken / shares open); a lot used to its last
// share gives up the whole remaining cost, so cost never drifts. The sale's value and fee are split across the lots
// it closes by the same proportion, the last lot taking the remainder, so the parts add up to the whole.
import { makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { isOver12Months } from "./holding";
import { rebaseLots } from "./rebase";
import type { Disposal, Split, TaxFill, Unmatched, WrittenOff } from "./types";

export type OpenLot = {
  readonly lotId: string;
  readonly buyD: string;
  readonly qty: bigint;
  readonly costMicro: bigint;
};

export type FifoResult = {
  readonly disposals: Disposal[];
  readonly unmatched: Unmatched[];
  readonly writtenOff: WrittenOff[];
  readonly open: OpenLot[];
};

/** round_half_away(amount x num / den), once. */
export function prorata(amount: bigint, num: bigint, den: bigint): bigint {
  return roundHalfAwayFromZero(makeRational(amount * num, den));
}

type Lot = { lotId: string; buyD: string; qty: bigint; costMicro: bigint };
type Event =
  | { d: string; rank: 0; key: string; split: Split }
  | { d: string; rank: 1 | 2; key: string; fill: TaxFill };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type FifoOptions = {
  /** On one date, run the buys before the sells (the Owner's log has no order within a day). Default: by id. */
  readonly buysFirst?: boolean;
};

export function fifoMatch(
  fills: readonly TaxFill[],
  splits: readonly Split[] = [],
  options: FifoOptions = {},
): FifoResult {
  const sellRank = options.buysFirst === true ? 2 : 1;
  const events: Event[] = [
    ...splits.map((split): Event => ({ d: split.exD, rank: 0, key: split.code, split })),
    ...fills.map((fill): Event => ({
      d: fill.d,
      rank: fill.side === "sell" ? sellRank : 1,
      key: fill.id,
      fill,
    })),
  ];
  // (date, id); a split goes before the fills of its ex-date
  events.sort((a, b) => cmp(a.d, b.d) || a.rank - b.rank || cmp(a.key, b.key));
  const lots: Lot[] = [];
  const out: FifoResult = { disposals: [], unmatched: [], writtenOff: [], open: [] };

  for (const e of events) {
    if (e.rank === 0) {
      const sp = e.split;
      if (sp.closure !== undefined) {
        // A cash merger, scrip merger or delisting: every open lot closes on the ex-date for the cash the books settled,
        // spread by share count (the last lot takes the remainder). No cash at all is a write-off, not a sale.
        const total = lots.reduce((n, l) => n + l.qty, 0n);
        let allocated = 0n;
        lots.forEach((lot, i) => {
          const last = i === lots.length - 1;
          const share = last
            ? sp.closure!.proceedsMicro - allocated
            : prorata(sp.closure!.proceedsMicro, lot.qty, total);
          allocated += share;
          if (sp.closure!.proceedsMicro === 0n) {
            out.writtenOff.push({
              code: sp.code,
              lotId: lot.lotId,
              exD: e.d,
              costMicro: lot.costMicro,
            });
          } else {
            out.disposals.push({
              code: sp.code,
              sellId: `ca:${sp.closure!.actionId}`,
              lotId: lot.lotId,
              buyD: lot.buyD,
              sellD: e.d,
              qty: lot.qty,
              costMicro: lot.costMicro,
              proceedsMicro: share,
              gainMicro: share - lot.costMicro,
              over12Months: isOver12Months(lot.buyD, e.d),
            });
          }
        });
        lots.length = 0;
        continue;
      }
      // Whole shares: the lot total is the book's aggregate floor(held x ratio); a lot left with none is written off.
      const next = rebaseLots(
        lots.map((l) => l.qty),
        sp.ratio,
      );
      for (let i = lots.length - 1; i >= 0; i -= 1) {
        const lot = lots[i]!;
        lot.qty = next[i]!;
        if (lot.qty === 0n) {
          out.writtenOff.push({
            code: sp.code,
            lotId: lot.lotId,
            exD: e.d,
            costMicro: lot.costMicro,
          });
          lots.splice(i, 1);
        }
      }
      continue;
    }
    const f = e.fill;
    if (f.side === "buy") {
      lots.push({ lotId: f.id, buyD: f.d, qty: f.qty, costMicro: f.valueMicro + f.feeMicro });
      continue;
    }
    let matched = 0n;
    let valueAllocated = 0n;
    let feeAllocated = 0n;
    while (matched < f.qty && lots.length > 0) {
      const lot = lots[0]!;
      const want = f.qty - matched;
      const take = lot.qty < want ? lot.qty : want;
      const cost = take === lot.qty ? lot.costMicro : prorata(lot.costMicro, take, lot.qty);
      matched += take;
      const lastOfSale = matched === f.qty;
      const valueShare = lastOfSale
        ? f.valueMicro - valueAllocated
        : prorata(f.valueMicro, take, f.qty);
      const feeShare = lastOfSale ? f.feeMicro - feeAllocated : prorata(f.feeMicro, take, f.qty);
      valueAllocated += valueShare;
      feeAllocated += feeShare;
      const proceeds = valueShare - feeShare;
      out.disposals.push({
        code: f.code,
        sellId: f.id,
        lotId: lot.lotId,
        buyD: lot.buyD,
        sellD: f.d,
        qty: take,
        costMicro: cost,
        proceedsMicro: proceeds,
        gainMicro: proceeds - cost,
        over12Months: isOver12Months(lot.buyD, f.d),
      });
      lot.qty -= take;
      lot.costMicro -= cost;
      if (lot.qty === 0n) lots.shift();
    }
    if (matched < f.qty) {
      out.unmatched.push({ code: f.code, sellId: f.id, sellD: f.d, qty: f.qty - matched });
    }
  }
  out.open.push(...lots.map((l) => ({ ...l })));
  return out;
}

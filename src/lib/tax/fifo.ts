// FIFO lot matching for one stream of fills (one code in one book, or one code of the Owner's log). M21 B3, D-1222.
// Exact integer micro arithmetic. Fills run in (date, id) order; a split or bonus issue on an ex-date is applied
// first on that date (it changes quantity, never cost, like `replayCostBasis`). A sale takes the oldest open shares
// first. A partly used lot gives up round_half_away(cost x shares taken / shares open); a lot used to its last
// share gives up the whole remaining cost, so cost never drifts. The sale's value and fee are split across the lots
// it closes by the same proportion, the last lot taking the remainder, so the parts add up to the whole.
import { makeRational, mulRat } from "@/lib/money/rational";
import { floorRat, roundHalfAwayFromZero } from "@/lib/money/round";
import { isOver12Months } from "./holding";
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
  | { d: string; rank: 1; key: string; fill: TaxFill };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function fifoMatch(fills: readonly TaxFill[], splits: readonly Split[] = []): FifoResult {
  const events: Event[] = [
    ...splits.map((split): Event => ({ d: split.exD, rank: 0, key: split.code, split })),
    ...fills.map((fill): Event => ({ d: fill.d, rank: 1, key: fill.id, fill })),
  ];
  // (date, id); a split goes before the fills of its ex-date
  events.sort((a, b) => cmp(a.d, b.d) || a.rank - b.rank || cmp(a.key, b.key));
  const lots: Lot[] = [];
  const out: FifoResult = { disposals: [], unmatched: [], writtenOff: [], open: [] };

  for (const e of events) {
    if (e.rank === 0) {
      // Whole shares, rounded down; a dropped fraction keeps its cost in the lot (no invented gain).
      for (let i = lots.length - 1; i >= 0; i -= 1) {
        const lot = lots[i]!;
        lot.qty = floorRat(mulRat(makeRational(lot.qty), e.split.ratio));
        if (lot.qty === 0n) {
          out.writtenOff.push({
            code: e.split.code,
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

// Specific-lot disposals (M21 B3; ARN-122, D-1222): one lot per paper `trade` row that has an exit fill. The paper book
// records which buy a sale closes (the trade row), so this is the choice the book actually made.
//   cost     = entry value + entry brokerage          proceeds = exit value - exit brokerage
// Splits and bonus issues between entry and exit change the share count, never the cost (decision 14); the shares
// shown are the ones sold. A trade closed with no exit fill (`legacy`, a suspended holding, ARN-026) has no sale
// price: it is listed as "closed without a sale price" and has no gain. An open trade is not realised and is left out.
import { isOver12Months } from "./holding";
import type { BookTrade, ClosedWithoutPrice, Disposal } from "./types";

export type SpecificResult = {
  readonly disposals: Disposal[];
  readonly closedWithoutPrice: ClosedWithoutPrice[];
};

export function specificLots(trades: readonly BookTrade[]): SpecificResult {
  const disposals: Disposal[] = [];
  const closedWithoutPrice: ClosedWithoutPrice[] = [];
  const ordered = [...trades].sort((a, b) =>
    a.entry.d !== b.entry.d
      ? a.entry.d < b.entry.d
        ? -1
        : 1
      : a.tradeId < b.tradeId
        ? -1
        : a.tradeId > b.tradeId
          ? 1
          : 0,
  );
  for (const t of ordered) {
    const cost = t.entry.valueMicro + t.entry.feeMicro;
    if (t.exit === null) {
      if (t.legacy) {
        closedWithoutPrice.push({
          executionId: t.executionId,
          code: t.code,
          buyD: t.entry.d,
          costMicro: cost,
        });
      }
      continue;
    }
    const proceeds = t.exit.valueMicro - t.exit.feeMicro;
    disposals.push({
      code: t.code,
      sellId: t.exit.id,
      lotId: t.entry.id,
      buyD: t.entry.d,
      sellD: t.exit.d,
      qty: t.exit.qty,
      costMicro: cost,
      proceedsMicro: proceeds,
      gainMicro: proceeds - cost,
      over12Months: isOver12Months(t.entry.d, t.exit.d),
    });
  }
  return { disposals, closedWithoutPrice };
}

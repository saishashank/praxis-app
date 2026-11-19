// Specific-lot disposals (M21 B3; ARN-122, D-1222): one lot per paper `trade` row that has an exit fill. The paper book
// records which buy a sale closes (the trade row), so this is the choice the book actually made.
//   cost     = entry value + entry brokerage          proceeds = exit value - exit brokerage
// Splits and bonus issues between entry and exit change the share count, never the cost (decision 14); the shares
// shown are the ones sold. A trade closed with no exit fill (`legacy`, a suspended holding, ARN-026) has no sale
// price: it is listed as "closed without a sale price" and has no gain. An open trade is not realised.
// A cash merger, scrip merger or delisting closes the holding with no sale fill (the books settle cash through a
// `ca_dispose` entry): each trade still open on that ex-date is a disposal on the ex-date, its proceeds the settled cash
// spread by share count, its cost its own cost (D-1267).
import { isOver12Months } from "./holding";
import { prorata } from "./fifo";
import { rebaseLots } from "./rebase";
import type { BookTrade, ClosedWithoutPrice, Disposal, Split } from "./types";

export type SpecificResult = {
  readonly disposals: Disposal[];
  readonly closedWithoutPrice: ClosedWithoutPrice[];
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function specificLots(
  trades: readonly BookTrade[],
  splitsFor: (cohortId: string, code: string) => readonly Split[] = () => [],
): SpecificResult {
  const disposals: Disposal[] = [];
  const closedWithoutPrice: ClosedWithoutPrice[] = [];
  const ordered = [...trades].sort(
    (a, b) => cmp(a.entry.d, b.entry.d) || cmp(a.tradeId, b.tradeId),
  );
  for (const t of ordered) {
    const cost = t.entry.valueMicro + t.entry.feeMicro;
    if (t.exit === null) {
      if (t.legacy) {
        closedWithoutPrice.push({
          executionId: t.executionId,
          code: t.code,
          buyD: t.entry.d,
          closedD: t.legacyD ?? t.entry.d,
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

  // closures (cash merger, scrip merger, delisting), per cohort and code
  const groups = new Map<string, BookTrade[]>();
  for (const t of ordered) {
    if (t.legacy) continue;
    const k = `${t.cohortId}\u0000${t.code}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const [k, group] of groups) {
    const cohortId = k.slice(0, k.indexOf("\u0000"));
    const splits = [...splitsFor(cohortId, group[0]!.code)].sort((a, b) => cmp(a.exD, b.exD));
    const done = new Set<string>();
    for (const c of splits) {
      if (c.closure === undefined || c.closure.proceedsMicro === 0n) continue;
      const open = group.filter(
        (t) => t.exit === null && !done.has(t.tradeId) && t.entry.d < c.exD,
      );
      if (open.length === 0) continue;
      const qtys = open.map((t) => t.entry.qty);
      for (const s of splits) {
        if (s.closure !== undefined || s.exD >= c.exD) continue;
        const idx = open.map((t, i) => (t.entry.d < s.exD ? i : -1)).filter((i) => i >= 0);
        const next = rebaseLots(
          idx.map((i) => qtys[i]!),
          s.ratio,
        );
        idx.forEach((i, j) => (qtys[i] = next[j]!));
      }
      const total = qtys.reduce((a, q) => a + q, 0n);
      let allocated = 0n;
      open.forEach((t, i) => {
        const share =
          i === open.length - 1
            ? c.closure!.proceedsMicro - allocated
            : prorata(c.closure!.proceedsMicro, qtys[i]!, total);
        allocated += share;
        const cost = t.entry.valueMicro + t.entry.feeMicro;
        done.add(t.tradeId);
        disposals.push({
          code: t.code,
          sellId: `ca:${c.closure!.actionId}`,
          lotId: t.entry.id,
          buyD: t.entry.d,
          sellD: c.exD,
          qty: qtys[i]!,
          costMicro: cost,
          proceedsMicro: share,
          gainMicro: share - cost,
          over12Months: isOver12Months(t.entry.d, c.exD),
        });
      });
    }
  }
  return { disposals, closedWithoutPrice };
}

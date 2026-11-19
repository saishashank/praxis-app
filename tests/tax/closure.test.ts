// @vitest-environment node
// M21 B3 review fixes (D-1267, D-1268): the lot re-base equals the book's aggregate re-base, a cash takeover is a sale in
// both columns, and a same-day buy runs before a sale in the log.
import { describe, expect, it } from "vitest";
import { rebaseQty } from "@/lib/arena/ledger";
import { makeRational } from "@/lib/money/rational";
import { fifoMatch } from "@/lib/tax/fifo";
import { specificLots } from "@/lib/tax/lots";
import { rebaseLots } from "@/lib/tax/rebase";
import type { BookTrade, Split, TaxFill } from "@/lib/tax/types";

const fill = (
  id: string,
  d: string,
  side: "buy" | "sell",
  qty: number,
  value: number,
): TaxFill => ({
  id,
  d,
  code: "ZZ1",
  side,
  qty: BigInt(qty),
  valueMicro: BigInt(value),
  feeMicro: 0n,
});

const takeover = (cash: bigint, d = "2025-10-15"): Split => ({
  code: "ZZ1",
  exD: d,
  ratio: makeRational(0n),
  closure: { actionId: "20", proceedsMicro: cash },
});

describe("lot re-base equals the aggregate re-base", () => {
  it("2 lots of 3 shares and a 1:2 consolidation: the lot total is rebaseQty of 6", () => {
    const lots = rebaseLots([3n, 3n], makeRational(1n, 2n));
    expect(lots.reduce((a, q) => a + q, 0n)).toBe(rebaseQty(6n, makeRational(1n, 2n))); // 3
    expect(lots).toEqual([2n, 1n]); // equal dropped fractions: the oldest lot takes the spare share
  });
  it("the largest dropped fraction takes the spare share first", () => {
    // 1:3 of 4 and 5: floors 1 and 1 (fractions 1/3 and 2/3); 9 x 1/3 = 3, so the spare share goes to the 2/3 lot
    expect(rebaseLots([4n, 5n], makeRational(1n, 3n))).toEqual([1n, 2n]);
  });
  it("a split is exact and a zero ratio leaves nothing", () => {
    expect(rebaseLots([3n, 5n], makeRational(2n, 1n))).toEqual([6n, 10n]);
    expect(rebaseLots([3n], makeRational(0n))).toEqual([0n]);
  });
  it("FIFO uses it: a consolidation of two 3-share lots leaves 2 + 1 with the cost unchanged", () => {
    const r = fifoMatch(
      [fill("a", "2025-01-02", "buy", 3, 3_000_000), fill("b", "2025-01-03", "buy", 3, 6_000_000)],
      [{ code: "ZZ1", exD: "2025-02-01", ratio: makeRational(1n, 2n) }],
    );
    expect(r.open.map((l) => [l.qty, l.costMicro])).toEqual([
      [2n, 3_000_000n],
      [1n, 6_000_000n],
    ]);
  });
});

describe("a cash takeover", () => {
  it("1 share bought at 10.00 and taken over at 12.00 is a gain of 2.00, not a write-off", () => {
    const r = fifoMatch([fill("b", "2025-08-10", "buy", 1, 10_000_000)], [takeover(12_000_000n)]);
    expect(r.disposals[0]).toMatchObject({
      sellId: "ca:20",
      sellD: "2025-10-15",
      costMicro: 10_000_000n,
      proceedsMicro: 12_000_000n,
      gainMicro: 2_000_000n,
    });
    expect(r.writtenOff).toEqual([]);
    expect(r.open).toEqual([]);
  });
  it("cash spreads over the open lots by share count; the last lot takes the remainder", () => {
    const r = fifoMatch(
      [
        fill("b1", "2025-01-02", "buy", 1, 1_000_000),
        fill("b2", "2025-01-03", "buy", 2, 2_000_000),
      ],
      [takeover(3_000_001n, "2025-02-01")],
    );
    expect(r.disposals.map((d) => d.proceedsMicro)).toEqual([1_000_000n, 2_000_001n]);
  });
  it("no cash at all is a write-off with its cost, not a sale", () => {
    const r = fifoMatch([fill("b", "2025-01-02", "buy", 1, 1_000_000)], [takeover(0n)]);
    expect(r.disposals).toEqual([]);
    expect(r.writtenOff).toEqual([
      { code: "ZZ1", lotId: "b", exD: "2025-10-15", costMicro: 1_000_000n },
    ]);
  });
  it("the specific-lot column gives the same sale for a trade still open on the ex-date", () => {
    const t: BookTrade = {
      tradeId: "t",
      cohortId: "c",
      executionId: "E",
      code: "ZZ1",
      entry: fill("b", "2025-08-10", "buy", 1, 10_000_000),
      exit: null,
      legacy: false,
    };
    const r = specificLots([t], () => [takeover(12_000_000n)]);
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0]).toMatchObject({ gainMicro: 2_000_000n, sellD: "2025-10-15" });
  });
});

describe("same day in the log", () => {
  it("buysFirst runs a buy before a sale that sorts earlier", () => {
    const f = [
      fill("a-sell", "2025-03-05", "sell", 1, 2_000_000),
      fill("z-buy", "2025-03-05", "buy", 1, 1_000_000),
    ];
    expect(fifoMatch(f).unmatched).toHaveLength(1);
    expect(fifoMatch(f, [], { buysFirst: true }).unmatched).toHaveLength(0);
  });
});

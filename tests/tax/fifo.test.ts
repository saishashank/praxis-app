// @vitest-environment node
// M21 B3 (ARN-122, D-1222): FIFO lot matching. Every figure is worked out by hand in the comments (micro units).
import { describe, expect, it } from "vitest";
import { makeRational } from "@/lib/money/rational";
import { fifoMatch, prorata } from "@/lib/tax/fifo";
import type { TaxFill } from "@/lib/tax/types";

const fill = (
  id: string,
  d: string,
  side: "buy" | "sell",
  qty: number,
  value: number,
  fee = 0,
  code = "ZZ1",
): TaxFill => ({
  id,
  d,
  code,
  side,
  qty: BigInt(qty),
  valueMicro: BigInt(value),
  feeMicro: BigInt(fee),
});

describe("prorata", () => {
  it("rounds half away from zero, once", () => {
    expect(prorata(3_000_001n, 2n, 3n)).toBe(2_000_001n); // 2_000_000.67
    expect(prorata(5n, 1n, 2n)).toBe(3n); // 2.5 -> 3
    expect(prorata(7n, 1n, 2n)).toBe(4n); // 3.5 -> 4
  });
});

describe("FIFO", () => {
  it("multiple buys and a partial sale: the oldest shares go first, cost moves pro rata", () => {
    // buy A 100 for 1_010_000_000 (1000.00 + 10.00 fee); buy B 50 for 606_000_000
    // sell 50: all from A: cost 1_010_000_000 x 50/100 = 505_000_000; proceeds 750_000_000 - 7_500_000
    // sell 100: A has 50 left (cost 505_000_000, the whole remainder), then B 50 (cost 606_000_000);
    //   value 1_400_000_000 splits 700_000_000 + 700_000_000, fee 14_000_000 splits 7_000_000 + 7_000_000
    const r = fifoMatch([
      fill("a", "2025-08-01", "buy", 100, 1_000_000_000, 10_000_000),
      fill("b", "2025-09-01", "buy", 50, 600_000_000, 6_000_000),
      fill("s1", "2025-10-01", "sell", 50, 750_000_000, 7_500_000),
      fill("s2", "2025-11-03", "sell", 100, 1_400_000_000, 14_000_000),
    ]);
    expect(
      r.disposals.map((d) => [d.sellId, d.lotId, d.qty, d.costMicro, d.proceedsMicro, d.gainMicro]),
    ).toEqual([
      ["s1", "a", 50n, 505_000_000n, 742_500_000n, 237_500_000n],
      ["s2", "a", 50n, 505_000_000n, 693_000_000n, 188_000_000n],
      ["s2", "b", 50n, 606_000_000n, 693_000_000n, 87_000_000n],
    ]);
    expect(r.unmatched).toEqual([]);
    expect(r.open).toEqual([]);
  });

  it("cost never drifts: the last share of a lot takes the remainder", () => {
    // 3 shares cost 3_000_000 + 1 fee = 3_000_001. Sell 2: 3_000_001 x 2/3 = 2_000_000.67 -> 2_000_001.
    // Remaining 1 share carries 3_000_001 - 2_000_001 = 1_000_000 and is taken whole by the next sale.
    // sell 2 for 2_400_000 less fee 1 = 2_399_999: gain 399_998. sell 1 for 1_100_000: gain 100_000.
    const r = fifoMatch([
      fill("b", "2025-01-02", "buy", 3, 3_000_000, 1),
      fill("s1", "2025-01-03", "sell", 2, 2_400_000, 1),
      fill("s2", "2025-01-04", "sell", 1, 1_100_000),
    ]);
    expect(r.disposals.map((d) => [d.costMicro, d.proceedsMicro, d.gainMicro])).toEqual([
      [2_000_001n, 2_399_999n, 399_998n],
      [1_000_000n, 1_100_000n, 100_000n],
    ]);
    expect(r.disposals.reduce((a, d) => a + d.costMicro, 0n)).toBe(3_000_001n);
  });

  it("a sale across lots splits its value and fee so the parts add up", () => {
    // lots of 1 (cost 1_000_000) and 2 (cost 2_000_000); one sale of 3 for 3_300_000 with fee 100
    // chunk 1: value 3_300_000 x 1/3 = 1_100_000, fee 100 x 1/3 = 33.33 -> 33; proceeds 1_099_967
    // chunk 2 (last): value 3_300_000 - 1_100_000 = 2_200_000, fee 100 - 33 = 67; proceeds 2_199_933
    const r = fifoMatch([
      fill("b1", "2025-01-02", "buy", 1, 1_000_000),
      fill("b2", "2025-01-03", "buy", 2, 2_000_000),
      fill("s", "2025-02-01", "sell", 3, 3_300_000, 100),
    ]);
    expect(r.disposals.map((d) => d.proceedsMicro)).toEqual([1_099_967n, 2_199_933n]);
    expect(r.disposals.reduce((a, d) => a + d.proceedsMicro, 0n)).toBe(3_300_000n - 100n);
  });

  it("a split on an ex-date changes quantity, not cost", () => {
    // 10 shares cost 50_000_000; 1:2 split on 2025-08-20 -> 20 shares, same cost. Sell 15 on 09-15 for 45_000_000:
    // cost 50_000_000 x 15/20 = 37_500_000, gain 7_500_000; 5 shares left carrying 12_500_000
    const r = fifoMatch(
      [
        fill("b", "2025-07-10", "buy", 10, 50_000_000),
        fill("s", "2025-09-15", "sell", 15, 45_000_000),
      ],
      [{ code: "ZZ1", exD: "2025-08-20", ratio: makeRational(2n, 1n) }],
    );
    expect(r.disposals).toHaveLength(1);
    expect(r.disposals[0]).toMatchObject({
      qty: 15n,
      costMicro: 37_500_000n,
      gainMicro: 7_500_000n,
    });
    expect(r.open).toEqual([{ lotId: "b", buyD: "2025-07-10", qty: 5n, costMicro: 12_500_000n }]);
  });

  it("a buy ON the ex-date is not re-based; a split after the sale does not touch it", () => {
    const r = fifoMatch(
      [
        fill("b1", "2025-08-01", "buy", 10, 10_000_000),
        fill("b2", "2025-08-20", "buy", 4, 4_000_000),
      ],
      [{ code: "ZZ1", exD: "2025-08-20", ratio: makeRational(2n, 1n) }],
    );
    expect(r.open.map((l) => [l.lotId, l.qty])).toEqual([
      ["b1", 20n],
      ["b2", 4n],
    ]);
  });

  it("a consolidation drops a fraction but keeps its cost; a zero result writes the lot off", () => {
    const r = fifoMatch(
      [fill("b", "2025-01-02", "buy", 5, 5_000_000), fill("c", "2025-01-02", "buy", 1, 1_000_000)],
      [{ code: "ZZ1", exD: "2025-02-01", ratio: makeRational(1n, 2n) }],
    );
    // 5 x 1/2 = 2.5 -> 2 shares, cost 5_000_000 stays; 1 x 1/2 = 0.5 -> 0: written off with its cost
    expect(r.open).toEqual([{ lotId: "b", buyD: "2025-01-02", qty: 2n, costMicro: 5_000_000n }]);
    expect(r.writtenOff).toEqual([
      { code: "ZZ1", lotId: "c", exD: "2025-02-01", costMicro: 1_000_000n },
    ]);
  });

  it("a sale with no earlier buy is flagged, never given a cost; a short cover is partly matched", () => {
    const none = fifoMatch([fill("s", "2025-01-02", "sell", 5, 5_000_000)]);
    expect(none.disposals).toEqual([]);
    expect(none.unmatched).toEqual([{ code: "ZZ1", sellId: "s", sellD: "2025-01-02", qty: 5n }]);
    // buy 2, sell 5: 2 matched, 3 flagged. The matched part takes its share of the value: 5_000_000 x 2/5 = 2_000_000
    const part = fifoMatch([
      fill("b", "2025-01-01", "buy", 2, 2_000_000),
      fill("s", "2025-01-02", "sell", 5, 5_000_000),
    ]);
    expect(part.disposals.map((d) => [d.qty, d.proceedsMicro, d.gainMicro])).toEqual([
      [2n, 2_000_000n, 0n],
    ]);
    expect(part.unmatched[0]!.qty).toBe(3n);
  });

  it("ties on the date break by id, whatever order the fills arrive in", () => {
    const fills = [
      fill("s", "2025-03-01", "sell", 1, 2_000_000),
      fill("b2", "2025-03-01", "buy", 1, 1_500_000),
      fill("b1", "2025-02-01", "buy", 1, 1_000_000),
    ];
    const a = fifoMatch(fills);
    const b = fifoMatch([...fills].reverse());
    expect(a).toEqual(b);
    expect(a.disposals[0]!.lotId).toBe("b1"); // the older buy goes first
    // same day: "a-buy" sorts before "b-sell", so the buy is there when the sale runs; "z-buy" would not be
    const same = fifoMatch([
      fill("b-sell", "2025-03-05", "sell", 1, 2_000_000),
      fill("a-buy", "2025-03-05", "buy", 1, 1_000_000),
    ]);
    expect(same.disposals).toHaveLength(1);
    const later = fifoMatch([
      fill("a-sell", "2025-03-05", "sell", 1, 2_000_000),
      fill("z-buy", "2025-03-05", "buy", 1, 1_000_000),
    ]);
    expect(later.unmatched).toHaveLength(1);
  });

  it("a loss is negative and carries no float", () => {
    const r = fifoMatch([
      fill("b", "2025-01-01", "buy", 1, 2_000_000, 5),
      fill("s", "2025-01-02", "sell", 1, 1_000_000, 5),
    ]);
    expect(r.disposals[0]!.gainMicro).toBe(1_000_000n - 5n - 2_000_005n);
  });
});

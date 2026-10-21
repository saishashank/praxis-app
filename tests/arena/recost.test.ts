// @vitest-environment node
// Cost-profile re-cost and price-shock arithmetic (M7 T4, decision 52 / D-132 draft; UX-022, UXN-152).
// Known answers are worked by hand in A$ from ARN-031/032 (see the comments), not computed by the
// code under test. Money is bigint micro-AUD throughout.
import { describe, expect, it } from "vitest";
import { getCostProfile } from "@/lib/arena/costs";
import {
  recostCohortDay,
  shockCohortDay,
  widenBuckets,
  type RecostFill,
  type RecostInput,
} from "@/lib/arena/recost";
import { SLIPPAGE_BUCKETS } from "@/lib/arena/slippage";
import { makeRational } from "@/lib/money/rational";

const A = (dollars: number, cents = 0): bigint =>
  BigInt(dollars) * 1_000_000n + BigInt(cents) * 10_000n;
const ADV = 5_000_000_000_000n; // A$5M: the 10 bps bucket

// Buy 99 shares, reference A$10.00, stored fill A$10.01 (10 bps up on the A$0.01 tick): value A$990.99.
// Sell 99 shares, reference A$20.00, stored fill A$19.98: value A$1,978.02. Stored profile P5: A$5 and A$10.
const buy: RecostFill = {
  id: "f1",
  d: "2026-10-05",
  code: "ZZA",
  side: "buy",
  qty: 99n,
  valueMicro: A(990, 99),
  brokerageMicro: A(5),
  refPriceMicro: A(10),
  fillPriceMicro: A(10, 1),
  advMicro: ADV,
};
const sell: RecostFill = {
  id: "f2",
  d: "2026-10-07",
  code: "ZZA",
  side: "sell",
  qty: 99n,
  valueMicro: A(1_978, 2),
  brokerageMicro: A(10),
  refPriceMicro: A(20),
  fillPriceMicro: A(19, 98),
  advMicro: ADV,
};

const base = (over: Partial<RecostInput> = {}): RecostInput => ({
  cohortProfile: getCostProfile("P5"),
  tickCrossFactor: makeRational(1n),
  storedNavMicro: A(600),
  storedLiqNavMicro: A(600),
  fills: [buy, sell],
  positions: [],
  stressProfile: getCostProfile("P3"),
  stressBuckets: widenBuckets(SLIPPAGE_BUCKETS, 50n),
  ...over,
});
const byKey = (r: ReturnType<typeof recostCohortDay>) => new Map(r.map((x) => [x.key, x]));

describe("re-cost known answers", () => {
  // Fees per side (buy / sell) from ARN-031, A$:
  //   P0 = P1 3 / 3 | P2 buy 990.99 < 1,000 is the first buy of the day: 0 / sell max(11, 0.10% = 1.98) = 11
  //   P3 6.50 / 6.50 | P4 0.03% = 0.297 and 0.593, min 3 -> 3 / 3
  //   P5 <= 1,000: 5 / <= 3,000: 10 | P5b <= 1,000: 2 / 0.20% of 1,978.02 = 3.95604
  // NAV change = stored fees (15) - fees under the profile.
  const expected: Record<string, bigint> = {
    P0: A(600) + A(9),
    P1: A(600) + A(9),
    P2: A(600) + A(4),
    P3: A(600) + A(2),
    P4: A(600) + A(9),
    P5: A(600),
    P5b: A(600) + 9_043_960n, // 15 - (2 + 3.956040) = 9.043960
  };
  it("matches the hand-worked NAV under every profile", () => {
    const r = byKey(recostCohortDay(base()));
    for (const [k, nav] of Object.entries(expected)) {
      expect(r.get(k as never)!.navMicro, k).toBe(nav);
      expect(r.get(k as never)!.liqNavMicro, k).toBe(nav);
    }
  });

  it("total fees: P2 pays 11 (the sell), P5b pays 5.95604", () => {
    const r = byKey(recostCohortDay(base()));
    expect(r.get("P2")!.feesMicro).toBe(A(11));
    expect(r.get("P5b")!.feesMicro).toBe(5_956_040n);
    expect(r.get("P5")!.feesMicro).toBe(A(15));
  });

  it("re-costing under the cohort's own profile gives the stored figures back", () => {
    const r = byKey(
      recostCohortDay(base({ storedNavMicro: 123_456_789n, storedLiqNavMicro: 100n })),
    );
    expect(r.get("P5")!.navMicro).toBe(123_456_789n);
    expect(r.get("P5")!.liqNavMicro).toBe(100n);
  });

  it("the order of the fills in the input does not matter", () => {
    const a = recostCohortDay(base());
    const b = recostCohortDay(base({ fills: [sell, buy] }));
    expect(b).toEqual(a);
  });

  // Stress = P3 and slippage +50 % (10 -> 15 bps): buy 10.00 -> 10.015 rounds up to 10.02 (+0.01),
  // sell 20.00 -> 19.97 (-0.01); values 991.98 and 1,977.03; cash -0.99 and -0.99; fees 6.50 + 6.50.
  // NAV = 600 + (15 - 13) - 1.98 = 600.02.
  it("stress: P3 fees and the wider slippage move cash by the extra price", () => {
    const s = byKey(recostCohortDay(base())).get("stress")!;
    expect(s.feesMicro).toBe(A(13));
    expect(s.navMicro).toBe(A(600) + 20_000n);
  });

  // An open position of 99 shares closing at A$20.00 (ADV A$5M): the sell fill is 19.98, value 1,978.02,
  // P5 sale fee 10 / P1 fee 3. Liquidation NAV under P1 is 7 higher than under P5; a frozen position
  // (haircut or suspended) does not change with the profile.
  it("liquidation NAV re-prices the sale of each open position", () => {
    const pos = { code: "ZZB", qty: 99n, closeMicro: A(20), advMicro: ADV, frozen: false };
    const stored = A(700);
    const liq = stored - A(10) - (99n * A(20) - A(1_978, 2)); // sale cost: slippage 1.98 + fee 10 (P5)
    const r = byKey(
      recostCohortDay(
        base({ fills: [], storedNavMicro: stored, storedLiqNavMicro: liq, positions: [pos] }),
      ),
    );
    expect(r.get("P5")!.liqNavMicro).toBe(liq);
    expect(r.get("P1")!.liqNavMicro).toBe(liq + A(7));
    expect(r.get("P1")!.navMicro).toBe(stored);
    const frozen = byKey(
      recostCohortDay(
        base({
          fills: [],
          storedNavMicro: stored,
          storedLiqNavMicro: liq,
          positions: [{ ...pos, frozen: true }],
        }),
      ),
    );
    expect(frozen.get("P1")!.liqNavMicro).toBe(liq);
  });

  it("P2 gives only the first buy of a security in a day the free ride", () => {
    const second: RecostFill = {
      ...buy,
      id: "f1b",
      qty: 50n,
      valueMicro: A(500, 50),
      brokerageMicro: A(5),
    };
    const r = byKey(recostCohortDay(base({ fills: [buy, second] })));
    // first buy free; the second buy pays max(11, 0.10% x 500.50) = 11
    expect(r.get("P2")!.feesMicro).toBe(A(11));
    const other = byKey(recostCohortDay(base({ fills: [buy, { ...second, code: "ZZC" }] })));
    expect(other.get("P2")!.feesMicro).toBe(0n); // a different security: its own first buy
  });
});

describe("price shocks", () => {
  // positions worth 1,000.000005 and 333.333333: 10 % = 100.0000005 -> 100.000001 (half away) and
  // 33.3333333 -> 33.333333; 20 % = 200.000001 and 66.6666666 -> 66.666667; 30 % = 300.0000015 -> 300.000002
  // and 99.9999999 -> 100.000000.
  const values = [1_000_000_005n, 333_333_333n];
  it("sums per-position amounts rounded once half away from zero, symmetric in sign", () => {
    const r = shockCohortDay(values, A(1_500));
    const pnl = new Map(r.map((x) => [x.pct, x.pnlMicro]));
    expect(pnl.get(10)).toBe(133_333_334n);
    expect(pnl.get(-10)).toBe(-133_333_334n);
    expect(pnl.get(20)).toBe(266_666_668n);
    expect(pnl.get(-20)).toBe(-266_666_668n);
    expect(pnl.get(30)).toBe(400_000_002n);
    expect(pnl.get(-30)).toBe(-400_000_002n);
    expect(r[0]!.navAfterMicro).toBe(A(1_500) - 400_000_002n);
    expect(r.every((x) => x.valueMicro === 1_333_333_338n)).toBe(true);
  });
  it("no open positions: zero P&L and the NAV unchanged", () => {
    for (const s of shockCohortDay([], A(600))) {
      expect(s.pnlMicro).toBe(0n);
      expect(s.navAfterMicro).toBe(A(600));
    }
  });
});

// @vitest-environment node
// Entry sizing (spec 05 ARN-023, ARN-024, ARN-024a, ARN-013; M3 T5). HIGH-RISK money maths: every
// expected value is hand-computed in micro-AUD (A$1.00 = 1_000_000) and written as a literal.
// Common setup: P5 brokerage (A$5.00 up to A$1,000.00), ADV A$5M (10 bps), tick A$0.01 from A$2.00.
import { describe, expect, it } from "vitest";
import { COST_PROFILES, feeFor, type CostProfile } from "@/lib/arena/costs";
import {
  isParcelOnlyRejection,
  MIN_MARKETABLE_PARCEL_MICRO,
  rejectReasonText,
  resizeEntryAtFill,
  sizeEntry,
  stallFloorMicro,
  type SizingInput,
} from "@/lib/arena/sizing";
import { makeRational } from "@/lib/money/rational";

const BASE: SizingInput = {
  settledCashMicro: 600_000_000n,
  navMicro: 600_000_000n,
  refPriceMicro: 9_800_000n, // fill 9_810_000 (A$9.81): 10 bps = 9_800 < one tick = 10_000
  advValueMicro: 5_000_000_000_000n,
  adv20Shares: 1_000_000_000n,
  tier: "U1",
  profile: COST_PROFILES.P5,
};
const size = (over: Partial<SizingInput> = {}) => sizeEntry({ ...BASE, ...over });

describe("accepted entry (spec Acceptance l.137: A$600 at A$9.80 buys 60 shares)", () => {
  it("sizes 60 shares and reports every intermediate", () => {
    const r = size();
    expect(r.accepted).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.fillPriceMicro).toBe(9_810_000n);
    expect(r.slipMicro).toBe(10_000n);
    expect(r.bufferMicro).toBe(6_000_000n); // 1% of NAV
    expect(r.preBrokerageMicro).toBe(594_000_000n);
    expect(r.estBrokerageMicro).toBe(5_000_000n);
    expect(r.deployableMicro).toBe(589_000_000n);
    expect(r.qty).toBe(60n); // 589_000_000 / 9_810_000 = 60.04; 61 x 9_810_000 = 598_410_000
    expect(r.orderValueMicro).toBe(588_600_000n);
    expect(r.brokerageMicro).toBe(5_000_000n);
    expect(r.totalCostMicro).toBe(593_600_000n);
    expect(r.cashAfterMicro).toBe(6_400_000n);
    expect(r.capShares).toBe(10_000_000n);
    expect(r.untradeable).toBeNull();
  });

  it("a sleeve margin to be moved comes off the deployable cash first (ARN-003, ARN-024a)", () => {
    // 620_000_000 - 20_000_000 margin - 6_000_000 buffer = 594_000_000, the same as above.
    const r = size({ settledCashMicro: 620_000_000n, sleeveMarginMicro: 20_000_000n });
    expect(r.preBrokerageMicro).toBe(594_000_000n);
    expect(r.qty).toBe(60n);
    expect(r.cashAfterMicro).toBe(6_400_000n); // 620_000_000 - 20_000_000 - 593_600_000
  });

  it("slippage is not reserved twice: a larger tick factor changes only the expected fill", () => {
    // factor 2: slip = max(9_800, 2 x 10_000) = 20_000, fill 9_820_000; 589_000_000 / 9_820_000 = 59.98.
    const r = size({ tickCrossFactor: makeRational(2n) });
    expect(r.fillPriceMicro).toBe(9_820_000n);
    expect(r.qty).toBe(59n); // 59 x 9_820_000 = 579_380_000; 60 x = 589_200_000 > 589_000_000
    expect(r.deployableMicro).toBe(589_000_000n);
  });

  it("uses supplied slippage buckets", () => {
    // one bucket of 100 bps: slip 98_000, raw 9_898_000, ceil to the A$0.01 grid = 9_900_000.
    const r = size({ buckets: [{ fromAdvMicro: 0n, bps: makeRational(100n) }] });
    expect(r.fillPriceMicro).toBe(9_900_000n);
    expect(r.qty).toBe(59n); // 59 x 9_900_000 = 584_100_000; 60 x = 594_000_000 > 589_000_000
  });

  it("uses a supplied buffer rate", () => {
    const r = size({ cashBuffer: makeRational(0n) });
    expect(r.bufferMicro).toBe(0n);
    expect(r.preBrokerageMicro).toBe(600_000_000n);
    expect(r.deployableMicro).toBe(595_000_000n); // P5 on A$600.00 is A$5.00
    expect(r.qty).toBe(60n); // 61 x 9_810_000 = 598_410_000 > 595_000_000
  });

  it("rounds the buffer once, half away from zero", () => {
    // 1% of 150 micro = 1.5 -> 2; of 149 = 1.49 -> 1.
    expect(size({ navMicro: 150n, settledCashMicro: 600_000_000n }).bufferMicro).toBe(2n);
    expect(size({ navMicro: 149n, settledCashMicro: 600_000_000n }).bufferMicro).toBe(1n);
  });

  it("passes fee context to both brokerage figures (P2 free first buy under A$1,000)", () => {
    // NAV 0 -> no buffer. Without context P2 charges max(A$11.00, 0.10%) = 11_000_000 on A$600.
    const without = size({ profile: COST_PROFILES.P2, navMicro: 0n });
    expect(without.estBrokerageMicro).toBe(11_000_000n);
    expect(without.deployableMicro).toBe(589_000_000n);
    expect(without.qty).toBe(60n);
    // First buy of the day under A$1,000.00 pays nothing: deployable 600_000_000 -> 61 shares.
    const free = size({
      profile: COST_PROFILES.P2,
      navMicro: 0n,
      feeContext: { firstBuyOfSecurityToday: true },
    });
    expect(free.estBrokerageMicro).toBe(0n);
    expect(free.qty).toBe(61n); // 61 x 9_810_000 = 598_410_000 <= 600_000_000
    expect(free.brokerageMicro).toBe(0n);
    expect(free.totalCostMicro).toBe(598_410_000n);
  });
});

describe("reason: cash", () => {
  it("nothing deployable after the margin and buffer", () => {
    // 5_000_000 - 6_000_000 buffer = -1_000_000: no brokerage estimate is possible.
    const r = size({ settledCashMicro: 5_000_000n });
    expect(r.accepted).toBe(false);
    expect(r.reasons).toEqual(["cash"]);
    expect(r.preBrokerageMicro).toBe(-1_000_000n);
    expect(r.estBrokerageMicro).toBe(0n);
    expect(r.qty).toBe(0n);
    expect(r.orderValueMicro).toBe(0n);
    expect(r.brokerageMicro).toBe(0n);
    expect(r.untradeable).toBeNull();
    expect(isParcelOnlyRejection(r.reasons)).toBe(false);
  });

  it("a buffer or margin that eats all the cash is also a cash rejection", () => {
    const r = size({ settledCashMicro: 20_000_000n, sleeveMarginMicro: 20_000_000n });
    expect(r.reasons).toEqual(["cash"]);
    expect(r.preBrokerageMicro).toBe(-6_000_000n);
  });

  it("brokerage estimate swallows the remaining cash", () => {
    // 9_000_000 - 6_000_000 = 3_000_000 before brokerage; P5 estimate A$5.00 -> -2_000_000.
    const r = size({ settledCashMicro: 9_000_000n });
    expect(r.reasons).toEqual(["cash"]);
    expect(r.preBrokerageMicro).toBe(3_000_000n);
    expect(r.estBrokerageMicro).toBe(5_000_000n);
    expect(r.deployableMicro).toBe(-2_000_000n);
    expect(r.cashAfterMicro).toBe(9_000_000n);
  });

  it("guards a profile whose real fee exceeds its estimate (fee falls as value rises)", () => {
    const falling: CostProfile = {
      ...COST_PROFILES.P5,
      rule: {
        kind: "tiered",
        tiers: [{ upToMicro: 1_000_000_000n, feeMicro: 5_000_000n }],
        above: { kind: "flat", feeMicro: 0n },
      },
    };
    // pre 1_000_000_001 (> A$1,000.00) -> estimate 0; fill 10_000_000; 100 shares = 1_000_000_000
    // pays A$5.00 -> total 1_005_000_000 > pre.
    const r = size({
      profile: falling,
      settledCashMicro: 1_000_000_001n,
      navMicro: 0n,
      refPriceMicro: 9_990_000n,
    });
    expect(r.fillPriceMicro).toBe(10_000_000n);
    expect(r.estBrokerageMicro).toBe(0n);
    expect(r.qty).toBe(100n);
    expect(r.orderValueMicro).toBe(1_000_000_000n);
    expect(r.brokerageMicro).toBe(5_000_000n);
    expect(r.totalCostMicro).toBe(1_005_000_000n);
    expect(r.reasons).toEqual(["cash"]);
    expect(r.accepted).toBe(false);
  });
});

describe("reason: whole_share (ARN-023)", () => {
  it("deployable cash buys less than one share", () => {
    // A$100 NAV: pre 99_000_000, deployable 94_000_000; fill 100_100_000 (10 bps = 100_000 > tick).
    const r = size({
      settledCashMicro: 100_000_000n,
      navMicro: 100_000_000n,
      refPriceMicro: 100_000_000n,
    });
    expect(r.fillPriceMicro).toBe(100_100_000n);
    expect(r.deployableMicro).toBe(94_000_000n);
    expect(r.qty).toBe(0n);
    expect(r.reasons).toEqual(["whole_share"]);
    expect(r.accepted).toBe(false);
    expect(isParcelOnlyRejection(r.reasons)).toBe(true);
    expect(rejectReasonText(r.reasons)).toBe("whole_share");
  });
});

describe("reason: parcel (ARN-024, A$500 minimum)", () => {
  it("TST-101 case 023 shape: 39 shares worth A$382.59 are rejected", () => {
    const r = size({ settledCashMicro: 400_000_000n, navMicro: 400_000_000n });
    expect(r.qty).toBe(39n);
    expect(r.orderValueMicro).toBe(382_590_000n);
    expect(r.reasons).toEqual(["parcel"]);
    expect(isParcelOnlyRejection(r.reasons)).toBe(true);
    // Rejected sizing still reports what was refused, for the log.
    expect(r.totalCostMicro).toBe(387_590_000n);
  });

  it("exactly A$500.00 passes; one micro below is rejected", () => {
    expect(MIN_MARKETABLE_PARCEL_MICRO).toBe(500_000_000n);
    // fill 10_000_000 x 50 = 500_000_000 (case 024): accepted.
    const at = size({
      settledCashMicro: 516_000_000n,
      navMicro: 516_000_000n,
      refPriceMicro: 9_990_000n,
    });
    expect(at.orderValueMicro).toBe(500_000_000n);
    expect(at.accepted).toBe(true);
    // fill 9_990_000 (ref 9_980_000) x 50 = 499_500_000 < 500_000_000: rejected.
    const below = size({
      settledCashMicro: 510_000_000n,
      navMicro: 510_000_000n,
      refPriceMicro: 9_980_000n,
    });
    expect(below.fillPriceMicro).toBe(9_990_000n);
    expect(below.qty).toBe(50n);
    expect(below.orderValueMicro).toBe(499_500_000n);
    expect(below.reasons).toEqual(["parcel"]);
  });

  it("a different minimum parcel is honoured", () => {
    const r = size({
      settledCashMicro: 510_000_000n,
      navMicro: 510_000_000n,
      refPriceMicro: 9_980_000n,
      minParcelMicro: 499_500_000n,
    });
    expect(r.accepted).toBe(true);
  });
});

describe("reason: participation (ARN-024, 1% of 20-session ADV in shares)", () => {
  // Fill A$2.01 (A$2.00 + one tick). 10_000 shares = 20_100_000_000; P5 on that is A$29.95.
  const cheap: Partial<SizingInput> = {
    refPriceMicro: 2_000_000n,
    navMicro: 0n,
    adv20Shares: 1_000_000n, // cap = 10_000 shares
  };

  it("TST-101 case 025 shape: 10_079 shares against a cap of 10_000", () => {
    const r = size({
      settledCashMicro: 100_000_000_000n,
      navMicro: 100_000_000_000n,
      refPriceMicro: 9_800_000n,
      adv20Shares: 1_000_000n,
    });
    expect(r.estBrokerageMicro).toBe(118_800_000n); // 0.12% of 99_000_000_000
    expect(r.qty).toBe(10_079n);
    expect(r.capShares).toBe(10_000n);
    expect(r.reasons).toEqual(["participation"]);
  });

  it("exactly at the cap passes", () => {
    const r = size({ ...cheap, settledCashMicro: 20_129_950_000n });
    expect(r.fillPriceMicro).toBe(2_010_000n);
    expect(r.estBrokerageMicro).toBe(29_950_000n);
    expect(r.deployableMicro).toBe(20_100_000_000n);
    expect(r.qty).toBe(10_000n);
    expect(r.capShares).toBe(10_000n);
    expect(r.reasons).toEqual([]);
    expect(r.accepted).toBe(true);
  });

  it("one share over the cap is rejected", () => {
    const r = size({ ...cheap, settledCashMicro: 20_131_960_000n });
    expect(r.qty).toBe(10_001n);
    expect(r.reasons).toEqual(["participation"]);
    expect(isParcelOnlyRejection(r.reasons)).toBe(false);
  });

  it("a supplied cap rate is used and a zero ADV rejects everything", () => {
    const wide = size({
      ...cheap,
      settledCashMicro: 20_131_960_000n,
      participationCap: makeRational(1n, 50n),
    });
    expect(wide.capShares).toBe(20_000n);
    expect(wide.accepted).toBe(true);
    const none = size({ ...cheap, settledCashMicro: 20_131_960_000n, adv20Shares: 0n });
    expect(none.capShares).toBe(0n);
    expect(none.reasons).toEqual(["participation"]);
  });

  it("the cap is on shares, rounded down: 150 ADV shares give a cap of 1", () => {
    expect(size({ adv20Shares: 150n }).capShares).toBe(1n);
  });
});

describe("several reasons at once, and the stall predicate", () => {
  it("parcel and participation are both reported, in a fixed order", () => {
    const r = size({ settledCashMicro: 400_000_000n, navMicro: 400_000_000n, adv20Shares: 100n });
    expect(r.reasons).toEqual(["parcel", "participation"]);
    expect(rejectReasonText(r.reasons)).toBe("parcel,participation");
    expect(isParcelOnlyRejection(r.reasons)).toBe(false);
  });

  it("isParcelOnlyRejection: empty is not a rejection; parcel and whole_share together count", () => {
    expect(isParcelOnlyRejection([])).toBe(false);
    expect(isParcelOnlyRejection(["parcel", "whole_share"])).toBe(true);
    expect(isParcelOnlyRejection(["parcel", "cash"])).toBe(false);
  });
});

describe("untradeable label (ARN-013) is a label, never a rejection", () => {
  it("U3 is labelled and still accepted when the sizing rules pass", () => {
    const r = size({ tier: "U3" });
    expect(r.accepted).toBe(true);
    expect(r.untradeable).toBe("u3");
  });

  it("a trade above 0.5% of ADV value is labelled", () => {
    // ADV A$100,000 -> 0.5% = A$500; the order is worth about A$579.
    const r = size({ advValueMicro: 100_000_000_000n });
    expect(r.orderValueMicro > 500_000_000n).toBe(true);
    expect(r.untradeable).toBe("adv_pct");
  });

  it("a supplied fraction moves the threshold", () => {
    const r = size({
      advValueMicro: 100_000_000_000n,
      untradeableAdvFraction: makeRational(1n, 10n),
    });
    expect(r.untradeable).toBeNull();
  });
});

describe("input guards", () => {
  it("rejects a non-positive reference price and negative ADV shares", () => {
    expect(() => size({ refPriceMicro: 0n })).toThrow(RangeError);
    expect(() => size({ adv20Shares: -1n })).toThrow(RangeError);
  });
});

describe("stall floor (spec 05 section 5.1, decision 4)", () => {
  it("default: (A$500 + A$5 + 10 bps) / 99% = 510_606_061 micro", () => {
    expect(stallFloorMicro({ profile: COST_PROFILES.P5 })).toBe(510_606_061n);
  });

  it("custom parcel, buffer and slippage bps", () => {
    // parcel A$1,000: P5 A$5.00; slip 20 bps = 2_000_000; (1_007_000_000) / 0.98 = 1_027_551_020.4.
    expect(
      stallFloorMicro({
        profile: COST_PROFILES.P5,
        parcelMicro: 1_000_000_000n,
        cashBuffer: makeRational(2n, 100n),
        slippageBps: makeRational(20n),
      }),
    ).toBe(1_027_551_020n);
  });

  it("with a reference price the slippage is max(10 bps, one tick) rounded adverse", () => {
    // ref A$9.80: tick 10_000 per share > 9_800 -> 10_000; parcel slip = 500_000_000 x 10_000 /
    // 9_800_000 = 510_204.08; (505_000_000 + 510_204.08) / 0.99 = 510_616_368.
    expect(stallFloorMicro({ profile: COST_PROFILES.P5, refPriceMicro: 9_800_000n })).toBe(
      510_616_368n,
    );
  });
});

describe("entry quantity at the fill (GL-03, D-207 item 3)", () => {
  const P5 = COST_PROFILES.P5;
  // plan: 60 shares at A$9.81 = 588.60 + A$5.00 brokerage = 593.60 against 594.00 of cash
  const planned = { plannedQty: 60n, profile: P5 };

  it("keeps the planned quantity when it is still covered (price as planned)", () => {
    expect(
      resizeEntryAtFill({
        ...planned,
        fillPriceMicro: 9_810_000n,
        availableCashMicro: 594_000_000n,
      }),
    ).toEqual({ status: "keep", qty: 60n });
  });

  it("a gap down never enlarges the order", () => {
    expect(
      resizeEntryAtFill({
        ...planned,
        fillPriceMicro: 9_520_000n,
        availableCashMicro: 594_000_000n,
      }),
    ).toEqual({ status: "keep", qty: 60n });
  });

  it("a +3% gap cuts the quantity instead of cancelling", () => {
    // A$9.81 +3% is about A$10.11 on the tick grid: 58 x 10.11 = 586.38 + 5.00 = 591.38 <= 594.00;
    // 59 x 10.11 = 596.49 + 5.00 > 594.00
    expect(
      resizeEntryAtFill({
        ...planned,
        fillPriceMicro: 10_110_000n,
        availableCashMicro: 594_000_000n,
      }),
    ).toEqual({ status: "resized", qty: 58n });
  });

  it("the resized value plus brokerage never exceeds cash, and one more share would", () => {
    const cash = 594_000_000n;
    const r = resizeEntryAtFill({
      ...planned,
      fillPriceMicro: 10_110_000n,
      availableCashMicro: cash,
    });
    if (r.status !== "resized") throw new Error("expected resized");
    const cost = (q: bigint): bigint => q * 10_110_000n + feeFor(P5, q * 10_110_000n, "buy");
    expect(cost(r.qty) <= cash).toBe(true);
    expect(cost(r.qty + 1n) > cash).toBe(true);
  });

  it("cancels as cash when one marketable parcel (A$500) is unaffordable", () => {
    // 49 shares x A$10.11 = 495.39 < A$500, cash only affords 49 after the A$5 fee (500.00 cash)
    expect(
      resizeEntryAtFill({
        ...planned,
        fillPriceMicro: 10_110_000n,
        availableCashMicro: 500_000_000n,
      }),
    ).toEqual({ status: "cancel", reason: "cash" });
  });

  it("cancels as cash when not even one share is affordable", () => {
    expect(
      resizeEntryAtFill({
        ...planned,
        fillPriceMicro: 10_110_000n,
        availableCashMicro: 4_000_000n,
      }),
    ).toEqual({ status: "cancel", reason: "cash" });
    expect(
      resizeEntryAtFill({ ...planned, fillPriceMicro: 10_110_000n, availableCashMicro: 0n }),
    ).toEqual({ status: "cancel", reason: "cash" });
  });

  it("a resized parcel exactly at A$500 is marketable", () => {
    // 50 x A$10.00 = 500.00 + 5.00 brokerage = 505.00 cash
    expect(
      resizeEntryAtFill({
        plannedQty: 60n,
        profile: P5,
        fillPriceMicro: 10_000_000n,
        availableCashMicro: 505_000_000n,
      }),
    ).toEqual({ status: "resized", qty: 50n });
  });
});

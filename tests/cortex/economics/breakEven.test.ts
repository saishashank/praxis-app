// @vitest-environment node
// Break-even card line (M15 C3a; CTX-021, CTX-022a, CTX-070; AT-52 "p_be fixture G 10, L 6, C 2.5 → 53.1 %").
import { describe, expect, it } from "vitest";
import { breakEvenCard, breakEvenCardFromGross } from "@/lib/cortex/economics/breakEven";
import { costPerOrder } from "@/lib/cortex/economics/cost";
import { COST_PROFILES } from "@/lib/arena/costs";
import { CARD_COST_LEVELS } from "@/lib/stats/breakEven";

describe("breakEvenCard", () => {
  it("AT-52 through the card line: G 10 %, L 6 % → p_be 53.1 % at C 2.5 %", () => {
    const card = breakEvenCard(0.1, 0.06);
    expect(card.line.map((l) => l.c)).toEqual(CARD_COST_LEVELS);
    expect(card.line[0]!.c).toBe(0.025);
    expect(card.line[0]!.pBe).toBeCloseTo(0.53125, 12);
    expect(Math.round(card.line[0]!.pBe * 1000) / 10).toBe(53.1);
    // the other two card levels: (6 + 5)/16 and (6 + 7.5)/16
    expect(card.line[1]!.pBe).toBeCloseTo(0.6875, 12);
    expect(card.line[2]!.pBe).toBeCloseTo(0.84375, 12);
    expect(card.atOrderCost).toBeNull();
    expect(card.gain).toBe(0.1);
    expect(card.loss).toBe(0.06);
  });

  it("with the order's own cost per order: p_be at C from CTX-022a", () => {
    // A$10 U1 on P5 at A$500, ADV A$5M: 22_000 ppm (cost.test.ts) → (0.06 + 0.022)/0.16
    const cost = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: 500_000_000n,
      priceMicro: 10_000_000n,
      tier: "U1",
      advMicro: 5_000_000_000_000n,
    });
    const card = breakEvenCard(0.1, 0.06, cost);
    expect(card.atOrderCost).not.toBeNull();
    expect(card.atOrderCost!.c).toBeCloseTo(0.022, 12);
    expect(card.atOrderCost!.pBe).toBeCloseTo(0.082 / 0.16, 12);
  });

  it("from gross outcomes through C2 conditionalGainLoss (flat exits on the loss side, D-301)", () => {
    const card = breakEvenCardFromGross([0.2, 0.0, -0.1, 0.0]);
    expect(card.gainLoss).toEqual({ gain: 0.2, loss: 0.1 / 3, nGain: 1, nLoss: 3 });
    expect(card.gain).toBe(0.2);
    expect(card.line[0]!.pBe).toBeCloseTo((0.1 / 3 + 0.025) / (0.2 + 0.1 / 3), 12);
  });

  it("validates its inputs as C2 does", () => {
    expect(() => breakEvenCard(0, 0)).toThrow(RangeError);
    expect(() => breakEvenCard(-1, 0.06)).toThrow(RangeError);
  });
});

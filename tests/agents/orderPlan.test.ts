// @vitest-environment node
// The order plan (M4 T8; design 2.6, 4.4; decisions 7 and 19): canonical JSON, exact stops from the
// ACTUAL fill, and the corporate-action crossing that replaces `order_qty_stale`.
import { describe, expect, it } from "vitest";
import {
  caBasisOf,
  crossing,
  exitOrderSpec,
  initialStopAtFill,
  isUnit,
  parsePlan,
  rescaleQty,
  scaleMicro,
  scalePlanPrices,
  serializePlan,
  type OrderPlan,
} from "@/lib/agents/orderPlan";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { makeRational } from "@/lib/money/rational";

const k = (n: bigint, d = 1n) => makeRational(n, d);

const plan: OrderPlan = {
  family: "F6",
  variant: "F6",
  ruleVersion: "F6.v1",
  caThrough: "2030-05-02",
  caApplied: ["9", "10"],
  rel: [{ id: "below_event_low", k: k(3n, 2n), atrMicro: 41_000n }],
  plan: {
    initialStops: [
      {
        id: "initial",
        via: null,
        spec: { atr_micro: 40_000n, k: k(2n), cap: null, level_micro: null },
      },
      {
        id: "F5:initial",
        via: "F5",
        spec: { atr_micro: 40_000n, k: k(5n, 2n), cap: k(1n, 5n), level_micro: 1_200_000n },
      },
    ],
    trails: [{ id: "F1:trail", via: "F1", k: k(3n), activateGain: k(1n, 10n) }],
    cs: [
      { id: "time_stop", via: null, kind: "time_stop", sessions: 20, minReturn: null },
      { id: "slow", via: null, kind: "time_stop", sessions: 40, minReturn: k(1n, 20n) },
      { id: "sma", via: null, kind: "close_above_sma", period: 5 },
      { id: "neg", via: null, kind: "negative_event", categories: ["guidance_down"] },
      { id: "any", via: null, kind: "negative_event", categories: null },
      { id: "low", via: null, kind: "close_below_level", levelMicro: 1_234_567n },
      { id: "dry", via: null, kind: "volume_dry_up", ratioBelow: k(1n, 2n), sessions: 3 },
    ],
  },
};

const action = (id: string, type: string, exDate: string, payload = {}): CorpActionRecord => ({
  id,
  code: "ZZA",
  type,
  exDate,
  payload,
});

describe("serialisation", () => {
  it("round-trips every rule kind exactly, and equal plans give equal bytes", () => {
    const json = serializePlan(plan);
    expect(parsePlan(json)).toEqual({ ...plan, caApplied: ["10", "9"] });
    expect(serializePlan(parsePlan(json))).toBe(json);
    expect(json.indexOf('"ca_applied"')).toBeLessThan(json.indexOf('"stops"')); // keys are sorted
  });

  it("refuses anything that is not a plan", () => {
    expect(() => parsePlan("{}")).toThrow(TypeError);
    expect(() => parsePlan(exitOrderSpec("2030-05-02", [], "time_stop", null))).toThrow(TypeError);
  });

  it("an exit order carries only its quantity basis and the rule that fired", () => {
    const spec = exitOrderSpec("2030-05-02", ["b", "a"], "time_stop", "F4");
    expect(JSON.parse(spec)).toEqual({
      ca_applied: ["a", "b"],
      ca_through: "2030-05-02",
      exit_rule: "time_stop",
      v: 1,
      via: "F4",
    });
    expect(caBasisOf(spec, "x")).toEqual({ through: "2030-05-02", applied: new Set(["a", "b"]) });
    expect(caBasisOf(null, "2030-01-01")).toEqual({ through: "2030-01-01", applied: new Set() });
    expect(caBasisOf("not json", "2030-01-01").through).toBe("2030-01-01");
  });
});

describe("the initial stop from the actual fill (ARN-021)", () => {
  it("takes the tightest rule: ATR distance, the cap, the event-low level", () => {
    // 2 x 40,000 = 80,000 below 2,000,000 -> 1,920,000; F5: 2.5 x ATR -> 1,900,000, cap -20 % ->
    // 1,600,000, level 1,200,000 -> max = 1,900,000; overall the highest is 1,920,000
    expect(initialStopAtFill(plan, 2_000_000n)).toBe(1_920_000n);
  });

  it("is never below one micro and rescales a plan that crossed a split", () => {
    const tiny: OrderPlan = {
      ...plan,
      plan: {
        ...plan.plan,
        initialStops: [
          {
            id: "i",
            via: null,
            spec: { atr_micro: 40_000n, k: k(2n), cap: null, level_micro: null },
          },
        ],
      },
    };
    expect(initialStopAtFill(tiny, 50_000n)).toBe(1n);
    // ATR 40,000 halves with a 2-for-1 split: 2 x 20,000 below a fill of 1,000,000
    expect(initialStopAtFill(tiny, 1_000_000n, k(1n, 2n))).toBe(960_000n);
  });

  it("scales plan levels through a price factor, half away from zero", () => {
    expect(scaleMicro(1_234_567n, k(1n, 2n))).toBe(617_284n); // 617,283.5 -> 617,284
    const scaled = scalePlanPrices(plan.plan, k(1n, 2n));
    expect(scaled.initialStops[0]!.spec.atr_micro).toBe(20_000n);
    expect(scaled.cs.find((r) => r.id === "low")).toMatchObject({ levelMicro: 617_284n });
    expect(scalePlanPrices(plan.plan, k(1n))).toBe(plan.plan);
  });
});

describe("corporate-action crossing (D-077 order_qty_stale)", () => {
  const acts = [
    action("1", "split", "2030-05-03", { new: 2, old: 1 }),
    action("2", "consolidation", "2030-05-06", { new: 1, old: 4 }),
    action("3", "cash_dividend", "2030-05-03"),
    { ...action("4", "split", "2030-05-03", { new: 3, old: 1 }), code: "ZZB" },
    action("5", "delisting", "2030-05-09"),
  ];

  it("multiplies the ratios of the actions inside the window, exact; a dividend changes nothing", () => {
    const c = crossing(acts, "ZZA", "2030-05-02", "2030-05-06");
    expect(c.ratio).toEqual(makeRational(1n, 2n)); // x2 then x1/4
    expect(c.priceFactor).toEqual(makeRational(2n));
    expect(c.disposal).toBe(false);
    expect(c.ids).toEqual(["1", "2"]);
    expect(rescaleQty(100n, c)).toBe(50n);
  });

  it("the window is (from, to]: the day of the basis is not crossed, the fill day is", () => {
    expect(isUnit(crossing(acts, "ZZA", "2030-05-03", "2030-05-03").ratio)).toBe(true);
    expect(crossing(acts, "ZZA", "2030-05-02", "2030-05-03").ids).toEqual(["1"]);
  });

  it("an action already applied when the order was written is skipped", () => {
    const c = crossing(acts, "ZZA", "2030-05-02", "2030-05-06", new Set(["1"]));
    expect(c.ratio).toEqual(makeRational(1n, 4n));
    expect(c.ids).toEqual(["2"]);
  });

  it("a disposal-type action is flagged, and the rest of the code is untouched", () => {
    expect(crossing(acts, "ZZA", "2030-05-02", "2030-05-09").disposal).toBe(true);
    expect(crossing(acts, "ZZB", "2030-05-02", "2030-05-09").ratio).toEqual(makeRational(3n));
    expect(isUnit(crossing(acts, "ZZC", "2030-05-02", "2030-05-09").ratio)).toBe(true);
  });

  it("a consolidation leaves whole shares only (floor)", () => {
    expect(rescaleQty(10n, crossing(acts, "ZZA", "2030-05-05", "2030-05-06"))).toBe(2n);
  });
});

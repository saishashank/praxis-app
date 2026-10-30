// @vitest-environment node
// M8 T3 coverage (TST-121): the pure helpers of the live candidate builder on stub inputs (invented
// codes, no database): event row conversion with and without its optional columns, ranking with
// duplicate codes, leg sizing for one or two slots (half size, negative cash), the sizing
// environment of a code with no bars, and the open-position state with relative stops, a volume
// dry-up rule and a missing ATR.
import { describe, expect, it } from "vitest";
import {
  eventRowOf,
  evaluateOpen,
  planLegs,
  positionState,
  rankedCandidates,
  sizeLeg,
  sizingEnvFor,
  type DayInputs,
  type Leg,
  type OpenTrade,
  type SizingContext,
} from "@/lib/agents/candidates";
import { defaultAgentParams } from "@/lib/agents/params";
import type { OrderPlan } from "@/lib/agents/orderPlan";
import { resolveCohortParams } from "@/lib/arena/cohort";
import { makeRational } from "@/lib/money/rational";

const p = defaultAgentParams();
const one = makeRational(1n);
const ser = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

describe("eventRowOf", () => {
  const full = {
    market: "AU",
    source: "asx",
    ann_id: "a1",
    code: "ZZA",
    published_at: "2030-02-01T01:00:00.000Z",
    timed: 1n,
    day0_d: "2030-02-01",
    group_key: "g",
    category: "contract",
    price_sensitive: 1,
    ar_ppm: 1200n,
    ar_num: 3n,
    ar_den: 7n,
    vol_ratio_ppm: 2_500_000,
    polarity: 1n,
    rule_version: "1",
    category_llm: "result",
    polarity_llm: -1n,
  };

  it("converts every column, including the optional ones", () => {
    expect(eventRowOf(full)).toEqual({
      market: "AU",
      source: "asx",
      ann_id: "a1",
      code: "ZZA",
      published_at: "2030-02-01T01:00:00.000Z",
      timed: 1,
      day0_d: "2030-02-01",
      group_key: "g",
      category: "contract",
      category_detail: null,
      price_sensitive: 1,
      ar_ppm: 1200,
      ar_num: "3",
      ar_den: "7",
      vol_ratio_ppm: 2_500_000,
      polarity: 1,
      rule_version: "1",
      category_llm: "result",
      polarity_llm: -1,
    });
  });

  it("keeps nulls as null and clamps the flags to 0 or 1", () => {
    const r = eventRowOf({
      ...full,
      timed: 0n,
      price_sensitive: 7,
      ar_ppm: null,
      ar_num: null,
      ar_den: null,
      vol_ratio_ppm: null,
      category_llm: null,
      polarity_llm: null,
    });
    expect(r).toMatchObject({
      timed: 0,
      price_sensitive: 0,
      ar_ppm: null,
      ar_num: null,
      ar_den: null,
      vol_ratio_ppm: null,
      category_llm: null,
      polarity_llm: null,
    });
  });
});

describe("rankedCandidates", () => {
  const cand = (code: string, rank: number | null, adv: number | null) =>
    ({
      d: "2030-02-01",
      family: "F1",
      variant: "v",
      ruleVersion: "F1.v1",
      code,
      tier: "U1",
      regime: "RISK-ON",
      halfSize: false,
      rank: [rank === null ? null : makeRational(BigInt(rank))],
      rankText: String(rank),
      adv: adv === null ? null : makeRational(BigInt(adv)),
      groupKey: null,
      classes: null,
      contributors: [],
      maxOpenMicro: null,
    }) as never;

  it("orders by rank, then ADV (unknown last), then code, and keeps one per code", () => {
    const out = rankedCandidates([
      cand("ZZB", 5, 100),
      cand("ZZA", 5, null),
      cand("ZZC", 9, 1),
      cand("ZZB", 1, 50),
      cand("ZZD", 5, 100),
      cand("ZZE", null, 1),
    ]);
    expect(out.map((c) => c.code)).toEqual(["ZZC", "ZZB", "ZZD", "ZZA", "ZZE"]);
    expect(out.find((c) => c.code === "ZZB")!.rankText).toBe("5");
  });
});

describe("leg sizing", () => {
  const ctx = (over: Partial<SizingContext> = {}): SizingContext => ({
    params: resolveCohortParams({}),
    cashMicro: 20_000_000_000n,
    navMicro: 20_000_000_000n,
    sleeveReserveMicro: 0n,
    ...over,
  });
  const env = (code: string) => ({
    refPriceMicro: 10_000_000n,
    advValueMicro: 50_000_000_000n,
    adv20Shares: 5_000_000n,
    tier: "U1" as const,
    code,
  });
  const leg = (code: string, over: Partial<Leg> = {}): Leg => ({
    key: code,
    halfSize: false,
    env: env(code),
    sleeve: false,
    ...over,
  });

  it("a single leg gets the whole cash; two legs and half size each halve it", () => {
    const whole = sizeLeg(ctx(), leg("ZZA"), 1);
    const half = sizeLeg(ctx(), leg("ZZA", { halfSize: true }), 1);
    const two = sizeLeg(ctx(), leg("ZZA"), 2);
    const quarter = sizeLeg(ctx(), leg("ZZA", { halfSize: true }), 2);
    expect(whole.accepted).toBe(true);
    expect(ser(half)).not.toBe(ser(whole));
    expect(ser(two)).toBe(ser(half));
    expect(ser(quarter)).not.toBe(ser(two));
  });

  it("negative cash is treated as none and the sleeve reserve is only taken on the sleeve leg", () => {
    const poor = sizeLeg(ctx({ cashMicro: -5n }), leg("ZZA"), 1);
    expect(poor.accepted).toBe(false);
    const reserve = ctx({ sleeveReserveMicro: 19_000_000_000n });
    const noSleeve = sizeLeg(reserve, leg("ZZA"), 1);
    const sleeve = sizeLeg(reserve, leg("ZZA", { sleeve: true }), 1);
    expect(ser(sleeve)).not.toBe(ser(noSleeve));
  });

  it("planLegs: nothing for no candidates or no slots; two legs only if both are accepted", () => {
    expect(planLegs(ctx(), [], 2)).toEqual([]);
    expect(planLegs(ctx(), [leg("ZZA")], 0)).toEqual([]);
    expect(planLegs(ctx(), [leg("ZZA")], 2)).toHaveLength(1);
    expect(planLegs(ctx(), [leg("ZZA"), leg("ZZB")], 2)).toHaveLength(2);
    const bad = leg("ZZB", { env: { ...env("ZZB"), refPriceMicro: 1_000_000_000_000n } });
    const out = planLegs(ctx(), [leg("ZZA"), bad], 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.leg.key).toBe("ZZA");
    expect(planLegs(ctx(), [leg("ZZA"), leg("ZZB")], 1)).toHaveLength(1);
  });
});

describe("sizingEnvFor", () => {
  const cross = { priceFactor: one, ratio: one } as never;
  const bar = (close: bigint, volume: bigint) => ({ d: "x", open: close, high: close, low: close, close, volume });

  it("averages value and shares over the ADV window; no bars divide by one", () => {
    const facts = { code: "ZZA", tier: "U1", bar: bar(10_000_000n, 1n), rawBars: [bar(10_000_000n, 100n), bar(20_000_000n, 300n)] } as never;
    const e = sizingEnvFor({ facts, cross, p });
    expect(e.advValueMicro).toBe((10_000_000n * 100n + 20_000_000n * 300n) / 2n);
    expect(e.adv20Shares).toBe(200n);
    expect(e.refPriceMicro).toBe(10_000_000n);
    const none = sizingEnvFor({ facts: { code: "ZZA", tier: "U2", bar: bar(5_000_000n, 1n), rawBars: [] } as never, cross, p });
    expect(none).toMatchObject({ advValueMicro: 0n, adv20Shares: 0n, tier: "U2", code: "ZZA" });
  });
});

describe("positionState and evaluateOpen", () => {
  const bar = (d: string, close: bigint, volume = 1000n) => ({ d, open: close, high: close, low: close, close, volume });
  const calendar = ["2030-02-04", "2030-02-05", "2030-02-06", "2030-02-07"].map((d) => ({ d, kind: "session", close_time: null })) as never;
  const trade: OpenTrade = { tradeId: "t1", cohortId: "c1", code: "ZZA", fillD: "2030-02-05", fillMicro: 10_000_000n, stopSpec: null };
  const plan = (over: Partial<OrderPlan> = {}): OrderPlan =>
    ({
      family: "F1",
      variant: "v",
      ruleVersion: "F1.v1",
      caThrough: "2030-02-04",
      caApplied: [],
      plan: {
        initialStops: [],
        trails: [],
        cs: [
          { id: "lvl", via: null, kind: "close_below_level", levelMicro: 9_000_000n },
          { id: "dry", via: null, kind: "volume_dry_up", sessions: 3, ratio: one, level: null } as never,
        ],
      },
      rel: [{ id: "rel1", k: makeRational(2n), atrMicro: 500_000n }],
      ...over,
    }) as OrderPlan;
  const day = (over: Partial<Record<string, unknown>> = {}): DayInputs => {
    const adj = [bar("2030-02-04", 9_500_000n), bar("2030-02-05", 10_000_000n), bar("2030-02-06", 11_000_000n), bar("2030-02-07", 10_500_000n)];
    return {
      d: "2030-02-07",
      facts: new Map([["ZZA", { code: "ZZA", bar: adj[3], ind: { atrWarm: true, atrMicro: 400_000n, closeAboveSmaShort: true } }]]),
      adjusted: new Map([["ZZA", adj]]),
      eventsByCode: new Map(),
      ...over,
    } as never;
  };

  it("builds the state: rebased levels, a relative stop anchored on the fill, dry-up ratios, ATR and events", () => {
    const s = positionState(trade, plan(), day(), [], calendar, p)!;
    expect(s.sessionsHeld).toBe(3);
    expect(s.highestCloseMicro).toBe(11_000_000n);
    expect(s.atrMicro).toBe(400_000n);
    expect(s.volumeRatios).toHaveLength(3);
    expect(s.events).toEqual([]);
    const rel = s.plan.cs.find((r) => r.id === "rel1") as { levelMicro: bigint };
    expect(rel.levelMicro).toBe(10_000_000n - 1_000_000n);
    expect(evaluateOpen([s])).toHaveLength(1);
  });

  it("a relative stop that would be at or below zero is floored at one micro", () => {
    const wide = plan({ rel: [{ id: "rel2", k: makeRational(100n), atrMicro: 500_000n }] });
    const s = positionState(trade, wide, day(), [], calendar, p)!;
    expect((s.plan.cs.find((r) => r.id === "rel2") as { levelMicro: bigint }).levelMicro).toBe(1n);
  });

  it("no bar at or after the fill falls back to D's close; a cold ATR is null; no volume rule gives no ratios", () => {
    const d = day({
      facts: new Map([["ZZA", { code: "ZZA", bar: bar("2030-02-07", 9_900_000n), ind: { atrWarm: false, atrMicro: null, closeAboveSmaShort: null } }]]),
      adjusted: new Map([["ZZA", [bar("2030-02-01", 9_000_000n)]]]),
    });
    const noDry = plan({ plan: { initialStops: [], trails: [], cs: [] }, rel: [] });
    const s = positionState(trade, noDry, d, [], calendar, p)!;
    expect(s.highestCloseMicro).toBe(9_900_000n);
    expect(s.atrMicro).toBeNull();
    expect(s.volumeRatios).toEqual([]);
  });

  it("returns null when the code has no facts or no adjusted bars today", () => {
    expect(positionState({ ...trade, code: "ZZX" }, plan(), day(), [], calendar, p)).toBeNull();
    expect(positionState(trade, plan(), day({ adjusted: new Map() }), [], calendar, p)).toBeNull();
  });
});

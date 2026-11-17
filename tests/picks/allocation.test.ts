// @vitest-environment node
// D-951 strategy split of "My portfolio": the strategy of a pick (candidate-measure picks out, the
// shortlist its own), the record, the empirical-Bayes shrinkage toward equal shares, the risk
// parity tilt, the 40 % cap, the weak-record cash, and determinism.
import { describe, expect, it } from "vitest";
import {
  allocate,
  recordOf,
  strategyOf,
  type AllocationInput,
  type AllocationProfile,
  type StrategyKey,
  type StrategyRecord,
} from "@/lib/picks/allocation";

const P: AllocationProfile = { shrinkN: 20, volTilt: 1, weakCash: 0 };
const input = (o: Partial<AllocationInput> & { inPlay: StrategyKey[] }): AllocationInput => ({
  records: new Map(),
  stopDistance: new Map(o.inPlay.map((s) => [s, 0.05])),
  strategyCap: 0.4,
  ...o,
});
const share = (a: ReturnType<typeof allocate>, s: StrategyKey) =>
  a.shares.find((x) => x.strategy === s)?.targetPpm;
const rec = (n: number, mean: number, sd = 0.05): StrategyRecord => ({ n, mean, sd });

describe("strategyOf", () => {
  it("families, the shortlist, and no candidate-measure pick", () => {
    expect(strategyOf("F3", "F3.v2")).toBe("F3");
    expect(strategyOf("F1", "SL.v1")).toBe("SL");
    expect(strategyOf("F2", "CAND.v1")).toBeNull();
    expect(strategyOf("F1", "CAND-mom.v2")).toBeNull();
    expect(strategyOf("F9", "F9.v1")).toBeNull();
    expect(strategyOf("SL", "X.v1")).toBeNull();
  });
});

describe("recordOf", () => {
  it("mean and sample standard deviation", () => {
    expect(recordOf([])).toEqual({ n: 0, mean: 0, sd: 0 });
    expect(recordOf([0.02])).toEqual({ n: 1, mean: 0.02, sd: 0 });
    const r = recordOf([0.01, 0.03]);
    expect(r.n).toBe(2);
    expect(r.mean).toBeCloseTo(0.02, 12);
    expect(r.sd).toBeCloseTo(Math.SQRT2 * 0.01, 12);
  });
});

describe("allocate", () => {
  it("nothing in play: all cash", () => {
    expect(allocate(input({ inPlay: [] }), P)).toEqual({ shares: [], cashPpm: 1_000_000 });
  });

  it("no record and equal stops: equal shares, capped at 40 %, the rest cash", () => {
    const a = allocate(input({ inPlay: ["F1", "F2"] }), P);
    expect(share(a, "F1")).toBe(400_000);
    expect(share(a, "F2")).toBe(400_000);
    expect(a.cashPpm).toBe(200_000);
    const four = allocate(input({ inPlay: ["F1", "F2", "F3", "SL"] }), P);
    expect(four.shares.map((x) => x.targetPpm)).toEqual([250_000, 250_000, 250_000, 250_000]);
    expect(four.cashPpm).toBe(0);
  });

  it("risk parity: a stop twice as far gets half the weight (tilt 1); tilt 0 ignores it", () => {
    const stops = new Map<StrategyKey, number>([
      ["F1", 0.05],
      ["F2", 0.1],
      ["F3", 0.05],
    ]);
    const a = allocate(input({ inPlay: ["F1", "F2", "F3"], stopDistance: stops }), P);
    expect(share(a, "F1")).toBe(400_000);
    expect(share(a, "F2")).toBe(200_000);
    const flat = allocate(input({ inPlay: ["F1", "F2", "F3"], stopDistance: stops }), {
      ...P,
      volTilt: 0,
    });
    expect(share(flat, "F2")).toBe(333_333);
    // a stronger tilt leans further to the calm strategies
    const strong = allocate(input({ inPlay: ["F1", "F2", "F3"], stopDistance: stops }), {
      ...P,
      volTilt: 2,
    });
    expect(share(strong, "F2")!).toBeLessThan(share(a, "F2")!);
  });

  it("shrinkage: a short record stays near the equal share, a long one moves to the record", () => {
    const rows = (n: number) =>
      allocate(
        input({
          inPlay: ["F1", "F2"],
          records: new Map([
            ["F1", rec(n, 0.04)],
            ["F2", rec(n, 0.01)],
          ]),
          strategyCap: 1,
        }),
        { ...P, volTilt: 0 },
      );
    const short = rows(2);
    const long = rows(200);
    // record share 80/20; lambda 2/22 vs 200/220
    expect(share(short, "F1")! / 1e6).toBeCloseTo((2 / 22) * 0.8 + (20 / 22) * 0.5, 5);
    expect(share(long, "F1")! / 1e6).toBeCloseTo((200 / 220) * 0.8 + (20 / 220) * 0.5, 5);
    // less shrinkage (aggressive) trusts the same record sooner
    const quick = allocate(
      input({
        inPlay: ["F1", "F2"],
        records: new Map([
          ["F1", rec(10, 0.04)],
          ["F2", rec(10, 0.01)],
        ]),
        strategyCap: 1,
      }),
      { ...P, volTilt: 0, shrinkN: 5 },
    );
    const slow = allocate(
      input({
        inPlay: ["F1", "F2"],
        records: new Map([
          ["F1", rec(10, 0.04)],
          ["F2", rec(10, 0.01)],
        ]),
        strategyCap: 1,
      }),
      { ...P, volTilt: 0, shrinkN: 40 },
    );
    expect(share(quick, "F1")!).toBeGreaterThan(share(slow, "F1")!);
  });

  it("a strategy without a record keeps the equal part of its share next to a winner", () => {
    const a = allocate(
      input({ inPlay: ["F1", "SL"], records: new Map([["F1", rec(40, 0.04)]]), strategyCap: 1 }),
      { ...P, volTilt: 0 },
    );
    // F1: 2/3 x 1 + 1/3 x 1/2 = 5/6; SL has no record (lambda 0): the full equal share 1/2;
    // scaled to 100 %: 5/8 and 3/8
    expect(share(a, "F1")! / 1e6).toBeCloseTo(5 / 8, 5);
    expect(share(a, "SL")! / 1e6).toBeCloseTo(3 / 8, 5);
    expect(a.shares[0]!.strategy).toBe("F1");
  });

  it("all records losing: equal record shares, and the weak share is kept in cash", () => {
    const records = new Map<StrategyKey, StrategyRecord>([
      ["F1", rec(30, -0.02)],
      ["F2", rec(30, -0.01)],
    ]);
    const none = allocate(input({ inPlay: ["F1", "F2"], records }), P);
    expect(none.shares.every((x) => x.weak)).toBe(true);
    expect(share(none, "F1")).toBe(400_000);
    const half = allocate(input({ inPlay: ["F1", "F2"], records }), { ...P, weakCash: 0.5 });
    expect(share(half, "F1")).toBe(200_000);
    expect(half.cashPpm).toBe(600_000);
  });

  it("the cap never hands its excess to another strategy; flags are reported", () => {
    const a = allocate(input({ inPlay: ["F1"] }), P);
    expect(a.shares[0]).toMatchObject({ strategy: "F1", targetPpm: 400_000, capped: true });
    expect(a.cashPpm).toBe(600_000);
  });

  it("a near-zero volatility is floored, so it never takes everything", () => {
    const a = allocate(
      input({
        inPlay: ["F1", "F2"],
        records: new Map([
          ["F1", rec(400, 0.01, 0)],
          ["F2", rec(400, 0.01, 0.05)],
        ]),
        stopDistance: new Map([
          ["F1", 0],
          ["F2", 0.05],
        ]),
        strategyCap: 1,
      }),
      P,
    );
    expect(a.shares[0]!.risk).toBe(0.01);
    expect(share(a, "F2")!).toBeGreaterThan(0);
  });

  it("is deterministic: the order of the strategies does not matter", () => {
    const records = new Map<StrategyKey, StrategyRecord>([
      ["F4", rec(12, 0.03, 0.04)],
      ["SL", rec(25, 0.01, 0.02)],
    ]);
    const one = allocate(input({ inPlay: ["SL", "F4", "F6"], records }), P);
    const two = allocate(input({ inPlay: ["F6", "SL", "F4", "SL"], records }), P);
    expect(two).toEqual(one);
    const sum = one.shares.reduce((a, x) => a + x.targetPpm, 0) + one.cashPpm;
    expect(sum).toBe(1_000_000);
  });
});

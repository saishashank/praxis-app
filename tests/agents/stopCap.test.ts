// @vitest-environment node
// FAM-004 stop-distance cap (M14, D-216): exact boundary, inside runFamilies, skip reason.
import { describe, expect, it } from "vitest";
import { runFamilies } from "@/lib/agents/families";
import { exceedsStopCap, stopDistance } from "@/lib/agents/families/stopCap";
import type { StopSpec } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import { makeRational } from "@/lib/money/rational";
import { CENT, factsOf, inputsOf, makeBars, rising } from "../fixtures/agents/families/builders";

const p = defaultAgentParams();
const REF = 10_000_000n;
const capSpec = (num: bigint, den: bigint): StopSpec => ({
  atr_micro: null,
  k: null,
  cap: makeRational(num, den),
  level_micro: null,
});
const TWELVE = makeRational(12n, 100n);

describe("stop distance (FAM-004)", () => {
  it("is exact: a 12 % distance passes a 12 % cap, 12.0001 % blocks", () => {
    expect(stopDistance({ stopSpec: capSpec(12n, 100n) }, REF)).toEqual(makeRational(12n, 100n));
    expect(exceedsStopCap({ stopSpec: capSpec(12n, 100n) }, REF, TWELVE)).toBe(false);
    expect(exceedsStopCap({ stopSpec: capSpec(120_001n, 1_000_000n) }, REF, TWELVE)).toBe(true);
  });

  it("an F5-style 20 % cap with a 15 % distance is blocked by the 12 % cap", () => {
    expect(exceedsStopCap({ stopSpec: capSpec(15n, 100n) }, REF, TWELVE)).toBe(true);
  });
});

describe("runFamilies applies the cap after F6", () => {
  const oversold = (i: number): bigint => {
    const base = rising(CENT)(Math.min(i, 296));
    const k = BigInt(Math.max(0, i - 296));
    return (base * (100n - 4n * k)) / 100n;
  };
  const world = () => inputsOf([factsOf("ZZD", "U1", makeBars({ close: oversold }), p)]);

  it("default cap leaves a normal F4 entry alone", () => {
    const out = runFamilies(world(), p);
    expect(out.candidates.some((c) => c.family === "F4")).toBe(true);
  });

  it("a tiny cap moves every candidate to blocked as skipped_stop_distance", () => {
    const tight = { ...p, entry: { ...p.entry, maxStopDistance: makeRational(1n, 1_000_000n) } };
    const out = runFamilies(world(), tight);
    expect(out.candidates).toEqual([]);
    const f4 = out.blocked.filter((c) => c.family === "F4");
    expect(f4.length).toBeGreaterThan(0);
    expect(f4.every((c) => c.reasons.includes("skipped_stop_distance"))).toBe(true);
  });
});

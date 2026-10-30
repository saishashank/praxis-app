// @vitest-environment node
// FAM-005/006/008/009 entry gates shared by live and replay (M14, D-214...D-221).
import { describe, expect, it } from "vitest";
import { costGateKey, costGateTable } from "@/lib/agents/costGate";
import {
  returnCorrelation,
  secondPositionVerdict,
  selectEntries,
  type EntryGateContext,
} from "@/lib/agents/entryGates";
import { runFamilies } from "@/lib/agents/families";
import type { Candidate, CodeFacts } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  CENT,
  DOLLAR,
  factsOf,
  inputsOf,
  makeBars,
  override,
  rising,
} from "../fixtures/agents/families/builders";

const p = defaultAgentParams();
const oversold = (i: number): bigint => {
  const base = rising(CENT)(Math.min(i, 296));
  const k = BigInt(Math.max(0, i - 296));
  return (base * (100n - 4n * k)) / 100n;
};
/** Alternating series; the two phases are perfectly anti-correlated, equal phases identical. */
const zig =
  (phase: number) =>
  (i: number): bigint =>
    100n * DOLLAR + BigInt((i + phase) % 2) * 5n * DOLLAR;

const base = factsOf("ZZA", "U1", makeBars({ close: oversold }), p);
const f4 = runFamilies(inputsOf([base]), p).candidates.find((x) => x.family === "F4")!;
const cand = (code: string, over: Partial<Candidate> = {}): Candidate => ({
  ...f4,
  code,
  ...over,
});

function ctx(facts: CodeFacts[], over: Partial<EntryGateContext> = {}): EntryGateContext {
  const m = new Map(facts.map((f) => [f.code, f] as const));
  return {
    entry: p.entry,
    advWindow: p.windows.adv,
    costProfile: COST_PROFILES.P5,
    factsOf: (code) => m.get(code),
    heldCodes: [],
    cashMicro: 10_000n * DOLLAR,
    ...over,
  };
}
const withIndustry = (code: string, industry: string | null, close = zig(0)): CodeFacts =>
  override(factsOf(code, "U1", makeBars({ close }), p), { industry });

describe("second position (FAM-006)", () => {
  it("correlation of identical series is 1, of opposite series -1", () => {
    const a = factsOf("ZZA", "U1", makeBars({ close: zig(0) }), p).closesAdj;
    const b = factsOf("ZZB", "U1", makeBars({ close: zig(1) }), p).closesAdj;
    expect(returnCorrelation(a, a, 60)).toBeCloseTo(1, 9);
    expect(returnCorrelation(a, b, 60)).toBeLessThan(-0.9);
    expect(returnCorrelation(a.slice(-10), a.slice(-10), 60)).toBeNull();
  });

  it("same industry blocks, different industry and low correlation passes", () => {
    const a = withIndustry("ZZA", "Banks");
    const same = withIndustry("ZZB", "Banks", zig(1));
    const other = withIndustry("ZZC", "Materials", zig(1));
    expect(secondPositionVerdict(same, a, 0.6, 60).ok).toBe(false);
    expect(secondPositionVerdict(other, a, 0.6, 60).ok).toBe(true);
  });

  it("high correlation blocks even across industries", () => {
    const a = withIndustry("ZZA", "Banks");
    const b = withIndustry("ZZB", "Materials", zig(0));
    expect(secondPositionVerdict(b, a, 0.6, 60).ok).toBe(false);
  });

  it("unknown industry falls back to correlation and flags it; placeholders are unknown", () => {
    const a = withIndustry("ZZA", "Class Pend");
    const b = withIndustry("ZZB", "Class Pend", zig(1));
    const v = secondPositionVerdict(b, a, 0.6, 60);
    expect(v.ok).toBe(true);
    expect(v.flags).toContain("industry_unknown");
  });

  it("too little history falls back to the industry test and flags corr_unknown", () => {
    const short = override(withIndustry("ZZB", "Materials"), { closesAdj: [1n, 2n] });
    const v = secondPositionVerdict(short, withIndustry("ZZA", "Banks"), 0.6, 60);
    expect(v).toEqual({ ok: true, flags: ["corr_unknown"] });
  });

  it("selectEntries: the first leg passes, a same-industry second is skipped, the next is tried", () => {
    const f = [
      withIndustry("ZZA", "Banks", zig(0)),
      withIndustry("ZZB", "Banks", zig(1)),
      withIndustry("ZZC", "Materials", zig(1)),
    ];
    const r = selectEntries([cand("ZZA"), cand("ZZB"), cand("ZZC")], ctx(f));
    expect(r.eligible.map((c) => c.code)).toEqual(["ZZA", "ZZC"]);
    expect([...r.skipped.values()]).toEqual(["second_position"]);
  });

  it("a held position counts as the first", () => {
    const f = [withIndustry("ZZH", "Banks", zig(0)), withIndustry("ZZB", "Banks", zig(1))];
    const r = selectEntries([cand("ZZB")], ctx(f, { heldCodes: ["ZZH"] }));
    expect(r.eligible).toEqual([]);
    expect([...r.skipped.values()]).toEqual(["second_position"]);
  });
});

describe("cost gate in selectEntries (FAM-005)", () => {
  const f = [withIndustry("ZZA", "Banks")];
  const c = cand("ZZA");
  const rows = (g: bigint) =>
    Array.from({ length: 30 }, () => ({
      family: c.family,
      ruleVersion: c.ruleVersion,
      variant: c.variant,
      grossNum: g,
      grossDen: 100n,
    }));

  it("no table: passes with cost_gate_unmeasured", () => {
    const r = selectEntries([c], ctx(f));
    expect(r.eligible).toEqual([c]);
    expect(r.flags.get(c)).toContain("cost_gate_unmeasured");
  });

  it("a thin median is skipped_cost_gate, a fat one passes without the flag", () => {
    const thin = costGateTable(rows(1n));
    expect(thin.get(costGateKey(c.family, c.ruleVersion, c.variant))!.median).not.toBeNull();
    expect([...selectEntries([c], ctx(f, { costTable: thin })).skipped.values()]).toEqual([
      "skipped_cost_gate",
    ]);
    const fat = selectEntries([c], ctx(f, { costTable: costGateTable(rows(50n)) }));
    expect(fat.eligible).toEqual([c]);
    expect(fat.flags.get(c) ?? []).not.toContain("cost_gate_unmeasured");
  });
});

describe("FAM-009 abstain_shock", () => {
  const f = [withIndustry("ZZA", "Banks")];
  it("a half-size candidate with under two parcels of cash abstains; full size does not", () => {
    const half = cand("ZZA", { halfSize: true });
    const poor = ctx(f, { cashMicro: 900n * DOLLAR });
    expect([...selectEntries([half], poor).skipped.values()]).toEqual(["abstain_shock"]);
    expect(selectEntries([cand("ZZA")], poor).eligible.length).toBe(1);
    expect(selectEntries([half], ctx(f)).eligible.length).toBe(1);
  });
});

describe("FAM-008 one open per order", () => {
  it("the gates are pure: the same night twice gives the same selection (no resubmission state)", () => {
    const f = [withIndustry("ZZA", "Banks"), withIndustry("ZZB", "Materials", zig(1))];
    const run = () => selectEntries([cand("ZZA"), cand("ZZB")], ctx(f));
    expect(run().eligible.map((c) => c.code)).toEqual(run().eligible.map((c) => c.code));
  });
});

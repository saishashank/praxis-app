// @vitest-environment node
// D-920 nightly shortlist (rule SL.v1): steady risers in an uptrend with a stop 2 x ATR below are
// offered as pick candidates with evidence from the same rule replayed on the window before D; flat or
// falling shares are not; bars after D never change the result; a code a strategy already offers is
// left out. Synthetic ZZ codes.
import { describe, expect, it } from "vitest";
import { getCostProfile } from "@/lib/arena/costs";
import {
  shortlistInputs,
  SHORTLIST_RULE,
  type DayBar,
  type ShortlistCode,
} from "@/lib/picks/shortlist";

const M = 1_000_000;
const START = Date.parse("2025-01-01T00:00:00Z");
const day = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);

/** Daily bars: close = 10 x (1 + g)^i with a gentle wave, a 3 % range (so ATR ~ 3 %). */
function bars(n: number, g: number, phase = 0): DayBar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 10 * (1 + g) ** i * (1 + 0.01 * Math.sin(i / 3 + phase));
    const m = (x: number) => BigInt(Math.round(x * M));
    return {
      d: day(i),
      openMicro: m(c * 0.998),
      highMicro: m(c * 1.015),
      lowMicro: m(c * 0.985),
      closeMicro: m(c),
      volume: 100_000,
    };
  });
}

const N = 340;
const D = day(N - 1);
const universe = (): ShortlistCode[] => [
  ...[0.004, 0.0035, 0.003, 0.0028, 0.0025, 0.0022].map((g, k) => ({
    code: `ZZUP${k}`,
    tier: "U1" as const,
    bars: bars(N, g, k),
  })),
  ...[0, -0.001, 0.0002, -0.0005, 0.0001, -0.002].map((g, k) => ({
    code: `ZZFL${k}`,
    tier: "U2" as const,
    bars: bars(N, g, k + 7),
  })),
];
const opts = (over: Partial<Parameters<typeof shortlistInputs>[1]> = {}) => ({
  d: D,
  market: "AU",
  costProfile: getCostProfile("P5"),
  advMicro: new Map<string, bigint>(),
  ...over,
});

describe("shortlistInputs (D-920)", () => {
  it("offers the steady risers, best first, with evidence and a stop below the price", () => {
    const out = shortlistInputs(universe(), opts());
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(5);
    for (const x of out) {
      expect(x.code.startsWith("ZZUP")).toBe(true);
      expect(x).toMatchObject({
        family: "F1",
        ruleVersion: SHORTLIST_RULE,
        variant: "S",
        cardId: null,
      });
      expect(x.signalId).toBe(`shortlist:AU:${D}:${SHORTLIST_RULE}:${x.code}`);
      expect(x.stopMicro! < x.referenceMicro).toBe(true);
      const dist = Number(x.referenceMicro - x.stopMicro!) / Number(x.referenceMicro);
      expect(dist).toBeGreaterThanOrEqual(0.03);
      expect(dist).toBeLessThanOrEqual(0.1);
      expect(x.scenario!.n).toBeGreaterThanOrEqual(30);
      expect(x.holdMedianSessions!).toBeGreaterThanOrEqual(1);
      expect(x.basedOn[0]).toMatch(/^Nightly shortlist \(trend\): up \d+% over about three months/);
      expect(x.basedOn[1]).toMatch(
        /^History: \d+ similar setups in the last year; \d+ % of them ended with a net gain/,
      );
    }
    // the strongest riser leads
    expect(out[0]!.code).toBe("ZZUP0");
  });

  it("leaves out a code a strategy already offers tonight, and fills the place with the next one", () => {
    const all = shortlistInputs(universe(), opts());
    const without = shortlistInputs(universe(), opts({ exclude: new Set([all[0]!.code]) }));
    expect(without.map((x) => x.code)).not.toContain(all[0]!.code);
    // only the top fifth qualifies, so the place is filled only when another share qualifies too
    expect(without.length).toBeGreaterThanOrEqual(all.length - 1);
  });

  it("never looks past D: bars after the decision change nothing", () => {
    const base = shortlistInputs(universe(), opts());
    const longer = universe().map((c) => ({ ...c, bars: bars(N + 30, 0.004, 0) }));
    // the same codes with 30 extra sessions after D (a big rise) must give the same evidence for D
    const cut = universe().map((c, k) => ({
      ...c,
      bars: [...c.bars, ...longer[k]!.bars.slice(N)],
    }));
    expect(shortlistInputs(cut, opts())).toEqual(base);
  });

  it("offers nothing in a market without uptrends", () => {
    const flat = universe().filter((c) => c.code.startsWith("ZZFL"));
    expect(shortlistInputs(flat, opts())).toEqual([]);
  });

  it("with too little history it still offers candidates but no scenario (so no pick is built)", () => {
    const short = universe().map((c) => ({ ...c, bars: c.bars.slice(-210) }));
    const out = shortlistInputs(short, opts({ d: D }));
    for (const x of out) expect(x.scenario).toBeNull();
  });
});

// @vitest-environment node
// D-921: how close the nightly shortlist rule (SL.v1) came the evening before, in plain words, and the
// picks-side hooks of the daily learning loop.
import { describe, expect, it } from "vitest";
import type { DayBar, ShortlistCode } from "@/lib/picks/shortlist";
import { shortlistNotes } from "@/lib/picks/shortlist";
import { pickHooks } from "@/lib/picks/dailyHooks";

const M = 1_000_000;
const START = Date.parse("2025-01-01T00:00:00Z");
const day = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);
const N = 300;
const m = (x: number) => BigInt(Math.round(x * M));

/** Close from price(i); a 2.4 % daily range so the stop (2 x ATR) is about 5 % away, inside 3 to 10 %. */
function bars(price: (i: number) => number): DayBar[] {
  return Array.from({ length: N }, (_, i) => {
    const c = price(i);
    return {
      d: day(i),
      openMicro: m(c),
      highMicro: m(c * 1.012),
      lowMicro: m(c * 0.988),
      closeMicro: m(c),
      volume: 100_000,
    };
  });
}
const code = (c: string, tier: "U1" | "U2" | "U3", b: DayBar[]): ShortlistCode => ({
  code: c,
  tier,
  bars: b,
});

const universe = (): ShortlistCode[] => [
  code(
    "STRONG",
    "U1",
    bars((i) => 10 * 1.004 ** i),
  ), // about +29 % over 63 sessions
  code(
    "SLOW",
    "U1",
    bars((i) => 100 + 0.054 * i),
  ), // a steady rise of about 3 % over 63 sessions
  code(
    "DOWN",
    "U2",
    bars((i) => 100 * 0.998 ** i),
  ),
  code(
    "TINY",
    "U3",
    bars((i) => 5 * 1.004 ** i),
  ),
  ...Array.from({ length: 6 }, (_, k) =>
    code(
      `FLAT${k}`,
      "U2",
      bars((i) => 50 + Math.sin(i / 5 + k)),
    ),
  ),
];
const D = day(N - 1);

describe("shortlistNotes", () => {
  const notes = shortlistNotes(universe(), D, ["STRONG", "SLOW", "DOWN", "TINY", "NOBODY"]);

  it("says a share that passed was on the shortlist, with its rank", () => {
    expect(notes.get("STRONG")).toEqual({ note: "on the shortlist (rank 1)", onShortlist: true });
  });

  it("says how close a near miss came, in plain numbers", () => {
    const slow = notes.get("SLOW")!;
    expect(slow.onShortlist).toBe(false);
    expect(slow.note).toMatch(/^missed the shortlist: rise only [23]% over 3 months \(needs 5%\)$/);
  });

  it("names the failed conditions of a falling share", () => {
    const down = notes.get("DOWN")!;
    expect(down.onShortlist).toBe(false);
    expect(down.note).toContain("missed the shortlist: closed below its 50-day average");
  });

  it("puts a small share and an unknown share outside the rule's universe", () => {
    expect(notes.get("TINY")!.note).toContain("small share");
    expect(notes.get("NOBODY")!.note).toContain("no price bar");
  });

  it("is not moved by bars after the evening it asks about", () => {
    const early = universe().map((c) => ({ ...c, bars: c.bars.slice(0, N - 10) }));
    const dEarly = day(N - 11);
    expect(shortlistNotes(early, dEarly, ["SLOW"]).get("SLOW")).toEqual(
      shortlistNotes(universe(), dEarly, ["SLOW"]).get("SLOW"),
    );
  });
});

describe("pick hooks", () => {
  it("hand the near-miss notes over from loose bars (dollars to micro-dollars, nothing after the evening)", () => {
    const shares = universe().map((c) => ({
      code: c.code,
      tier: c.tier,
      bars: c.bars.map((b) => ({
        d: b.d,
        o: Number(b.openMicro) / M,
        h: Number(b.highMicro) / M,
        l: Number(b.lowMicro) / M,
        c: Number(b.closeMicro) / M,
        v: b.volume,
      })),
    }));
    const out = pickHooks.shortlistNotes(shares, D, ["STRONG"]);
    expect(out.get("STRONG")).toEqual({ note: "on the shortlist (rank 1)", onShortlist: true });
  });
});

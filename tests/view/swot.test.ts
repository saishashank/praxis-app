// @vitest-environment node
// D-196: the rules-based SWOT from our own stored data, each line one checkable fact.
import { describe, expect, it } from "vitest";
import { buildSwot, SWOT_MIN_SESSIONS } from "@/lib/view/swot";

const flat = (n: number, p = 10) => Array.from({ length: n }, () => p);
const base = {
  volumes: flat(260, 1000),
  shortPpm: null,
  shortPrevPpm: null,
  priceSensitive30d: 0,
  sizeGroup: null,
};

describe("buildSwot", () => {
  it("needs about a year of sessions", () => {
    expect(buildSwot({ ...base, closes: flat(SWOT_MIN_SESSIONS - 1) })).toBeNull();
  });

  it("an uptrend near its high, calm, heavily traded, with news, is all strengths and opportunities", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 10 * 1.002 ** i); // a steady rise
    const s = buildSwot({ ...base, closes, sizeGroup: "Large", priceSensitive30d: 2 })!;
    expect(s.strengths.join(" ")).toMatch(/uptrend/);
    expect(s.strengths.join(" ")).toMatch(/52-week high/);
    expect(s.strengths.join(" ")).toMatch(/Steady price/);
    expect(s.strengths.join(" ")).toMatch(/Heavily traded/);
    expect(s.opportunities.join(" ")).toMatch(/2 price-sensitive announcements/);
    expect(s.weaknesses).toEqual([]);
    expect(s.threats).toEqual([]);
  });

  it("a slide to its low, wild swings, thin trading and heavy shorting are weaknesses and threats", () => {
    const closes = Array.from({ length: 260 }, (_, i) => 10 * 0.995 ** i * (i % 2 ? 0.94 : 1.06));
    const s = buildSwot({
      ...base,
      closes,
      sizeGroup: "Small",
      shortPpm: 80_000,
      shortPrevPpm: 60_000,
    })!;
    expect(s.weaknesses.join(" ")).toMatch(/downtrend/);
    expect(s.weaknesses.join(" ")).toMatch(/Thinly traded/);
    expect(s.threats.join(" ")).toMatch(/52-week low/);
    expect(s.threats.join(" ")).toMatch(/Very volatile/);
    expect(s.threats.join(" ")).toMatch(/8\.0% of the shares sold short/);
    expect(s.threats.join(" ")).toMatch(/Falling hard/);
  });

  it("spots unusual volume and falling short interest from a high level", () => {
    const volumes = [...flat(259, 1000), 3000];
    const s = buildSwot({
      ...base,
      closes: flat(260),
      volumes,
      shortPpm: 50_000,
      shortPrevPpm: 70_000,
    })!;
    expect(s.opportunities.join(" ")).toMatch(/3\.0 times the usual volume/);
    expect(s.opportunities.join(" ")).toMatch(/Short selling is falling/);
  });
});

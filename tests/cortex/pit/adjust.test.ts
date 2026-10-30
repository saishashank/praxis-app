// @vitest-environment node
// CTX-050 adjustment method through one builder (M15 C1a; docs/M15_design.md 3c "Adjustment").
import { describe, expect, it } from "vitest";
import { makeRational } from "@/lib/money/rational";
import { buildCodeSeries, dividendFactors, dividendTermsOf } from "@/lib/cortex/pit/adjust";
import { barsFor, ZZA_DIVIDEND, ZZC_SPLIT } from "./zzWorld";

describe("buildCodeSeries", () => {
  it("prices / ratio and volume x ratio for bars before the ex-date; later bars untouched", () => {
    const raw = barsFor("ZZC");
    const s = buildCodeSeries(
      "ZZC",
      raw,
      [{ exDate: "2026-03-11", ratio: makeRational(2n, 1n) }],
      [],
    );
    expect(s.d).toEqual(raw.map((b) => b.d));
    const ex = raw.findIndex((b) => b.d === "2026-03-11");
    for (let i = 0; i < raw.length; i += 1) {
      const f = i < ex ? 2n : 1n;
      expect(s.adjClose[i]).toBe(raw[i]!.close / f);
      expect(s.adjVolume[i]).toBe(raw[i]!.volume * f);
      expect(s.adj[i]!.high).toBe(raw[i]!.high / f);
      expect(s.divFactor[i]).toBe(1);
    }
    expect(s.raw).toBe(raw);
  });

  it("refuses bars that are not oldest first", () => {
    expect(() => buildCodeSeries("ZZC", [...barsFor("ZZC")].reverse(), [], [])).toThrow(RangeError);
  });

  it("empty input gives empty arrays", () => {
    const s = buildCodeSeries("ZZX", [], [], []);
    expect(s.d).toEqual([]);
    expect(s.divFactor).toEqual([]);
  });
});

describe("dividend factor", () => {
  it("multiplies bars before each ex-date by 1 - dps / prior close, and compounds", () => {
    const raw = barsFor("ZZA"); // closes 20.20, 20.40, 20.60, ... (A$) from the 2nd
    const one = dividendFactors(raw, [{ exDate: "2026-03-05", dpsMicro: makeRational(100_000n) }]);
    const priorClose = Number(raw[2]!.close); // the 4th, last bar before the 5th
    expect(one[0]).toBeCloseTo(1 - 100_000 / priorClose, 12);
    expect(one[2]).toBeCloseTo(1 - 100_000 / priorClose, 12);
    expect(one[3]).toBe(1);
    const two = dividendFactors(raw, [
      { exDate: "2026-03-05", dpsMicro: makeRational(100_000n) },
      { exDate: "2026-03-12", dpsMicro: makeRational(50_000n) },
    ]);
    const prior2 = Number(raw.find((b) => b.d === "2026-03-11")!.close);
    expect(two[0]).toBeCloseTo((1 - 100_000 / priorClose) * (1 - 50_000 / prior2), 12);
    expect(two[4]).toBeCloseTo(1 - 50_000 / prior2, 12);
    expect(two.at(-1)).toBe(1);
  });

  it("a dividend with no earlier bar, or an absurd term, contributes nothing", () => {
    const raw = barsFor("ZZA");
    expect(
      dividendFactors(raw, [{ exDate: "2026-03-02", dpsMicro: makeRational(100_000n) }]),
    ).toEqual(raw.map(() => 1));
    const huge = dividendFactors(raw, [
      { exDate: "2026-03-05", dpsMicro: makeRational(99_000_000n) },
    ]);
    expect(huge).toEqual(raw.map(() => 1));
    expect(dividendFactors([], [{ exDate: "2026-03-05", dpsMicro: makeRational(1n) }])).toEqual([]);
  });

  it("dividendTermsOf keeps dividend records, skips other types and unreadable payloads", () => {
    const terms = dividendTermsOf([
      ZZA_DIVIDEND,
      ZZC_SPLIT,
      { ...ZZA_DIVIDEND, id: "bad", payload: { pay_date: "2026-03-20" } },
    ]);
    expect(terms).toEqual([{ exDate: "2026-03-05", dpsMicro: makeRational(100_000n) }]);
  });
});

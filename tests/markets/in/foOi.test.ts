// @vitest-environment node
// M20 IN1 (DAT-243 b): the F&O / SLB open-interest proxy. short_ppm = SLB open quantity / issued shares x 10^6, half-up,
// clamped to 1,000,000; a row with no issued count or a bad date is skipped. The proxy is identified by its source.
import { describe, expect, it } from "vitest";
import { parseFoOi, shortInterestRows, SOURCE } from "@/lib/data/sources/in/foOi.mjs";

const T =
  "symbol,slb_open_qty,issued_qty,as_of\nAAA,150000,100000000,2026-11-12\nBBB,3,2,2026-11-12\nCCC,1,0,2026-11-12\nDDD,5,100,12-11-2026\nEEE,1,3,2026-11-12\n";

describe("parseFoOi", () => {
  it("computes the proxy share in ppm, half up and clamped", () => {
    const r = parseFoOi(T, { market: "IN" });
    const by = Object.fromEntries(r.rows.map((x) => [x.code, x.shortPpm]));
    expect(by).toEqual({ AAA: 1500, BBB: 1_000_000, EEE: 333_333 });
    expect(r.skipped).toBe(2);
  });

  it("known at the end of the as-of day (IST); source marks it as a proxy", () => {
    const r = parseFoOi(T, { market: "IN" });
    expect(r.rows[0]!.publishedAt).toBe("2026-11-12T18:29:59.000Z");
    const row = shortInterestRows(r.rows.slice(0, 1), "2026-11-13T00:00:00.000Z")[0]!;
    expect(row).toEqual([
      "IN",
      "AAA",
      "2026-11-12",
      1500,
      "2026-11-12T18:29:59.000Z",
      "2026-11-13T00:00:00.000Z",
      0,
      SOURCE,
    ]);
  });
});

// GL-10 (O-51): the total-return benchmark series and its coverage label.
import { afterEach, describe, expect, it } from "vitest";
import {
  benchmarkBasis,
  benchmarkLabel,
  loadBenchmarkBasis,
  totalReturnSeries,
} from "@/lib/picks/benchmark";
import { setConfig } from "@/lib/config/store";
import {
  parseVendorActionsText,
  writeVendorActions,
} from "../../src/lib/data/vendorActions/vendorActions.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { pipelineDb } from "../pipeline/helpers";

afterEach(cleanupTempDbs);

const M = 1_000_000n;
const idx = [
  { d: "2030-01-02", closeMicro: 100n * M },
  { d: "2030-01-03", closeMicro: 100n * M },
  { d: "2030-01-04", closeMicro: 110n * M },
  { d: "2030-01-07", closeMicro: 110n * M },
];
const etf = [
  { d: "2030-01-02", closeMicro: 50n * M },
  { d: "2030-01-03", closeMicro: 50n * M },
  { d: "2030-01-04", closeMicro: 50n * M },
];

describe("totalReturnSeries", () => {
  it("equals the price index when there are no dividends", () => {
    expect(totalReturnSeries(idx, [], etf).map((p) => p.levelMicro)).toEqual(
      idx.map((p) => p.closeMicro),
    );
    expect(totalReturnSeries([], [], etf)).toEqual([]);
  });

  it("reinvests a dividend on its ex-date, using the ETF close of the session before", () => {
    // 1 on a 50 close = +2 % on the ex-date 2030-01-04: 100 * 1.1 * 1.02 = 112.2
    const s = totalReturnSeries(idx, [{ exDate: "2030-01-04", amountMicro: 1n * M }], etf);
    expect(s.map((p) => p.levelMicro)).toEqual([100n * M, 100n * M, 112_200_000n, 112_200_000n]);
  });

  it("applies a dividend whose ex-date is a non-session on the next session, and ignores one before the start", () => {
    const s = totalReturnSeries(
      idx,
      [
        { exDate: "2030-01-01", amountMicro: 5n * M },
        { exDate: "2030-01-05", amountMicro: 1n * M },
      ],
      [...etf, { d: "2030-01-07", closeMicro: 50n * M }],
    );
    expect(s[0]!.levelMicro).toBe(100n * M);
    expect(s[2]!.levelMicro).toBe(110n * M);
    expect(s[3]!.levelMicro).toBe(112_200_000n);
  });

  it("skips a dividend with no earlier ETF close", () => {
    const s = totalReturnSeries(idx, [{ exDate: "2030-01-03", amountMicro: 1n * M }], []);
    expect(s.map((p) => p.levelMicro)).toEqual(idx.map((p) => p.closeMicro));
  });
});

describe("coverage rule", () => {
  it("labels total return only when vendor rows reach the window start and a dividend exists", () => {
    expect(benchmarkBasis("2030-01-02", "2029-06-01", 3)).toBe("total_return");
    expect(benchmarkBasis("2030-01-02", "2030-01-02", 1)).toBe("total_return");
    expect(benchmarkBasis("2030-01-02", "2030-02-01", 3)).toBe("price_only");
    expect(benchmarkBasis("2030-01-02", null, 0)).toBe("price_only");
    expect(benchmarkBasis("2030-01-02", "2029-06-01", 0)).toBe("price_only");
    expect(benchmarkLabel("price_only")).toBe("Price only — dividends not included.");
    expect(benchmarkLabel("total_return")).toBe("Total return — dividends reinvested.");
  });

  it("reads the database: placeholder code and no rows stay price only, covered rows switch", async () => {
    const db = await pipelineDb();
    expect(await loadBenchmarkBasis(db, "AU", "2030-01-02", "2030-03-01")).toBe("price_only");
    await setConfig(db, {
      key: "c1_etf_code",
      value: "ZZETF",
      userId: null,
      now: "2030-01-01T00:00:00.000Z",
    });
    expect(await loadBenchmarkBasis(db, "AU", "2030-01-02", "2030-03-01")).toBe("price_only");
    const rows = parseVendorActionsText(
      JSON.stringify([
        {
          code: "ZZETF",
          ex_date: "2029-12-15",
          kind: "dividend",
          amount: 0.5,
          currency: "AUD",
          source: "yahoo",
          fetched_at: "2030-01-01T07:30:00.000Z",
        },
      ]),
    ).rows;
    await writeVendorActions(db, { rows });
    expect(await loadBenchmarkBasis(db, "AU", "2030-01-02", "2030-03-01")).toBe("total_return");
    expect(await loadBenchmarkBasis(db, "AU", "2029-01-02", "2030-03-01")).toBe("price_only");
  });
});

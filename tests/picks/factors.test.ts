// @vitest-environment node
// AGT-112 nightly read: bucket assignment, effect, and the "not enough history" rule (n < 30).
import { describe, expect, it } from "vitest";
import { bucketOf, factorLines, numericValue, readFactorRows } from "@/lib/picks/factors";
import { MARKET, world } from "./harness";
import { cleanupTempDbs } from "../db/helpers";
import { afterAll } from "vitest";

afterAll(cleanupTempDbs);

const rows = [
  {
    factor: "rsi_short",
    bucket: 1,
    edges: [10, 20],
    n: 87,
    medianNetPpm: 10_000,
    familyMedianPpm: 30_000,
  },
  {
    factor: "rsi_short",
    bucket: 2,
    edges: [10, 20],
    n: 14,
    medianNetPpm: 50_000,
    familyMedianPpm: 30_000,
  },
  {
    factor: "rsi_short",
    bucket: 3,
    edges: [10, 20],
    n: 60,
    medianNetPpm: 70_000,
    familyMedianPpm: 30_000,
  },
];

describe("AGT-112 factor lines", () => {
  it("assigns the bucket by the stored edges", () => {
    expect(bucketOf(5, [10, 20])).toBe(1);
    expect(bucketOf(10, [10, 20])).toBe(1);
    expect(bucketOf(15, [10, 20])).toBe(2);
    expect(bucketOf(25, [10, 20])).toBe(3);
  });

  it("reads rational and decimal rule values, not words", () => {
    expect(numericValue("3/2")).toBe(1.5);
    expect(numericValue("-7.5")).toBe(-7.5);
    expect(numericValue("true")).toBeNull();
    expect(numericValue("1/0")).toBeNull();
  });

  it("states the effect (bucket median minus family median) when n is enough", () => {
    const [line] = factorLines({ rsi_short: "5/1" }, rows, 30);
    expect(line).toMatchObject({ bucket: 1, n: 87, effectPpm: -20_000, enough: true });
  });

  it("reads 'not enough history' with no effect for a bucket with n = 14 (UXN-121)", () => {
    const [line] = factorLines({ rsi_short: "15/1" }, rows, 30);
    expect(line).toMatchObject({ bucket: 2, n: 14, effectPpm: null, enough: false });
  });

  it("moves the line when the minimum n key moves", () => {
    const [line] = factorLines({ rsi_short: "15/1" }, rows, 14);
    expect(line!.enough).toBe(true);
    expect(line!.effectPpm).toBe(20_000);
  });

  it("skips factors with no numeric value today and is independent of input order", () => {
    expect(factorLines({ other: "1/1" }, rows, 30)).toEqual([]);
    expect(factorLines({ rsi_short: "up" }, rows, 30)).toEqual([]);
    expect(factorLines({ rsi_short: "25/1" }, [...rows].reverse(), 30)).toEqual(
      factorLines({ rsi_short: "25/1" }, rows, 30),
    );
  });
});

describe("readFactorRows", () => {
  it("reads the stored buckets of one rule version and split", async () => {
    const { db, run } = await world();
    for (const [bucket, n] of [
      [1, 40],
      [2, 14],
    ] as const) {
      await run(
        `INSERT INTO factor_bucket_stat (market, family, rule_version, split_version, factor, bucket,
           edges_json, n, median_net_ppm, family_median_ppm) VALUES (?, 'F1', 'F1.v1', 1, 'rsi_short', ?, '[10,20]', ?, 5000, 1000)`,
        [MARKET, bucket, n],
      );
    }
    const got = await readFactorRows(db, {
      market: MARKET,
      family: "F1",
      ruleVersion: "F1.v1",
      splitVersion: 1,
    });
    expect(got.map((g) => [g.bucket, g.n, g.edges])).toEqual([
      [1, 40, [10, 20]],
      [2, 14, [10, 20]],
    ]);
    expect(
      await readFactorRows(db, {
        market: MARKET,
        family: "F1",
        ruleVersion: "F1.v1",
        splitVersion: 2,
      }),
    ).toEqual([]);
  });
});

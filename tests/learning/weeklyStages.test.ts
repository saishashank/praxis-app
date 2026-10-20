// @vitest-environment node
// M6 T12: the weekly learning run's stage functions that can be checked without a replay: AGT-112 factor
// buckets (known answers, idempotent writer, ARN-102 raise), the promotion roll wiring (D-121:
// `rollAfterPromotion` for every promotion applied since the last run), and the ARN-076 output shape
// for the families with one evidence class.
import { afterAll, describe, expect, it, vi } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  bucketEdges,
  computeFactorBuckets,
  medianPpm,
  writeFactorBuckets,
  type FactorObs,
} from "@/lib/learning/factors";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const awaiting = vi.fn<(db: unknown, market: string) => Promise<string[]>>();
const loadPromotionMock = vi.fn<(db: unknown, id: string) => Promise<unknown>>();
const rollMock = vi.fn<(db: unknown, input: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@/lib/learning/promotion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/learning/promotion")>();
  return {
    ...real,
    promotionsAwaitingRoll: (db: unknown, market: string) => awaiting(db, market),
    loadPromotion: (db: unknown, id: string) => loadPromotionMock(db, id),
    rollAfterPromotion: (db: unknown, input: Record<string, unknown>) => rollMock(db, input),
  };
});

afterAll(cleanupTempDbs);

const params = defaultAgentParams();

const obs = (value: string, netPpm: number, over: Partial<FactorObs> = {}): FactorObs => ({
  family: "F1",
  ruleVersion: "F1.v1",
  splitVersion: 1,
  netPpm,
  values: { rsi: value },
  ...over,
});

describe("AGT-112 factor buckets (known answers)", () => {
  it("terciles of six values: edges at ranks 2 and 4, integer medians, family median beside them", () => {
    expect(params.picks.factorBuckets).toBe("terciles");
    const rows = [1, 2, 3, 4, 5, 6].map((v) => obs(String(v), v * 1000));
    expect(bucketEdges([1, 2, 3, 4, 5, 6], 3)).toEqual([2, 4]);
    const out = computeFactorBuckets("AU", rows, params);
    expect(out.map((r) => [r.bucket, r.n, r.median_net_ppm, r.family_median_ppm])).toEqual([
      [1, 2, 1500, 3500],
      [2, 2, 3500, 3500],
      [3, 2, 5500, 3500],
    ]);
    expect(out.every((r) => r.edges_json === "[2,4]" && r.factor === "rsi")).toBe(true);
  });

  it("stored fractions are numeric; flags and text are not; a factor with fewer values than buckets is skipped", () => {
    const rows = [
      obs("1/2", 10),
      obs("3/2", 20),
      obs("5/2", 30),
      obs("true", 40),
      obs("rsi2=unusable", 50),
    ];
    const out = computeFactorBuckets("AU", rows, params);
    expect(out.map((r) => r.n)).toEqual([1, 1, 1]); // only the three numeric values
    expect(computeFactorBuckets("AU", rows.slice(0, 2), params)).toEqual([]);
  });

  it("groups by (family, rule version, split version); medians of even counts floor", () => {
    expect(medianPpm([])).toBeNull();
    expect(medianPpm([3, 1, 2])).toBe(2);
    expect(medianPpm([-3, -2])).toBe(-3); // floor(-2.5)
    const rows = [
      ...[1, 2, 3].map((v) => obs(String(v), v)),
      ...[1, 2, 3].map((v) => obs(String(v), v, { splitVersion: 2 })),
    ];
    const out = computeFactorBuckets("AU", rows, params);
    expect([...new Set(out.map((r) => r.split_version))]).toEqual([1, 2]);
  });

  it("the writer is idempotent and a differing stored row raises (ARN-102)", async () => {
    const db = await freshDb("main");
    const rows = computeFactorBuckets(
      "AU",
      [1, 2, 3, 4, 5, 6].map((v) => obs(String(v), v * 1000)),
      params,
    );
    expect(await writeFactorBuckets(db, rows)).toEqual({ written: 3, unchanged: 0 });
    expect(await writeFactorBuckets(db, rows)).toEqual({ written: 0, unchanged: 3 });
    const changed = rows.map((r) => ({ ...r, median_net_ppm: 1 }));
    await expect(writeFactorBuckets(db, changed)).rejects.toThrow(/ARN-102/);
    const n = await db.execute("SELECT COUNT(*) AS n FROM factor_bucket_stat");
    expect(Number(n.rows[0]!.n)).toBe(3);
  });
});

describe("rolls stage: rollAfterPromotion is wired (D-121)", () => {
  it("calls it once per promotion applied since the last run, with the family's primary rows", async () => {
    const { rollsStage } = await import("@/lib/learning/weeklyStages");
    awaiting.mockResolvedValue(["promo-1", "promo-2"]);
    loadPromotionMock.mockImplementation(async (_db, id) => ({ id, family: "F1" }));
    rollMock.mockResolvedValue({ status: "rolled", splitVersion: 2 });
    const sessions = ["2029-01-01", "2029-01-02", "2029-01-03"];
    const entry = (family: string, variant: string, entryD: string, exitD: string | null) => ({
      family,
      variant,
      row: { entry_d: entryD, exit_d: exitD },
    });
    const ctx = {
      db: {},
      market: "AU",
      d: "2029-01-06",
      params,
      runId: "r",
      world: { sessions },
      ledger: {
        entries: [
          entry("F1", "F1", "2029-01-01", "2029-01-02"),
          entry("F1", "F1-U1", "2029-01-02", null), // another variant: not primary
          entry("F2", "F2", "2029-01-02", null), // another family
        ],
      },
      facts: new Map(),
      calendar: [],
    };
    const out = await rollsStage(ctx as never);
    expect(rollMock).toHaveBeenCalledTimes(2);
    const first = rollMock.mock.calls[0]![1];
    expect(first).toMatchObject({
      promotionId: "promo-1",
      calendar: sessions,
      now: "2029-01-06",
      stats: params.stats,
      primaryRows: [{ entryD: "2029-01-01", exitD: "2029-01-02" }],
    });
    expect(out.stats[0]).toMatchObject({
      scope: "AU",
      metric: "rolls",
      value: {
        awaiting: 2,
        results: [
          { promotion: "promo-1", status: "rolled" },
          { promotion: "promo-2", status: "rolled" },
        ],
      },
    });
  });

  it("with nothing awaiting it rolls nothing", async () => {
    const { rollsStage } = await import("@/lib/learning/weeklyStages");
    rollMock.mockClear();
    awaiting.mockResolvedValue([]);
    const out = await rollsStage({ db: {}, market: "AU", d: "x", params } as never);
    expect(rollMock).not.toHaveBeenCalled();
    expect(out.stats[0]!.value).toEqual({ awaiting: 0, results: [] });
  });
});

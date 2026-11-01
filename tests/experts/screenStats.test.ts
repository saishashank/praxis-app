// @vitest-environment node
// Screening statistics (D-518): deterministic block bootstrap, one-sided p, insufficiency, one BH pass, ranking.
import { describe, expect, it } from "vitest";
import type { DevelopmentSample, DevRow } from "@/lib/experts/devView";
import {
  clusterStatistic,
  isInsufficient,
  screenRun,
  type ClusterStat,
  type StatOptions,
} from "@/lib/experts/screenStats";
import { scopedPrng, uniform01 } from "@/lib/stats/rng";

const OPTS: StatOptions = { replicates: 400, minRows: 20, minBlocks: 3 };

function gauss(rng: ReturnType<typeof scopedPrng>): number {
  let s = 0;
  for (let i = 0; i < 12; i += 1) s += uniform01(rng);
  return s - 6;
}

function sample(
  scope: string,
  mean: number,
  opts: { n?: number; withControls?: boolean; flipSecondHalf?: boolean } = {},
): DevelopmentSample {
  const n = opts.n ?? 300;
  const sessionCount = n * 4;
  const block = 100;
  const rng = scopedPrng(`zz:${scope}`);
  const rows: DevRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const session = i * 4;
    const m = opts.flipSecondHalf === true && session >= sessionCount / 2 ? -mean : mean;
    const x = m + 0.03 * gauss(rng);
    rows.push({
      entryD: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
      session,
      net: x + 0.001,
      excess: opts.withControls === false ? null : x,
    });
  }
  return {
    split: "development",
    rows,
    blocks: new Set(rows.map((r) => Math.floor(r.session / block))).size,
    sessionCount,
    blockSessions: block,
  };
}

const must = (x: ReturnType<typeof clusterStatistic>): ClusterStat => {
  if (isInsufficient(x)) throw new Error("insufficient");
  return x;
};

describe("clusterStatistic", () => {
  it("is deterministic for a sample, seed and options", () => {
    const s = sample("a", 0.01);
    expect(clusterStatistic(s, "seed-1", OPTS)).toEqual(clusterStatistic(s, "seed-1", OPTS));
  });

  it("gives a small p and a positive lower bound to a planted edge, a large p to a negative mean", () => {
    const edge = must(clusterStatistic(sample("edge", 0.02), "e", OPTS));
    expect(edge.rows).toBe(300);
    expect(edge.p).toBeLessThan(0.01);
    expect(edge.lower90).toBeGreaterThan(0);
    expect(edge.firstHalf).toBeGreaterThan(0);
    expect(edge.secondHalf).toBeGreaterThan(0);
    const loss = must(clusterStatistic(sample("loss", -0.02), "l", OPTS));
    expect(loss.p).toBeGreaterThan(0.9);
  });

  it("p is never 0 and never above 1", () => {
    const edge = must(clusterStatistic(sample("big", 0.5), "b", OPTS));
    expect(edge.p).toBeGreaterThan(0);
    expect(edge.p).toBeLessThanOrEqual(1);
  });

  it("never tests mean net: too few controlled rows is insufficient, not a fallback (D-595)", () => {
    expect(clusterStatistic(sample("nc", 0.02, { withControls: false }), "n", OPTS)).toEqual({
      insufficient: "controls",
    });
    // 300 rows, only 19 with a control: still insufficient at minRows 20
    const s = sample("mixed", 0.02);
    const rows = s.rows.map((r, i) => (i < 19 ? r : { ...r, excess: null }));
    expect(clusterStatistic({ ...s, rows }, "m", OPTS)).toEqual({ insufficient: "controls" });
  });

  it("counts rows and blocks on the controlled rows only; meanNet stays over every row", () => {
    const s = sample("part", 0.02);
    const rows = s.rows.map((r, i) => (i % 2 === 0 ? r : { ...r, excess: null }));
    const st = must(clusterStatistic({ ...s, rows }, "p", OPTS));
    expect(st.rows).toBe(150);
    expect(st.blocks).toBe(
      new Set(rows.filter((r) => r.excess !== null).map((r) => Math.floor(r.session / 100))).size,
    );
    expect(st.meanNet).toBeCloseTo(rows.reduce((a, r) => a + r.net, 0) / rows.length, 12);
    expect(st.meanExcess).toBeCloseTo(
      rows.filter((r) => r.excess !== null).reduce((a, r) => a + r.excess!, 0) / 150,
      12,
    );
  });

  it("reports insufficient rows and blocks instead of a statistic", () => {
    expect(clusterStatistic(sample("few", 0.02, { n: 10 }), "f", OPTS)).toEqual({
      insufficient: "rows",
    });
    expect(clusterStatistic(sample("blk", 0.02), "f", { ...OPTS, minBlocks: 999 })).toEqual({
      insufficient: "blocks",
    });
  });

  it("p is one-sided toward a positive mean: a mirrored series gets the mirror p (same draws, same seed)", () => {
    const s = sample("mirror", 0.004);
    const neg: DevelopmentSample = {
      ...s,
      rows: s.rows.map((r) => ({ ...r, excess: -r.excess! })),
    };
    const a = must(clusterStatistic(s, "m", OPTS));
    const b = must(clusterStatistic(neg, "m", OPTS));
    expect(b.meanExcess).toBeCloseTo(-a.meanExcess, 12);
    // #{rep - m >= m} + #{-(rep - m) >= -m} = R + #{rep - m = m}, so p_a + p_b = 1 + (1 + ties) / (R + 1)
    expect(a.p + b.p).toBeGreaterThanOrEqual(1 + 1 / (OPTS.replicates + 1) - 1e-12);
    expect(a.p + b.p).toBeLessThan(1 + 3 / (OPTS.replicates + 1));
    expect(a.p).toBeLessThan(b.p);
  });

  it("splits the sessions into halves", () => {
    const st = must(clusterStatistic(sample("half", 0.02, { flipSecondHalf: true }), "h", OPTS));
    expect(st.firstHalf).toBeGreaterThan(0);
    expect(st.secondHalf).toBeLessThan(0);
  });
});

describe("screenRun", () => {
  const stat = (over: Partial<ClusterStat>): ClusterStat => ({
    rows: 100,
    blocks: 10,
    meanNet: 0,
    meanExcess: 0,
    lower90: 0,
    p: 0.5,
    firstHalf: 0.01,
    secondHalf: 0.01,
    ...over,
  });

  it("is empty for no clusters", () => {
    expect(screenRun([], 0.1)).toEqual([]);
  });

  it("survives only BH-rejected clusters whose halves agree, grade L1 iff survived (KB-076)", () => {
    const rows = screenRun(
      [
        { id: "K-1", stat: stat({ p: 0.001, lower90: 0.01 }) },
        { id: "K-2", stat: stat({ p: 0.002, lower90: 0.03 }) },
        { id: "K-3", stat: stat({ p: 0.001, lower90: 0.05, secondHalf: -0.01 }) }, // signs disagree
        { id: "K-4", stat: stat({ p: 0.6 }) },
      ],
      0.1,
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["K-1"]).toMatchObject({ survived: true, rank: 2, grade: "L1" });
    expect(by["K-2"]).toMatchObject({ survived: true, rank: 1, grade: "L1" });
    expect(by["K-3"]).toMatchObject({ bhRejected: true, signAgrees: false, survived: false });
    expect(by["K-3"]!.rank).toBeNull();
    expect(by["K-3"]!.grade).toBe("L0");
    expect(by["K-4"]).toMatchObject({ survived: false, grade: "L0" });
  });

  it("adjusts over all clusters at once (a lone cluster is not adjusted, forty are)", () => {
    const lone = screenRun([{ id: "K-1", stat: stat({ p: 0.02 }) }], 0.1)[0]!;
    expect(lone.adjustedP).toBeCloseTo(0.02, 12);
    const forty = screenRun(
      Array.from({ length: 40 }, (_, i) => ({
        id: `K-${i + 1}`,
        stat: stat({ p: i === 0 ? 0.02 : 0.9 }),
      })),
      0.1,
    )[0]!;
    expect(forty.adjustedP).toBeCloseTo(0.8, 12);
    expect(forty.bhRejected).toBe(false);
  });

  it("breaks rank ties by p then id", () => {
    const rows = screenRun(
      [
        { id: "K-2", stat: stat({ p: 0.002, lower90: 0.02 }) },
        { id: "K-1", stat: stat({ p: 0.001, lower90: 0.02 }) },
      ],
      0.1,
    );
    expect(rows.find((r) => r.id === "K-1")!.rank).toBe(1);
    expect(rows.find((r) => r.id === "K-2")!.rank).toBe(2);
  });
});

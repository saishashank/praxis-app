// @vitest-environment node
// Angle registry rules (M15 C1a; docs/M15_design.md 3a "angles"; CTX-011, CTX-030, CTX-051,
// D-290, D-291, D-292): status rules, candidate -> undefined, nightly rank standardisation to
// [-1, 1] with deterministic ties, and the D7 / D9 / D10 gate and meta entries.
import { describe, expect, it } from "vitest";
import { D10_ANGLES } from "@/lib/cortex/angles/d10";
import { D7_ANGLES } from "@/lib/cortex/angles/d7";
import { D9_ANGLES } from "@/lib/cortex/angles/d9";
import {
  ANGLE_ID_RE,
  ANGLES,
  ANGLE_COUNT,
  ANGLES_PER_DOMAIN,
  angleById,
  canActivate,
  defaultGrid,
  defineAngles,
  domainOf,
  evaluateAngle,
  LIVE_READERS,
  rankStandardise,
  resolveStatus,
  scoredSet,
} from "@/lib/cortex/angles/registry";
import {
  ANGLE_CLUSTERS,
  GATE_CLUSTERS,
  type AngleDef,
  type AsOfView,
} from "@/lib/cortex/angles/types";
import { INPUT_KINDS } from "@/lib/cortex/pit/types";

const score = (over: Partial<AngleDef> = {}): AngleDef => ({
  id: "A-D1-01",
  version: 1,
  domain: 1,
  title: "t",
  definition: "d",
  kind: "score",
  cluster: "momentum",
  orientation: 1,
  horizonSessions: 20,
  warmupSessions: 10,
  inputs: ["bar_au"],
  grid: { lookback: [126, 100, 140] },
  compute: () => 0.5,
  ...over,
});

// The registry never touches the view for an entry without a compute; this stub proves it.
const noView = new Proxy({} as AsOfView, {
  get(_t, prop) {
    throw new Error(`view.${String(prop)} must not be read`);
  },
});

describe("the full registry (D-331)", () => {
  it("holds exactly the 100 ids A-D1-01…A-D10-10, sorted by domain then id", () => {
    expect(ANGLES.length).toBe(ANGLE_COUNT);
    const want: string[] = [];
    for (let d = 1; d <= 10; d++) {
      for (let i = 1; i <= ANGLES_PER_DOMAIN; i++)
        want.push(`A-D${d}-${String(i).padStart(2, "0")}`);
    }
    expect(ANGLES.map((a) => a.id)).toEqual(want);
    expect(angleById("A-D1-01")?.domain).toBe(1);
  });
});

describe("the C1a entries: D7, D9, D10", () => {
  it("are the 30 gate and meta entries, none scored, none with a compute (D-292)", () => {
    const c1a = ANGLES.filter((a) => [7, 9, 10].includes(a.domain));
    expect(c1a.map((a) => a.id)).toEqual(
      [...D7_ANGLES, ...D9_ANGLES, ...D10_ANGLES].map((a) => a.id),
    );
    for (const a of c1a) {
      expect(a.id).toMatch(ANGLE_ID_RE);
      expect([7, 9, 10]).toContain(a.domain);
      expect(a.kind).not.toBe("score");
      expect(GATE_CLUSTERS).toContain(a.cluster);
      expect(a.compute).toBeUndefined();
      expect(a.orientation).toBe(1);
      expect(a.existing?.length).toBeGreaterThan(0); // the passport cites the existing module
      expect(a.inputs.every((k) => INPUT_KINDS.includes(k))).toBe(true);
    }
    expect(angleById("A-D7-02")?.existing).toContain("src/lib/agents/families/stopCap.ts");
    expect(angleById("A-D7-10")?.existing).toContain("src/lib/stats/killSwitch.ts");
    expect(angleById("A-D9-07")?.existing).toContain("ARN-108");
  });

  it("the announcement-dependent entries are candidates (CTX-051) and nothing else needs data", () => {
    const c1a = ANGLES.filter((a) => [7, 9, 10].includes(a.domain));
    const needs = c1a.filter((a) => a.needsData).map((a) => a.id);
    expect(needs).toEqual(["A-D9-02", "A-D9-03", "A-D10-05", "A-D10-06"]);
    for (const a of c1a) {
      const s = resolveStatus(a, "active");
      expect(s).toBe(a.needsData ? "candidate" : "active");
      expect(evaluateAngle(a, s, noView, "ZZA", 0)).toBeUndefined(); // no compute -> undefined
    }
  });

  it("every D7 entry is risk or regime; D9 risk/regime/meta; D10 meta; gates are gates", () => {
    for (const a of D7_ANGLES) expect(["risk", "regime"]).toContain(a.cluster);
    for (const a of D10_ANGLES) expect(a.cluster).toBe("meta");
    const gates = ANGLES.filter((a) => [7, 9, 10].includes(a.domain) && a.kind === "gate").map(
      (a) => a.id,
    );
    expect(gates).toEqual([
      "A-D7-01",
      "A-D7-02",
      "A-D7-04",
      "A-D7-05",
      "A-D7-07",
      "A-D7-08",
      "A-D7-10",
      "A-D9-01",
      "A-D9-02",
      "A-D9-03",
      "A-D9-04",
      "A-D9-06",
      "A-D9-08",
      "A-D10-01",
      "A-D10-02",
      "A-D10-08",
    ]);
  });
});

describe("status rules", () => {
  it("LIVE_READERS: every live kind but macro (D-291)", () => {
    expect([...LIVE_READERS].sort()).toEqual(INPUT_KINDS.filter((k) => k !== "macro").sort());
  });

  it("activatable only when every input has a live reader; macro angles are measured at most", () => {
    expect(canActivate(score())).toEqual({ ok: true });
    const macro = score({ inputs: ["bar_au", "macro"] });
    expect(canActivate(macro)).toEqual({ ok: false, reason: "no_live_reader", missing: ["macro"] });
    expect(resolveStatus(macro, "active")).toBe("measured");
    expect(resolveStatus(macro, "watch")).toBe("measured");
    expect(resolveStatus(macro, "measured")).toBe("measured");
    expect(resolveStatus(macro, "candidate")).toBe("candidate");
    // A reader set that includes macro (offline) lets it activate.
    expect(resolveStatus(macro, "active", new Set(INPUT_KINDS))).toBe("active");
  });

  it("needs_data or a score angle without a compute stays candidate; retired stays retired", () => {
    const nd = score({ needsData: "announcement archive" });
    expect(canActivate(nd)).toEqual({ ok: false, reason: "needs_data", missing: [] });
    expect(resolveStatus(nd, "active")).toBe("candidate");
    expect(resolveStatus(nd, "measured")).toBe("candidate");
    expect(resolveStatus(nd, "retired")).toBe("retired");
    const nc = score({ compute: undefined });
    expect(canActivate(nc)).toEqual({ ok: false, reason: "no_compute", missing: [] });
    expect(resolveStatus(nc, "active")).toBe("candidate");
  });

  it("evaluateAngle: candidate and retired return undefined without touching the view", () => {
    const a = score();
    expect(evaluateAngle(a, "candidate", noView, "ZZA", 0)).toBeUndefined();
    expect(evaluateAngle(a, "retired", noView, "ZZA", 0)).toBeUndefined();
    expect(evaluateAngle(a, "active", noView, "ZZA", 0)).toBe(0.5);
    expect(evaluateAngle(a, "measured", noView, "ZZA", 0)).toBe(0.5);
  });

  it("evaluateAngle passes the default grid point (first of each dimension) unless one is given", () => {
    const seen: unknown[] = [];
    const a = score({
      grid: { lookback: [126, 100], skip: [0, 21] },
      compute: (_v, _c, _t, g) => {
        seen.push(g);
        return 1;
      },
    });
    expect(defaultGrid(a)).toEqual({ lookback: 126, skip: 0 });
    evaluateAngle(a, "active", noView, "ZZA", 3);
    evaluateAngle(a, "active", noView, "ZZA", 3, { lookback: 100, skip: 21 });
    expect(seen).toEqual([
      { lookback: 126, skip: 0 },
      { lookback: 100, skip: 21 },
    ]);
  });

  it("scoredSet: score kind with status active or watch (watch keeps its weight, CTX-032)", () => {
    const defs = [
      score({ id: "A-D1-01" }),
      score({ id: "A-D1-02" }),
      score({ id: "A-D1-03" }),
      {
        ...score({
          id: "A-D7-01",
          domain: 7,
          kind: "gate",
          cluster: "risk",
          existing: ["FAM-005"],
        }),
      },
    ];
    const status: Record<string, "active" | "watch" | "measured" | "candidate"> = {
      "A-D1-01": "active",
      "A-D1-02": "watch",
      "A-D1-03": "measured",
      "A-D7-01": "active",
    };
    expect(scoredSet(defs, (id) => status[id]!).map((a) => a.id)).toEqual(["A-D1-01", "A-D1-02"]);
  });
});

describe("defineAngles validation", () => {
  it("sorts by domain then id and accepts the score clusters of CTX-011", () => {
    const out = defineAngles([
      score({ id: "A-D10-01", domain: 10, cluster: "sentiment" }),
      score({ id: "A-D2-03", domain: 2, cluster: "event" }),
      score({ id: "A-D2-01", domain: 2, cluster: "quality" }),
    ]);
    expect(out.map((a) => a.id)).toEqual(["A-D2-01", "A-D2-03", "A-D10-01"]);
    expect(ANGLE_CLUSTERS.length).toBe(6);
    expect(domainOf("A-D10-07")).toBe(10);
    expect(() => domainOf("A-D11-01")).toThrow(RangeError);
  });

  it("rejects duplicates, a domain that does not match the id, bad clusters, grids and orientation", () => {
    expect(() => defineAngles([score(), score()])).toThrow(/duplicate/);
    expect(() => defineAngles([score({ domain: 2 })])).toThrow(/domain/);
    expect(() => defineAngles([score({ cluster: "risk" })])).toThrow(/score cluster/);
    expect(() =>
      defineAngles([score({ kind: "gate", cluster: "momentum", existing: ["x"] })]),
    ).toThrow(/gate cluster/);
    expect(() => defineAngles([score({ grid: { k: [] } })])).toThrow(/grid/);
    expect(() => defineAngles([score({ grid: { k: [Number.NaN] } })])).toThrow(/grid/);
    expect(() => defineAngles([score({ orientation: 0 as unknown as 1 })])).toThrow(/orientation/);
    expect(() => defineAngles([score({ version: 0 })])).toThrow(/version/);
    expect(() => defineAngles([score({ inputs: ["bar_au", "bar_au"] })])).toThrow(
      /duplicate input/,
    );
    expect(() => defineAngles([score({ horizonSessions: -1 })])).toThrow(/horizon/);
    expect(() => defineAngles([score({ warmupSessions: 1.5 })])).toThrow(/warm-up/);
  });

  it("a gate or meta entry without a compute must cite its existing rule (D-292)", () => {
    const bare = score({ kind: "gate", cluster: "risk", compute: undefined });
    expect(() => defineAngles([bare])).toThrow(/D-292/);
    expect(() => defineAngles([{ ...bare, existing: ["FAM-005"] }])).not.toThrow();
    expect(() => defineAngles([{ ...bare, needsData: "fundamentals" }])).not.toThrow();
    // A gate with its own compute (a calendar flag, say) needs no citation.
    expect(() =>
      defineAngles([score({ kind: "gate", cluster: "calendar", compute: () => ({ flag: "x" }) })]),
    ).not.toThrow();
  });
});

describe("rankStandardise", () => {
  it("maps the lowest to -1 and the highest to +1, linearly in average rank", () => {
    const r = rankStandardise(
      new Map([
        ["ZZC", 3],
        ["ZZA", 1],
        ["ZZB", 2],
      ]),
      1,
    );
    expect([...r.entries()]).toEqual([
      ["ZZA", -1],
      ["ZZB", 0],
      ["ZZC", 1],
    ]);
  });

  it("ties share the average rank, so equal inputs give equal outputs whatever the insertion order", () => {
    const a = rankStandardise(
      new Map([
        ["ZZA", 1],
        ["ZZB", 1],
        ["ZZC", 3],
      ]),
      1,
    );
    const b = rankStandardise(
      new Map([
        ["ZZC", 3],
        ["ZZB", 1],
        ["ZZA", 1],
      ]),
      1,
    );
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.get("ZZA")).toBe(-0.5);
    expect(a.get("ZZB")).toBe(-0.5);
    expect(a.get("ZZC")).toBe(1);
    const all = rankStandardise(
      new Map([
        ["ZZA", 7],
        ["ZZB", 7],
      ]),
      1,
    );
    expect([...all.values()]).toEqual([0, 0]);
  });

  it("orientation -1 flips the sign (CTX-011: +1 favourable to a long entry)", () => {
    const r = rankStandardise(
      new Map([
        ["ZZA", 1],
        ["ZZB", 2],
        ["ZZC", 3],
      ]),
      -1,
    );
    expect([...r.values()]).toEqual([1, 0, -1]);
    expect(Object.is(r.get("ZZB"), -0)).toBe(false); // never -0 (same bytes in every store)
  });

  it("drops non-finite values; one code maps to 0; empty stays empty", () => {
    const r = rankStandardise(
      new Map([
        ["ZZA", Number.NaN],
        ["ZZB", 5],
        ["ZZC", Number.POSITIVE_INFINITY],
      ]),
      1,
    );
    expect([...r.entries()]).toEqual([["ZZB", 0]]);
    expect(rankStandardise(new Map(), 1).size).toBe(0);
  });

  it("every output lies in [-1, 1] and the mean rank maps to 0 on a larger universe", () => {
    const values = new Map<string, number>();
    for (let i = 0; i < 101; i += 1) values.set(`ZZ${String(i).padStart(3, "0")}`, (i * 37) % 101);
    const r = rankStandardise(values, 1);
    let sum = 0;
    for (const v of r.values()) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      sum += v;
    }
    expect(sum).toBeCloseTo(0, 12);
  });
});

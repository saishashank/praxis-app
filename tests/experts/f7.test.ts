// @vitest-environment node
// F7 gate (M13-lite WP5; KB-078, D-518): pure grade and gate rules.
import { describe, expect, it } from "vitest";
import { clusterGrade, f7Gate, maximumMatching } from "@/lib/experts/f7";

describe("clusterGrade", () => {
  it("L0 unscreened, L1 survived, L2 only when the challenger passed VAL-110 or is promoted", () => {
    expect(clusterGrade({ survived: false, challenger: null })).toBe("L0");
    expect(clusterGrade({ survived: true, challenger: null })).toBe("L1");
    expect(
      clusterGrade({ survived: true, challenger: { state: "replay", passedVal110: false } }),
    ).toBe("L1");
    expect(
      clusterGrade({ survived: true, challenger: { state: "rejected", passedVal110: false } }),
    ).toBe("L1");
    expect(
      clusterGrade({ survived: true, challenger: { state: "shakedown", passedVal110: true } }),
    ).toBe("L2");
    expect(
      clusterGrade({ survived: true, challenger: { state: "promoted", passedVal110: false } }),
    ).toBe("L2");
  });
});

describe("f7Gate", () => {
  const k = (clusterId: string, ...expertIds: string[]) => ({ clusterId, expertIds });
  it("fires only at min distinct supporting-expert sets", () => {
    expect(f7Gate([], 3)).toEqual({ fires: false, distinctExperts: 0, clusters: 0 });
    expect(f7Gate([k("K-1", "X-1"), k("K-2", "X-2")], 3).fires).toBe(false);
    const v = f7Gate([k("K-1", "X-1"), k("K-2", "X-2"), k("K-3", "X-3", "X-1")], 3);
    expect(v).toEqual({ fires: true, distinctExperts: 3, clusters: 3 });
  });
  it("clusters resting on the same people count once; empty sets never count", () => {
    const v = f7Gate(
      [k("K-1", "X-1", "X-2"), k("K-2", "X-2", "X-1"), k("K-3"), k("K-4", "X-3")],
      3,
    );
    expect(v.clusters).toBe(2);
    expect(v.fires).toBe(false);
  });
  it("counts only clusters that can each be credited to a different expert (D-621)", () => {
    // {A}, {B}, {A,B}: three distinct sets, two experts -> the third cluster has no voice of its own
    const v = f7Gate([k("K-1", "X-A"), k("K-2", "X-B"), k("K-3", "X-A", "X-B")], 3);
    expect(v).toEqual({ fires: false, distinctExperts: 2, clusters: 2 });
    // a union of four experts is not enough either when the matching is three
    const w = f7Gate(
      [k("K-1", "X-A"), k("K-2", "X-B"), k("K-3", "X-A", "X-B"), k("K-4", "X-C", "X-D")],
      4,
    );
    expect(w).toEqual({ fires: false, distinctExperts: 4, clusters: 3 });
    expect(maximumMatching([["X-A"], ["X-A", "X-B"], ["X-B", "X-C"]])).toBe(3);
    expect(maximumMatching([])).toBe(0);
  });
  it("a minimum below one never fires", () => {
    expect(f7Gate([k("K-1", "X-1")], 0).fires).toBe(false);
  });
});

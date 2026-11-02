// @vitest-environment node
// The C1c package as one set (M15; docs/M15_design.md 2 "C1c"; CTX-011, CTX-051; D-271, D-290,
// D-291, D-292): fifty validated ids that merge with the C1a entries without a clash, the status
// each resolves to under the live reader set, and the rules the package promised (announcement
// angles candidate, macro never active, sector angles candidate, D7/D9/D10-style citations on
// every gate without a compute).
import { describe, expect, it } from "vitest";
import { D10_ANGLES } from "@/lib/cortex/angles/d10";
import { D3_ANGLES } from "@/lib/cortex/angles/d3";
import { D4_ANGLES } from "@/lib/cortex/angles/d4";
import { D5_ANGLES } from "@/lib/cortex/angles/d5";
import { D6_ANGLES } from "@/lib/cortex/angles/d6";
import { D7_ANGLES } from "@/lib/cortex/angles/d7";
import { D8_ANGLES } from "@/lib/cortex/angles/d8";
import { D9_ANGLES } from "@/lib/cortex/angles/d9";
import {
  ANGLE_ID_RE,
  ANGLES_PER_DOMAIN,
  canActivate,
  defaultGrid,
  defineAngles,
  domainOf,
  evaluateAngle,
  resolveStatus,
} from "@/lib/cortex/angles/registry";
import { ANGLE_CLUSTERS, GATE_CLUSTERS, type AsOfView } from "@/lib/cortex/angles/types";
import { INPUT_KINDS } from "@/lib/cortex/pit/types";

const C1C = [...D3_ANGLES, ...D4_ANGLES, ...D5_ANGLES, ...D6_ANGLES, ...D8_ANGLES];
const C1A = [...D7_ANGLES, ...D9_ANGLES, ...D10_ANGLES];

const noView = new Proxy({} as AsOfView, {
  get(_t, prop) {
    throw new Error(`view.${String(prop)} must not be read`);
  },
});

describe("C1c: D3, D4, D5, D6, D8", () => {
  it("is fifty validated passports that merge with C1a into eighty distinct ids", () => {
    const defs = defineAngles(C1C);
    expect(defs.length).toBe(5 * ANGLES_PER_DOMAIN);
    expect(defineAngles([...C1A, ...C1C]).length).toBe(80);
    for (const domain of [3, 4, 5, 6, 8]) {
      expect(defs.filter((a) => a.domain === domain).length).toBe(ANGLES_PER_DOMAIN);
    }
    for (const a of defs) {
      expect(a.id).toMatch(ANGLE_ID_RE);
      expect(domainOf(a.id)).toBe(a.domain);
      expect(a.version).toBe(1);
      expect(a.orientation).toBe(1);
      expect(a.definition.length).toBeGreaterThan(40);
      expect(a.inputs.every((k) => INPUT_KINDS.includes(k))).toBe(true);
      if (a.kind === "score") expect(ANGLE_CLUSTERS).toContain(a.cluster);
      else expect(GATE_CLUSTERS).toContain(a.cluster);
      if (a.kind !== "score" && a.compute === undefined && !a.needsData)
        expect(a.existing?.length).toBeGreaterThan(0); // D-292
      for (const pts of Object.values(a.grid)) expect(pts.length).toBeGreaterThan(0);
      expect(Object.keys(defaultGrid(a))).toEqual(Object.keys(a.grid));
    }
  });

  it("announcement-dependent entries carry the archive needsData and resolve to candidate (CTX-051)", () => {
    const announcement = C1C.filter((a) => a.inputs.includes("announcement")).map((a) => a.id);
    expect(announcement).toEqual([
      ...D3_ANGLES.map((a) => a.id),
      "A-D4-04",
      "A-D5-10",
      "A-D6-02",
      "A-D6-06",
      "A-D6-07",
      "A-D6-08",
      "A-D8-04",
      "A-D8-06",
    ]);
    // A-D8-05 reads the DAT-234 list and the calendar only; the archive needsData keeps it candidate.
    const d805 = C1C.find((x) => x.id === "A-D8-05")!;
    expect(d805.inputs).toEqual(["index_change", "calendar"]);
    expect(d805.needsData).toMatch(/announcement archive/);
    expect(resolveStatus(d805, "active")).toBe("candidate");
    for (const id of announcement) {
      const a = C1C.find((x) => x.id === id)!;
      expect(a.needsData).toMatch(/announcement archive/);
      expect(resolveStatus(a, "active")).toBe("candidate");
      expect(resolveStatus(a, "measured")).toBe("candidate");
      // The registry never touches the view for a candidate.
      expect(evaluateAngle(a, resolveStatus(a, "active"), noView, "ZZA", 0)).toBeUndefined();
    }
  });

  it("macro angles are measured at most (D-291); the US-index angle is activatable (D-290)", () => {
    const macro = C1C.filter((a) => a.inputs.includes("macro")).map((a) => a.id);
    expect(macro).toEqual(["A-D5-05", "A-D5-06", "A-D5-09"]);
    for (const id of ["A-D5-05", "A-D5-09"]) {
      const a = C1C.find((x) => x.id === id)!;
      expect(canActivate(a)).toEqual({ ok: false, reason: "no_live_reader", missing: ["macro"] });
      expect(resolveStatus(a, "active")).toBe("measured");
      expect(resolveStatus(a, "watch")).toBe("measured");
      expect(resolveStatus(a, "candidate")).toBe("candidate");
    }
    const us = C1C.find((x) => x.id === "A-D5-08")!;
    expect(us.inputs).toEqual(["index_us"]);
    expect(canActivate(us)).toEqual({ ok: true });
  });

  it("sector angles read the map and are candidates in replay (D-271)", () => {
    for (const id of ["A-D5-03", "A-D5-04"]) {
      const a = C1C.find((x) => x.id === id)!;
      expect(a.inputs).toContain("sector_map");
      expect(a.needsData).toMatch(/sector map/);
      expect(resolveStatus(a, "active")).toBe("candidate");
    }
  });

  it("the activatable set is exactly the price / ASIC / calendar / index angles", () => {
    const active = C1C.filter((a) => resolveStatus(a, "active") === "active").map((a) => a.id);
    expect(active).toEqual([
      "A-D4-05",
      "A-D4-07",
      "A-D4-08",
      "A-D5-01",
      "A-D5-02",
      "A-D5-08",
      "A-D6-01",
      "A-D6-03",
      "A-D6-10",
      "A-D8-01",
      "A-D8-02",
      "A-D8-03",
      "A-D8-07",
      "A-D8-08",
      "A-D8-09",
      "A-D8-10",
    ]);
    for (const id of active) {
      const a = C1C.find((x) => x.id === id)!;
      if (a.kind === "score") expect(a.compute).toBeDefined();
      if (a.compute === undefined)
        expect(evaluateAngle(a, "active", noView, "ZZA", 0)).toBeUndefined();
    }
  });
});

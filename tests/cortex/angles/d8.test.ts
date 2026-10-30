// @vitest-environment node
// D8 Timing, calendar and execution (M15 C1c; angles_D8.md; CTX-014, CTX-022b, CTX-024, CTX-028;
// D-292): every entry is a gate; the existing v1 rules are cited without a compute; the ex-date
// flag, the index-event window and the weekday / holiday bucket are computed from the vendor
// actions, the DAT-234 list and the trading calendar.
import { describe, expect, it } from "vitest";
import { D8_ANGLES } from "@/lib/cortex/angles/d8";
import {
  ANGLES_PER_DOMAIN,
  canActivate,
  defaultGrid,
  defineAngles,
  evaluateAngle,
  resolveStatus,
} from "@/lib/cortex/angles/registry";
import { GATE_CLUSTERS } from "@/lib/cortex/angles/types";
import { buildAsOfView, sessionIndexOf } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant } from "@/lib/cortex/pit/truncation";
import { longWorld } from "./d3to8World";

const world = longWorld({ sessions: 300 });
const view = buildAsOfView(world);
const T = world.sessions.length - 1;
const byId = (id: string) => D8_ANGLES.find((a) => a.id === id)!;
const run = (id: string, t: number, grid: Record<string, number> = {}, code = "ZZA", v = view) => {
  const def = byId(id);
  return def.compute!(v, code, t, { ...defaultGrid(def), ...grid });
};
const at = (d: string) => sessionIndexOf(world.sessions, d);

describe("D8 passports", () => {
  it("has ten validated gate entries: existing rules cited, three computes, three candidates", () => {
    const defs = defineAngles(D8_ANGLES);
    expect(defs.length).toBe(ANGLES_PER_DOMAIN);
    for (const a of defs) {
      expect(a.domain).toBe(8);
      expect(a.kind).toBe("gate");
      expect(GATE_CLUSTERS).toContain(a.cluster);
      expect(a.orientation).toBe(1);
      expect(a.existing?.length).toBeGreaterThan(0);
    }
    expect(defs.map((a) => a.cluster)).toEqual([
      "risk",
      "risk",
      "calendar",
      "calendar",
      "calendar",
      "calendar",
      "calendar",
      "risk",
      "risk",
      "risk",
    ]);
    expect(D8_ANGLES.filter((a) => a.compute).map((a) => a.id)).toEqual([
      "A-D8-03",
      "A-D8-05",
      "A-D8-07",
    ]);
    expect(defs.map((a) => resolveStatus(a, "active"))).toEqual([
      "active",
      "active",
      "active",
      "candidate", // 04 results season
      "candidate", // 05 index dates (announcement archive per CTX-051)
      "candidate", // 06 days-to-event
      "active",
      "active",
      "active",
      "active",
    ]);
    for (const id of ["A-D8-04", "A-D8-05", "A-D8-06"]) {
      if (id !== "A-D8-05") expect(byId(id).inputs).toContain("announcement"); // N3: inputs = what the compute reads
      expect(byId(id).needsData).toMatch(/announcement archive/);
      expect(canActivate(byId(id)).ok).toBe(false);
      expect(evaluateAngle(byId(id), "candidate", view, "ZZA", T)).toBeUndefined();
    }
    expect(byId("A-D8-01").existing).toContain("src/lib/agents/families/exits.ts gapCancelLevel");
    expect(byId("A-D8-08").existing).toContain("CTX-014");
    expect(byId("A-D8-09").existing).toContain("FAM-002");
    expect(byId("A-D8-10").existing).toContain("ARN-106");
    // A gate without a compute evaluates to undefined through the registry (the gate list calls the module).
    expect(evaluateAngle(byId("A-D8-01"), "active", view, "ZZA", T)).toBeUndefined();
  });
});

describe("D8 computes", () => {
  it("A-D8-03 ex-date flag: tonight is the ex-date of ZZA's 0.10 dividend; offsets move the match", () => {
    expect(run("A-D8-03", T)).toEqual({ flag: "ex_date_adjusted" });
    expect(run("A-D8-03", T - 1)).toEqual({ flag: "none" });
    expect(run("A-D8-03", T - 1, { ex_offset: 1 })).toEqual({ flag: "ex_date_adjusted" });
    expect(run("A-D8-03", T - 2, { ex_offset: 2 })).toEqual({ flag: "none" }); // the row is unknown two sessions out
    expect(run("A-D8-03", T, { ex_offset: -1 })).toEqual({ flag: "none" });
    expect(run("A-D8-03", T - 99)).toEqual({ flag: "ex_date_adjusted" }); // the 0.30 dividend
    expect(run("A-D8-03", T - 98, { ex_offset: -1 })).toEqual({ flag: "ex_date_adjusted" });
    expect(run("A-D8-03", T, {}, "ZZB")).toEqual({ flag: "none" });
    expect(run("A-D8-03", 0)).toEqual({ flag: "none" });
  });

  it("A-D8-05 index-event window [D - 1, D + 20]: ZZC's delete (effective T - 1); unknown when the list is missing", () => {
    expect(run("A-D8-05", T - 1, {}, "ZZC")).toEqual({ flag: "excluded_index_event" }); // D = effective
    expect(run("A-D8-05", T, {}, "ZZC")).toEqual({ flag: "excluded_index_event" }); // D - 1
    expect(run("A-D8-05", T - 7, {}, "ZZC")).toEqual({ flag: "none" }); // announced, not yet known (D-302)
    expect(run("A-D8-05", T - 6, {}, "ZZC")).toEqual({ flag: "excluded_index_event" });
    expect(run("A-D8-05", T, {}, "ZZB")).toEqual({ flag: "none" }); // effective beyond the calendar
    expect(run("A-D8-05", T, {}, "ZZA")).toEqual({ flag: "none" });
    const missing = buildAsOfView({ ...world, indexChanges: null });
    expect(run("A-D8-05", T, {}, "ZZA", missing)).toEqual({ flag: "unknown" });
    expect(missing.indexChangesLoaded).toBe(false);
  });

  it("A-D8-07 weekday and holiday buckets around Australia Day 2020", () => {
    expect(run("A-D8-07", at("2020-01-24"))).toEqual({ bucket: "pre_holiday" });
    expect(run("A-D8-07", at("2020-01-28"))).toEqual({ bucket: "post_holiday" });
    expect(run("A-D8-07", at("2020-01-29"))).toEqual({ bucket: "wed" });
    expect(run("A-D8-07", at("2020-01-06"))).toEqual({ bucket: "mon" });
    expect(run("A-D8-07", at("2020-01-10"))).toEqual({ bucket: "fri" });
    expect(run("A-D8-07", at("2020-01-23"))).toEqual({ bucket: "thu" });
  });

  it("every compute passes TST-109 on the long world", () => {
    const ts = [0, 1, at("2020-01-24"), at("2020-01-28"), T - 23, T - 7, T - 6, T - 2, T - 1, T];
    for (const def of D8_ANGLES.filter((a) => a.compute)) {
      assertTruncationInvariant(world, (v, c, t) => evaluateAngle(def, "active", v, c, t), { ts });
      assertTruncationInvariant(
        world,
        (v, c, t) => evaluateAngle(def, "active", v, c, t, { ...defaultGrid(def), ex_offset: 1 }),
        { ts },
      );
    }
  });
});

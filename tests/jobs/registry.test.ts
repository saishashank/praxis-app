// @vitest-environment node
// The job registry (D-840, D-841): the ONE list of scheduled jobs the Owner can also run by hand. It is
// checked here against the Worker slot table, the dispatchable workflows and the workflow files, so a job
// added to the schedule without a registry entry fails this test. Also the per-job parameter schema.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AU_SLOTS, DISPATCHABLE_WORKFLOWS } from "../../worker/src/schedule";
import { GO_LIVE_SLOTS } from "@/lib/golive/slots";
import { findJob, JOBS, RUNNABLE_JOBS, validateParams } from "@/lib/jobs/registry.mjs";

const ROOT = path.resolve(__dirname, "../..");

describe("the registry equals the Worker table", () => {
  it("has one job per slot id, no extras, and unique ids", () => {
    const ids = JOBS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(AU_SLOTS.map((s) => s.id)));
  });

  it("agrees with each slot: kind, workflow, route, time, trading days, monthly, listing", () => {
    for (const s of AU_SLOTS) {
      const j = findJob(s.id)!;
      expect(j, s.id).toBeDefined();
      expect(j.kind, s.id).toBe(
        s.runner === "actions" ? "workflow" : s.runner === "route" ? "route" : "worker-internal",
      );
      expect(j.workflow, s.id).toBe(s.workflow ?? undefined);
      expect(j.route, s.id).toBe(s.route);
      expect(j.time, s.id).toBe(s.time);
      expect(j.days === "trading", s.id).toBe(s.tradingDaysOnly);
      expect(j.days === "first-saturday", s.id).toBe(s.monthly === "first-saturday");
      expect(j.safety === "go-live", s.id).toBe(s.requiresListing === true);
      expect(j.safety === "internal", s.id).toBe(!s.enabled);
      expect(j.runNow, s.id).toBe(s.enabled);
    }
  });

  it("every dispatchable workflow belongs to at least one job, and every workflow file exists", () => {
    const used = new Set(JOBS.flatMap((j) => (j.workflow ? [j.workflow] : [])));
    for (const w of DISPATCHABLE_WORKFLOWS) expect(used.has(w), w).toBe(true);
    for (const w of used) {
      expect(DISPATCHABLE_WORKFLOWS.includes(w), w).toBe(true);
      expect(existsSync(path.join(ROOT, ".github", "workflows", w)), w).toBe(true);
    }
  });

  it("every route job points at a real route file", () => {
    for (const j of JOBS.filter((x) => x.kind === "route")) {
      const file = path.join(ROOT, "src/app", `${j.route!}`, "route.ts");
      expect(existsSync(file), j.id).toBe(true);
    }
  });

  it("GO_LIVE_SLOTS (the Owner list) is derived from the go-live jobs", () => {
    expect(GO_LIVE_SLOTS.map((s) => s.id)).toEqual(
      JOBS.filter((j) => j.safety === "go-live").map((j) => j.id),
    );
  });
});

describe("registry rules", () => {
  it("is Owner-only, plain words, no blueprint, schedule text matches time and day type", () => {
    for (const j of JOBS) {
      expect(j.ownerOnly, j.id).toBe(true);
      expect(/^\d\d:\d\d$/.test(j.time), j.id).toBe(true);
      expect(j.schedule.includes(j.time), j.id).toBe(true);
      expect(j.schedule.startsWith("Trading days"), j.id).toBe(j.days === "trading");
      expect(`${j.label} ${j.schedule}`.toLowerCase(), j.id).not.toContain("blueprint");
      expect(j.id, j.id).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  it("has a per-job hourly cap of at least 1 and plain-word notes (D-851)", () => {
    for (const j of JOBS) {
      expect(Number.isInteger(j.maxPerHour) && j.maxPerHour >= 1, j.id).toBe(true);
      if (j.note !== undefined) {
        expect(j.note.toLowerCase(), j.id).not.toContain("blueprint");
        expect(j.note.endsWith("."), j.id).toBe(true);
      }
    }
    expect(findJob("llm-bakeoff")?.maxPerHour).toBe(1);
    expect(findJob("arena-close")?.note).toBeDefined();
    expect(findJob("arena-signals")?.note).toBeDefined();
    expect(findJob("backup")?.maxPerHour).toBe(6);
  });

  it("only workflows or routes can be run by hand; Worker-internal jobs never", () => {
    for (const j of JOBS) {
      expect(j.runNow, j.id).toBe(j.kind !== "worker-internal");
    }
    expect(RUNNABLE_JOBS.every((j) => j.kind !== "worker-internal")).toBe(true);
    expect(findJob("asx-poll")?.runNow).toBe(false);
  });

  it("findJob is exact", () => {
    expect(findJob("backup")?.id).toBe("backup");
    expect(findJob("BACKUP")).toBeUndefined();
    expect(findJob(5)).toBeUndefined();
    expect(findJob("__proto__")).toBeUndefined();
  });
});

describe("validateParams", () => {
  const TODAY = "2026-11-02";
  const dated = findJob("evening-review")!;
  const plain = findJob("backup")!;

  it("a dateless job takes no parameters", () => {
    expect(validateParams(plain, undefined, TODAY)).toEqual({});
    expect(validateParams(plain, {}, TODAY)).toEqual({});
    expect(validateParams(plain, { d: TODAY }, TODAY)).toBeNull();
    expect(validateParams(plain, { x: 1 }, TODAY)).toBeNull();
    expect(validateParams(plain, "d", TODAY)).toBeNull();
    expect(validateParams(plain, [], TODAY)).toBeNull();
  });

  it("a dated job takes today or the allowed days back, and defaults to today", () => {
    expect(validateParams(dated, {}, TODAY)).toEqual({ d: TODAY });
    expect(validateParams(dated, { d: "" }, TODAY)).toEqual({ d: TODAY });
    expect(validateParams(dated, { d: TODAY }, TODAY)).toEqual({ d: TODAY });
    expect(validateParams(dated, { d: "2026-11-01" }, TODAY)).toEqual({ d: "2026-11-01" });
    expect(validateParams(dated, { d: "2026-10-31" }, TODAY)).toBeNull();
    expect(validateParams(dated, { d: "2026-11-03" }, TODAY)).toBeNull();
  });

  it("refuses malformed dates and extra keys", () => {
    for (const d of ["2026-02-30", "2026-13-01", "11/02/2026", "2026-11-2", 20261102, true]) {
      expect(validateParams(dated, { d }, TODAY), String(d)).toBeNull();
    }
    expect(validateParams(dated, { d: TODAY, extra: "1" }, TODAY)).toBeNull();
    expect(validateParams(dated, { d: TODAY }, "not a date")).toBeNull();
  });
});

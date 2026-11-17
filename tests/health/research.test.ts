// @vitest-environment node
// M23 M4 (D-1643, D-1764): the System Health research line, plain words, never a throw.
import { afterEach, describe, expect, it } from "vitest";
import { loadResearchHealth, researchHealthOf } from "@/lib/health/research";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { apply } from "../../e2e/seed/states/cortex-research.mjs";

afterEach(cleanupTempDbs);

describe("researchHealthOf", () => {
  it("says no alarm and no refusal, and counts with the right singular", () => {
    expect(researchHealthOf({ alarms: 0, refusals: 0 }).line).toBe(
      "Research tests and risk monitors: no open alarm, no second look refused",
    );
    expect(researchHealthOf({ alarms: 1, refusals: 1 }).line).toBe(
      "Research tests and risk monitors: 1 open alarm, 1 second look refused",
    );
    expect(researchHealthOf({ alarms: 3, refusals: 2 })).toEqual({
      state: "ok",
      line: "Research tests and risk monitors: 3 open alarms, 2 second looks refused",
    });
  });
});

describe("loadResearchHealth", () => {
  it("reads a fresh database as clear, the seed as open alarms and one refusal, and a failed read as attention", async () => {
    const db = await freshDb("main");
    expect((await loadResearchHealth(db)).line).toBe(
      "Research tests and risk monitors: no open alarm, no second look refused",
    );
    await apply(db, "2026-10-16T09:00:00Z");
    // the stall monitor in its newest quarter, and the one-off lens revisit row
    expect((await loadResearchHealth(db)).line).toBe(
      "Research tests and risk monitors: 2 open alarms, 1 second look refused",
    );
    const bad = {
      execute: async (): Promise<never> => {
        throw new Error("down");
      },
    };
    expect(await loadResearchHealth(bad)).toEqual({
      state: "attention",
      line: "Research tests and risk monitors: their state could not be read",
    });
  });
});

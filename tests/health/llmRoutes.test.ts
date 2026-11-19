// @vitest-environment node
// M22 L1 (D-1446): the routes line of System Health: plain words, job names from ROLE_WORDS, never a job code, a model id or a key.
import { describe, expect, it } from "vitest";
import { routesHealthOf } from "@/lib/health/llmRoutes";
import { routesStatus } from "@/lib/llm/factory";
import type { RoleVerdict } from "@/lib/llm/bakeoffIndex.generated";
import type { GateRole, RosterEntry } from "@/lib/llm/roster";

const row: RosterEntry = {
  provider: "groq",
  modelId: "mid-27b",
  tier: "medium",
  roles: [],
  limits: { rpm: null, rpd: null, tpm: null },
  trainsOnPrompts: false,
  strictSchema: null,
  knowledgeCutoff: null,
  checkedOn: "2026-11-17",
  status: "verified",
  sourceUrl: "https://example.invalid/limits",
  note: "fixture",
};
const idx = (g: GateRole): Partial<Record<GateRole, RoleVerdict>> => ({
  [g]: { verdict: "PASS", date: "2026-11-20", run: "r", report: "r.md", models: ["mid-27b"] },
});
const line = (liveRoles: string[] | null, index: Partial<Record<GateRole, RoleVerdict>> = {}) =>
  routesHealthOf(routesStatus({ liveRoles, index, roster: [row] }, { checkKeys: false }));

describe("routesHealthOf", () => {
  it("none switched on: one calm line", () => {
    expect(line([])).toEqual({
      state: "ok",
      lines: ["AI jobs: all on written rules (none switched on)"],
    });
  });

  it("a job without a pass says the test run has not passed", () => {
    expect(line(["R6"])).toEqual({
      state: "attention",
      lines: ["Case writing: rules only, test run not passed yet"],
    });
  });

  it("a job that passed is live; the line counts models, not names them", () => {
    expect(line(["R1"], idx("R1"))).toEqual({
      state: "ok",
      lines: ["Announcement triage: live model, 1 model in order"],
    });
  });

  it("R3 listed alone says it follows the writing switch; words shows both wording jobs", () => {
    expect(line(["R3"], idx("words")).lines).toEqual([
      "Review wording: rules only, it follows the plain-words writing switch alone",
    ]);
    expect(line(["words"], idx("words")).lines).toEqual([
      "Review wording: live model, 1 model in order",
      "Daily summary wording: live model, 1 model in order",
    ]);
  });

  it("an unreadable setting is an attention line", () => {
    const h = line(null);
    expect(h.state).toBe("attention");
    expect(h.lines).toEqual(["AI jobs: the setting could not be read, all on written rules"]);
  });

  it("no line carries a job code, a model id or a host", () => {
    const all = [
      line(["R1", "R2", "R6", "R7", "words"], idx("R1")),
      line(["R3"]),
      line(null),
    ].flatMap((h) => h.lines);
    for (const l of all) {
      expect(l).not.toMatch(/\bR[1-7]\b/);
      expect(l).not.toMatch(/mid-27b|groq|https?:/i);
    }
  });
});

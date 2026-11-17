// @vitest-environment node
// M22 L1 (LLM-077, D-1401, D-1445): the live-roles guard refuses ADDING a job that has no recorded test-run PASS (R3 and R5
// follow the words verdict); removing a job or keeping the list passes; anything unreadable refuses (fails closed).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/llm/bakeoffIndex.generated", () => ({
  BAKEOFF_INDEX: {
    R6: { verdict: "PASS", date: "2026-11-20", run: "r1", report: "r1.md", models: ["m"] },
    R7: { verdict: "FAIL", date: "2026-11-20", run: "r1", report: "r1.md", models: [] },
    words: { verdict: "PASS", date: "2026-11-20", run: "r1", report: "r1.md", models: ["m"] },
  },
}));

import { LIVE_ROLE_REFUSAL, liveRolesGuard } from "@/lib/config/guards/liveRoles";
import { switchRefusal } from "@/lib/config/switchGuards";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let main: Client;
beforeEach(async () => {
  main = await freshDb("main");
});

const store = (list: unknown) =>
  main.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
          VALUES ('llm_live_roles', 'global', ?, NULL, NULL, '2026-11-17T00:00:00.000Z', 'test')`,
    args: [JSON.stringify(list)],
  });
const failing = { execute: () => Promise.reject(new Error("down")) };

describe("liveRolesGuard", () => {
  it("the refusal is plain words with no job code", () => {
    expect(LIVE_ROLE_REFUSAL).toBe("This writing task has not passed its test run yet");
  });

  it("adds a job that passed; refuses one that failed or never ran", async () => {
    expect(await liveRolesGuard(main, ["R6"])).toBeNull();
    expect(await liveRolesGuard(main, ["R7"])).toBe(LIVE_ROLE_REFUSAL); // newest report is a FAIL
    expect(await liveRolesGuard(main, ["R1"])).toBe(LIVE_ROLE_REFUSAL); // no report
    expect(await liveRolesGuard(main, ["R6", "R1"])).toBe(LIVE_ROLE_REFUSAL);
  });

  it("R3 and R5 follow the words verdict, and words has its own", async () => {
    expect(await liveRolesGuard(main, ["words"])).toBeNull();
    expect(await liveRolesGuard(main, ["R3", "R5"])).toBeNull();
  });

  it("a job already listed stays allowed, removing always passes, the empty list passes", async () => {
    await store(["R7", "R1"]); // stored earlier (before a later FAIL)
    expect(await liveRolesGuard(main, ["R7", "R1"])).toBeNull();
    expect(await liveRolesGuard(main, ["R7"])).toBeNull();
    expect(await liveRolesGuard(main, [])).toBeNull();
    expect(await liveRolesGuard(main, ["R7", "R1", "R6"])).toBeNull();
    expect(await liveRolesGuard(main, ["R7", "R2"])).toBe(LIVE_ROLE_REFUSAL);
  });

  it("fails closed: a non-list value, an unknown name, a stored value that is not a list, a failing read", async () => {
    expect(await liveRolesGuard(main, "R6")).toBe(LIVE_ROLE_REFUSAL);
    expect(await liveRolesGuard(main, [6])).toBe(LIVE_ROLE_REFUSAL);
    expect(await liveRolesGuard(main, ["R4"])).toBe(LIVE_ROLE_REFUSAL);
    expect(await liveRolesGuard(failing, ["R6"])).toBe(LIVE_ROLE_REFUSAL);
    await store("R6");
    expect(await liveRolesGuard(main, ["R6"])).toBe(LIVE_ROLE_REFUSAL);
  });

  it("is the registered guard of the key", async () => {
    expect(await switchRefusal(main, "llm_live_roles", ["R7"])).toBe(LIVE_ROLE_REFUSAL);
    expect(await switchRefusal(main, "llm_live_roles", ["R6"])).toBeNull();
  });
});

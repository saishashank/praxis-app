// @vitest-environment node
// M22 L5 (LLM-079, D-1416): the small reader's line of System Health: plain words, no model or file name, no job code.
import { afterEach, describe, expect, it } from "vitest";
import { dayLabel, loadMinilmHealth, minilmHealthOf } from "@/lib/health/minilm";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const ag = (rows: number, agree: number) => ({ rows, agree, materialAgree: agree });

describe("minilmHealthOf", () => {
  it("off is one calm line", () => {
    expect(minilmHealthOf({ enabled: false, problem: null, latest: null })).toEqual({
      state: "ok",
      line: "Small reader: off",
    });
  });
  it("on but unable to run is an attention line in plain words", () => {
    expect(
      minilmHealthOf({
        enabled: true,
        problem: "The local classifier has not been trained yet",
        latest: null,
      }),
    ).toEqual({
      state: "attention",
      line: "Small reader: on but cannot run (the local classifier has not been trained yet)",
    });
  });
  it("on with nothing compared, and with a night's figure", () => {
    expect(minilmHealthOf({ enabled: true, problem: null, latest: null }).line).toBe(
      "Small reader: on, nothing compared yet",
    );
    expect(
      minilmHealthOf({
        enabled: true,
        problem: null,
        latest: { d: "2030-01-02", agreement: ag(0, 0) },
      }).line,
    ).toBe("Small reader: on, nothing compared yet");
    expect(
      minilmHealthOf({
        enabled: true,
        problem: null,
        latest: { d: "2030-01-02", agreement: ag(40, 37) },
      }),
    ).toEqual({
      state: "ok",
      line: "Small reader: on, agreed with the written rules on 37 of 40 announcements (93 %) on Wed 2 Jan",
    });
    expect(
      minilmHealthOf({
        enabled: true,
        problem: null,
        latest: { d: "2030-01-02", agreement: ag(1, 1) },
      }).line,
    ).toContain("1 of 1 announcement (100 %)");
  });
  it("dayLabel is a calendar label", () => {
    expect(dayLabel("2030-01-02")).toBe("Wed 2 Jan");
  });
});

describe("loadMinilmHealth", () => {
  it("a fresh database reads as off", async () => {
    expect((await loadMinilmHealth(await freshDb("main"))).line).toBe("Small reader: off");
  });
  it("switched on in the store with no trained head reads as attention", async () => {
    const db = await freshDb("main");
    await db.execute(
      `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
       VALUES ('minilm_enabled', 'global', '"on"', NULL, NULL, '2030-01-01T00:00:00.000Z', 'test')`,
    );
    const h = await loadMinilmHealth(db);
    expect(h.state).toBe("attention");
    expect(h.line).toMatch(/^Small reader: on but cannot run/);
  });
  it("a failed read is an attention line, not a throw", async () => {
    const h = await loadMinilmHealth({ execute: () => Promise.reject(new Error("x")) });
    expect(h).toEqual({ state: "attention", line: "Small reader: its state could not be read" });
  });
});

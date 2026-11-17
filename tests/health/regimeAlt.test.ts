// @vitest-environment node
// M22 E5 (DAT-248, D-1441): the System Health line of the shadow regime reading, plain words, never a throw.
import { afterEach, describe, expect, it } from "vitest";
import { loadRegimeAltHealth, regimeAltHealthOf } from "@/lib/health/regimeAlt";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("regimeAltHealthOf", () => {
  it("says off, no reading, no sources and the differing count", () => {
    const off = regimeAltHealthOf({ enabled: false, latest: null, differing: 0, sessions: 0 });
    expect(off.line).toBe("Outside signals on the market mood: off");
    expect(
      regimeAltHealthOf({ enabled: true, latest: null, differing: 0, sessions: 0 }).line,
    ).toMatch(/no reading stored yet/);
    expect(
      regimeAltHealthOf({
        enabled: true,
        latest: { inputsStatus: "unavailable" },
        differing: 0,
        sessions: 3,
      }).line,
    ).toMatch(/none of the sources is accepted/);
    expect(
      regimeAltHealthOf({
        enabled: true,
        latest: { inputsStatus: "ok" },
        differing: 3,
        sessions: 20,
      }).line,
    ).toBe(
      "Outside signals on the market mood: on, the reading differs from the base on 3 of the last 20 sessions",
    );
  });
});

describe("loadRegimeAltHealth", () => {
  it("reads off on a fresh database and an attention line when the read fails", async () => {
    const db = await freshDb("main");
    expect((await loadRegimeAltHealth(db)).line).toBe("Outside signals on the market mood: off");
    const bad = {
      execute: async (): Promise<never> => {
        throw new Error("down");
      },
    };
    expect(await loadRegimeAltHealth(bad)).toEqual({
      state: "attention",
      line: "Outside signals on the market mood: its state could not be read",
    });
  });

  it("counts the differing sessions when on", async () => {
    const db = await freshDb("main");
    await db.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('regime_altinputs_enabled', 'global', '\"on\"', 'x')",
      args: [],
    });
    for (const [d, alt] of [
      ["2030-01-01", "NEUTRAL"],
      ["2030-01-02", "RISK-OFF"],
    ] as const) {
      await db.execute({
        sql: "INSERT INTO regime_alt_reading (market, d, base_state, alt_state, inputs_status, inputs_json, created_at) VALUES ('AU', ?, 'NEUTRAL', ?, 'ok', '{}', '2030-01-02T00:00:00Z')",
        args: [d, alt],
      });
    }
    expect((await loadRegimeAltHealth(db)).line).toBe(
      "Outside signals on the market mood: on, the reading differs from the base on 1 of the last 2 sessions",
    );
  });
});

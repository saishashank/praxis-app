// @vitest-environment node
// DAT-252 (3), D-974: the split-day frequency is a pure function plus one read-only measurement, and it
// is a scenario of the SELECT-only diagnose CLI. Fixture data only.
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseMain, readOnly, SCENARIOS } from "@/lib/arena/diagnose";
import { measure, QUANTITY_TYPES, summarise } from "@/lib/data/splitFrequency";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const days = (n: number) =>
  Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);

describe("summarise", () => {
  it("counts per year, the share of codes and the share of windows touched (hand table)", () => {
    const d = days(30);
    const s = summarise(
      [
        { code: "AAA", exDate: "2026-01-15", type: "split" },
        { code: "AAA", exDate: "2026-01-16", type: "dividend" }, // not a quantity change
      ],
      new Map([
        ["AAA", d],
        ["BBB", d],
      ]),
      20,
    );
    expect(QUANTITY_TYPES).toEqual(["split", "consolidation", "bonus_issue"]);
    expect(s.actions).toBe(1);
    expect(s.perYear).toEqual({ "2026": 1 });
    expect(s.codesWithBars).toBe(2);
    expect(s.codesWithSplit).toBe(1);
    expect(s.codesWithSplitPct).toBe(50);
    // 30 bars, window 20: 11 windows per code, 22 in all; AAA's windows ending day 20 to 30 all
    // contain day 15 except none start after 15 (start 11 at the latest), so all 11 are touched
    expect(s.windows).toBe(22);
    expect(s.windowsTouched).toBe(11);
    expect(s.windowsTouchedPct).toBe(50);
  });

  it("an empty store is all zeros, not a division error", () => {
    const s = summarise([], new Map());
    expect([s.windows, s.windowsTouchedPct, s.codesWithSplitPct]).toEqual([0, 0, 0]);
  });
});

describe("measure and the diagnose scenario", () => {
  it("reads a migrated database and writes nothing", async () => {
    const db = await freshDb("main");
    const before = Number(
      (await db.execute("SELECT COUNT(*) AS n FROM corporate_action")).rows[0]!.n,
    );
    const s = await measure(readOnly(db), 20);
    expect(s.actions).toBe(0);
    expect(
      Number((await db.execute("SELECT COUNT(*) AS n FROM corporate_action")).rows[0]!.n),
    ).toBe(before);
  });

  it("is registered, refuses an unknown name and a bad window, and needs a database", async () => {
    expect(SCENARIOS).toContain("splitFrequency");
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await diagnoseMain(["--scenario", "nope"], {}, out)).toBe(2);
    expect(await diagnoseMain(["--scenario", "splitFrequency", "--window", "1"], {}, out)).toBe(2);
    expect(await diagnoseMain(["--scenario", "splitFrequency"], {}, out)).toBe(1);
    expect(lines.join("\n")).not.toMatch(/token|libsql:/i);
  });
});

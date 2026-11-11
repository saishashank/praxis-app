// @vitest-environment node
// BLD-041 / D-493 (M11-lite WP7): the steelman health line. Production has no R6 model wired (D-480),
// so the line reads "pending production"; ten nights at 98 % or better complete the evidence. The line
// is read-only over steelman_night and never throws.
import { afterEach, describe, expect, it } from "vitest";
import { loadSteelmanHealth, steelmanHealthOf } from "@/lib/health/steelman";
import { insertNight, type NightRow } from "@/lib/steelman/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const row = (i: number, over: Partial<NightRow> = {}): NightRow => ({
  market: "AU",
  d: `2026-03-${String(i).padStart(2, "0")}`,
  requested: 3,
  written: 3,
  notWrittenLimit: 0,
  notWrittenBudget: 0,
  notWrittenNoModel: 0,
  notWrittenCritic: 0,
  notWrittenError: 0,
  claimsTotal: 20,
  claimsValid: 20,
  validityPpm: 1_000_000,
  criticHidden: 0,
  createdAt: "2026-03-30T00:00:00.000Z",
  ...over,
});

// OPS-111 (13), D-977: the line shows to every role, so it must stay free of anything the masking rule
// would hide: no ASX code, no company name, no date. Counts and fixed words only.
describe("steelman health line masking (D-580)", () => {
  const NO_CODE_NAME_DATE = /\b[A-Z]{3,4}\b|\d{4}-\d{2}-\d{2}|\b(Pty|Ltd|Limited|Corp)\b/;
  const shapes = [
    [],
    [1, 2, 3].map((i) => row(i, { written: 0, claimsTotal: 0, claimsValid: 0, validityPpm: 0 })),
    [row(5), row(4, { validityPpm: 979_999 })],
    Array.from({ length: 12 }, (_, i) => row(12 - i)),
    [row(1, { notWrittenError: 2, notWrittenNoModel: 1, notWrittenCritic: 4 })],
  ];

  it("every shape reads as fixed words and counts: no code, name or date", () => {
    for (const rows of shapes) {
      const t = steelmanHealthOf(rows).text;
      // "Steelman" is the label; strip it and the fixed uppercase-free words before the scan
      expect(t.replace(/Steelman/g, "").match(NO_CODE_NAME_DATE), t).toBeNull();
    }
  });

  it("the scan itself catches a code, a name and a date (self-test)", () => {
    for (const bad of ["Steelman: ZZA written", "Steelman: Zed Pty Ltd", "Steelman 2026-03-04"]) {
      expect(NO_CODE_NAME_DATE.test(bad.replace(/Steelman/g, ""))).toBe(true);
    }
  });

  it("a NightRow carries no code, name or date field to leak", () => {
    expect(Object.keys(row(1)).sort()).toEqual(
      [
        "claimsTotal",
        "claimsValid",
        "createdAt",
        "criticHidden",
        "d",
        "market",
        "notWrittenBudget",
        "notWrittenCritic",
        "notWrittenError",
        "notWrittenLimit",
        "notWrittenNoModel",
        "requested",
        "validityPpm",
        "written",
      ].sort(),
    );
  });
});

describe("steelman health line", () => {
  it("reads pending production with no night recorded", () => {
    const h = steelmanHealthOf([]);
    expect(h.text).toBe(
      "Steelman: 0 nights at 98 % or better, 10 needed, pending production (no night recorded yet).",
    );
    expect(h.state).toBe("ok");
  });

  it("reads pending production while no model is wired (nights with nothing written)", () => {
    const h = steelmanHealthOf(
      [1, 2, 3].map((i) => row(i, { written: 0, claimsTotal: 0, claimsValid: 0, validityPpm: 0 })),
    );
    expect(h.qualifying).toBe(0);
    expect(h.text).toContain("pending production (no model wired, none written)");
  });

  it("counts only nights at 98 % or better with claims, and stays pending under ten", () => {
    const rows = [
      row(5),
      row(4, { validityPpm: 979_999 }),
      row(3, { validityPpm: 980_000 }),
      row(2, { claimsTotal: 0, claimsValid: 0, validityPpm: 1_000_000 }),
    ];
    const h = steelmanHealthOf(rows);
    expect(h.qualifying).toBe(2);
    expect(h.text).toBe(
      "Steelman: 2 nights at 98 % or better, 10 needed, pending production (12 written over the last 4 nights).",
    );
  });

  it("is complete at ten qualifying nights of the last ten", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(12 - i));
    const h = steelmanHealthOf(rows);
    expect(h.qualifying).toBe(10);
    expect(h.text).toBe("Steelman: 10 nights at 98 % or better, 10 needed; evidence complete.");
  });

  it("loads from the table, newest ten nights, and survives a missing table", async () => {
    const db = await freshDb("main");
    expect((await loadSteelmanHealth(db, "AU")).text).toContain("pending production");
    for (let i = 1; i <= 3; i++) await insertNight(db, row(i));
    const h = await loadSteelmanHealth(db, "AU");
    expect(h).toMatchObject({ nights: 3, qualifying: 3, state: "ok" });
    await db.execute("DROP TABLE steelman_night");
    const bad = await loadSteelmanHealth(db, "AU");
    expect(bad.state).toBe("attention");
    expect(bad.text).toContain("could not be read");
  });
});

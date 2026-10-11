// @vitest-environment node
// System Health "Data quality" section data (DAT-211, ROL-102a): counts for every role, the codes
// behind each rule for the Owner only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHealthSummary } from "@/lib/health/summary";
import { getQualitySummary, TOP_CODES_PER_RULE } from "@/lib/health/quality";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const OLD = "2026-10-12";
const D = "2026-10-13";
const NOW = new Date("2026-10-13T08:00:00.000Z");

async function score(d: string, u1: [number, number]) {
  const gate = u1[0] * 100 >= 95 * u1[1] ? 1 : 0;
  for (const [tier, v, e] of [
    ["U1", u1[0], u1[1]],
    ["U2", 5, 5],
    ["U3", 0, 0],
  ] as const) {
    await db.execute({
      sql: `INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass)
            VALUES ('AU', ?, ?, ?, ?, ?, ?)`,
      args: [d, tier, v, e, e ? v / e : 1, tier === "U1" ? gate : 1],
    });
  }
}
const flag = (
  d: string,
  code: string | null,
  check: string,
  sev: string,
  blocks: 0 | 1,
  cleared = false,
) =>
  db.execute({
    sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at, cleared_at, blocks_entries)
          VALUES ('AU', ?, ?, ?, ?, '2026-10-13T07:00:00.000Z', ?, ?)`,
    args: [code, d, check, sev, cleared ? "2026-10-13T07:30:00.000Z" : null, blocks],
  });

describe("getQualitySummary", () => {
  it("no scores yet: empty summary for every role", async () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      expect(await getQualitySummary(db, role)).toEqual({
        date: null,
        tiers: [],
        rules: [],
        openTotal: 0,
      });
    }
  });

  it("counts open flags by rule and severity for the latest date only", async () => {
    await score(OLD, [20, 20]);
    await score(D, [17, 20]);
    await flag(OLD, "ZZA", "DAT-200:suspect_move", "warning", 1); // an older date: not shown
    await flag(D, "ZZA", "DAT-210:missing_bar", "error", 1);
    await flag(D, "ZZB", "DAT-210:missing_bar", "error", 1);
    await flag(D, "ZZC", "DAT-210:missing_bar", "error", 1, true); // cleared: not counted
    await flag(D, "ZZD", "DAT-200:refetch_diff", "warning", 0);
    await flag(D, null, "DAT-210:u1_gate", "critical", 1);
    const s = await getQualitySummary(db, "viewer");
    expect(s.date).toBe(D);
    expect(s.openTotal).toBe(4);
    expect(s.rules.map((r) => [r.checkId, r.severity, r.count, r.blocksEntries])).toEqual([
      ["DAT-200:refetch_diff", "warning", 1, false],
      ["DAT-210:missing_bar", "error", 2, true],
      ["DAT-210:u1_gate", "critical", 1, true],
    ]);
    expect(s.tiers).toEqual([
      { tier: "U1", valid: 17, expected: 20, score: 0.85, gatePass: false },
      { tier: "U2", valid: 5, expected: 5, score: 1, gatePass: true },
      { tier: "U3", valid: 0, expected: 0, score: 1, gatePass: true },
    ]);
  });

  it("codes are Owner-only: absent (not null) for editor and viewer", async () => {
    await score(D, [20, 20]);
    for (let i = 0; i < TOP_CODES_PER_RULE + 2; i++) {
      await flag(D, `ZZ${String.fromCharCode(65 + i)}`, "DAT-200:suspect_move", "warning", 1);
    }
    await flag(D, null, "DAT-210:u1_gate", "critical", 1);
    const owner = await getQualitySummary(db, "owner");
    const suspect = owner.rules.find((r) => r.checkId === "DAT-200:suspect_move")!;
    expect(suspect.count).toBe(TOP_CODES_PER_RULE + 2);
    expect(suspect.topCodes).toEqual(["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"]);
    expect(owner.rules.find((r) => r.checkId === "DAT-210:u1_gate")!.topCodes).toEqual([]);
    for (const role of ["editor", "viewer"] as const) {
      const s = await getQualitySummary(db, role);
      for (const r of s.rules) expect("topCodes" in r).toBe(false);
      expect(JSON.stringify(s)).not.toContain("ZZA");
      expect(s.rules.find((r) => r.checkId === "DAT-200:suspect_move")!.count).toBe(7);
    }
  });
});

describe("getHealthSummary quality section", () => {
  it("is included for every role and never hides the jobs when unreadable", async () => {
    await score(D, [20, 20]);
    await flag(D, "ZZA", "DAT-200:suspect_move", "warning", 1);
    for (const role of ["owner", "editor", "viewer"] as const) {
      const s = await getHealthSummary(db, NOW, role, {});
      expect(s.quality?.date).toBe(D);
      expect(s.quality?.openTotal).toBe(1);
      expect("topCodes" in s.quality!.rules[0]).toBe(role === "owner");
    }
    await db.execute("DROP TABLE quality_score");
    const s = await getHealthSummary(db, NOW, "viewer", {});
    expect(s.quality).toBeNull();
    expect(s.jobs.length).toBeGreaterThan(0);
  });
});

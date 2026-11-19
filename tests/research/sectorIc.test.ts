// @vitest-environment node
// M23 R3 (D-1633, D-1634, D-1710 to D-1715): the CXA-009 panel builder on synthetic ZZ data (SEC-110: no real code or
// price). A planted persistent group effect passes over 130 months, a null does not, 94 qualifying months is below sample
// before any outcome is read, and the industry file, the member rule and the month windows behave as the plan says.
import { describe, expect, it } from "vitest";
import {
  buildDays,
  buildPanel,
  countMonths,
  parseIndustryFile,
  sectorIcRun,
  seriesOfDays,
  SECTOR_IC_WINDOWS,
  type SectorIcPlanParams,
} from "@/lib/research/lineages/sectorIc";
import type { Universe, World } from "@/lib/research/lineages/cxa003";
import { scopedPrng, uniform01 } from "@/lib/stats/rng";

const GROUPS = 6;
const PER_GROUP = 4;
const SESSIONS_PER_MONTH = 21;
const CODES = Array.from({ length: GROUPS * PER_GROUP }, (_, i) => `ZZ${i}`);
const GROUP_OF = new Map(CODES.map((c, i) => [c, `G${Math.floor(i / PER_GROUP)}`]));

const params: SectorIcPlanParams = {
  lineage: "zz_sector_ic",
  minMembers: 3,
  minGroupsPerMonth: 4,
  minMonths: 95,
  expectedBlockMonths: 3,
  alpha: 0.1,
  replicates: 400,
  masterSeed: 20261018n,
};

/** A world of `months` calendar months of 21 sessions; each group drifts by `drift` per rank and every code adds noise. */
function syntheticWorld(months: number, drift: number, seed: string): World {
  const dates: string[] = [];
  for (let m = 0; m < months; m += 1) {
    const y = 2001 + Math.floor(m / 12);
    const mm = String((m % 12) + 1).padStart(2, "0");
    for (let d = 1; d <= SESSIONS_PER_MONTH; d += 1)
      dates.push(`${y}-${mm}-${String(d).padStart(2, "0")}`);
  }
  const rng = scopedPrng(seed);
  const series = new Map<string, unknown>();
  for (const [i, code] of CODES.entries()) {
    const close = new Float64Array(dates.length);
    const g = Math.floor(i / PER_GROUP);
    let c = 100;
    for (let s = 0; s < dates.length; s += 1) {
      close[s] = c;
      c *= 1 + (g - (GROUPS - 1) / 2) * drift + (uniform01(rng) - 0.5) * 0.01; // threshold-ok: synthetic noise
    }
    series.set(code, { code, pos: Int32Array.from(dates.map((_, s) => s)), close });
  }
  return { dates, series } as unknown as World;
}

const everyone = {
  at: () => CODES.map((code) => ({ code, vol: 0, volDecile: 0 })),
} as unknown as Pick<Universe, "at">;

const rowsOf = (world: World) => seriesOfDays(buildDays(world, everyone, GROUP_OF, "2030-01-01"));

describe("CXA-009 panel and look (synthetic)", () => {
  it("a planted persistent group effect over 130 months passes", () => {
    const rows = rowsOf(syntheticWorld(130, 0.0008, "plant"));
    const run = sectorIcRun(rows, params, "2008-01-01");
    if (run.result.status !== "looked") throw new Error("expected a look");
    expect(run.result.months).toBe(121);
    expect(run.result.meanIc!).toBeGreaterThan(0.1);
    expect(run.result.lowerIc!).toBeGreaterThan(0);
    expect(run.result.verdict).toBe("PASS");
    expect(run.groups).toBe(GROUPS);
    // the development and holdout means come from the same look and split the months
    expect(run.developmentMonths + run.result.holdoutMonths).toBe(run.result.usedMonths);
    expect(run.result.holdoutMonths).toBeGreaterThan(0);
  });

  it("a null (no group effect; one seed in ten would pass by design, this one does not) does not pass", () => {
    const rows = rowsOf(syntheticWorld(130, 0, "null2"));
    const run = sectorIcRun(rows, params, "2008-01-01");
    if (run.result.status !== "looked") throw new Error("expected a look");
    expect(run.result.lowerIc!).toBeLessThan(0.1);
    expect(run.result.verdict).toBe("NULL");
  });

  it("94 qualifying months is below sample; 95 reaches the look", () => {
    const short = rowsOf(syntheticWorld(103, 0.0008, "short"));
    expect(countMonths(short, params)).toBe(94);
    expect(sectorIcRun(short, params, "2008-01-01").result).toMatchObject({
      status: "below_sample",
      months: 94,
      floor: 95,
    });
    const enough = rowsOf(syntheticWorld(104, 0.0008, "short"));
    expect(countMonths(enough, params)).toBe(95);
    expect(sectorIcRun(enough, params, "2008-01-01").result.status).toBe("looked");
  });

  it("months need 147 sessions before and 21 after the month start, from the session list alone", () => {
    const rows = rowsOf(syntheticWorld(30, 0.0008, "edge"));
    const panel = buildPanel(rows);
    const first = Math.min(...panel.startOf.values());
    const last = Math.max(...panel.startOf.values());
    expect(first).toBeGreaterThanOrEqual(SECTOR_IC_WINDOWS.signal + SECTOR_IC_WINDOWS.gap);
    expect(last + SECTOR_IC_WINDOWS.outcome).toBeLessThan(panel.sessions.length);
  });

  it("a group that starts after the first signal session is not in the month", () => {
    const world = syntheticWorld(30, 0.0008, "late");
    const late = new Map(GROUP_OF);
    // G5 exists only from session index 200 on: give its codes no bar before that
    for (const [i, code] of CODES.entries()) {
      if (Math.floor(i / PER_GROUP) !== GROUPS - 1) continue;
      const s = world.series.get(code)!;
      for (let t = 0; t < 200; t += 1) (s.pos as Int32Array)[t] = -1;
    }
    const rows = seriesOfDays(buildDays(world, everyone, late, "2030-01-01"));
    const panel = buildPanel(rows);
    const early = panel.entries.find((e) => panel.startOf.get(e.month)! < 200 + 147)!;
    expect(early.groups.map((g) => g.group)).not.toContain(`G${GROUPS - 1}`);
    const lateMonth = panel.entries[panel.entries.length - 1]!;
    expect(lateMonth.groups.map((g) => g.group)).toContain(`G${GROUPS - 1}`);
  });

  it("the industry file keeps real groups only: empty and Not Applic are left out", () => {
    const m = parseIndustryFile({
      rows: [
        { code: "ZZ1", industry: "Materials" },
        { code: "ZZ2", industry: "Not Applic" },
        { code: "ZZ3", industry: "" },
        { code: "ZZ4", industry: " Energy " },
        { code: "ZZ5" },
      ],
    });
    expect([...m.entries()]).toEqual([
      ["ZZ1", "Materials"],
      ["ZZ4", "Energy"],
    ]);
    expect(() => parseIndustryFile({})).toThrow("no rows");
  });

  it("a code without a group is never a member", () => {
    const world = syntheticWorld(2, 0, "members");
    const partial = new Map([...GROUP_OF].filter(([c]) => c !== "ZZ0"));
    const days = buildDays(world, everyone, partial, "2030-01-01");
    expect(days[5]!.members.has("ZZ0")).toBe(false);
    expect(days[5]!.members.size).toBe(CODES.length - 1);
    expect(days[5]!.members.get("ZZ1")).toEqual({ group: "G0", asOf: "2030-01-01" });
  });
});

// @vitest-environment node
// M17 WP7: chanceDisplay (UXN-308), pick order (UXN-309), dormant floor + concentration (UXN-307, D-383),
// one family badge table (UXN-311, D-393).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chanceDisplay, chanceLine, NO_HISTORY_TEXT, type ChanceInput } from "@/lib/picks/chance";
import { sortPicks, type SortablePick } from "@/lib/picks/sort";
import { applyFloor, concentration, PICKS_PER_PROFILE } from "@/lib/picks/floor";
import { FAMILY_BADGE, familyBadge } from "@/lib/ui/familyBadge";
import { FAMILY_BADGE as FROM_MAP } from "@/app/(app)/home/familyMap";

const base: ChanceInput = {
  status: "allowed",
  p: 0.62,
  lo: 0.55,
  hi: 0.69,
  nEff: 120,
  slopeUb: 1.2,
  hideBelow: 1.0,
};
const NONE = { kind: "no_history" } as const;

describe("chanceDisplay", () => {
  it("shadow, suspended, missing p or missing slope -> no history", () => {
    expect(chanceDisplay({ ...base, status: "shadow" })).toEqual(NONE);
    expect(chanceDisplay({ ...base, status: "suspended" })).toEqual(NONE);
    expect(chanceDisplay({ ...base, p: null })).toEqual(NONE);
    expect(chanceDisplay({ ...base, slopeUb: null })).toEqual(NONE);
  });
  it("hidden when the slope upper bound is below the key", () => {
    expect(chanceDisplay({ ...base, slopeUb: 0.99 })).toEqual(NONE);
    expect(chanceDisplay({ ...base, slopeUb: 1.0 }).kind).toBe("chance");
  });
  it("allowed and live-tested with a passing slope show the plain line", () => {
    for (const status of ["allowed", "live-tested"] as const) {
      const d = chanceDisplay({ ...base, status });
      expect(d).toEqual({ kind: "chance", pct: 62, lo: 55, hi: 69, n: 120 });
      expect(chanceLine(d)).toBe(
        "About 6 in 10 similar past setups came out ahead after costs (range 6 to 7 in 10), based on 120 past setups.",
      );
    }
    expect(chanceLine(NONE)).toBe(NO_HISTORY_TEXT);
  });
});

const pick = (rank: number, pct: number | null, gain: number | null): SortablePick => ({
  rank,
  chance: pct === null ? NONE : { kind: "chance", pct, lo: null, hi: null, n: 50 },
  expectedGainPpm: gain,
});

describe("sortPicks", () => {
  it("all shadow: rank order on both bases", () => {
    const rows = [pick(3, null, 5), pick(1, null, 1), pick(2, null, null)];
    expect(sortPicks(rows, "chance").map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(sortPicks(rows, "expected_gain").map((r) => r.rank)).toEqual([3, 1, 2]);
  });
  it("shown chances sort by p, ties by gain; no-chance picks last in rank order", () => {
    const rows = [
      pick(1, null, 9),
      pick(2, 60, 1),
      pick(3, 70, 1),
      pick(4, 60, 5),
      pick(5, null, 1),
    ];
    expect(sortPicks(rows, "chance").map((r) => r.rank)).toEqual([3, 4, 2, 1, 5]);
  });
  it("does not mutate its input", () => {
    const rows = [pick(2, 50, 1), pick(1, 60, 1)];
    sortPicks(rows, "chance");
    expect(rows.map((r) => r.rank)).toEqual([2, 1]);
  });
});

describe("floor and concentration", () => {
  const row = (family: string, status: "shadow" | "allowed", pct: number | null) => ({
    family,
    status,
    chance: pct === null ? NONE : ({ kind: "chance", pct, lo: null, hi: null, n: 9 } as const),
  });
  it("dormant while every family is shadow (low or no p are all kept)", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row("F1", "shadow", i % 2 ? 10 : null));
    expect(applyFloor(rows, 55)).toHaveLength(PICKS_PER_PROFILE);
    expect(applyFloor(rows.slice(0, 4), 55)).toHaveLength(4);
  });
  it("applies only to allowed families that show a chance", () => {
    const rows = [
      row("F1", "allowed", 54),
      row("F1", "allowed", 55),
      row("F2", "allowed", null),
      row("F3", "shadow", 10),
    ];
    expect(applyFloor(rows, 55).map((r) => r.chance.kind === "chance" && r.chance.pct)).toEqual([
      55,
      false,
      10,
    ]);
  });
  it("concentration counts per family with the badge label, no cap", () => {
    const c = concentration([
      { family: "F1" },
      { family: "F1" },
      { family: "F1" },
      { family: "F4" },
    ]);
    expect(c).toEqual([
      { family: "F1", label: "Breakout", code: "br", count: 3, sharePct: 75 },
      { family: "F4", label: "Bounce", code: "bo", count: 1, sharePct: 25 },
    ]);
  });
});

describe("one family badge table (D-393)", () => {
  it("covers F1-F7 and ID with a two-letter mark", () => {
    expect(Object.keys(FAMILY_BADGE)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "ID"]);
    for (const b of Object.values(FAMILY_BADGE)) expect(b.mark).toMatch(/^[A-Z]{2}$/);
    expect(familyBadge("F7").label).toBe("Expert consensus");
    expect(familyBadge("zz").label).toBe("Pick");
  });
  it("home/familyMap re-exports the same object", () => {
    expect(FROM_MAP).toBe(FAMILY_BADGE);
  });
  it("no other module defines a family label table", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    const owners = files.filter((f) => /["']Small-cap discovery["']/.test(readFileSync(f, "utf8")));
    expect(owners.map((f) => f.replace(/\\/g, "/").split("/src/")[1])).toEqual([
      "lib/ui/familyBadge.ts",
    ]);
  });
});

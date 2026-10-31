// @vitest-environment node
// AT-64 (M17 WP7/WP8; UXN-307..310): (a) chanceDisplay over six input combinations with `hideBelow` from
// the key; (b) sort with and without chances; (c) the sort preference values; (d) the intraday tile source
// carries no chance or rating; (e) masking of the intraday rows (rows tested in tests/picks/wp8.test.tsx).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chanceDisplay, chanceLine, NO_HISTORY_TEXT, type ChanceInput } from "@/lib/picks/chance";
import { sortPicks } from "@/lib/picks/sort";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { DEFAULT_PREFERENCES, PICK_SORTS } from "@/lib/preferences/service";

const hideBelow = Number(
  (CONFIG_KEYS.cortex_slope_hide_ub as unknown as { default: unknown }).default,
);
const ok: ChanceInput = {
  status: "allowed",
  p: 0.62,
  lo: 0.55,
  hi: 0.69,
  nEff: 120,
  slopeUb: 1.1,
  hideBelow,
};

describe("AT-64 (a) chance display", () => {
  it("six combinations", () => {
    expect(hideBelow).toBe(1);
    expect(chanceDisplay({ ...ok, status: "shadow" }).kind).toBe("no_history");
    expect(chanceDisplay({ ...ok, status: "suspended" }).kind).toBe("no_history");
    expect(chanceDisplay({ ...ok, slopeUb: 0.9 }).kind).toBe("no_history");
    expect(chanceDisplay({ ...ok, slopeUb: null }).kind).toBe("no_history");
    expect(chanceDisplay({ ...ok, p: null }).kind).toBe("no_history");
    expect(chanceDisplay({ ...ok, status: "live-tested" })).toMatchObject({
      kind: "chance",
      pct: 62,
    });
    expect(chanceLine(chanceDisplay({ ...ok, status: "shadow" }))).toBe(NO_HISTORY_TEXT);
  });
});

describe("AT-64 (b)(c) order and its preference", () => {
  const none = { kind: "no_history" } as const;
  const row = (rank: number, pct: number | null, gain: number | null) => ({
    rank,
    chance: pct === null ? none : ({ kind: "chance", pct, lo: null, hi: null, n: 50 } as const),
    expectedGainPpm: gain,
  });
  it("no chance anywhere: rank order; with chances they lead", () => {
    const rows = [row(3, null, 10), row(1, null, 5), row(2, null, 20)];
    expect(sortPicks(rows, "chance").map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(
      sortPicks([row(1, null, 5), row(2, 60, 1), row(3, 70, 1)], "chance").map((r) => r.rank),
    ).toEqual([3, 2, 1]);
    expect(sortPicks(rows, "expected_gain").map((r) => r.rank)).toEqual([2, 3, 1]);
  });
  it("the stored values are exactly the two bases and the default is chance", () => {
    expect([...PICK_SORTS]).toEqual(["chance", "expected_gain"]);
    expect(DEFAULT_PREFERENCES.picks_sort).toBe("chance");
  });
});

describe("AT-64 (d)(e) intraday tile source", () => {
  it("never renders a chance, a rules score or a model figure", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/(app)/picks/IntradaySection.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/chanceDisplay|chanceLine|rulesScore|\.score|confidence/i);
    expect(src).toContain("INTRADAY_UNRATED");
  });
  it("the loader masks to letters and the week", () => {
    const loader = readFileSync(join(process.cwd(), "src/lib/ui/loaders/pickAlerts.ts"), "utf8");
    expect(loader).toMatch(/kit \? kit\.aliases\.label\(code\)/);
    expect(loader).toMatch(/masked \? \(isoWeek\(d\)/);
  });
});

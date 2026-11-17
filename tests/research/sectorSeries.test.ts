// @vitest-environment node
// The sector series (M23 S1; CXA-009, D-1632, D-1670...D-1674): hand-computed returns and levels on a ZZ fixture.
import { afterEach, describe, expect, it } from "vitest";
import {
  chainLevel,
  groupReturns,
  levelAt,
  levelReturnPpm,
  memberReturnPpm,
  monthEntries,
  monthStarts,
  sectorSeries,
  type Member,
  type SessionInput,
} from "@/lib/research/sectorSeries";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  CLASS_AS_OF,
  CLOSES,
  EXPECTED,
  GROUP_OF,
  SESSIONS,
  enableZz,
  plantZz,
  writeSectorIndexFor,
} from "./sectorFixture";

afterEach(cleanupTempDbs);

const members = (): Map<string, Member> =>
  new Map(Object.entries(GROUP_OF).map(([c, g]) => [c, { group: g, asOf: CLASS_AS_OF }]));
const days = (): SessionInput[] =>
  SESSIONS.map((d, i) => ({
    d,
    close: new Map(Object.entries(CLOSES).map(([c, v]) => [c, v[i]!])),
    members: members(),
  }));

describe("memberReturnPpm and groupReturns", () => {
  it("rounds half away from zero in integer ppm; a move above 60 % is left out, 60 % itself is kept", () => {
    expect(memberReturnPpm(110, 100)).toBe(100000);
    expect(memberReturnPpm(160, 100)).toBe(600000);
    expect(memberReturnPpm(161, 100)).toBeNull(); // 61 %
  });

  it("a 61 % rise and a 61 % fall are both left out; a missing or non-positive price is left out", () => {
    expect(memberReturnPpm(161, 100)).toBeNull();
    expect(memberReturnPpm(39, 100)).toBeNull();
    expect(memberReturnPpm(40, 100)).toBe(-600000);
    expect(memberReturnPpm(undefined, 100)).toBeNull();
    expect(memberReturnPpm(100, undefined)).toBeNull();
    expect(memberReturnPpm(0, 100)).toBeNull();
    expect(memberReturnPpm(1, 3)).toBeNull(); // -66.7 %, above the guard
    expect(memberReturnPpm(2, 3)).toBe(-333333); // (2 - 3) x 1e6 / 3 = -333333.33
    expect(memberReturnPpm(4, 3)).toBe(333333);
  });

  it("the group mean rounds half away from zero (+1 and 0 -> 1; -1 and 0 -> -1)", () => {
    const m = new Map<string, Member>([
      ["X1", { group: "G", asOf: "2030-01-01" }],
      ["X2", { group: "G", asOf: "2030-01-01" }],
    ]);
    const up = groupReturns(
      new Map([
        ["X1", 1_000_001],
        ["X2", 1_000_000],
      ]),
      m,
      new Map([
        ["X1", 1_000_000],
        ["X2", 1_000_000],
      ]),
    );
    expect(up.get("G")).toEqual({ retPpm: 1, n: 2, mapAsOf: "2030-01-01" });
    const down = groupReturns(
      new Map([
        ["X1", 999_999],
        ["X2", 1_000_000],
      ]),
      m,
      new Map([
        ["X1", 1_000_000],
        ["X2", 1_000_000],
      ]),
    );
    expect(down.get("G")!.retPpm).toBe(-1);
  });

  it("a group with no usable member is absent; the newest classification date is carried", () => {
    const m = new Map<string, Member>([
      ["X1", { group: "G1", asOf: "2030-01-01" }],
      ["X2", { group: "G2", asOf: "2030-01-05" }],
      ["X3", { group: "G2", asOf: "2030-01-09" }],
    ]);
    const r = groupReturns(
      new Map([
        ["X2", 110],
        ["X3", 110],
      ]),
      m,
      new Map([
        ["X1", 100],
        ["X2", 100],
        ["X3", 100],
      ]),
    );
    expect([...r.keys()]).toEqual(["G2"]);
    expect(r.get("G2")).toEqual({ retPpm: 100000, n: 2, mapAsOf: "2030-01-09" });
  });
});

describe("sectorSeries (3 groups, 5 sessions)", () => {
  it("matches the hand-computed returns, levels and member counts", () => {
    const rows = sectorSeries(days());
    expect(
      rows.map((r) => ({ d: r.d, group: r.group, retPpm: r.retPpm, levelPpm: r.levelPpm, n: r.n })),
    ).toEqual(EXPECTED);
    expect(rows.every((r) => r.mapAsOf === CLASS_AS_OF)).toBe(true);
  });

  it("the 61 % move is left out of GB on the fourth session (n 2, not 3)", () => {
    const gb = sectorSeries(days()).find((r) => r.d === SESSIONS[3] && r.group === "GB")!;
    expect(gb.n).toBe(2);
    expect(gb.retPpm).toBe(50000);
  });

  it("chainLevel rounds half away from zero", () => {
    expect(chainLevel(1_000_000, 0)).toBe(1_000_000);
    expect(chainLevel(1_033_333, 50_000)).toBe(1_085_000);
    expect(chainLevel(3, 500_000)).toBe(5); // 4.5 -> 5
    expect(chainLevel(3, -500_000)).toBe(2); // 1.5 -> 2
  });

  it("a code that changes group mid-window is counted in each group on its own dates", () => {
    const d1: SessionInput = {
      d: "2030-02-03",
      close: new Map([
        ["P", 100],
        ["Q", 100],
        ["R", 100],
      ]),
      members: new Map([
        ["P", { group: "G1", asOf: "2030-01-01" }],
        ["Q", { group: "G1", asOf: "2030-01-01" }],
        ["R", { group: "G2", asOf: "2030-01-01" }],
      ]),
    };
    const d2: SessionInput = {
      d: "2030-02-04",
      close: new Map([
        ["P", 110],
        ["Q", 120],
        ["R", 100],
      ]),
      members: d1.members,
    };
    // Q moves to G2 on the third day (the map of that date), keeping its own return on each date.
    const d3: SessionInput = {
      d: "2030-02-05",
      close: new Map([
        ["P", 121],
        ["Q", 108],
        ["R", 110],
      ]),
      members: new Map([
        ["P", { group: "G1", asOf: "2030-01-01" }],
        ["Q", { group: "G2", asOf: "2030-02-05" }],
        ["R", { group: "G2", asOf: "2030-01-01" }],
      ]),
    };
    const rows = sectorSeries([d1, d2, d3]);
    const at = (d: string, g: string) => rows.find((r) => r.d === d && r.group === g)!;
    // day 2: G1 = mean(+100000, +200000) = 150000 over 2; G2 = R 0 over 1
    expect(at(d2.d, "G1")).toMatchObject({ retPpm: 150000, n: 2, levelPpm: 1150000 });
    expect(at(d2.d, "G2")).toMatchObject({ retPpm: 0, n: 1, levelPpm: 1000000 });
    // day 3: G1 has only P (+100000 on 110 -> 121), Q is in G2 with R: Q 120 -> 108 = -100000, R 100 -> 110 = +100000
    expect(at(d3.d, "G1")).toMatchObject({ retPpm: 100000, n: 1, levelPpm: 1265000 });
    expect(at(d3.d, "G2")).toMatchObject({
      retPpm: 0,
      n: 2,
      levelPpm: 1000000,
      mapAsOf: "2030-02-05",
    });
  });

  it("a group with no row on a session keeps its level for the next chain", () => {
    const m = new Map<string, Member>([
      ["X", { group: "G", asOf: "2030-01-01" }],
      ["Y", { group: "H", asOf: "2030-01-01" }],
    ]);
    const mk = (d: string, x: number | null, y: number): SessionInput => ({
      d,
      close: new Map<string, number>([
        ["Y", y],
        ...(x === null ? [] : ([["X", x]] as [string, number][])),
      ]),
      members: m,
    });
    const rows = sectorSeries([
      mk("2030-03-01", 100, 100),
      mk("2030-03-02", 110, 100),
      mk("2030-03-03", null, 100),
      mk("2030-03-04", 121, 100),
    ]);
    expect(rows.filter((r) => r.group === "G").map((r) => [r.d, r.retPpm, r.levelPpm])).toEqual([
      ["2030-03-02", 100000, 1100000],
    ]); // the gap day has no price, and the day after has no previous price either
  });
});

describe("month entries and level returns (what the IC look reads)", () => {
  it("monthStarts takes the first session of each calendar month", () => {
    expect(
      monthStarts(["2030-01-30", "2030-01-31", "2030-02-01", "2030-02-04", "2030-03-01"]),
    ).toEqual([
      { month: 0, index: 0, d: "2030-01-30" },
      { month: 1, index: 2, d: "2030-02-01" },
      { month: 2, index: 4, d: "2030-03-01" },
    ]);
  });

  it("monthEntries gives the groups and member counts of the month's first row date", () => {
    const rows = sectorSeries(days());
    expect(monthEntries(rows)).toEqual([
      {
        month: 0,
        groups: [
          { group: "GA", members: 2 },
          { group: "GB", members: 3 },
          { group: "GC", members: 1 },
        ],
      },
    ]);
  });

  it("levelAt carries forward and levelReturnPpm is the level ratio in ppm", () => {
    const rows = sectorSeries(days());
    expect(levelAt(rows, "GA", SESSIONS[0])).toBeNull();
    expect(levelAt(rows, "GA", SESSIONS[2])).toBe(1025000);
    expect(levelAt(rows, "GA", "2030-12-31")).toBe(1071125);
    expect(levelReturnPpm(rows, "GA", SESSIONS[1], SESSIONS[3])).toBe(100000); // 1,127,500 / 1,025,000 - 1
    expect(levelReturnPpm(rows, "GC", SESSIONS[1], SESSIONS[2])).toBe(-400000);
    expect(levelReturnPpm(rows, "GC", SESSIONS[0], SESSIONS[2])).toBeNull();
  });
});

describe("the stored series equals the pure one (the step, five nights)", () => {
  it("writes the hand-computed rows night by night, forward only", async () => {
    const db = await freshDb("main");
    await enableZz(db);
    await plantZz(db);
    for (const d of SESSIONS) {
      await writeSectorIndexFor(db, d);
    }
    const r = await db.execute(
      "SELECT d, group_code, weighting, ret_ppm, level_ppm, n_members, map_as_of FROM sector_index WHERE market = 'ZZ' ORDER BY d, group_code",
    );
    expect(
      r.rows.map((x) => ({
        d: String(x.d),
        group: String(x.group_code),
        retPpm: Number(x.ret_ppm),
        levelPpm: Number(x.level_ppm),
        n: Number(x.n_members),
      })),
    ).toEqual(EXPECTED);
    expect(r.rows.every((x) => x.weighting === "equal" && x.map_as_of === CLASS_AS_OF)).toBe(true);
  });
});

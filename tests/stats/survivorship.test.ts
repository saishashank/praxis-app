// @vitest-environment node
// Survivorship series, exposure partition, delisting sensitivity and code reuse (M4 T13; ARN-082, DAT-125).
import { describe, expect, it } from "vitest";
import { makeRational } from "../../src/lib/money/rational";
import {
  DELISTING_LIMITATION,
  announcementListByYear,
  delistingSensitivity,
  detectCodeReuse,
  partitionByExposure,
  survivorshipSeries,
  type Announcement,
} from "../../src/lib/stats/survivorship";
import { PARAMS, weekdayCalendar } from "../fixtures/stats/t13";

const calendar = weekdayCalendar(1100); // 2015-01-05 .. about 2019-02
const at = (i: number): string => calendar[i]!;
const yearAt = (i: number): number => Number(at(i).slice(0, 4));

/** Three announcements for `code` at calendar indexes a, a+gap1, a+gap1+gap2. */
function triple(code: string, a: number, g1 = 5, g2 = 5): Announcement[] {
  return [
    { code, d: at(a) },
    { code, d: at(a + g1) },
    { code, d: at(a + g1 + g2) },
  ];
}

describe("the DAT-125 list (>= 3 announcements in the previous 60 sessions)", () => {
  it("lists a code in the year(s) of the sessions that can see all three", () => {
    const list = announcementListByYear(triple("AAA", 100), calendar, PARAMS);
    expect(list.get(yearAt(111))?.has("AAA")).toBe(true);
  });
  it("two announcements are not enough", () => {
    const two = triple("AAA", 100).slice(0, 2);
    expect(announcementListByYear(two, calendar, PARAMS).size).toBe(0);
  });
  it("three announcements spread over 60 sessions or more are not on the list; 59 apart are", () => {
    // first at 100, third at 100 + 59 -> inside a 60-session look-back from 160; third at 160 -> not.
    const inside: Announcement[] = [100, 130, 159].map((i) => ({ code: "AAA", d: at(i) }));
    const outside: Announcement[] = [100, 130, 160].map((i) => ({ code: "BBB", d: at(i) }));
    expect(announcementListByYear(inside, calendar, PARAMS).size).toBe(1);
    expect(announcementListByYear(outside, calendar, PARAMS).size).toBe(0);
  });
  it("a window that crosses a year end lists the code in both years", () => {
    const y = calendar.findIndex((d) => d.startsWith("2016-01-0"));
    const list = announcementListByYear(triple("CCC", y - 6, 2, 2), calendar, PARAMS);
    expect(list.get(2015)?.has("CCC")).toBe(true);
    expect(list.get(2016)?.has("CCC")).toBe(true);
  });
});

describe("missing share per year and the 5 % flag", () => {
  // 25 codes listed in 2016, all announcing three times mid-2016.
  const mid = calendar.findIndex((d) => d.startsWith("2016-06-0"));
  const announcements = Array.from({ length: 25 }, (_, i) =>
    triple(`C${String(i).padStart(2, "0")}`, mid, 3, 3),
  ).flat();
  const codes = Array.from({ length: 25 }, (_, i) => `C${String(i).padStart(2, "0")}`);
  const run = (missing: number) =>
    survivorshipSeries({
      announcements,
      calendar,
      hasPrice: new Set(codes.slice(missing)),
      params: PARAMS,
    });

  it("1 of 25 missing is 4 %: not exposed; 2 of 25 is 8 %: exposed", () => {
    const a = run(1).find((y) => y.year === 2016)!;
    expect(a.listed).toBe(25);
    expect(a.missing).toBe(1);
    expect(a.share).toEqual(makeRational(1n, 25n));
    expect(a.exposed).toBe(false);
    const b = run(2).find((y) => y.year === 2016)!;
    expect(b.exposed).toBe(true);
  });
  it("exactly 5 % is not above the threshold", () => {
    // 1 of 20 listed.
    const twenty = codes.slice(0, 20);
    const ann = twenty.flatMap((c) => triple(c, mid, 3, 3));
    const s = survivorshipSeries({
      announcements: ann,
      calendar,
      hasPrice: new Set(twenty.slice(1)),
      params: PARAMS,
    }).find((y) => y.year === 2016)!;
    expect(s.share).toEqual(makeRational(1n, 20n));
    expect(s.exposed).toBe(false);
  });
  it("a year with nobody listed is measured, empty and not exposed", () => {
    const y = run(2).find((v) => v.year === 2018)!;
    expect(y).toMatchObject({ listed: 0, missing: 0, share: null, exposed: false });
  });
  it("years before the announcement backfill are 'survivorship unknown (exposed)'", () => {
    const s = survivorshipSeries({
      announcements,
      calendar,
      hasPrice: new Set(codes),
      params: PARAMS,
      announcementBackfillStartD: "2016-01-04",
    });
    expect(s.find((y) => y.year === 2015)).toMatchObject({ status: "unknown", exposed: true });
    expect(s.find((y) => y.year === 2016)!.status).toBe("measured");
  });
  it("is deterministic and sorted by year", () => {
    const a = run(2);
    expect(JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      JSON.stringify(run(2), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
    expect(a.map((y) => y.year)).toEqual([...a.map((y) => y.year)].sort());
  });
});

describe("results with and without exposed years", () => {
  const series = [
    {
      year: 2015,
      status: "measured",
      listed: 10,
      missing: 0,
      share: makeRational(0n, 10n),
      exposed: false,
    },
    {
      year: 2016,
      status: "measured",
      listed: 10,
      missing: 3,
      share: makeRational(3n, 10n),
      exposed: true,
    },
  ] as const;
  it("splits rows by entry year and reports the exposed share exactly", () => {
    const rows = [
      { entryD: "2015-03-02", x: 1 },
      { entryD: "2016-03-02", x: 2 },
      { entryD: "2016-04-04", x: 3 },
      { entryD: "2016-05-02", x: 4 },
    ];
    const p = partitionByExposure(rows, series);
    expect(p.withoutExposed.map((r) => r.x)).toEqual([1]);
    expect(p.exposed.map((r) => r.x)).toEqual([2, 3, 4]);
    expect(p.exposedShare).toEqual(makeRational(3n, 4n));
    expect(partitionByExposure([], series).exposedShare).toBeNull();
  });
});

describe("delisting sensitivity", () => {
  const rows = [
    {
      id: "a",
      code: "AAA",
      entryD: "2016-01-04",
      exitD: "2016-03-01",
      net: 0.05,
      lastTradedNet: -0.3,
    },
    {
      id: "b",
      code: "BBB",
      entryD: "2016-01-04",
      exitD: "2016-03-01",
      net: 0.03,
      lastTradedNet: null,
    },
    { id: "c", code: "CCC", entryD: "2016-01-04", exitD: "2016-03-01", net: 0.01 },
    { id: "d", code: "AAA", entryD: "2016-04-04", exitD: "2016-05-02", net: 0.02 },
  ];
  const delisted = new Map([
    ["AAA", "2016-02-10"],
    ["BBB", "2016-02-20"],
  ]);
  it("re-scores rows delisted within their hold at the last price or -100 %", () => {
    const s = delistingSensitivity(rows, delisted);
    expect(s.n).toBe(4);
    expect(s.affected).toBe(2); // row d starts after AAA's delisting: not in its hold
    expect(s.unscorable).toBe(1);
    expect(s.baseMean).toBeCloseTo((0.05 + 0.03 + 0.01 + 0.02) / 4, 12);
    expect(s.lastPriceMean).toBeCloseTo((-0.3 + 0.03 + 0.01 + 0.02) / 4, 12);
    expect(s.wipeoutMean).toBeCloseTo((-1 - 1 + 0.01 + 0.02) / 4, 12);
    expect(s.limitation).toBe(DELISTING_LIMITATION);
  });
  it("nothing delisted leaves all three means equal; empty input has null means", () => {
    const s = delistingSensitivity(rows, new Map());
    expect(s.affected).toBe(0);
    expect(s.lastPriceMean).toBe(s.baseMean);
    expect(s.wipeoutMean).toBe(s.baseMean);
    expect(delistingSensitivity([], delisted).baseMean).toBeNull();
  });
  it("the delisting date on the entry or exit day counts as within the hold", () => {
    const edge = [
      { id: "e", code: "AAA", entryD: "2016-02-10", exitD: "2016-03-01", net: 0.1 },
      { id: "f", code: "AAA", entryD: "2016-01-04", exitD: "2016-02-10", net: 0.1 },
    ];
    expect(delistingSensitivity(edge, delisted).affected).toBe(2);
  });
  it("is independent of the row order", () => {
    const a = delistingSensitivity(rows, delisted);
    const b = delistingSensitivity([...rows].reverse(), delisted);
    expect(b).toEqual(a);
  });
});

describe("code reuse (flag only)", () => {
  it("flags a gap of at least the threshold followed by a different name", () => {
    const spans = [
      { code: "XYZ", name: "Old Mining Ltd", firstIdx: 0, lastIdx: 300 },
      { code: "XYZ", name: "New Tech Ltd", firstIdx: 450, lastIdx: 900 },
      { code: "ABC", name: "Same Ltd", firstIdx: 0, lastIdx: 100 },
      { code: "ABC", name: "Same Ltd", firstIdx: 400, lastIdx: 600 },
      { code: "DEF", name: "A Ltd", firstIdx: 0, lastIdx: 100 },
      { code: "DEF", name: "B Ltd", firstIdx: 150, lastIdx: 600 },
    ];
    expect(detectCodeReuse(spans, 120)).toEqual([
      { code: "XYZ", gapSessions: 150, fromName: "Old Mining Ltd", toName: "New Tech Ltd" },
    ]);
    expect(detectCodeReuse(spans, 151)).toEqual([]);
  });
});

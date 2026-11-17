// @vitest-environment node
// M23 R2 (D-1685 to D-1688): the CXA-003 detectors, the universe, the windows and the frozen plan on synthetic ZZ series.
// Every code, price and date here is made up; nothing reads the history extract.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TierRules } from "@/lib/data/universe/tiers.mjs";
import {
  boundarySessionOf,
  buildSetups,
  CXA003_PARAMS,
  HOLDS,
  holdoutEntryCounts,
  hi52VolSessions,
  monthStartSessions,
  parseSeries,
  priceBook,
  sessionsFromIndexFile,
  shortCoverSessions,
  splitWindows,
  studyWindow,
  Universe,
  type Series,
  type ShortReport,
  type World,
} from "@/lib/research/lineages/cxa003";
import { PARCEL_BASE_MICRO } from "@/lib/research/costs";

const DAY = 86_400;
const T0 = Date.UTC(2020, 0, 1) / 1000; // a Wednesday

/** The first `n` weekday dates from 2020-01-01 as Unix seconds. */
function weekdays(n: number): number[] {
  const out: number[] = [];
  for (let d = 0; out.length < n; d += 1) {
    const ts = T0 + d * DAY;
    const dow = new Date(ts * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(ts);
  }
  return out;
}
const iso = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

const N = 320;
const STAMPS = weekdays(N);
const DATES = STAMPS.map(iso);
const SESSION_OF = new Map(DATES.map((d, i) => [d, i]));

function file(over: {
  close?: (i: number) => number | null;
  volume?: (i: number) => number | null;
  open?: (i: number) => number | null;
  from?: number;
  splits?: Record<string, { date: number; numerator: number; denominator: number }>;
}) {
  const from = over.from ?? 0;
  const ts = STAMPS.slice(from);
  const idx = ts.map((_, k) => k + from);
  const close = over.close ?? (() => 10);
  return {
    tz: "UTC",
    timestamps: ts,
    open: idx.map((i) => (over.open ?? close)(i)),
    low: idx.map((i) => (close(i) ?? 10) * 0.99),
    close: idx.map((i) => close(i)),
    volume: idx.map((i) => (over.volume ?? (() => 1000))(i)),
    splits: over.splits ?? {},
  };
}
const series = (code: string, f: ReturnType<typeof file>): Series =>
  parseSeries(code, f, SESSION_OF, N)!;

describe("calendar and series", () => {
  it("session dates come from the index file non-null closes; an off-calendar bar is dropped", () => {
    const idx = { tz: "UTC", timestamps: STAMPS.slice(0, 5), close: [1, 1, null, 1, 1] };
    expect(sessionsFromIndexFile(idx)).toEqual([DATES[0], DATES[1], DATES[3], DATES[4]]);
    const s = parseSeries("ZZA", file({}), new Map([[DATES[3]!, 0]]), 1)!;
    expect(s.session.length).toBe(1);
  });

  it("a later split gives the raw close factor of earlier bars; a missing open stays unfilled", () => {
    const split = { a: { date: STAMPS[10]!, numerator: 2, denominator: 1 } };
    const s = series("ZZA", file({ splits: split, open: (i) => (i === 3 ? null : 10) }));
    expect(s.rawFactor[9]).toBe(2);
    expect(s.rawFactor[10]).toBe(1);
    expect(Number.isNaN(s.open[3]!)).toBe(true);
    const book = priceBook({ dates: DATES, series: new Map([["ZZA", s]]) });
    expect(book.open("ZZA", 3)).toBeUndefined();
    expect(book.open("ZZA", 4)).toBe(10_000_000n);
  });
});

describe("hi52_vol detector", () => {
  const rising = (i: number): number => 10 + i * 0.01;
  it("signals only a close at its 252-session high on at least twice the 20-session median volume", () => {
    const f = file({ close: rising, volume: (i) => (i === 290 ? 2500 : i === 291 ? 1999 : 1000) });
    // closes rise every session so every session is a high; only 290 has volume of at least 2 x the median of 1000
    expect(hi52VolSessions(series("ZZA", f))).toEqual([290]);
  });

  it("a higher close inside the window blocks the signal; a tie with the high still counts", () => {
    const tie = file({
      close: (i) => (i === 285 ? 50 : i === 290 ? 50 : 10 + (i % 3) * 0.1),
      volume: (i) => (i === 290 ? 5000 : 1000),
    });
    expect(hi52VolSessions(series("ZZA", tie))).toEqual([290]);
    const blocked = file({
      close: (i) => (i === 285 ? 60 : i === 290 ? 50 : 10),
      volume: (i) => (i === 290 ? 5000 : 1000),
    });
    expect(hi52VolSessions(series("ZZA", blocked))).toEqual([]);
  });

  it("a short history gives no signal; the first full window ends 251 sessions after the first bar", () => {
    const short = file({ from: 100, close: rising, volume: (i) => (i === 330 ? 9999 : 1000) });
    expect(hi52VolSessions(series("ZZA", short))).toEqual([]); // 220 sessions of history only
    const exact = file({
      from: 20,
      close: rising,
      volume: (i) => (i === 271 || i === 270 ? 9999 : 1000),
    });
    // first bar at session 20: the first full window ends at session 271; 270 is too early
    expect(hi52VolSessions(series("ZZA", exact))).toEqual([271]);
  });

  it("too few volume bars in the 20 prior sessions gives no signal", () => {
    const s = series("ZZA", file({ close: rising, volume: (i) => (i === 290 ? 9999 : 1000) }));
    for (let t = 275; t < 290; t += 1) s.pos[t] = -1; // 15 of the 20 prior sessions have no bar
    expect(hi52VolSessions(s)).toEqual([]);
  });
});

describe("month start", () => {
  it("is the first session of each calendar month", () => {
    const starts = monthStartSessions(DATES);
    expect(DATES[starts[0]!]).toBe("2020-01-01");
    expect(DATES[starts[1]!]).toBe("2020-02-03"); // 1 Feb is a Saturday
    expect(starts.length).toBe(new Set(DATES.map((d) => d.slice(0, 7))).size);
  });
});

describe("short_cover detector", () => {
  const report = (asOf: string, published: string, pct: number): ShortReport => ({
    asOf,
    published: `${published}T23:59:59.000Z`,
    pct,
  });
  // daily reports published 3 sessions after their date
  const daily = (pctAt: (i: number) => number): ShortReport[] =>
    DATES.slice(0, N - 4).map((d, i) => report(d, DATES[i + 3]!, pctAt(i)));

  it("fires at the first session a report is known, at 5 percent or more and 2 points below the report known 20 sessions earlier", () => {
    const got = shortCoverSessions(
      daily((i) => (i < 100 ? 8 : 5.5)),
      DATES,
    );
    // the report dated session 100 is published on session 103 (end of day) and known at the close of session 104;
    // the report known 20 sessions earlier (session 84) is the one dated session 80: 8 to 5.5 is a fall of 2.5 points
    expect(got[0]).toBe(104);
    // the signal lasts while the reference report is still from before the drop: sessions 104 to 123
    expect(got.length).toBe(20);
    expect(got[got.length - 1]).toBe(123);
  });

  it("a report not yet published at the session does not count (the publication lag)", () => {
    const reports = [report(DATES[50]!, DATES[60]!, 8), report(DATES[70]!, DATES[80]!, 5)];
    // known at 61 and 81; at 81 the report known 20 sessions earlier (61) is the first: 8 to 5 is a fall of 3
    expect(shortCoverSessions(reports, DATES)).toEqual([81]);
    // published later (known at 84) the reference at 64 is still the first report: the signal moves to 84
    const late = [report(DATES[50]!, DATES[60]!, 8), report(DATES[70]!, DATES[83]!, 5)];
    expect(shortCoverSessions(late, DATES)).toEqual([84]);
    // with a lag past the calendar end the report is never known
    const never = [report(DATES[50]!, DATES[60]!, 8), report(DATES[70]!, "2999-01-01", 5)];
    expect(shortCoverSessions(never, DATES)).toEqual([]);
  });

  it("a level below 5 percent or a fall of less than 2 points gives none", () => {
    expect(
      shortCoverSessions(
        daily((i) => (i < 100 ? 4.9 : 2)),
        DATES,
      ),
    ).toEqual([]);
    expect(
      shortCoverSessions(
        daily((i) => (i < 100 ? 8 : 6.5)),
        DATES,
      ),
    ).toEqual([]);
  });
});

describe("windows, purge and unfinished", () => {
  const setup = (signalSession: number, hold = 21) => ({ code: "ZZA", signalSession, hold });
  it("splits at the boundary, purges development setups that exit in the holdout and drops unfinished exits", () => {
    const boundary = boundarySessionOf(DATES, "2020-10-01");
    const w = splitWindows(
      [
        setup(boundary - 40), // exit 18 sessions before the boundary: development
        setup(boundary - 10), // exit 12 sessions after the boundary: purged
        setup(boundary + 5), // holdout
        setup(N - 10), // exit after the last session: unfinished
      ],
      boundary,
      N - 1,
    );
    expect(w.development.length).toBe(1);
    expect(w.holdout.length).toBe(1);
    expect(w.purged).toBe(1);
    expect(w.unfinished).toBe(1);
  });

  it("counts the holdout entries against the floors without reading a price", () => {
    const setups = Array.from({ length: 70 }, (_, i) => ({
      code: `ZZ${i}`,
      signalSession: 200 + i,
      hold: 21,
    }));
    const r = holdoutEntryCounts(splitWindows(setups, 100, 10_000));
    expect(r.counts.setups).toBe(70);
    expect(r.floorsMet).toBe(r.counts.blocks >= CXA003_PARAMS.floors.minBlocks);
  });

  it("the boundary session is the first date on or after the holdout start", () => {
    expect(boundarySessionOf(DATES, "2020-02-03")).toBe(monthStartSessions(DATES)[1]);
    expect(boundarySessionOf(DATES, "2999-01-01")).toBe(DATES.length);
  });
});

describe("universe and low-volatility lineage", () => {
  const rules: TierRules = {
    windowSessions: 60,
    u1: { advMicro: 1_000n, priceMicro: 500_000n, top: 2, minSessions: 54 },
    u2: { advMicro: 1_000_000_000n, priceMicro: 200_000n, listedDays: 365, mcapMicro: 0n },
    u3: { advMicro: 1_000_000_000n, priceMicro: 100_000n },
  };
  // four codes with steady noise of different size; ZZC trades a tiny volume (not U1), ZZD has a short history
  const noisy = (amp: number) => (i: number) => 10 + amp * Math.sin(i * 1.7);
  const world: World = {
    dates: DATES,
    series: new Map([
      ["ZZA", series("ZZA", file({ close: noisy(0.05), volume: () => 500_000 }))],
      ["ZZB", series("ZZB", file({ close: noisy(0.5), volume: () => 400_000 }))],
      ["ZZC", series("ZZC", file({ close: noisy(0.1), volume: () => 1 }))],
      ["ZZD", series("ZZD", file({ close: noisy(0.1), volume: () => 600_000, from: 300 }))],
    ]),
  };

  it("U1 is the top codes by 60-session median traded value with enough bars; the quiet one is decile 0", () => {
    const u = new Universe(world, rules);
    const rows = u.at(150);
    expect(rows.map((r) => r.code).sort()).toEqual(["ZZA", "ZZB"]);
    expect(rows.find((r) => r.code === "ZZA")!.volDecile).toBe(0);
    expect(rows.find((r) => r.code === "ZZB")!.volDecile).toBe(5); // floor(1 * 10 / 2)
    // the pool of an entry session is the universe of the signal session before it
    expect(
      u
        .pool()(151)
        .map((c) => c.code)
        .sort(),
    ).toEqual(["ZZA", "ZZB"]);
  });

  it("the low-volatility setups are the decile-0 codes on each month first session", () => {
    const u = new Universe(world, rules);
    const setups = buildSetups("lowvol", world, u, new Map());
    expect(new Set(setups.map((s) => s.code))).toEqual(new Set(["ZZA"]));
    expect(setups.every((s) => s.hold === HOLDS.lowvol && s.tier === "U1")).toBe(true);
    const starts = new Set(monthStartSessions(DATES));
    expect(setups.every((s) => starts.has(s.signalSession))).toBe(true);
  });

  it("below the floors the study returns before any price is read", () => {
    const u = new Universe(world, rules);
    const setups = buildSetups("lowvol", world, u, new Map());
    const guarded = {
      open: () => {
        throw new Error("a price was read");
      },
    };
    const r = studyWindow({
      key: "lowvol",
      setups,
      prices: guarded,
      pool: u.pool(),
      k: 3,
      parcelMicro: PARCEL_BASE_MICRO,
      costProfile: "P6",
    });
    expect(r.status).toBe("below_sample");
  });

  it("with the floors lowered the study gives a verdict word and counts", () => {
    const u = new Universe(world, rules);
    const setups = buildSetups("lowvol", world, u, new Map());
    const r = studyWindow({
      key: "lowvol",
      setups,
      prices: priceBook(world),
      pool: u.pool(),
      k: 1,
      parcelMicro: PARCEL_BASE_MICRO,
      costProfile: "P6",
      floors: { minSetups: 3, minBlocks: 3 },
      replicates: 200,
    });
    expect(r.status).toBe("looked");
    if (r.status === "looked") expect(["PASS", "NULL", "INCONCLUSIVE"]).toContain(r.verdict);
  });
});

describe("the code agrees with the frozen plan", () => {
  const plan = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../docs/research/prereg/CXA-003.json"), "utf8"),
  ) as {
    common: {
      split: { developmentTo: string; holdoutFrom: string };
      floors: { setups: number; blocks: number };
    };
    lineages: { id: string; hold?: number; detector: string }[];
    variants: { id: string; parcelMicro: string; countsInK: boolean }[];
  };
  const lineage = (id: string) => plan.lineages.find((l) => l.id === id)!;

  it("holds, floors and boundary match", () => {
    expect(lineage("cxa003_hi52_vol").hold).toBe(CXA003_PARAMS.hi52.hold);
    expect(lineage("cxa003_lowvol").hold).toBe(CXA003_PARAMS.lowvol.hold);
    expect(lineage("cxa003_short_cover").hold).toBe(CXA003_PARAMS.shortCover.hold);
    expect(plan.common.floors.setups).toBe(CXA003_PARAMS.floors.minSetups);
    expect(plan.common.floors.blocks).toBe(CXA003_PARAMS.floors.minBlocks);
    expect(plan.common.split.developmentTo).toBe(CXA003_PARAMS.boundary.developmentTo);
    expect(plan.common.split.holdoutFrom).toBe(CXA003_PARAMS.boundary.holdoutFrom);
  });

  it("the detector words carry the numbers the code uses", () => {
    const h = lineage("cxa003_hi52_vol").detector;
    expect(h).toContain(`${CXA003_PARAMS.hi52.windowSessions} sessions`);
    expect(h).toContain(`${CXA003_PARAMS.hi52.volumeMultiple} times`);
    expect(h).toContain(`${CXA003_PARAMS.hi52.volumeSessions} prior sessions`);
    expect(h).toContain(`at least ${CXA003_PARAMS.hi52.volumeMinBars} with a bar`);
    const s = lineage("cxa003_short_cover").detector;
    expect(s).toContain(`at least ${CXA003_PARAMS.shortCover.minSharePct} percent`);
    expect(s).toContain(`${CXA003_PARAMS.shortCover.minFallPp} percentage points`);
    expect(s).toContain(`${CXA003_PARAMS.shortCover.lookbackSessions} sessions earlier`);
  });

  it("the variants are three, at the larger parcel, and never counted in k", () => {
    expect(plan.variants.map((v) => v.id)).toEqual([
      "cxa003_hi52_vol_p5000",
      "cxa003_lowvol_p5000",
      "cxa003_short_cover_p5000",
    ]);
    expect(
      plan.variants.every((v) => v.parcelMicro === "5000000000" && v.countsInK === false),
    ).toBe(true);
  });
});

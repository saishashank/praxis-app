// @vitest-environment node
// The store side of the movers gap additions (CR-MOV-A1, A2, A3, A8; D-740…D-759) on a migrated test DB
// with synthetic ZZ data: the halt watch from live announcements and the view, the arms, the live
// volume-creep flags, the known result dates and the EOD sector composite. Idempotent writers.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import type { EventRow } from "@/lib/cortex/pit/types";
import { DEFAULT_MOVERS_PARAMS } from "@/lib/cortex/moversParams";
import {
  advanceHaltWatch,
  armedCatalysts,
  armHaltResumes,
  gridNeighbourhood,
  latestHaltWatch,
  loadMoversNight,
  loadMoversParams,
  marketHoursOf,
  openHaltWatches,
  recordCreepFlags,
  sectorReturns,
  writeSectorComposite,
} from "@/lib/cortex/store/movers";
import { localToUtc } from "@/lib/data/calendar";
import { synthWorld, weekdaySessions, type PathSpec } from "../angles/d1d2World";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const TZ = "Australia/Melbourne";
const SESSIONS = weekdaySessions(40, Date.UTC(2030, 0, 1)); // 2030-01-01 … (Tue)
const S = (i: number): string => SESSIONS[i]!;
const at = (d: string, hhmm: string): string => localToUtc(d, hhmm, TZ).toISOString();
const NOW = "2030-03-01T09:00:00.000Z";

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

async function ann(
  code: string,
  id: string,
  publishedAt: string,
  title: string,
  type: string | null = null,
) {
  await db.execute({
    sql:
      "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source) " +
      "VALUES ('AU', ?, ?, ?, ?, ?, 1, ?, 'zz')",
    args: [code, id, publishedAt, publishedAt, type, title],
  });
}

// ZZH: a halt notice on session 30 (pre-open), halted sessions 30 and 31, trades again on session 32.
const haltedPath: PathSpec = {
  close: () => 1_000,
  volume: (i) => (i === 30 || i === 31 ? 0 : 100_000),
};
const haltedWorld = () =>
  synthWorld({
    sessions: SESSIONS,
    codes: { ZZH: haltedPath, ZZN: { close: () => 1_000 } },
    overrides: {
      halts: new Map([
        [
          "ZZH",
          [
            { d: S(29), halted: false },
            { d: S(30), halted: true },
            { d: S(32), halted: false },
          ],
        ],
      ]),
    },
  });

describe("halt watch from announcements and the view (A1)", () => {
  it("opens on the notice night with the class from the neighbour, stays open, resumes once", async () => {
    await ann("ZZH", "h1", at(S(30), "08:45"), "Trading Halt", "Trading Halt");
    await ann("ZZH", "h2", at(S(29), "17:30"), "Proposed capital raising");
    await ann("ZZN", "n1", at(S(30), "09:00"), "Quarterly report");
    const world = haltedWorld();
    const view = buildAsOfView(world);
    const hours = await marketHoursOf(db, "AU");
    const o = (i: number) => ({
      market: "AU",
      d: S(i),
      view,
      t: i,
      now: `${S(i)}T09:00:00.000Z`,
      calendar: world.calendar,
      hours,
    });

    expect(await advanceHaltWatch(db, o(29))).toEqual({ opened: 0, resumed: 0 }); // notice not yet published
    expect(await advanceHaltWatch(db, o(30))).toEqual({ opened: 1, resumed: 0 });
    expect(await advanceHaltWatch(db, o(30))).toEqual({ opened: 0, resumed: 0 }); // a re-run changes nothing
    expect(await advanceHaltWatch(db, o(31))).toEqual({ opened: 0, resumed: 0 });
    let w = (await latestHaltWatch(db, "AU", S(0))).get("ZZH")!;
    expect(w).toMatchObject({
      sinceD: S(30),
      status: "open",
      reasonClass: "capital_raise",
      expectedSign: -1,
      seq: 1,
    });
    expect([...(await latestHaltWatch(db, "AU", S(0))).keys()]).toEqual(["ZZH"]);

    expect(await advanceHaltWatch(db, o(32))).toEqual({ opened: 0, resumed: 1 });
    w = (await latestHaltWatch(db, "AU", S(0))).get("ZZH")!;
    expect(w).toMatchObject({ status: "resumed", resumeD: S(32), seq: 2 });
    // the resumed notice is never reopened by a later night
    expect(await advanceHaltWatch(db, o(33))).toEqual({ opened: 0, resumed: 0 });
  });

  it("only announcements published by the cut-off count (point in time)", async () => {
    await ann("ZZH", "h1", at(S(30), "20:30"), "Trading Halt", "Trading Halt"); // after the 18:10 cut-off
    const world = haltedWorld();
    const view = buildAsOfView(world);
    const r = await advanceHaltWatch(db, {
      market: "AU",
      d: S(30),
      view,
      t: 30,
      now: NOW,
      calendar: world.calendar,
      hours: await marketHoursOf(db, "AU"),
    });
    expect(r.opened).toBe(0);
  });

  it("loadMoversNight carries the latest watch per code; openHaltWatches lists the open ones for the review", async () => {
    await ann("ZZH", "h1", at(S(30), "08:45"), "Trading Halt", "Trading Halt");
    const world = haltedWorld();
    const view = buildAsOfView(world);
    await advanceHaltWatch(db, {
      market: "AU",
      d: S(30),
      view,
      t: 30,
      now: NOW,
      calendar: world.calendar,
      hours: await marketHoursOf(db, "AU"),
    });
    const params = await loadMoversParams(db);
    expect(params).toEqual(DEFAULT_MOVERS_PARAMS);
    const night = await loadMoversNight(db, { market: "AU", d: S(31), params });
    expect(night.haltWatch.get("ZZH")).toMatchObject({ status: "open", reasonClass: "unknown" });
    expect(night.knownDates.size).toBe(0); // no archive yet
    const open = await openHaltWatches(
      db,
      "AU",
      S(31),
      params.haltWatchExpirySessions,
      world.calendar,
    );
    expect(open).toEqual([{ code: "ZZH", reasonClass: "unknown", expectedSign: 0, sinceD: S(30) }]);
  });
});

describe("arming the intraday scan (A1, A3)", () => {
  const seedWatch = (code: string, since: string, status = "open", sign = -1) =>
    db.execute({
      sql:
        "INSERT INTO halt_watch (market, code, since_d, seq, status, reason_class, expected_sign, resume_d, known_at) " +
        `VALUES ('AU', ?, ?, 1, ?, 'capital_raise', ?, ${status === "resumed" ? `'${since}'` : "NULL"}, 't')`,
      args: [code, since, status, sign],
    });

  it("arms an open watch from the session after the notice, with its sign, from the arm minute", async () => {
    await seedWatch("ZZH", S(30));
    await seedWatch("ZZR", S(30), "resumed");
    const world = haltedWorld();
    const hours = await marketHoursOf(db, "AU");
    const arm = (sessionD: string) =>
      armHaltResumes(db, {
        market: "AU",
        sessionD,
        now: NOW,
        params: DEFAULT_MOVERS_PARAMS,
        calendar: world.calendar,
        hours,
      });
    expect(await arm(S(30))).toBe(0); // the notice day is the scan's own catalyst
    expect(await arm(S(31))).toBe(1);
    expect(await arm(S(31))).toBe(0); // idempotent
    const early = await armedCatalysts(db, {
      market: "AU",
      sessionD: S(31),
      nowLocalHhmm: "09:59",
      cap: 20,
    });
    expect(early.size).toBe(0);
    const open = await armedCatalysts(db, {
      market: "AU",
      sessionD: S(31),
      nowLocalHhmm: "10:00",
      cap: 20,
    });
    expect([...open.keys()]).toEqual(["ZZH"]);
    expect(open.get("ZZH")).toMatchObject({
      source: "arm",
      category: "halt_resume",
      materiality: 2,
      polarity: -1,
    });
    expect(await arm(S(37))).toBe(0); // past the 5-session expiry
  });

  it("a reinstatement notice published before the arm time arms a code the watch never saw", async () => {
    await ann("ZZI", "r1", at(S(31), "09:20"), "Reinstatement to Official Quotation");
    const world = haltedWorld();
    const n = await armHaltResumes(db, {
      market: "AU",
      sessionD: S(31),
      now: at(S(31), "09:30"),
      params: DEFAULT_MOVERS_PARAMS,
      calendar: world.calendar,
      hours: await marketHoursOf(db, "AU"),
    });
    expect(n).toBe(1);
    const c = await armedCatalysts(db, {
      market: "AU",
      sessionD: S(31),
      nowLocalHhmm: "10:30",
      cap: 20,
    });
    expect(c.get("ZZI")).toMatchObject({ polarity: 0, category: "halt_resume" });
  });

  it("intraday_arm_codes_max caps the arms of a session (0 = none) and the catalysts read", async () => {
    for (const c of ["ZZA", "ZZB", "ZZC"]) await seedWatch(c, S(30));
    const world = haltedWorld();
    const hours = await marketHoursOf(db, "AU");
    const n = await armHaltResumes(db, {
      market: "AU",
      sessionD: S(31),
      now: NOW,
      params: { ...DEFAULT_MOVERS_PARAMS, intradayArmCodesMax: 2 },
      calendar: world.calendar,
      hours,
    });
    expect(n).toBe(2);
    expect(
      (await armedCatalysts(db, { market: "AU", sessionD: S(31), nowLocalHhmm: "11:00", cap: 1 }))
        .size,
    ).toBe(1);
    expect(
      (await armedCatalysts(db, { market: "AU", sessionD: S(31), nowLocalHhmm: "11:00", cap: 0 }))
        .size,
    ).toBe(0);
  });
});

function evOf(code: string, day0: string): EventRow {
  return {
    id: `asx|${code}-${day0}`,
    code,
    day0,
    groupKey: `${code}|${day0}`,
    category: "results",
    priceSensitive: true,
    polarity: 1,
    ar: null,
    volRatio: null,
    timed: true,
    day0LowMicro: null,
    publishedAt: `${day0}T01:00:00.000Z`,
  };
}

describe("live measurement of A-D2-07 (A3)", () => {
  const N = 60;
  const sessions = weekdaySessions(N, Date.UTC(2030, 0, 1));
  const last = N - 1;
  const spike = (jumpPct: number, vol: number): PathSpec => ({
    close: (i) => (i === last ? Math.round(1_000 * (1 + jumpPct)) : 1_000),
    volume: (i) => (i === last ? vol : 100_000),
  });
  const world = (codes: Record<string, PathSpec>, events: Map<string, EventRow[]>) =>
    synthWorld({ sessions, codes, overrides: { events } });

  it("the grid neighbourhood is the default point plus one alternative at a time", () => {
    expect(gridNeighbourhood({ vr_min: [3, 2], ar_min_pct: [2] })).toEqual([
      { vr_min: 3, ar_min_pct: 2 },
      { vr_min: 2, ar_min_pct: 2 },
    ]);
  });

  it("flags are appended per grid point and the default point arms the next session", async () => {
    const w = world(
      {
        ZZS: spike(0.05, 400_000), // 4x, 5 %: both points
        ZZT: spike(0.05, 250_000), // 2.5x: only vr_min 2
        ZZU: { close: () => 1_000 },
        ZZV: spike(0.05, 400_000), // explained by news on the last session
      },
      new Map([
        ["ZZV", [evOf("ZZV", sessions[last]!)]],
        ["ZZU", [evOf("ZZU", sessions[2]!)]],
      ]),
    );
    const view = buildAsOfView(w);
    const run = () =>
      recordCreepFlags(db, {
        market: "AU",
        d: sessions[last]!,
        view,
        t: last,
        now: NOW,
        params: DEFAULT_MOVERS_PARAMS,
        calendar: w.calendar,
        hours: { tz: TZ, open_time: "10:00", close_time: "16:00" },
      });
    expect(await run()).toEqual({ flagged: 3, armed: 1 });
    expect(await run()).toEqual({ flagged: 0, armed: 0 }); // insert-or-ignore
    const flags = (
      await db.execute(
        "SELECT code, grid_key, angle_version FROM angle_forward_flag ORDER BY code, grid_key",
      )
    ).rows.map((r) => ({ ...r }));
    expect(flags).toEqual([
      { code: "ZZS", grid_key: "ar_min_pct=2,vr_min=2", angle_version: 2 },
      { code: "ZZS", grid_key: "ar_min_pct=2,vr_min=3", angle_version: 2 },
      { code: "ZZT", grid_key: "ar_min_pct=2,vr_min=2", angle_version: 2 },
    ]);
    const arms = (await db.execute("SELECT code, reason, session_d FROM intraday_arm")).rows.map(
      (r) => ({ ...r }),
    );
    expect(arms).toEqual([{ code: "ZZS", reason: "volume_creep", session_d: "2030-03-26" }]);
  });

  it("an extract with no events at all measures nothing", async () => {
    const w = synthWorld({ sessions, codes: { ZZS: spike(0.05, 400_000) } });
    const r = await recordCreepFlags(db, {
      market: "AU",
      d: sessions[last]!,
      view: buildAsOfView(w),
      t: last,
      now: NOW,
      params: DEFAULT_MOVERS_PARAMS,
      calendar: w.calendar,
      hours: { tz: TZ, open_time: "10:00", close_time: "16:00" },
    });
    expect(r).toEqual({ flagged: 0, armed: 0 });
  });
});

describe("known result dates need a year of archive (A2, A7)", () => {
  const arch = (id: string, code: string, sessionD: string, type: string, knownAt: string) =>
    db.execute({
      sql:
        "INSERT INTO announcement_archive (market, code, source, ann_id, published_at, known_at, session_d, timing, type, price_sensitive, title) " +
        "VALUES ('AU', ?, 'zz', ?, ?, ?, ?, 'pre_open', ?, 1, 'ZZ report')",
      args: [code, id, `${sessionD}T00:00:00.000Z`, knownAt, sessionD, type],
    });

  it("empty before the archive spans known_date_min_history_days, then one row per code a year on", async () => {
    await arch("a", "ZZA", "2030-02-20", "Half Yearly Report", "2030-02-20T01:00:00.000Z");
    const p = DEFAULT_MOVERS_PARAMS;
    // the archive started on 2030-02-20: 193 days at 2030-09-01, short of the 365 needed
    expect(
      (await loadMoversNight(db, { market: "AU", d: "2030-09-01", params: p })).knownDates.size,
    ).toBe(0);
    // an earlier row makes the archive a year old on 2031-02-18; the half-year date is predicted 52 weeks on
    await arch("z", "ZZZ", "2030-01-10", "Trading Halt", "2030-01-10T01:00:00.000Z");
    const night = await loadMoversNight(db, { market: "AU", d: "2031-02-18", params: p });
    expect(night.knownDates.get("ZZA")).toEqual(["2031-02-19"]);
    expect(night.knownDates.has("ZZB")).toBe(false);
  });
});

describe("EOD sector composite (A8)", () => {
  const bar = (code: string, d: string, c: number, v: number) =>
    db.execute({
      sql:
        "INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at) " +
        "VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'zz', 't', 't')",
      args: [code, d, c, c, c, c, v],
    });
  const cls = (code: string, industry: string) =>
    db.execute({
      sql: "INSERT INTO instrument_class (market, code, industry, source, as_of, loaded_at) VALUES ('AU', ?, ?, 'zz', '2030-03-01', 't')",
      args: [code, industry],
    });

  it("equal-weights the liquid names of an industry; the split guard and the liquidity floor leave names out", async () => {
    for (const [c, ind] of [
      ["ZZ1", "ZZIND"],
      ["ZZ2", "ZZIND"],
      ["ZZ3", "ZZIND"],
      ["ZZ4", "ZZIND"],
      ["ZZ5", "ZZIND"],
      ["ZZ6", "ZZOTH"],
    ]) {
      await cls(c!, ind!);
    }
    // previous session 2030-03-05, session 2030-03-06
    await bar("ZZ1", "2030-03-05", 10, 200_000);
    await bar("ZZ1", "2030-03-06", 10.5, 200_000); // +5 %
    await bar("ZZ2", "2030-03-05", 10, 200_000);
    await bar("ZZ2", "2030-03-06", 9.9, 200_000); // -1 %
    await bar("ZZ3", "2030-03-05", 0.5, 9_000_000); // price floor A$1: left out
    await bar("ZZ3", "2030-03-06", 0.6, 9_000_000);
    await bar("ZZ4", "2030-03-05", 10, 1_000); // A$10,000 traded: left out
    await bar("ZZ4", "2030-03-06", 11, 1_000);
    await bar("ZZ5", "2030-03-05", 10, 200_000);
    await bar("ZZ5", "2030-03-06", 2, 200_000); // -80 %: a split, not a return
    await bar("ZZ6", "2030-03-05", 10, 200_000);
    await bar("ZZ6", "2030-03-06", 11, 200_000); // +10 %, another industry
    const w1 = await writeSectorComposite(db, { market: "AU", d: "2030-03-06", now: NOW });
    expect(w1.industries).toBe(2);
    expect(
      (await writeSectorComposite(db, { market: "AU", d: "2030-03-06", now: NOW })).industries,
    ).toBe(0);
    const rows = (
      await db.execute(
        "SELECT industry, ret_ppm, n_members, map_as_of FROM sector_composite_daily ORDER BY industry",
      )
    ).rows.map((r) => ({ ...r }));
    expect(rows).toEqual([
      { industry: "ZZIND", ret_ppm: 20_000, n_members: 2, map_as_of: "2030-03-01" },
      { industry: "ZZOTH", ret_ppm: 100_000, n_members: 1, map_as_of: "2030-03-01" },
    ]);
    const sr = await sectorReturns(db, "AU", "2030-03-07");
    expect(sr.get("ZZIND")).toEqual({ retPpm: 20_000, members: 2 });
    expect((await sectorReturns(db, "AU", "2030-03-06")).size).toBe(0); // only completed sessions
    expect((await sectorReturns(db, "AU", "2030-03-20")).size).toBe(0); // older than a week
  });
});

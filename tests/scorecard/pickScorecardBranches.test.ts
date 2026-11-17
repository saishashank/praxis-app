// @vitest-environment node
// D-1060…D-1070 (Owner O-84): the edges of the pick scorecard that the main tests leave out: bad bars,
// empty nights, golive Cortex nights, a profile outside the three, an unreadable stored summary, and a
// stored run read back. Synthetic ZZ data only.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  cortexDay,
  followPick,
  parseSummary,
  profileDay,
  scoreDay,
  summarise,
  type CortexDay,
  type DayResult,
  type LaterBar,
  type PickOutcome,
  type ScoredPick,
} from "@/lib/scorecard/pickScorecard";
import {
  loadLatestScorecard,
  persistScorecard,
  REPORT_LINEAGE,
  scorecardExists,
  scorecardRunId,
  type ScorecardRun,
} from "@/lib/scorecard/pickScorecardStore";
import { featureNight, rankVal } from "../cortex/learn/zzLearn";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

/** The following calendar day (the stored tables check the date shape). */
const nextOf = (d: string): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const m = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const bar = (d: string, o: number, h: number, l: number, c: number): LaterBar => ({
  d,
  open: m(o),
  high: m(h),
  low: m(l),
  close: m(c),
});
const pick = (code: string, profile: string, rank: number): ScoredPick => ({
  profile,
  rank,
  code,
  source: "strategy",
  stopMicro: m(9),
  aimMicro: m(11),
});

describe("followPick edges", () => {
  it("a first bar that does not open above zero gives nothing known", () => {
    const zero: LaterBar = { d: "2026-11-16", open: 0n, high: 1n, low: 1n, close: 1n };
    expect(followPick(pick("ZZ001", "balanced", 1), [zero])).toMatchObject({
      nextPpm: null,
      fivePpm: null,
      race: "unknown",
    });
  });

  it("a fall is a negative next-day ppm, and a bar touching only the aim is an aim", () => {
    const o = followPick(pick("ZZ001", "balanced", 1), [bar("2026-11-16", 10, 11.5, 9.5, 9.5)]);
    expect(o).toMatchObject({ nextPpm: -50_000, fivePpm: null, race: "aim" });
  });
});

describe("profileDay sums", () => {
  const o = (over: Partial<PickOutcome>): PickOutcome => ({
    profile: "balanced",
    rank: 1,
    code: "ZZ001",
    source: "strategy",
    nextPpm: 10_000,
    fivePpm: 30_000,
    race: "neither",
    ...over,
  });
  it("counts known and unknown results separately and only up moves as up", () => {
    const p = profileDay([
      o({}),
      o({ nextPpm: -5_000, fivePpm: -1_000, race: "stop" }),
      o({ nextPpm: 0, fivePpm: 0, race: "aim" }),
      o({ nextPpm: null, fivePpm: null, race: "unknown" }),
    ]);
    expect(p).toEqual({
      n: 4,
      nextN: 3,
      nextSumPpm: 5_000,
      nextUp: 1,
      fiveN: 3,
      fiveSumPpm: 29_000,
      fiveUp: 1,
      aim: 1,
      stop: 1,
      neither: 1,
      unknown: 1,
    });
    expect(profileDay([]).n).toBe(0);
  });
});

describe("cortexDay edges", () => {
  const codes = Array.from({ length: 40 }, (_, i) => `ZZ${String(i + 1).padStart(3, "0")}`);
  const moves = codes.map((code, i) => ({ code, movePpm: (i + 1 - 20) * 1000 }));
  const sets = {
    gainers: [...moves].sort((a, b) => b.movePpm - a.movePpm).slice(0, 5),
    losers: [...moves].sort((a, b) => a.movePpm - b.movePpm).slice(0, 5),
  };
  const night = featureNight("2026-11-13", 40, (k, a) =>
    a === "A-D1-02" || a === "A-D2-01" ? rankVal(k) : a === "A-D1-06" ? { bucket: "mid" } : 1,
  );

  it("a night with no rows is no result", () => {
    expect(cortexDay({ d: "2026-11-13", rows: [] }, sets, codes, new Map())).toBeNull();
  });

  it("no returns means a zero gap, an equal top and bottom means a zero gap, the basis is carried", () => {
    const none = cortexDay(night, sets, codes, new Map(), "golive")!;
    expect(none).toMatchObject({ basis: "golive", gapPpm: 0, scored: 40 });
    const flat = cortexDay(night, sets, codes, new Map(codes.map((c) => [c, 0.01])))!;
    expect(flat.gapPpm).toBe(0);
    expect(flat.basis).toBe("live");
  });

  it("only shares the Cortex scored count towards the sets", () => {
    const half = cortexDay(night, sets, codes.slice(0, 30), new Map())!;
    expect(half.scored).toBe(30);
    expect(half.gainersN).toBeLessThanOrEqual(5);
    expect(half.gainersN).toBe(
      sets.gainers.filter((g) => codes.slice(0, 30).includes(g.code)).length,
    );
  });
});

describe("scoreDay and summarise edges", () => {
  const codes = Array.from({ length: 40 }, (_, i) => `ZZ${String(i + 1).padStart(3, "0")}`);
  const moves = codes.map((code, i) => ({ code, movePpm: (i + 1 - 20) * 1000 }));
  const explain = () => ({ cause: null, name: null });
  const later = (): readonly LaterBar[] => [];
  const cx = (basis: "live" | "golive", gapPpm: number | null): CortexDay => ({
    basis,
    scored: 30,
    gainersInTop: 1,
    gainersN: 5,
    losersInBottom: 2,
    losersN: 5,
    gapPpm,
  });
  const dayOf = (d: string, picks: ScoredPick[], cortex: CortexDay | null): DayResult =>
    scoreDay({ d, nextD: nextOf(d), picks, moves, liquid: codes, explain, later, cortex });

  it("a night with no picks is empty; a code picked twice is named by the better rank; a fourth profile sorts after the three", () => {
    const empty = dayOf("2026-11-10", [], null);
    expect(empty).toMatchObject({ picksN: 0, namedN: 0, chancePpm: 0 });
    expect(Object.keys(empty.profiles)).toEqual(["aggressive", "balanced", "conservative"]);
    const twice = dayOf(
      "2026-11-11",
      [pick("ZZ040", "balanced", 2), pick("ZZ040", "aggressive", 1), pick("ZZ001", "custom", 1)],
      null,
    );
    expect(twice.detail.gainers[0]).toMatchObject({ code: "ZZ040", where: "Aggressive #1" });
    expect(Object.keys(twice.profiles).sort()).toEqual([
      "aggressive",
      "balanced",
      "conservative",
      "custom",
    ]);
    expect(twice.profiles.custom).toMatchObject({ n: 1, unknown: 1 });
  });

  it("the run: golive and live nights, a missing gap, an up and a flat gap, no strategy picks", () => {
    const days = [
      dayOf("2026-11-10", [pick("ZZ040", "balanced", 1)], cx("live", 4_000)),
      dayOf(
        "2026-11-11",
        [{ ...pick("ZZ039", "custom", 1), source: "shortlist" }],
        cx("golive", -2_000),
      ),
      dayOf("2026-11-12", [], cx("golive", null)),
      dayOf("2026-11-13", [], cx("live", 0)),
      dayOf("2026-11-14", [], null),
    ];
    const s = summarise(days, { sessions: 5, skipped: ["x"] });
    expect(s.skipped).toEqual(["x"]);
    expect(s.cortex).toMatchObject({
      days: 4,
      liveNights: 2,
      goLiveNights: 2,
      gapDays: 3,
      gapSumPpm: 2_000,
      gapUpDays: 1,
      gainers: 20,
      losers: 20,
      chanceGainers: 2, // 4 nights x 5 gainers x one tenth
    });
    expect(s.strategyNights).toBe(1);
    expect(s.daysWithPicks).toBe(2);
    expect(Object.keys(s.profiles).sort()).toEqual([
      "aggressive",
      "balanced",
      "conservative",
      "custom",
    ]);
    expect(s.firstD).toBe("2026-11-10");
    expect(s.lastD).toBe("2026-11-14");
  });

  it("no nights at all: empty dates and zeros", () => {
    const s = summarise([], { sessions: 40 });
    expect(s).toMatchObject({ days: 0, firstD: "", lastD: "", picksN: 0, chanceHits: 0 });
    expect(s.profiles).toEqual({});
  });
});

describe("parseSummary refuses what is not a v1 summary", () => {
  const good = summarise([], { sessions: 1 });
  it("null, a scalar, a wrong format and each missing part", () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary("x")).toBeNull();
    expect(parseSummary({ ...good, v: 2 })).toBeNull();
    expect(parseSummary({ ...good, days: "3" })).toBeNull();
    expect(parseSummary({ ...good, chanceHits: null })).toBeNull();
    expect(parseSummary({ ...good, gainers: undefined })).toBeNull();
    expect(parseSummary({ ...good, profiles: undefined })).toBeNull();
    expect(parseSummary({ ...good, cortex: undefined })).toBeNull();
    expect(parseSummary(good)).toEqual(good);
  });
});

describe("stored runs", () => {
  const codes = Array.from({ length: 40 }, (_, i) => `ZZ${String(i + 1).padStart(3, "0")}`);
  const moves = codes.map((code, i) => ({ code, movePpm: (i + 1 - 20) * 1000 }));
  const day = (d: string, cortex: CortexDay | null): DayResult =>
    scoreDay({
      d,
      nextD: nextOf(d),
      picks: [pick("ZZ040", "balanced", 1)],
      moves,
      liquid: codes,
      explain: () => ({ cause: null, name: null }),
      later: () => [],
      cortex,
    });
  const runOf = (
    id: string,
    createdAt: string,
    days: DayResult[],
    status: "complete" | "partial" = "complete",
  ): ScorecardRun => ({
    id,
    market: "AU",
    createdAt,
    commitSha: "b".repeat(40),
    sessions: 5,
    firstD: days[0]!.d,
    lastD: days[days.length - 1]!.d,
    status,
    summary: summarise(days, { sessions: 5 }),
  });
  const count = async (db: Client, table: string) =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

  it("the id names the market, last night, length and the first 8 characters of both hashes", () => {
    expect(scorecardRunId("AU", "2026-11-12", 40, "a".repeat(64), "b".repeat(40))).toBe(
      "pickscore:AU:2026-11-12:40:aaaaaaaa:bbbbbbbb",
    );
    expect(REPORT_LINEAGE("AU")).toBe("AU:pick-scorecard");
  });

  it("nothing stored reads as null", async () => {
    const db = await freshDb("main");
    expect(await loadLatestScorecard(db, "AU")).toBeNull();
    expect(await scorecardExists(db, "none")).toBe(false);
  });

  it("writes days, one look and the run; a repeat is ignored; the newest run is read back", async () => {
    const db = await freshDb("main");
    const days1 = [day("2026-11-10", null), day("2026-11-11", { ...cortexOf(), gapPpm: 5_000 })];
    const first = runOf("run-1", "2026-11-16T00:00:00.000Z", days1, "partial");
    const written = await persistScorecard(db, first, days1);
    expect(written).toBe(2 + 1 + 1);
    expect(await persistScorecard(db, first, days1)).toBe(4); // statements sent; rows are ignored
    expect(await count(db, "pick_scorecard_day")).toBe(2);
    expect(await count(db, "pick_scorecard_run")).toBe(1);
    expect(await count(db, "trial_ledger")).toBe(1);
    const stored = await db.execute(
      "SELECT d, cortex_scored, cortex_gap_ppm FROM pick_scorecard_day ORDER BY d",
    );
    expect(stored.rows.map((r) => [r.d, Number(r.cortex_scored), r.cortex_gap_ppm])).toEqual([
      ["2026-11-10", 0, null], // no Cortex that night
      ["2026-11-11", 30, 5000],
    ]);
    expect(await scorecardExists(db, "run-1")).toBe(true);

    expect((await loadLatestScorecard(db, "AU"))!.status).toBe("partial");
    const days2 = [day("2026-11-12", null)];
    await persistScorecard(db, runOf("run-2", "2026-11-17T00:00:00.000Z", days2), days2);
    const latest = (await loadLatestScorecard(db, "AU"))!;
    expect(latest.id).toBe("run-2");
    expect(latest.status).toBe("complete");
    expect(latest.summary.days).toBe(1);
    expect(await loadLatestScorecard(db, "XX")).toBeNull();
  });

  it("an unreadable or foreign stored summary is not a scorecard", async () => {
    const db = await freshDb("main");
    const put = (id: string, at: string, json: string) =>
      db.execute({
        sql: `INSERT INTO pick_scorecard_run (id, market, created_at, commit_sha, sessions, first_d, last_d,
                status, summary_json) VALUES (?, 'AU', ?, 'c', 5, '2026-11-10', '2026-11-10', 'complete', ?)`,
        args: [id, at, json],
      });
    // the table's own check keeps non-JSON out, so the unreadable case is read through a stub
    const stub = {
      execute: async () => ({
        rows: [
          {
            id: "x",
            market: "AU",
            created_at: "t",
            commit_sha: "c",
            sessions: 5,
            first_d: "a",
            last_d: "b",
            status: "complete",
            summary_json: "{not json",
          },
        ],
      }),
    };
    expect(await loadLatestScorecard(stub as never, "AU")).toBeNull();
    await put("bad-format", "2026-11-17T00:00:00.000Z", '{"v":2}');
    expect(await loadLatestScorecard(db, "AU")).toBeNull();
  });

  function cortexOf(): CortexDay {
    return {
      basis: "live",
      scored: 30,
      gainersInTop: 1,
      gainersN: 5,
      losersInBottom: 2,
      losersN: 5,
      gapPpm: null,
    };
  }
});

// @vitest-environment node
// The learning Cortex's nightly stage on a real migrated file (design C.7 "stage.ts"; D-923): reads the
// stored Cortex features of D-1 and D-21, writes the scorecard rows, one 'scorecard' event and the
// review section into daily_learning; a re-run writes nothing new (insert-or-ignore). LRN-AT-10 (reads
// budget), LRN-AT-11 (never reads the picks). Synthetic ZZ data only.
import type { Client, InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { cortexLearnNight, priorReference, SCORECARD_SEQ } from "@/lib/cortex/learn/stage";
import { angleDaysSince, eventsSince } from "@/lib/cortex/learn/store";
import { loadDailyLearning, type MoverExplanation } from "@/lib/learning/daily";
import type { World } from "@/lib/learning/dailyLoad";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { BACK21, bars, codes, D, featureNight, PREV } from "./zzLearn";

afterEach(cleanupTempDbs);

const NOW = "2026-11-10T09:30:00.000Z";

function world(n = 40): World {
  const shares = new Map(
    [...bars(n)].map(([code, list]) => [
      code,
      {
        code,
        tier: "U1",
        bars: list.map((b) => ({ d: b.d, o: b.c, h: b.c, l: b.c, c: b.c, v: 1000 })),
      },
    ]),
  );
  return {
    d: D,
    prev: PREV,
    tierOf: new Map(codes(n).map((c) => [c, "U1"])),
    moves: [],
    indexMovePpm: null,
    sectorOf: new Map(),
    shares,
    liquidCodes: codes(n),
    sensitive: new Map(),
    names: new Map(),
    signals: new Map(),
  };
}

const mover = (
  code: string,
  side: "gainer" | "loser",
  cause: MoverExplanation["cause"],
): MoverExplanation => ({
  code,
  name: null,
  side,
  movePpm: side === "gainer" ? 50_000 : -50_000,
  cause,
  causeText: "",
  indexMovePpm: null,
  sectorName: null,
  sectorMovePpm: null,
  volumeVsUsualPpm: null,
  setupBefore: [],
  caughtBy: null,
  nearMiss: null,
});

async function seedNight(db: Client, d: string, n = 40): Promise<void> {
  const night = featureNight(d, n);
  const stmts: InStatement[] = night.rows.map((r) => ({
    sql: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
          VALUES ('AU', ?, ?, ?, '{}', ?, ?)`,
    args: [d, r.code, JSON.stringify(r.features), r.activeSetHash, r.manifestId],
  }));
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500), "write");
}

async function seed(db: Client, n = 40): Promise<void> {
  await seedNight(db, PREV, n);
  await seedNight(db, BACK21, n);
  await db.execute({
    sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
          VALUES ('AU', ?, 1, 1, 'RISK-ON', 'RISK-ON', 0)`,
    args: ["2026-11-06"],
  });
  await db.execute({
    sql: `INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, ?)`,
    args: [
      D,
      JSON.stringify({
        d: D,
        summary: ["s"],
        movers: [],
        lessons: [],
        improvements: [],
        hypothesesOpened: [],
      }),
      NOW,
    ],
  });
}

const opts = (over: Partial<Parameters<typeof cortexLearnNight>[1]> = {}) => ({
  market: "AU",
  d: D,
  calendar: [],
  world: world(),
  movers: [
    mover("ZZ040", "gainer", "news_before_open"),
    mover("ZZ039", "gainer", "stock_specific"),
    mover("ZZ001", "loser", "market_move"),
  ],
  now: NOW,
  ...over,
});

describe("cortexLearnNight", () => {
  it("writes the scorecard, one event and the review section; a re-run writes nothing new", async () => {
    const db = await freshDb("main");
    await seed(db);
    const s = (await cortexLearnNight(db, opts()))!;
    expect(s.numbers).toMatchObject({
      rows: 6,
      angles: 3,
      nextDayOf: 2,
      nextDayRight: 1,
      dataBreaks: 0,
    });
    expect(s.numbers.coverage).toMatchObject({
      gainers: 2,
      gainersInTop: 0,
      newsBeforeOpen: 1,
      scored: 40,
    });
    const rows = await angleDaysSince(db, "AU", D);
    expect(rows).toHaveLength(6);
    const h1 = rows.find((r) => r.angleId === "A-D1-02" && r.horizon === 1)!;
    expect(h1).toMatchObject({
      featureD: PREV,
      n: 39,
      excludedNews: 1,
      regime: "RISK-ON",
      psiPpm: 0,
    });
    expect(rows.find((r) => r.horizon === 20)!.featureD).toBe(BACK21);
    const ev = await eventsSince(db, "AU", D);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ seq: SCORECARD_SEQ, kind: "scorecard", createdAt: NOW });
    expect((ev[0]!.evidence as { reference: string }).reference).toBe("back20");
    const day = (await loadDailyLearning(db, "AU", D))!;
    expect(day.summary).toEqual(["s"]);
    expect(day.cortex).toEqual(JSON.parse(JSON.stringify(s)));
    // re-run: same words, nothing new
    const again = await cortexLearnNight(db, opts({ now: "2026-11-10T11:00:00.000Z" }));
    expect(again).toEqual(s);
    expect(await angleDaysSince(db, "AU", D)).toEqual(rows);
    expect((await eventsSince(db, "AU", D))[0]!.createdAt).toBe(NOW);
  });

  it("the next night measures the population against the stored prior nights", async () => {
    const db = await freshDb("main");
    await seed(db);
    await cortexLearnNight(db, opts());
    const next = "2026-11-11";
    await seedNight(db, D);
    await seedNight(db, "2026-10-13");
    const w = world();
    await cortexLearnNight(db, opts({ d: next, world: { ...w, d: next, prev: D } }));
    const ev = await eventsSince(db, "AU", next);
    expect((ev[0]!.evidence as { reference: string }).reference).toBe("prior60");
    const rows = await angleDaysSince(db, "AU", next, next);
    expect(rows.find((r) => r.angleId === "A-D1-02" && r.horizon === 1)!.psiPpm).toBe(0);
  });

  it("nothing on a day without a session; no Cortex features still gives the words; no stored night is fine", async () => {
    const db = await freshDb("main");
    expect(await cortexLearnNight(db, opts({ d: "2026-11-14" }))).toBeNull();
    const s = (await cortexLearnNight(db, opts()))!;
    expect(s.numbers.rows).toBe(0);
    expect(s.lines[0]).toMatch(/^The Cortex stored no scores for the evening before Tue 10 Nov/);
    expect(await loadDailyLearning(db, "AU", D)).toBeNull(); // the daily loop stored nothing: no row made
    expect(await eventsSince(db, "AU", D)).toHaveLength(1);
  });

  it("LRN-AT-10 and LRN-AT-11: under 6,000 rows read on a full-size universe; never a picks table", async () => {
    const n = 2450;
    const db = await freshDb("main");
    await seed(db, n);
    let rowsRead = 0;
    const sqls: string[] = [];
    const sqlOf = (s: InStatement): string => (typeof s === "string" ? s : s.sql);
    const counting = {
      execute: async (s: InStatement) => {
        sqls.push(sqlOf(s));
        const r = await db.execute(s);
        rowsRead += r.rows.length;
        return r;
      },
      batch: async (ss: InStatement[], mode?: "write" | "read") => {
        sqls.push(...ss.map(sqlOf));
        const r = await db.batch(ss, mode);
        rowsRead += r.reduce((a, x) => a + x.rows.length, 0);
        return r;
      },
    } as unknown as Client;
    const s = (await cortexLearnNight(counting, opts({ world: world(n) })))!;
    expect(s.numbers.rows).toBe(6);
    expect(rowsRead).toBeGreaterThan(2 * n - 1);
    expect(rowsRead).toBeLessThanOrEqual(6000);
    for (const q of sqls)
      expect(q).not.toMatch(/\b(pick|pick_outcome|cortex_decision|price_bar)\b/);
  }, 60_000);
});

describe("the stored section", () => {
  it("a malformed cortex section in a stored night is dropped on read", async () => {
    const db = await freshDb("main");
    await db.execute({
      sql: `INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, ?)`,
      args: [D, JSON.stringify({ d: D, cortex: { lines: "not a list" } }), NOW],
    });
    expect((await loadDailyLearning(db, "AU", D))!.cortex).toBeUndefined();
  });
});

describe("priorReference", () => {
  it("sums the stored histograms and skips malformed evidence", () => {
    const h = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    expect(priorReference([])).toBeNull();
    expect(priorReference([null, { hist: null }, { hist: { "A-D1-02": [1, 2] } }, {}])).toBeNull();
    const r = priorReference([
      { hist: { "A-D1-02": h } },
      { hist: { "A-D1-02": h.map(() => "x") } },
      { hist: { "A-D1-02": h } },
    ]);
    expect(r!.get("A-D1-02")).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
  });
});

// @vitest-environment node
// D-1078: the learning Cortex's warm start (src/lib/cortex/learn/warmStart.ts). The key test is parity:
// the rows it writes for a night equal, column for column, what the live nightly stage writes for the
// same night (only the manifest id carries the `warmstart:` marker). Also: no look-ahead, idempotent,
// live rows win, bounds, isolation (only cortex_angle_day and one cortex_learn_event are written), a
// source for never-stored feature nights, and the weekly stage reaching the re-weighting path on
// warm-start evidence. Synthetic ZZ data only; dates sit outside the February / August results windows.
import type { Client, InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { angleById } from "@/lib/cortex/angles/registry";
import { learnConfig } from "@/lib/cortex/learn/config";
import { cortexLearnNight } from "@/lib/cortex/learn/stage";
import { angleDaysSince, eventsSince } from "@/lib/cortex/learn/store";
import type { FeatureNight } from "@/lib/cortex/learn/scorecard";
import {
  planWarmStart,
  warmStart,
  WARM_EVENT_SEQ,
  WARM_PREFIX,
  type FeatureNightSource,
} from "@/lib/cortex/learn/warmStart";
import { cortexLearnWeekly } from "@/lib/cortex/learn/weekly";
import { insertMap, insertPassport, type MapParams, type MapRow } from "@/lib/cortex/store";
import { runDailyLearning } from "@/lib/learning/daily";
import { replayMain } from "@/lib/replay/cli";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { rankVal, weekdays } from "./learn/zzLearn";

afterEach(cleanupTempDbs);

const M = "AU";
const NOW = "2026-06-13T09:30:00.000Z";
const ANGLES = ["A-D1-02", "A-D2-01", "A-D1-06"];
const N_CODES = 40;
const SESSIONS = weekdays("2026-02-23", "2026-06-12"); // 80 sessions, none in a results window
const NEWEST = SESSIONS[SESSIONS.length - 1]!;
const code = (k: number): string => `ZZ${String(k).padStart(3, "0")}`;
const noise = (k: number, i: number): number =>
  (((k * 7919 + i * 104729) % 2001) / 1000 - 1) * 0.01;

/** Rank-standardised values of a night: code k's raw score is k plus a night-specific wobble. */
function featureRows(i: number, sessionD: string): FeatureNight {
  const raw = Array.from({ length: N_CODES }, (_, j) => ({
    k: j + 1,
    s: j + 1 + 6 * noise(j + 1, i) * 100,
  }));
  const order = [...raw].sort((a, b) => a.s - b.s);
  const pos = new Map(order.map((x, p) => [x.k, p + 1]));
  return {
    d: sessionD,
    rows: raw.map((x) => {
      const v = rankVal(pos.get(x.k)!, N_CODES);
      return {
        code: code(x.k),
        features: { "A-D1-02": v, "A-D2-01": -v, "A-D1-06": (x.k % 7) / 7 },
        activeSetHash: "zzhash",
        manifestId: "zzmanifest",
      };
    }),
  };
}

type SeedOpts = { features?: boolean; lastSessions?: number; newestClose?: number };

async function seed(db: Client, o: SeedOpts = {}): Promise<void> {
  const days = SESSIONS.slice(0, o.lastSessions ?? SESSIONS.length);
  const stmts: InStatement[] = [];
  for (let k = 1; k <= N_CODES; k += 1) {
    stmts.push({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
      args: [SESSIONS[0]!, code(k)],
    });
    let prev = 10;
    days.forEach((d, i) => {
      const c =
        o.newestClose !== undefined && i === SESSIONS.length - 1
          ? o.newestClose
          : Number((prev * (1 + 0.0004 * k + noise(k, i))).toFixed(6));
      stmts.push({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000, 'zz', 't', 't')`,
        args: [code(k), d, prev, Math.max(prev, c) * 1.01, Math.min(prev, c) * 0.99, c],
      });
      prev = c;
    });
  }
  // price-sensitive news the evening before every session, 08:00 Sydney (before the open), codes 1..12
  days.forEach((d, i) => {
    if (i === 0) return;
    const before = new Date(`${d}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    for (let k = 1; k <= 12; k += 1) {
      stmts.push({
        sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
              VALUES ('AU', ?, ?, ?, 't', 'x', 1, 'News', 'zz')`,
        args: [code(k), `a${i}-${k}`, `${before.toISOString().slice(0, 10)}T22:00:00.000Z`],
      });
    }
  });
  stmts.push({
    sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
          VALUES ('AU', '2026-02-20', 1, 1, 'NEUTRAL', 'NEUTRAL', 0)`,
    args: [],
  });
  stmts.push({
    sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
          VALUES ('AU', '2026-05-01', 1, 1, 'RISK-ON', 'RISK-ON', 0)`,
    args: [],
  });
  if (o.features !== false) {
    days.forEach((d, i) => {
      for (const r of featureRows(i, d).rows) {
        stmts.push({
          sql: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
                VALUES ('AU', ?, ?, ?, '{}', ?, ?)`,
          args: [d, r.code, JSON.stringify(r.features), r.activeSetHash, r.manifestId],
        });
      }
    });
  }
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500), "write");
}

const rowsOf = async (db: Client) =>
  (await angleDaysSince(db, M, "2000-01-01")).map((r) => ({
    ...r,
    manifestId: r.manifestId.startsWith(WARM_PREFIX)
      ? r.manifestId.slice(WARM_PREFIX.length)
      : r.manifestId,
  }));

async function liveNight(db: Client, d: string): Promise<void> {
  const r = await runDailyLearning(db, { market: M, d, calendar: [], now: NOW });
  expect(r.night).toBeDefined();
  await cortexLearnNight(db, {
    market: M,
    d,
    calendar: [],
    world: r.night!.world,
    movers: r.night!.movers,
    now: NOW,
  });
}

const lastNights = (n: number): string[] => SESSIONS.slice(-(n + 1), -1);

describe("warmStart parity with the live stage", () => {
  it("writes, for the same nights, exactly the rows the live nightly stage writes", async () => {
    const live = await freshDb("main");
    await seed(live);
    const nights = lastNights(3);
    for (const d of nights) await liveNight(live, d);
    const expected = await rowsOf(live);
    expect(expected.length).toBeGreaterThan(0);
    expect(new Set(expected.map((r) => r.d))).toEqual(new Set(nights));
    // the scenario exercises news exclusion, both horizons, a regime change and the prior-60 reference
    expect(expected.some((r) => r.excludedNews > 0)).toBe(true);
    expect(new Set(expected.map((r) => r.horizon))).toEqual(new Set([1, 20]));
    expect(expected.some((r) => r.psiPpm !== null)).toBe(true);

    const warm = await freshDb("main");
    await seed(warm);
    const r = await warmStart(warm, { market: M, calendar: [], sessions: 3, now: NOW });
    expect(r.nights).toEqual(nights);
    expect(r.written).toBe(3);
    const raw = await angleDaysSince(warm, M, "2000-01-01");
    expect(raw.every((x) => x.manifestId.startsWith(WARM_PREFIX))).toBe(true);
    expect(await rowsOf(warm)).toEqual(expected);
  });
});

describe("warmStart guards", () => {
  it("never reads past D: changing any bar or announcement after D changes no row of D", async () => {
    const a = await freshDb("main");
    await seed(a);
    const b = await freshDb("main");
    await seed(b, { newestClose: 1000 });
    const D = lastNights(1)[0]!;
    // the newest session (after D) has wild closes (seeded below); add announcements after D's open
    await b.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
            VALUES ('AU', 'ZZ020', 'late', ?, 't', 'x', 1, 'Late news', 'zz')`,
      args: [`${NEWEST}T01:00:00.000Z`],
    });
    // and an announcement during D's own trading hours (after the open: not "before the open")
    await b.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
            VALUES ('AU', 'ZZ021', 'during', ?, 't', 'x', 1, 'During news', 'zz')`,
      args: [`${D}T02:00:00.000Z`],
    });
    await warmStart(a, { market: M, calendar: [], sessions: 1, now: NOW });
    await warmStart(b, { market: M, calendar: [], sessions: 1, now: NOW });
    const ra = await rowsOf(a);
    expect(ra.length).toBeGreaterThan(0);
    expect(await rowsOf(b)).toEqual(ra);
  });

  it("a re-run writes nothing new", async () => {
    const db = await freshDb("main");
    await seed(db);
    const first = await warmStart(db, { market: M, calendar: [], sessions: 5, now: NOW });
    expect(first.written).toBe(5);
    const before = await rowsOf(db);
    const second = await warmStart(db, { market: M, calendar: [], sessions: 5, now: NOW });
    expect(second).toMatchObject({ written: 0, skippedExisting: 5, firstD: null, lastD: null });
    expect(await rowsOf(db)).toEqual(before);
    const ev = (await eventsSince(db, M, "2000-01-01")).filter((e) => e.seq === WARM_EVENT_SEQ);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "scorecard", d: lastNights(1)[0] });
    expect(ev[0]!.evidence).toMatchObject({ warmStart: true, nights: 5, firstD: lastNights(5)[0] });
  });

  it("live rows win: a night the live stage scored is skipped and keeps its manifest id", async () => {
    const db = await freshDb("main");
    await seed(db);
    const live = lastNights(3)[1]!;
    await liveNight(db, live);
    const liveRows = (await angleDaysSince(db, M, live, live)).length;
    const r = await warmStart(db, { market: M, calendar: [], sessions: 3, now: NOW });
    expect(r).toMatchObject({ written: 2, skippedExisting: 1 });
    expect(r.nights).not.toContain(live);
    const kept = await angleDaysSince(db, M, live, live);
    expect(kept).toHaveLength(liveRows);
    expect(kept.every((x) => !x.manifestId.startsWith(WARM_PREFIX))).toBe(true);
  });

  it("enforces the bounds 1..120 on the number of sessions", async () => {
    const db = await freshDb("main");
    await seed(db);
    for (const n of [0, 121, -1, 2.5]) {
      await expect(
        warmStart(db, { market: M, calendar: [], sessions: n, now: NOW }),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      warmStart(db, { market: M, calendar: [], sessions: 120, now: NOW }),
    ).resolves.toBeDefined();
  });

  it("writes only cortex_angle_day and cortex_learn_event", async () => {
    const db = await freshDb("main");
    await seed(db);
    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'",
      )
    ).rows.map((x) => String(x.name));
    const counts = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of tables) {
        out[t] = Number((await db.execute(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0]!.n);
      }
      return out;
    };
    const before = await counts();
    await warmStart(db, { market: M, calendar: [], sessions: 4, now: NOW });
    const after = await counts();
    const changed = tables.filter((t) => after[t] !== before[t]).sort();
    expect(changed).toEqual(["cortex_angle_day", "cortex_learn_event"]);
    expect(after.cortex_learn_event! - before.cortex_learn_event!).toBe(1);
  });
});

describe("warmStart feature nights", () => {
  const sourceOf = (): FeatureNightSource => async (d) => {
    const i = SESSIONS.indexOf(d);
    return i < 0 ? null : featureRows(i, d);
  };

  it("never-stored feature nights come from the source and give the same rows; without a source the night is skipped", async () => {
    const stored = await freshDb("main");
    await seed(stored);
    await warmStart(stored, { market: M, calendar: [], sessions: 3, now: NOW });

    const bare = await freshDb("main");
    await seed(bare, { features: false });
    const plan = await planWarmStart(bare, { market: M, calendar: [], sessions: 3 });
    expect(plan.nights).toEqual(lastNights(3));
    expect(plan.missingFeatureNights.length).toBeGreaterThan(3);
    const none = await warmStart(bare, { market: M, calendar: [], sessions: 3, now: NOW });
    expect(none).toMatchObject({ written: 0, skippedNoData: 3 });
    expect(await angleDaysSince(bare, M, "2000-01-01")).toHaveLength(0);
    const r = await warmStart(bare, {
      market: M,
      calendar: [],
      sessions: 3,
      now: NOW,
      source: sourceOf(),
    });
    expect(r.written).toBe(3);
    expect(await rowsOf(bare)).toEqual(await rowsOf(stored));
  });
});

describe("the weekly stage on warm-start evidence", () => {
  const CONFIG = learnConfig({ replicates: 200 }, { relaxed: true });
  const FIXED: MapRow = {
    market: M,
    family: "F1",
    ruleVersion: "F1.zz.1",
    fittedAt: "2026-01-01T00:00:00.000Z",
    params: {
      a: 1,
      b: 0,
      s_mean: 0,
      s_sd: 1,
      K: 2,
      clusters: [
        ...new Set(["A-D1-02", "A-D2-01"].map((a) => String(angleById(a)!.cluster))),
      ].sort(),
      angles: ["A-D1-02", "A-D2-01"],
      tiers: ["U1"],
      family_mean_net: 0.01,
      top3_min_s: -1,
    } as unknown as MapParams,
    activeSetHash: "zzhash",
    nEff: 250,
    pool: "zz",
    fitSplit: "development",
  };

  it("with 50 warm-start nights the next weekly run reaches the re-weighting path", async () => {
    const db = await freshDb("main");
    await seed(db);
    await insertMap(db, FIXED);
    for (const id of ["A-D1-02", "A-D2-01"]) {
      await insertPassport(db, {
        market: M,
        angleId: id,
        version: 1,
        domain: Number(id.slice(3, 4)),
        cluster: angleById(id)!.cluster as never,
        orientation: 1,
        kind: "score",
        inputs: ["bar_au"],
        historyFields: {},
        status: "active",
        horizonSessions: 20,
        evidence: { dev_ic: 0.02 },
        measured: null,
        frozenAt: "2026-01-01T00:00:00Z",
      });
    }
    await db.execute(
      "INSERT INTO lineage (id, created_d, parent) VALUES ('AU:F1', '2026-01-01', NULL)",
    );
    await db.execute(`INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len,
        validation_len, purge, data_end_d, deferred_until_d, reason)
        VALUES ('AU:F1', 1, 20, 60, 60, 5, '2026-01-01', '2027-01-01', 'create')`);
    const weekly = (d: string) =>
      cortexLearnWeekly(db, { market: M, d, calendar: [], now: NOW, config: CONFIG, hooks: {} });
    // the first weekly run only starts the learner (generation 0, equal weights)
    expect((await weekly("2026-06-13"))[0]).toMatchObject({ action: "generation_zero" });
    const w = await warmStart(db, { market: M, calendar: [], sessions: 50, now: NOW });
    expect(w.written).toBe(50);
    const rows20 = (await angleDaysSince(db, M, "2000-01-01")).filter((r) => r.horizon === 20);
    expect(rows20.length).toBeGreaterThanOrEqual(40 * ANGLES.length - 40);
    const r = (await weekly("2026-06-20"))[0]!;
    expect(r.action).toBe("reweight");
    expect(r.generation).toBe(1);
    expect(r.charged).toBe(true);
    const ev = (await eventsSince(db, M, "2026-06-19")).find((e) => e.kind === "reweight")!;
    expect((ev.evidence as { rows: number }).rows).toBeGreaterThanOrEqual(40);
  });
});

describe("replay --mode cortex-warm-start", () => {
  const keepOpen = (db: Client): Client =>
    new Proxy(db, {
      get: (t, p) =>
        p === "close"
          ? () => undefined
          : typeof (t as never)[p] === "function"
            ? (...a: unknown[]) => ((t as never)[p] as (...x: unknown[]) => unknown)(...a)
            : (t as never)[p],
    });
  const run = async (db: Client, argv: string[]) => {
    const lines: string[] = [];
    const code = await replayMain(
      ["--mode", "cortex-warm-start", ...argv],
      { TURSO_MAIN_URL: "file:x.db" },
      { openDb: () => keepOpen(db), out: (s) => void lines.push(s), nowMs: () => Date.parse(NOW) },
    );
    return { code, lines };
  };

  it("refuses bad session counts", async () => {
    const db = await freshDb("main");
    for (const n of ["0", "121", "x", "2.5"]) {
      const r = await run(db, ["--sessions", n]);
      expect(r).toEqual({ code: 2, lines: ["replay: failed (bad argument)"] });
    }
    expect((await run(db, ["--sessions"])).code).toBe(2);
  });

  it("writes the nights from stored features and says nights, skipped, first and last", async () => {
    const db = await freshDb("main");
    await seed(db);
    const r = await run(db, ["--sessions", "3"]);
    expect(r.code).toBe(0);
    const nights = lastNights(3);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(
      new RegExp(
        `^replay cortex-warm-start: nights_written=3 skipped_existing=0 skipped_no_data=0 first=${nights[0]} last=${nights[2]} rows=[0-9]+$`,
      ),
    );
    const again = await run(db, ["--sessions", "3"]);
    expect(again.lines[0]).toContain("nights_written=0 skipped_existing=3");
  });

  it("needs a snapshot source only when a feature night was never stored", async () => {
    const db = await freshDb("main");
    await seed(db, { features: false });
    const r = await run(db, ["--sessions", "3"]);
    expect(r).toEqual({ code: 1, lines: ["replay: failed (no snapshot source)"] });
  });
});

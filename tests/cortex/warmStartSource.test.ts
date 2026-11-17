// @vitest-environment node
// D-1078: `snapshotFeatureSource`, the feature nights a warm start rebuilds from a snapshot world: a night
// outside the world or before any frozen passport gives null; otherwise the fixed Cortex's features of
// that evening, with one replay shared by the nights that have the same angle statuses; and the CLI path
// (`--mode cortex-warm-start`) that builds it from a snapshot only when a night was never stored. ZZ data.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { angleById } from "@/lib/cortex/angles/registry";
import { insertPassport } from "@/lib/cortex/store";
import { asOfWorldOf, createCortexReplay, cortexTierFrom } from "@/lib/replay/cortexReplay";
import { histogramText, newCortexTally } from "@/lib/scorecard/pickReplay";
import { buildSnapshot, loadSnapshot } from "@/lib/replay/snapshot";
import { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import { replayMain } from "@/lib/replay/cli";
import { warmStart, type WarmWorld } from "@/lib/cortex/learn/warmStart";
import { microToFloat } from "@/lib/agents/indicators";
import { snapshotFeatureSource } from "@/lib/replay/warmStartSource";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";

vi.mock("@/lib/replay/cortexReplay", async (orig) => {
  const m = await orig<typeof import("@/lib/replay/cortexReplay")>();
  return { ...m, createCortexReplay: vi.fn(m.createCortexReplay) };
});

const params = defaultAgentParams();
const CODES = Array.from({ length: 24 }, (_, i) => `ZZ${String(i + 1).padStart(2, "0")}`);
const CAL = weekdayCalendar(420, "2026-01-05");
const N1 = CAL[400]!;
const N2 = CAL[401]!;
const N3 = CAL[410]!;
const SWITCH = `${CAL[405]!}T00:00:00.000Z`; // a later passport version frozen between N2 and N3
const IDS = ["A-D1-02", "A-D2-01", "A-D1-06"];

/**
 * `late`: D-1082 production shape: universe rows exist only for the last sessions (a few codes, one halted
 * for a day), and an extra thin code that is below the tier floor until session 350.
 */
function snapshotBytes(late = false): Uint8Array {
  let seed = 4242;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const bars: Record<string, unknown>[] = [];
  const universe: Record<string, unknown>[] = [];
  CODES.forEach((code, k) => {
    let c = 5 + rnd() * 5;
    if (!late || k < 12) {
      for (const d of late ? [CAL[410], CAL[411]] : [CAL[0]]) {
        universe.push({
          d,
          code,
          status: "active",
          tier: "U1",
          mcap_est: 1e9,
          adv: 5e7,
          halted: late && k === 0 && d === CAL[410] ? 1 : 0,
        });
      }
    }
    for (const d of CAL) {
      const o = c;
      c = Math.max(0.5, c * (1 + 0.0025 * (1 + (k % 5)) + (rnd() - 0.5) * 0.02));
      bars.push({
        code,
        d,
        o: Number(o.toFixed(3)),
        h: Number((Math.max(o, c) * 1.004).toFixed(3)),
        l: Number((Math.min(o, c) * 0.996).toFixed(3)),
        c: Number(c.toFixed(3)),
        volume: Math.round(5_000_000 * (0.5 + rnd())),
      });
    }
  });
  if (late) {
    const c = 5;
    CAL.forEach((d, i) => {
      bars.push({
        code: "ZZ99",
        d,
        o: c,
        h: c * 1.01,
        l: c * 0.99,
        c,
        volume: i < 350 ? 10 : 5_000_000,
      });
    });
  }
  let idx = 7000;
  const index_bars = CAL.map((d) => {
    idx *= 1 + (rnd() - 0.48) * 0.01;
    const m = Math.round(idx * 1e6);
    return { index_code: "AXJO", d, o_micro: m, h_micro: m, l_micro: m, c_micro: m };
  });
  const calendar = CAL.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
  return buildSnapshot({
    from: CAL[0]!,
    to: CAL[CAL.length - 1]!,
    inputs: { calendar, universe, bars, index_bars, corporate_actions: [], announcements: [] },
  }).bytes;
}

let world: SnapshotWorld;
let lateWorld: SnapshotWorld;
beforeAll(() => {
  lateWorld = new SnapshotWorld(loadSnapshot(snapshotBytes(true)), { params, tierSource: "bars" });
  world = new SnapshotWorld(loadSnapshot(snapshotBytes()), { params, tierSource: "bars" });
}, 60_000);
afterAll(cleanupTempDbs);

async function passport(db: Client, id: string, version: number, status: string, frozenAt: string) {
  const a = angleById(id)!;
  await insertPassport(db, {
    market: "AU",
    angleId: id,
    version,
    domain: a.domain,
    cluster: a.cluster as never,
    orientation: a.orientation,
    kind: "score",
    inputs: [...a.inputs],
    historyFields: {},
    status: status as never,
    horizonSessions: a.horizonSessions,
    evidence: {},
    measured: null,
    frozenAt,
  });
}

const deps = (db: Client, w: SnapshotWorld = world) => ({ db, world: w, params, market: "AU" });
const built = () => vi.mocked(createCortexReplay).mock.calls.length;

describe("snapshotFeatureSource", () => {
  it("a night the snapshot world has no session for is null, without reading passports", async () => {
    const db = await freshDb("main");
    const src = await snapshotFeatureSource(deps(db));
    expect(await src("2020-01-01")).toBeNull();
    expect(await src("2026-01-03")).toBeNull(); // a Saturday: not a session
  });

  it("no frozen passports as of the night is null", async () => {
    const db = await freshDb("main");
    const src = await snapshotFeatureSource(deps(db));
    expect(await src(N1)).toBeNull();
  });

  it("builds the night's features from the passports, one replay per distinct set", async () => {
    const db = await freshDb("main");
    for (const id of IDS) await passport(db, id, 1, "active", "2026-01-01T00:00:00.000Z");
    const src = await snapshotFeatureSource(deps(db));
    const before = built();

    const a = await src(N1);
    expect(a).not.toBeNull();
    expect(a!.d).toBe(N1);
    expect(a!.rows.length).toBeGreaterThan(10);
    expect(Object.keys(a!.rows[0]!.features).length).toBeGreaterThan(0);
    expect(built() - before).toBe(1);

    // the same angle set the next evening: the replay is reused and the active set is the same
    const b = await src(N2);
    expect(b!.d).toBe(N2);
    expect(built() - before).toBe(1);
    expect(b!.rows[0]!.activeSetHash).toBe(a!.rows[0]!.activeSetHash);

    // asking for the first night again is stable
    expect(await src(N1)).toEqual(a);
    expect(built() - before).toBe(1);

    // a later version retires an angle: a different set builds another replay
    await passport(db, "A-D1-02", 2, "retired", SWITCH);
    const c = await src(N3);
    expect(c).not.toBeNull();
    expect(built() - before).toBe(2);
    expect(c!.rows[0]!.activeSetHash).not.toBe(a!.rows[0]!.activeSetHash);
  }, 120_000);
});

describe("D-1082 the Cortex replay of a bars-tiered world with late universe rows", () => {
  const FIRST = CAL[300]!; // 110 sessions before the first universe row
  const fromD = cortexTierFrom(CAL, FIRST);
  const night = (d: string, from?: string) =>
    createCortexReplay({
      world: lateWorld,
      params,
      schemaSha: "t",
      ...(from === undefined ? {} : { fromD: from }),
    }).hook.night(d, []);

  it("runs a night long before the first universe row, from the bar-derived tiers", () => {
    expect(lateWorld.tierRowsOf("ZZ01").map((r) => r.d)).toEqual([CAL[410], CAL[411]]);
    const out = night(CAL[320]!, fromD);
    expect(out.reason).not.toBe("late_bar");
    expect(out.features.size).toBeGreaterThan(10);
  }, 60_000);

  it("a night before the tier series starts has no codes and abstains late_bar", () => {
    const out = night(CAL[100]!, fromD);
    expect(out.reason).toBe("late_bar");
    expect(out.features.size).toBe(0);
  });

  it("without fromD the series covers the last sessions, and a start past the end gives none", () => {
    expect(night(CAL[410]!).features.size).toBeGreaterThan(10);
    expect(asOfWorldOf({ world: lateWorld, params, fromD: "2999-01-01" }).tiers).toBeUndefined();
  }, 60_000);

  it("the tier and halt series are change points; a thin code is null until it trades", () => {
    const { tiers, halts } = lateWorld.cortexTierRows(CAL[340]!);
    const thin = tiers.get("ZZ99")!;
    expect(thin[0]).toEqual({ d: CAL[340], tier: null });
    expect(thin.length).toBeGreaterThan(1);
    expect(thin[1]!.d >= CAL[350]!).toBe(true);
    expect(thin[1]!.tier).not.toBeNull();
    expect(halts.get("ZZ01")).toEqual([
      { d: CAL[340], halted: false },
      { d: CAL[410], halted: true },
      { d: CAL[411], halted: false },
    ]);
    expect(halts.get("ZZ20")).toEqual([{ d: CAL[340], halted: false }]);
    expect(lateWorld.barsTiered).toBe(true);
    expect(world.barsTiered).toBe(true);
    expect(new SnapshotWorld(loadSnapshot(snapshotBytes()), { params }).barsTiered).toBe(false);
  }, 60_000);

  it("snapshotFeatureSource gives features for a night 20 sessions before the first universe row", async () => {
    const db = await freshDb("main");
    for (const id of IDS) await passport(db, id, 1, "active", "2026-01-01T00:00:00.000Z");
    const tally = newCortexTally();
    const src = await snapshotFeatureSource({
      ...deps(db, lateWorld),
      firstNight: CAL[385]!,
      tally,
    });
    const got = await src(CAL[390]!); // 20 sessions before the first universe row
    expect(got).not.toBeNull();
    expect(got!.rows.length).toBeGreaterThan(10);
    expect(await src("2020-01-01")).toBeNull();
    expect(await src(CAL[100]!)).toBeNull(); // before the tier series: the Cortex abstains
    expect(tally.nights).toBe(3);
    expect(tally.featured).toBe(1);
    expect(tally.noSession).toBe(1);
    expect(tally.noPassports).toBe(0);
    expect(histogramText(tally.abstained)).toBe("late_bar:1");
  }, 120_000);

  it("tallies nights without passports, and writes nothing about nights it was not asked for", async () => {
    const db = await freshDb("main");
    const tally = newCortexTally();
    const src = await snapshotFeatureSource({ ...deps(db, lateWorld), tally });
    expect(await src(CAL[390]!)).toBeNull();
    expect(tally).toMatchObject({ nights: 1, noPassports: 1, featured: 0 });
    expect(histogramText(tally.abstained)).toBe("none");
    expect(
      histogramText(
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    ).toBe("a:1,b:2");
  });
});

describe("D-1084 the warm start reads the universe, closes and bars from the world", () => {
  const worldOf = (w: SnapshotWorld): WarmWorld => ({
    tiersOn: (d) => w.warmTiersOn(d),
    closesOn: (d) => w.warmClosesOn(d),
    barsOf: (codes, from, to) => w.warmBars(codes, from, to),
  });

  /** A database holding the world's bars and a universe of the last `n` sessions only. */
  async function dbOf(w: SnapshotWorld, n: number): Promise<Client> {
    const db = await freshDb("main");
    for (const id of IDS) await passport(db, id, 1, "active", "2026-01-01T00:00:00.000Z");
    const last = CAL.slice(-n);
    const stmts: { sql: string; args: (string | number)[] }[] = CODES.map((c) => ({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
      args: [last[0]!, c],
    }));
    for (const c of CODES) {
      for (const b of w.barsOf(c).filter((x) => x.d >= last[0]!)) {
        const f = (m: bigint): number => microToFloat(m);
        stmts.push({
          sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
                VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'zz', 't', 't')`,
          args: [c, b.d, f(b.open), f(b.high), f(b.low), f(b.close), Number(b.volume)],
        });
      }
    }
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500), "write");
    return db;
  }
  const rowsOf = async (db: Client) =>
    (await db.execute("SELECT * FROM cortex_angle_day ORDER BY d, angle_id")).rows.map((r) =>
      JSON.stringify(Object.values(r)),
    );
  const NOW = "2026-11-12T09:30:00.000Z";

  it("writes the same rows as the database path when the database is complete", async () => {
    const a = await dbOf(world, 30);
    const b = await dbOf(world, 30);
    const src = (db: Client) =>
      snapshotFeatureSource({ ...deps(db), firstNight: CAL[CAL.length - 12]! });
    const viaDb = await warmStart(a, {
      market: "AU",
      calendar: [],
      sessions: 3,
      now: NOW,
      source: await src(a),
    });
    const viaWorld = await warmStart(b, {
      market: "AU",
      calendar: [],
      sessions: 3,
      now: NOW,
      source: await src(b),
      world: worldOf(world),
    });
    expect(viaDb.written).toBe(3);
    expect(viaWorld.written).toBe(3);
    const rowsDb = await rowsOf(a);
    expect(rowsDb.length).toBeGreaterThan(0);
    expect(await rowsOf(b)).toEqual(rowsDb);
  }, 240_000);

  it("writes nights from before the database's universe, which the database path skips", async () => {
    const a = await dbOf(world, 6);
    const b = await dbOf(world, 6);
    const o = (db: Client, w?: WarmWorld) =>
      snapshotFeatureSource({ ...deps(db), firstNight: CAL[CAL.length - 12]! }).then((source) => ({
        market: "AU",
        calendar: [],
        sessions: 10,
        now: NOW,
        source,
        ...(w === undefined ? {} : { world: w }),
      }));
    const viaDb = await warmStart(a, await o(a));
    const viaWorld = await warmStart(b, await o(b, worldOf(world)));
    expect(viaDb.skipReasons.universe).toBeGreaterThan(0);
    expect(viaWorld.written).toBeGreaterThan(viaDb.written);
    expect(viaWorld.skipReasons.universe).toBe(0);
    expect(viaWorld.nights[0]! < CAL[CAL.length - 6]!).toBe(true);
  }, 240_000);

  it("a world with no universe on a night skips it as universe", async () => {
    const db = await dbOf(world, 6);
    const none = { ...worldOf(world), tiersOn: () => null };
    const empty = { ...worldOf(world), tiersOn: () => new Map<string, string>() };
    for (const w of [none, empty]) {
      const r = await warmStart(db, {
        market: "AU",
        calendar: [],
        sessions: 2,
        now: NOW,
        world: w,
      });
      expect(r).toMatchObject({ written: 0, skippedNoData: 2, skipReasons: { universe: 2 } });
    }
  });

  it("the world's halted code leaves the night's universe, and bad bars are not read", () => {
    expect(lateWorld.warmTiersOn(CAL[410]!).has("ZZ01")).toBe(false);
    expect(lateWorld.warmTiersOn(CAL[411]!).has("ZZ01")).toBe(true);
    expect(lateWorld.warmTiersOn(CAL[340]!).has("ZZ99")).toBe(false); // below the tier floor
    expect(lateWorld.warmClosesOn(CAL[411]!).size).toBeGreaterThan(20);
    expect(lateWorld.warmClosesOn("2020-01-01").size).toBe(0);
    const bars = lateWorld.warmBars(["ZZ01", "NOPE"], CAL[400]!, CAL[402]!);
    expect([...bars.keys()]).toEqual(["ZZ01"]);
    expect(bars.get("ZZ01")!.map((x) => x.d)).toEqual([CAL[400], CAL[401], CAL[402]]);
  });
});

describe("replay --mode cortex-warm-start, set-up and failures", () => {
  const keepOpen = (db: Client): Client =>
    new Proxy(db, {
      get: (t, p) => {
        if (p === "close") return () => undefined;
        const v = (t as never)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  const NOW_MS = Date.parse("2026-11-12T09:30:00.000Z");
  const run = async (
    argv: string[],
    env: Record<string, string | undefined>,
    deps: Parameters<typeof replayMain>[2],
  ) => {
    const lines: string[] = [];
    const code = await replayMain(["--mode", "cortex-warm-start", ...argv], env, {
      out: (l) => void lines.push(l),
      nowMs: () => NOW_MS,
      ...deps,
    });
    return { code, lines };
  };
  const LAST = CAL.slice(-30); // the database holds the last 30 sessions of the snapshot's calendar

  /** The database side: universe, passports and bars for the last 30 sessions; no stored features. */
  async function seedDb(): Promise<Client> {
    const db = await freshDb("main");
    for (const id of IDS) await passport(db, id, 1, "active", "2026-01-01T00:00:00.000Z");
    const stmts: { sql: string; args: (string | number)[] }[] = CODES.map((c) => ({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
      args: [LAST[0]!, c],
    }));
    CODES.forEach((c, k) =>
      LAST.forEach((d, i) => {
        const px = 10 + k * 0.1 + Math.sin(i + k) * 0.3;
        stmts.push({
          sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
                VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000, 'zz', 't', 't')`,
          args: [c, d, px, px * 1.01, px * 0.99, px],
        });
      }),
    );
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500), "write");
    return db;
  }

  it("without a database URL, or a remote one without a token, it is not configured", async () => {
    const db = await freshDb("main");
    for (const env of [{}, { TURSO_MAIN_URL: "" }, { TURSO_MAIN_URL: "libsql://x.example.test" }]) {
      expect(await run([], env, { openDb: () => keepOpen(db) })).toEqual({
        code: 1,
        lines: ["replay: failed (database not configured)"],
      });
    }
  });

  it("a database that cannot be read fails at the set-up stage, naming the kind of error only", async () => {
    const bare = keepOpen(await freshDb("main"));
    const broken = new Proxy(bare, {
      get: (t, p) =>
        p === "execute" || p === "batch"
          ? async () => {
              throw new RangeError("secret detail https://example.test/x");
            }
          : (t as never)[p],
    });
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      { openDb: () => broken },
    );
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^replay cortex-warm-start: failed \(RangeError\) stage=setup/);
    expect(r.lines[0]).not.toContain("secret");
    expect(r.lines[0]).not.toContain("example.test");
  });

  it("an empty database has no night to plan and never asks for a snapshot", async () => {
    const db = await freshDb("main");
    let asked = 0;
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => keepOpen(db),
        prepareSnapshot: async () => {
          asked += 1;
          return new Uint8Array();
        },
      },
    );
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(
      /nights_written=0 skipped_existing=0 skipped_no_data=0 first=none last=none rows=0 skip_reasons=universe:0,moves:0,features:0,liquid:0,card:0 feature_nulls=no_session:0,no_passports:0,abstained:0 feature_nights=0\/0 cortex_abstain=none$/,
    );
    expect(asked).toBe(0);
  });

  it("builds the missing feature nights from the snapshot and writes the nights", async () => {
    const db = await seedDb();
    const bytes = snapshotBytes();
    let opened = 0;
    let range: { from: string; to: string } | null = null;
    const slept: number[] = [];
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => {
          opened += 1;
          return keepOpen(db);
        },
        // no params injected: they are read from the database (the defaults when it holds none)
        prepareSnapshot: async (x) => {
          range = x;
          return bytes;
        },
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(r.code).toBe(0);
    expect(opened).toBe(2); // a fresh connection after the long snapshot build
    expect(range!.to).toBe("2026-11-12");
    expect(range!.from < range!.to).toBe(true);
    expect(slept).toEqual([]); // the reconnect answered at once
    expect(r.lines).toHaveLength(1);
    const m =
      /nights_written=(\d+) skipped_existing=0 skipped_no_data=(\d+) first=(\S+) last=(\S+) rows=(\d+) skip_reasons=universe:(\d+),moves:(\d+),features:(\d+),liquid:(\d+),card:(\d+) feature_nulls=\S+ feature_nights=\d+\/\d+ cortex_abstain=\S+$/.exec(
        r.lines[0]!,
      );
    expect(m).not.toBeNull();
    expect(Number(m![1]) + Number(m![2])).toBe(3);
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![5])).toBeGreaterThan(0);
    const skips = [6, 7, 8, 9, 10].reduce((a, i) => a + Number(m![i]), 0);
    expect(skips).toBe(Number(m![2])); // the reasons add up to the skipped nights
  }, 120_000);

  it("uses injected parameters, and a reconnect that fails at first is retried after a pause", async () => {
    const db = await seedDb();
    let opened = 0;
    let selects = 0;
    const flaky = new Proxy(keepOpen(db), {
      get: (t, p) =>
        p === "execute"
          ? async (stmt: unknown) => {
              if (stmt === "SELECT 1" && (selects += 1) === 1) throw new Error("dropped");
              return t.execute(stmt as never);
            }
          : (t as never)[p],
    });
    const slept: number[] = [];
    const r = await run(
      ["--sessions", "2"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => (++opened === 1 ? keepOpen(db) : flaky),
        params,
        prepareSnapshot: async () => snapshotBytes(),
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(r.code).toBe(0);
    expect(slept).toEqual([1000]); // one failed answer, one pause, then fine
    expect(r.lines[0]).toMatch(/^replay cortex-warm-start: nights_written=\d+ /);
  }, 120_000);

  it("names the stage when the snapshot cannot be built or the reconnect never answers", async () => {
    const db = await seedDb();
    const failing = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => keepOpen(db),
        params,
        prepareSnapshot: async () => {
          throw new TypeError("secret detail https://example.test/x");
        },
      },
    );
    expect(failing.code).toBe(1);
    expect(failing.lines[0]).toMatch(
      /^replay cortex-warm-start: failed \(TypeError\) stage=snapshot/,
    );
    expect(failing.lines[0]).not.toContain("secret");

    let opened = 0;
    const dead = new Proxy(keepOpen(db), {
      get: (t, p) =>
        p === "execute"
          ? async (stmt: unknown) => {
              if (stmt === "SELECT 1") throw new Error("down");
              return t.execute(stmt as never);
            }
          : (t as never)[p],
    });
    const slept: number[] = [];
    const never = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => (++opened === 1 ? keepOpen(db) : dead),
        params,
        prepareSnapshot: async () => snapshotBytes(),
        sleep: async (ms) => void slept.push(ms),
      },
    );
    expect(never.code).toBe(1);
    expect(never.lines[0]).toMatch(/^replay cortex-warm-start: failed \(Error\) stage=compute/);
    expect(slept).toEqual([1000, 2000, 3000]); // PING_TRIES = 4: three pauses, then the error
  }, 120_000);

  it("a snapshot source is required once a night's features were never stored", async () => {
    const db = await seedDb();
    const r = await run(
      ["--sessions", "3"],
      { TURSO_MAIN_URL: "file:x.db" },
      { openDb: () => keepOpen(db) },
    );
    expect(r).toEqual({ code: 1, lines: ["replay: failed (no snapshot source)"] });
  });
});

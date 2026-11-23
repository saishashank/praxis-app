// @vitest-environment node
// D-1860: the TRIAL warm start (src/lib/cortex/learn/warmStart.ts `trial: true`, replay mode
// cortex-trial-warm-start). It back-scores the angles not yet proven as `trial:` rows and stores the
// computed feature nights (insert-or-ignore: a stored live night wins), and writes nothing a learner,
// a map, a leader or a family status could read. A regular run is unchanged by it. Synthetic ZZ data.
import type { Client, InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { isTrialId, trialId } from "@/lib/cortex/angles/trial";
import { angleDaysOfHorizon, angleDaysSince, eventsSince } from "@/lib/cortex/learn/store";
import type { FeatureNight } from "@/lib/cortex/learn/scorecard";
import {
  planWarmStart,
  warmStart,
  WARM_EVENT_SEQ,
  WARM_PREFIX,
  WARM_TRIAL_EVENT_SEQ,
  WARM_TRIAL_SESSIONS_DEFAULT,
  type FeatureNightSource,
} from "@/lib/cortex/learn/warmStart";
import { defaultAgentParams } from "@/lib/agents/params";
import { replayMain } from "@/lib/replay/cli";
import { buildSnapshot } from "@/lib/replay/snapshot";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { rankVal, weekdays } from "./learn/zzLearn";

afterEach(cleanupTempDbs);

const M = "AU";
const NOW = "2026-06-13T09:30:00.000Z";
const N_CODES = 40;
const SESSIONS = weekdays("2026-02-23", "2026-06-12"); // 80 sessions, none in a results window
const code = (k: number): string => `ZZ${String(k).padStart(3, "0")}`;
const noise = (k: number, i: number): number =>
  (((k * 7919 + i * 104729) % 2001) / 1000 - 1) * 0.01;

/** A computed night: a trial value per code (and one proven-looking key, which a trial run must ignore). */
const night = (d: string): FeatureNight => {
  const i = SESSIONS.indexOf(d);
  const raw = Array.from({ length: N_CODES }, (_, j) => ({
    k: j + 1,
    s: j + 1 + 600 * noise(j + 1, i),
  }));
  const pos = new Map([...raw].sort((a, b) => a.s - b.s).map((x, p) => [x.k, p + 1]));
  return {
    d,
    rows: raw.map((x) => {
      const v = rankVal(pos.get(x.k)!, N_CODES);
      return {
        code: code(x.k),
        features: {
          "A-D1-02": v,
          [trialId("A-D1-02")]: v,
          [trialId("A-D2-01")]: -v,
          [trialId("A-D1-06")]: { flag: "up" },
        },
        activeSetHash: "zzhash",
        manifestId: "zzmanifest",
      };
    }),
  };
};
const source: FeatureNightSource = async (d) => night(d);

async function seed(db: Client, storedLive?: string[]): Promise<void> {
  const stmts: InStatement[] = [];
  for (let k = 1; k <= N_CODES; k += 1) {
    stmts.push({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
      args: [SESSIONS[0]!, code(k)],
    });
    let prev = 10;
    SESSIONS.forEach((d, i) => {
      const c = Number((prev * (1 + 0.0004 * k + noise(k, i))).toFixed(6));
      stmts.push({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000, 'zz', 't', 't')`,
        args: [code(k), d, prev, Math.max(prev, c) * 1.01, Math.min(prev, c) * 0.99, c],
      });
      prev = c;
      if (storedLive?.includes(d)) {
        stmts.push({
          sql: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
                VALUES ('AU', ?, ?, '{}', '{}', 'livehash', 'livemanifest')`,
          args: [d, code(k)],
        });
      }
    });
  }
  stmts.push({
    sql: `INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state, exit_streak)
          VALUES ('AU', '2026-02-20', 1, 1, 'NEUTRAL', 'NEUTRAL', 0)`,
    args: [],
  });
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500), "write");
}

const lastNights = (n: number): string[] => SESSIONS.slice(-(n + 1), -1);
const count = async (db: Client, table: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

describe("trial warm start", () => {
  it("writes trial rows only, marked trial, and stores the computed feature nights", async () => {
    const db = await freshDb("main");
    await seed(db);
    const r = await warmStart(db, {
      market: M,
      calendar: [],
      sessions: 3,
      now: NOW,
      source,
      trial: true,
    });
    expect(r.nights).toEqual(lastNights(3));
    expect(r.written).toBe(3);
    const raw = (await db.execute("SELECT angle_id, manifest_id FROM cortex_angle_day")).rows;
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((x) => isTrialId(String(x.angle_id)))).toBe(true);
    expect(raw.every((x) => String(x.manifest_id).startsWith(`${WARM_PREFIX}trial:`))).toBe(true);
    // numbers and a flag-valued angle are scored without error
    expect(new Set(raw.map((x) => x.angle_id))).toEqual(
      new Set([trialId("A-D1-02"), trialId("A-D2-01"), trialId("A-D1-06")]),
    );
    // the feature nights the 3 nights needed (D-1 and D-21 of each) are stored, with their trial keys
    const nights = (await db.execute("SELECT DISTINCT d FROM cortex_feature_daily ORDER BY d"))
      .rows;
    expect(nights.length).toBe(r.featureNightsStored);
    expect(nights.length).toBeGreaterThanOrEqual(4);
    const one = (
      await db.execute({
        sql: "SELECT features_json, flags_json, manifest_id FROM cortex_feature_daily WHERE market = 'AU' AND d = ? AND code = ?",
        args: [String(nights[0]!.d), code(1)],
      })
    ).rows[0]!;
    expect(Object.keys(JSON.parse(String(one.features_json)))).toContain(trialId("A-D1-02"));
    expect(JSON.parse(String(one.flags_json))[trialId("A-D1-06")]).toBe("up");
    expect(String(one.manifest_id).startsWith(WARM_PREFIX)).toBe(true);
    // the learner's readers see nothing of it
    expect(await angleDaysSince(db, M, "2000-01-01")).toEqual([]);
    expect(await angleDaysOfHorizon(db, M, 20, "2000-01-01")).toEqual([]);
    expect(await angleDaysOfHorizon(db, M, 1, "2000-01-01")).toEqual([]);
    // one trial event, never a warm-start event
    const ev = await eventsSince(db, M, "2000-01-01");
    expect(ev.filter((e) => e.seq === WARM_EVENT_SEQ)).toEqual([]);
    const te = ev.filter((e) => e.seq === WARM_TRIAL_EVENT_SEQ);
    expect(te).toHaveLength(1);
    expect(te[0]!.evidence).toMatchObject({ trialWarmStart: true, nights: 3 });
    expect((te[0]!.evidence as { warmStart?: unknown }).warmStart).toBeUndefined();
    expect(te[0]!.words).toContain("not yet proven");
  });

  it("touches only cortex_angle_day, cortex_feature_daily and cortex_learn_event", async () => {
    const db = await freshDb("main");
    await seed(db);
    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cortex_%'",
      )
    ).rows.map((x) => String(x.name));
    const before = new Map<string, number>();
    for (const t of tables) before.set(t, await count(db, t));
    await warmStart(db, { market: M, calendar: [], sessions: 2, now: NOW, source, trial: true });
    const changed: string[] = [];
    for (const t of tables) if ((await count(db, t)) !== before.get(t)) changed.push(t);
    expect(changed.sort()).toEqual([
      "cortex_angle_day",
      "cortex_feature_daily",
      "cortex_learn_event",
    ]);
    for (const t of ["angle_passport", "cortex_map", "cortex_leader", "cortex_family_status"]) {
      if (tables.includes(t) || t === "angle_passport") {
        expect(await count(db, t)).toBe(before.get(t) ?? 0);
      }
    }
  });

  it("a re-run writes nothing new, and a regular run is not blocked by trial rows", async () => {
    const db = await freshDb("main");
    await seed(db);
    await warmStart(db, { market: M, calendar: [], sessions: 3, now: NOW, source, trial: true });
    const rows = await count(db, "cortex_angle_day");
    const feats = await count(db, "cortex_feature_daily");
    const again = await warmStart(db, {
      market: M,
      calendar: [],
      sessions: 3,
      now: NOW,
      source,
      trial: true,
    });
    expect(again).toMatchObject({ written: 0, skippedExisting: 3, featureNightsStored: 0 });
    expect(await count(db, "cortex_angle_day")).toBe(rows);
    expect(await count(db, "cortex_feature_daily")).toBe(feats);
    // the stored nights now hold trial keys, so a regular run (no trial) must still write only proven rows
    const regular = await planWarmStart(db, { market: M, calendar: [], sessions: 3 });
    expect(regular.nights).toEqual(lastNights(3));
    expect(regular.skippedExisting).toBe(0);
    const reg = await warmStart(db, { market: M, calendar: [], sessions: 3, now: NOW });
    expect(reg.written).toBe(3);
    const ids = new Set(
      (await db.execute("SELECT angle_id FROM cortex_angle_day")).rows.map((x) =>
        String(x.angle_id),
      ),
    );
    expect([...ids].filter((x) => !isTrialId(x))).toEqual(["A-D1-02"]); // the proven-looking key only
  });

  it("a regular run with a source that carries trial keys writes no trial row and the same rows as without", async () => {
    const a = await freshDb("main");
    await seed(a);
    const b = await freshDb("main");
    await seed(b);
    const plain: FeatureNightSource = async (d) => {
      const n = night(d);
      return {
        d,
        rows: n.rows.map((r) => ({
          ...r,
          features: Object.fromEntries(Object.entries(r.features).filter(([k]) => !isTrialId(k))),
        })),
      };
    };
    await warmStart(a, { market: M, calendar: [], sessions: 3, now: NOW, source });
    await warmStart(b, { market: M, calendar: [], sessions: 3, now: NOW, source: plain });
    const dump = async (db: Client) =>
      (await db.execute("SELECT * FROM cortex_angle_day ORDER BY d, angle_id, horizon")).rows.map(
        (r) => ({ ...r }),
      );
    expect(await dump(a)).toEqual(await dump(b));
    expect(await count(a, "cortex_feature_daily")).toBe(0); // a regular run stores no feature night
  });

  it("a stored live night wins: it is kept as it is and only gains the trial values in memory", async () => {
    const db = await freshDb("main");
    const nights = lastNights(2);
    const prev = SESSIONS[SESSIONS.indexOf(nights[1]!) - 1]!;
    await seed(db, [prev]);
    const r = await warmStart(db, {
      market: M,
      calendar: [],
      sessions: 2,
      now: NOW,
      source,
      trial: true,
    });
    expect(r.featureNightsKept).toBeGreaterThan(0);
    const kept = (
      await db.execute({
        sql: "SELECT DISTINCT features_json, manifest_id FROM cortex_feature_daily WHERE market = 'AU' AND d = ?",
        args: [prev],
      })
    ).rows;
    expect(kept).toHaveLength(1);
    expect(String(kept[0]!.features_json)).toBe("{}");
    expect(String(kept[0]!.manifest_id)).toBe("livemanifest");
    expect(r.written).toBeGreaterThan(0);
  });

  it("covers four weeks by default: the plan of a plain trial run is 25 nights, bounds still 1..120", async () => {
    expect(WARM_TRIAL_SESSIONS_DEFAULT).toBeGreaterThanOrEqual(20);
    const db = await freshDb("main");
    await seed(db);
    const plan = await planWarmStart(db, { market: M, calendar: [], trial: true });
    expect(plan.nights).toHaveLength(WARM_TRIAL_SESSIONS_DEFAULT);
    expect(plan.missingFeatureNights.length).toBeGreaterThan(WARM_TRIAL_SESSIONS_DEFAULT); // 25 + 21 - 1
    const plain = await planWarmStart(db, { market: M, calendar: [], trial: false });
    expect(plain.nights).toHaveLength(60);
    for (const n of [0, 121]) {
      await expect(
        warmStart(db, { market: M, calendar: [], sessions: n, now: NOW, trial: true }),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe("replay command line", () => {
  const emptySnapshot = buildSnapshot({
    from: "2026-01-01",
    to: "2026-01-02",
    inputs: {
      calendar: [],
      universe: [],
      bars: [],
      index_bars: [],
      corporate_actions: [],
      announcements: [],
    },
  }).bytes;
  const keepOpen = (db: Client): Client => {
    const real = db.close.bind(db);
    db.close = () => undefined;
    void real;
    return db;
  };
  const run = async (db: Client, argv: string[]) => {
    const lines: string[] = [];
    const code = await replayMain(
      argv,
      { TURSO_MAIN_URL: "file:x.db" },
      {
        openDb: () => keepOpen(db),
        out: (s) => void lines.push(s),
        nowMs: () => Date.parse(NOW),
        prepareSnapshot: async () => emptySnapshot,
        params: defaultAgentParams(),
        sleep: async () => {},
      },
    );
    return { code, lines };
  };

  it("the mode cortex-trial-warm-start and the flag --trial both run a trial warm start", async () => {
    for (const argv of [
      ["--mode", "cortex-trial-warm-start", "--sessions", "3"],
      ["--mode", "cortex-warm-start", "--sessions", "3", "--trial"],
    ]) {
      const db = await freshDb("main");
      await seed(db);
      const r = await run(db, argv);
      expect(r.code).toBe(0);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toContain("trial=1 feature_nights_stored=0 feature_nights_kept=0");
      expect(r.lines[0]).toContain("skipped_no_data=3");
    }
  });

  it("a plain trial run asks for the default four-week window and a regular run prints no trial field", async () => {
    const db = await freshDb("main");
    await seed(db);
    const t = await run(db, ["--mode", "cortex-trial-warm-start"]);
    expect(t.lines[0]).toContain(`skipped_no_data=${WARM_TRIAL_SESSIONS_DEFAULT}`);
    const db2 = await freshDb("main");
    await seed(db2);
    const r = await run(db2, ["--mode", "cortex-warm-start", "--sessions", "3"]);
    expect(r.lines[0]).not.toContain("trial=");
    const bad = await run(db2, ["--mode", "cortex-trial-warm-start", "--sessions", "0"]);
    expect(bad).toEqual({ code: 2, lines: ["replay: failed (bad argument)"] });
  });
});

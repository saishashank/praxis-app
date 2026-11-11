// @vitest-environment node
// The probe and base stages on a real migrated file (Owner O-81): base version 1 on first sight; a
// charged strong probe promoted after 120 trading days (not 119) into base version 2 with a system
// map row used only from the next night (as-of); the event's words; a re-run writes nothing; no read
// before the probe's start (the sealed holdout rows are never touched); an Owner import re-bases the
// family. probeNight: recurring mover causes open a charged probe or escalate, the probe's stored
// values are scored into cortex_angle_day, the Cortex stage computes probes from the next night.
// Synthetic ZZ data only.
import type { Client, InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_SEQ0,
  PROBE_SEQ0,
  baseCellId,
  baseWeekly,
  openProbe,
  probeCellId,
  probeNight,
} from "@/lib/cortex/learn/baseStage";
import { baseInForce, baseVersions, openProbeAngles } from "@/lib/cortex/learn/baseStore";
import { cleanWords } from "@/lib/cortex/learn/learnWords";
import type { AngleDayRow } from "@/lib/cortex/learn/scorecard";
import { angleDaysSince, eventsSince, insertAngleDays } from "@/lib/cortex/learn/store";
import { loadStoreReads, newestPerFamily } from "@/lib/cortex/stage";
import { getCell } from "@/lib/cortex/store/ledger";
import { insertMap, latestMaps, type MapRow } from "@/lib/cortex/store/maps";
import { insertPassport } from "@/lib/cortex/store/passports";
import type { MoverExplanation } from "@/lib/learning/daily";
import type { World } from "@/lib/learning/dailyLoad";
import { scopedPrng, uniform01 } from "@/lib/stats/rng";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { BACK21, bars, codes, D, PREV, rankVal, weekdays } from "./zzLearn";

afterEach(cleanupTempDbs);

const S = weekdays("2026-01-05", "2026-12-31");
const at = (d: string): string => `${d}T20:00:00.000Z`; // after the night's cut-off

const FIXED: MapRow = {
  market: "AU",
  family: "F1",
  ruleVersion: "F1.v2-mom",
  fittedAt: "2025-12-01T00:00:00.000Z",
  params: {
    a: 1.1,
    b: -0.2,
    s_mean: 0,
    s_sd: 1,
    K: 1,
    clusters: ["momentum"],
    angles: ["A-D1-11"],
    tiers: ["U1"],
    top3_min_s: 0.8,
    plan: "time_hold",
    hold: 120,
  } as unknown as MapRow["params"],
  activeSetHash: "fixedhash",
  nEff: 300,
  pool: "F1",
  fitSplit: "development",
};

async function setup(): Promise<Client> {
  const db = await freshDb("main");
  await insertMap(db, FIXED);
  await insertPassport(db, {
    market: "AU",
    angleId: "A-D1-11",
    version: 1,
    domain: 1,
    cluster: "momentum",
    orientation: 1,
    kind: "score",
    inputs: ["bar_au"],
    historyFields: [],
    status: "active",
    horizonSessions: 120,
    evidence: {},
    measured: null,
    frozenAt: "2025-12-01T00:00:00.000Z",
  });
  return db;
}

function normal(p: ReturnType<typeof scopedPrng>): number {
  return (
    Math.sqrt(-2 * Math.log(Math.max(1e-12, uniform01(p)))) * Math.cos(2 * Math.PI * uniform01(p))
  );
}

const row = (
  angleId: string,
  d: string,
  horizon: 1 | 20,
  ic: number,
  version = 1,
): AngleDayRow => ({
  market: "AU",
  d,
  angleId,
  angleVersion: version,
  horizon,
  featureD: "2020-01-01",
  n: 400,
  ic: Math.max(-1, Math.min(1, ic)),
  topExcessPpm: 0,
  bottomExcessPpm: 0,
  basePpm: 0,
  regime: "NEUTRAL",
  resultsSeason: 0,
  psiPpm: null,
  excludedNews: 0,
  activeSetHash: "h",
  manifestId: "m",
});

/** Scorecard nights S[1..last]: the probe strong (0.05 ± 0.05), the base measure noise. */
async function seedNights(db: Client, last: number): Promise<void> {
  const p = scopedPrng("base-stage-test");
  const rows: AngleDayRow[] = [];
  for (let i = 1; i <= last; i += 1) {
    const d = S[i]!;
    rows.push(row("A-D2-07", d, 1, 0.05 + 0.05 * normal(p), 2), row("A-D2-07", d, 20, 0.04, 2));
    rows.push(row("A-D1-11", d, 1, 0.08 * normal(p)), row("A-D1-11", d, 20, 0.01));
  }
  // the sealed holdout years: strongly negative rows the test must never read
  for (const d of weekdays("2020-03-02", "2020-08-28")) rows.push(row("A-D2-07", d, 1, -0.5, 2));
  await insertAngleDays(db, rows);
}

/** A database wrapper recording every statement (the holdout and budget checks). */
function spy(db: Client): { db: Client; seen: { sql: string; args: unknown[] }[] } {
  const seen: { sql: string; args: unknown[] }[] = [];
  const note = (s: InStatement): void => {
    if (typeof s === "string") seen.push({ sql: s, args: [] });
    else seen.push({ sql: s.sql, args: Array.isArray(s.args) ? [...s.args] : [] });
  };
  const wrapped = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "execute")
        return (s: InStatement) => {
          note(s);
          return target.execute(s);
        };
      if (prop === "batch")
        return (ss: InStatement[], mode?: "write" | "read") => {
          ss.forEach(note);
          return target.batch(ss, mode);
        };
      return Reflect.get(target, prop, recv);
    },
  });
  return { db: wrapped, seen };
}

describe("baseWeekly", () => {
  it("writes base version 1 from the fixed rule the first time, charged, and does nothing else", async () => {
    const db = await setup();
    const r = (await baseWeekly(db, { market: "AU", d: S[0]!, calendar: [], now: at(S[0]!) }))!;
    expect(r.families).toEqual([{ family: "F1", version: 1, count: 1, change: "initial" }]);
    expect(r.restartLearner).toEqual([]);
    const v = await baseVersions(db, "AU");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      version: 1,
      reason: "initial",
      ruleVersion: "F1.v2-mom",
      angles: ["A-D1-11"],
    });
    expect(await getCell(db, baseCellId("AU", "F1", 1))).not.toBeNull();
    expect(
      await baseWeekly(db, { market: "AU", d: "2026-01-10", calendar: [], now: "x" }),
    ).toBeNull();
    db.close();
  });

  it("promotes a charged strong probe after 120 trading days into base version 2, used from the next night", async () => {
    const db = await setup();
    await baseWeekly(db, { market: "AU", d: S[0]!, calendar: [], now: at(S[0]!) });
    await openProbe(db, {
      market: "AU",
      family: "F1",
      angleId: "A-D2-07",
      d: S[0]!,
      now: at(S[0]!),
      seq: PROBE_SEQ0,
      cause: "volume_no_news",
      words: "Started trying a candidate measure.",
    });
    await seedNights(db, 125);

    // 119 trading days since the open: one block only → nothing changes
    const early = (await baseWeekly(db, {
      market: "AU",
      d: S[118]!,
      calendar: [],
      now: at(S[118]!),
    }))!;
    expect(early.families[0]).toMatchObject({ version: 1, change: null });
    expect(early.closed).toEqual([]);

    // 120: two blocks agree, t > 3, BH over the one probe tried → base v2
    const { db: watched, seen } = spy(db);
    const d = S[119]!;
    const r = (await baseWeekly(watched, { market: "AU", d, calendar: [], now: at(d) }))!;
    expect(r.families).toEqual([
      { family: "F1", version: 2, count: 2, change: "promote", angleId: "A-D2-07" },
    ]);
    expect(r.restartLearner).toEqual([
      { family: "F1", ruleVersion: "F1.v2-mom+b2", baseVersion: 2, sinceD: S[120]! },
    ]);
    expect(r.closed).toEqual([{ family: "F1", angleId: "A-D2-07", reason: "promoted" }]);

    // holdout untouched: no data read before the probe's open night, no bar or outcome read at all
    for (const s of seen) {
      expect(s.sql).not.toMatch(/price_bar|cortex_outcome/);
      if (/cortex_angle_day|cortex_feature|daily_learning/.test(s.sql)) {
        for (const a of s.args) {
          if (typeof a === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a)) expect(a >= S[0]!).toBe(true);
        }
      }
    }

    const versions = await baseVersions(db, "AU");
    expect(versions.map((v) => [v.version, v.reason, v.angles.length])).toEqual([
      [1, "initial", 1],
      [2, "promote", 2],
    ]);
    expect(versions[1]).toMatchObject({
      added: ["A-D2-07"],
      removed: [],
      sinceD: S[120],
      ruleVersion: "F1.v2-mom+b2",
    });

    // as-of: the system row is not used on its own night, from the next night it is the fixed rule
    const tonight = await latestMaps(db, "AU", d);
    expect(tonight.some((m) => m.ruleVersion === "F1.v2-mom+b2")).toBe(false);
    expect(newestPerFamily(tonight).get("F1")!.ruleVersion).toBe("F1.v2-mom");
    const next = await latestMaps(db, "AU", S[120]!);
    const sys = newestPerFamily(next).get("F1")!;
    expect(sys.ruleVersion).toBe("F1.v2-mom+b2");
    expect(sys.params as unknown as Record<string, unknown>).toMatchObject({
      system: true,
      claims_p: false,
      p_hidden: true,
      base_version: 2,
      angles: ["A-D1-11", "A-D2-07"],
      admitted: ["A-D2-07"],
    });
    expect((await baseInForce(db, "AU", d)).get("F1")!.version).toBe(1);
    expect((await baseInForce(db, "AU", S[120]!)).get("F1")!.version).toBe(2);

    // the words, the charge before the result
    const ev = await eventsSince(db, "AU", d, d);
    const change = ev.find((e) => e.kind === "base_change")!;
    expect(change.seq).toBeGreaterThanOrEqual(BASE_SEQ0);
    expect(change.words).toContain("New measure added to the base");
    expect(change.words).toContain("heavy trading without news (the base now has 2 measures)");
    for (const e of ev) expect(cleanWords(e.words), e.words).toBe(true);
    const cell = (await getCell(db, probeCellId("AU", "F1", "A-D2-07", S[0]!)))!;
    expect(cell.loggedAt).toBe(at(S[0]!));
    expect(cell.resultAt).toBe(at(d));
    expect(cell.loggedAt < cell.resultAt!).toBe(true);
    expect((await getCell(db, baseCellId("AU", "F1", 1)))!.resultAt).toBe(at(d));
    expect(await getCell(db, baseCellId("AU", "F1", 2))).not.toBeNull();

    // a re-run of the night writes nothing new
    const before = (await db.execute("SELECT COUNT(*) AS n FROM cortex_learn_event")).rows[0]!.n;
    const again = (await baseWeekly(db, { market: "AU", d, calendar: [], now: at(d) }))!;
    expect(again.families[0]).toMatchObject({ version: 2, change: null });
    expect((await db.execute("SELECT COUNT(*) AS n FROM cortex_learn_event")).rows[0]!.n).toBe(
      before,
    );
    expect(await baseVersions(db, "AU")).toHaveLength(2);

    // the next week: the system row leads, nothing to change, the probe is closed (not reopened)
    const week = (await baseWeekly(db, {
      market: "AU",
      d: S[124]!,
      calendar: [],
      now: at(S[124]!),
    }))!;
    expect(week.families[0]).toMatchObject({ version: 2, change: null });
    expect(await openProbeAngles(db, "AU", S[125]!)).toEqual([]);

    // an Owner import of a new fixed rule re-bases the family (the learner restarts on it)
    await insertMap(db, {
      ...FIXED,
      ruleVersion: "F1.v3-mom",
      fittedAt: "2026-07-01T00:00:00.000Z",
      params: {
        ...(FIXED.params as object),
        angles: ["A-D1-11", "A-D1-01"],
      } as unknown as MapRow["params"],
    });
    const imp = (await baseWeekly(db, {
      market: "AU",
      d: "2026-07-03",
      calendar: [],
      now: at("2026-07-03"),
    }))!;
    expect(imp.families[0]).toMatchObject({ version: 3, change: "owner_import", count: 2 });
    expect(imp.restartLearner[0]).toMatchObject({
      family: "F1",
      ruleVersion: "F1.v3-mom",
      baseVersion: 3,
    });
    expect(imp.lines[0]).toContain("Owner's new rule");
    db.close();
  });

  it("closes a probe that points the wrong way after two blocks (futile), settling its charge", async () => {
    const db = await setup();
    await baseWeekly(db, { market: "AU", d: S[0]!, calendar: [], now: at(S[0]!) });
    await openProbe(db, {
      market: "AU",
      family: "F1",
      angleId: "A-D1-10",
      d: S[0]!,
      now: at(S[0]!),
      seq: PROBE_SEQ0,
      words: "w",
    });
    const rows: AngleDayRow[] = [];
    for (let i = 1; i <= 120; i += 1)
      rows.push(row("A-D1-10", S[i]!, 1, i % 2 === 0 ? -0.05 : 0.01));
    await insertAngleDays(db, rows);
    const r = (await baseWeekly(db, { market: "AU", d: S[119]!, calendar: [], now: at(S[119]!) }))!;
    expect(r.closed).toEqual([{ family: "F1", angleId: "A-D1-10", reason: "futile" }]);
    expect(r.families[0]!.change).toBeNull();
    expect((await getCell(db, probeCellId("AU", "F1", "A-D1-10", S[0]!)))!.resultAt).toBe(
      at(S[119]!),
    );
    db.close();
  });

  it("a probe of an angle the base already has is closed", async () => {
    const db = await setup();
    await baseWeekly(db, { market: "AU", d: S[0]!, calendar: [], now: at(S[0]!) });
    await openProbe(db, {
      market: "AU",
      family: "F1",
      angleId: "A-D1-11",
      d: S[0]!,
      now: at(S[0]!),
      seq: PROBE_SEQ0,
      words: "w",
    });
    const r = (await baseWeekly(db, { market: "AU", d: S[5]!, calendar: [], now: at(S[5]!) }))!;
    expect(r.closed).toEqual([{ family: "F1", angleId: "A-D1-11", reason: "base_has_it" }]);
    db.close();
  });
});

// ---- nightly ---------------------------------------------------------------------------------------

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
  } as unknown as World;
}

const mover = (code: string, cause: MoverExplanation["cause"]) => ({
  code,
  side: "gainer" as const,
  cause,
});

async function seedMovers(db: Client): Promise<void> {
  const nights = weekdays("2026-10-13", PREV);
  for (const d of nights) {
    await db.execute({
      sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, ?)",
      args: [
        d,
        JSON.stringify({
          movers: [
            mover("ZZ001", "volume_no_news"),
            mover("ZZ002", "stock_specific"),
            mover("ZZ003", "market_move"),
          ],
        }),
        at(d),
      ],
    });
  }
  // one malformed night is skipped, not fatal
  await db.execute({
    sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', '2026-10-12', '{\"movers\": 3}', 'x')",
  });
}

describe("probeNight", () => {
  const NOW = `${D}T09:30:00.000Z`;

  it("opens a charged probe for a recurring cause, escalates what no measure captures, re-runs write nothing", async () => {
    const db = await setup();
    await baseWeekly(db, { market: "AU", d: "2026-10-01", calendar: [], now: at("2026-10-01") });
    await seedMovers(db);
    const r = (await probeNight(db, {
      market: "AU",
      d: D,
      calendar: [],
      movers: [mover("ZZ009", "volume_no_news")],
      now: NOW,
    }))!;
    expect(r.opened).toEqual([{ family: "F1", angleId: "A-D2-07" }]);
    expect(r.escalated).toEqual(["stock_specific"]);
    expect(r.scoredRows).toBe(0);
    const ev = await eventsSince(db, "AU", D, D);
    expect(ev.map((e) => [e.seq, e.kind])).toEqual([
      [PROBE_SEQ0, "probe_open"],
      [PROBE_SEQ0 + 1, "escalate"],
    ]);
    expect(ev[1]!.words).toContain("A new measure is needed for moves that neither news");
    for (const e of ev) expect(cleanWords(e.words), e.words).toBe(true);
    const cellId = (ev[0]!.evidence as { cellId: string }).cellId;
    expect(cellId).toBe(probeCellId("AU", "F1", "A-D2-07", D));
    expect((await getCell(db, cellId))!.resultAt).toBeNull();

    const again = (await probeNight(db, {
      market: "AU",
      d: D,
      calendar: [],
      movers: [mover("ZZ009", "volume_no_news")],
      now: NOW,
    }))!;
    expect(again.opened).toEqual([]);
    expect(again.escalated).toEqual([]);
    expect(await eventsSince(db, "AU", D, D)).toHaveLength(2);

    // the Cortex stage computes the probe from the next night only
    expect(await openProbeAngles(db, "AU", D)).toEqual([]);
    expect(await openProbeAngles(db, "AU", "2026-11-11")).toEqual(["A-D2-07"]);
    const reads = await loadStoreReads(db as never, { market: "AU", d: "2026-11-11" });
    expect(reads.probes).toEqual(["A-D2-07"]);
    expect(
      await probeNight(db, { market: "AU", d: "2026-11-14", calendar: [], movers: [], now: NOW }),
    ).toBeNull();
    db.close();
  });

  it("without recurring causes it only scores; without a base it can only escalate", async () => {
    const db = await setup();
    const quiet = (await probeNight(db, {
      market: "AU",
      d: D,
      calendar: [],
      movers: [],
      now: NOW,
    }))!;
    expect(quiet).toEqual({ scoredRows: 0, opened: [], escalated: [], lines: [], top5: {} });
    await seedMovers(db);
    const r = (await probeNight(db, { market: "AU", d: D, calendar: [], movers: [], now: NOW }))!;
    expect(r.opened).toEqual([]);
    expect(r.escalated).toEqual(["stock_specific", "volume_no_news"]);
    db.close();
  });

  it("scores an open probe from its stored values with the same scorecard (both horizons)", async () => {
    const db = await setup();
    await openProbe(db, {
      market: "AU",
      family: "F1",
      angleId: "A-D2-07",
      d: "2026-10-01",
      now: at("2026-10-01"),
      seq: PROBE_SEQ0,
      words: "w",
    });
    for (const night of [PREV, BACK21]) {
      await db.batch(
        codes().map((code, i) => ({
          sql: `INSERT INTO cortex_feature_probe (market, d, code, angle_id, value, flag, angle_version, manifest_id)
                VALUES ('AU', ?, ?, 'A-D2-07', ?, NULL, 2, 'zzmanifest')`,
          args: [night, code, rankVal(i + 1)],
        })),
        "write",
      );
    }
    const r = (await probeNight(db, {
      market: "AU",
      d: D,
      calendar: [],
      world: world(),
      movers: [],
      now: NOW,
    }))!;
    expect(r.scoredRows).toBe(2);
    const rows = await angleDaysSince(db, "AU", D, D);
    expect(rows.map((x) => [x.angleId, x.horizon, x.activeSetHash])).toEqual([
      ["A-D2-07", 1, "probe"],
      ["A-D2-07", 20, "probe"],
    ]);
    expect(rows[0]!.ic).toBeCloseTo(1, 10);
    // a re-run inserts nothing
    const again = (await probeNight(db, {
      market: "AU",
      d: D,
      calendar: [],
      world: world(),
      movers: [],
      now: NOW,
    }))!;
    expect(again.scoredRows).toBe(0);
    db.close();
  });
});

// @vitest-environment node
// D-921: the nightly daily-learning run on a real migrated file: it explains the movers from evidence,
// stores the night (round trip), opens a hypothesis once, and never reads past D.
import { createClient, type Client, type InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import {
  loadDailyLearning,
  runDailyLearning,
  type DailyLearning,
  type PickHooks,
} from "@/lib/learning/daily";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const D = "2026-11-10"; // Tuesday
const PREV = "2026-11-09";
const N = 60;

/** The N weekdays ending D, oldest first. */
const days = (): string[] => {
  const out: string[] = [];
  const t = new Date(`${D}T00:00:00Z`);
  while (out.length < N) {
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) out.unshift(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() - 1);
  }
  return out;
};

/** A repeatable wobble of +-0.3 % for share k on session i. */
const wobble = (k: number, i: number): number => (((k * 7919 + i * 104729) % 7) - 3) / 1000;

type Spec = {
  code: string;
  tier: string;
  sector: string | null;
  /** close step on session i (i = N - 1 is D) */
  step: (i: number) => number;
  gap?: number;
  vol?: (i: number) => number;
};

const specs = (): Spec[] => {
  const out: Spec[] = [];
  for (let k = 1; k <= 6; k += 1) {
    out.push({
      code: `M0${k}`,
      tier: "U1",
      sector: "Materials",
      step: (i) => (i === N - 1 ? 0.04 : wobble(k, i)),
    });
  }
  for (let k = 1; k <= 5; k += 1) {
    out.push({
      code: `E0${k}`,
      tier: "U1",
      sector: "Energy",
      step: (i) => (k === 1 && i === N - 1 ? 0.09 : wobble(k + 10, i)),
    });
  }
  for (let k = 1; k <= 3; k += 1) {
    out.push({ code: `W0${k}`, tier: "U1", sector: "Tech", step: () => 0.01, gap: 0.05 });
  }
  out.push({
    code: "Z01",
    tier: "U3",
    sector: null,
    step: (i) => (i === N - 1 ? 0.15 : wobble(99, i)),
    vol: (i) => (i === N - 1 ? 5000 : 1000),
  });
  return out;
};

async function seed(db: Client): Promise<void> {
  const ds = days();
  const stmts: InStatement[] = [];
  for (const s of specs()) {
    stmts.push({
      sql: "INSERT INTO instrument (market, code, name) VALUES ('AU', ?, ?)",
      args: [s.code, `${s.code} LIMITED`],
    });
    stmts.push({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU', ?, ?, 'active', ?, 0)`,
      args: [D, s.code, s.tier],
    });
    if (s.sector !== null) {
      stmts.push({
        sql: `INSERT INTO instrument_class (market, code, industry, source, as_of, loaded_at) VALUES ('AU', ?, ?, 'zz', '2026-01-01', 't')`,
        args: [s.code, s.sector],
      });
    }
    let prev = 10;
    ds.forEach((d, i) => {
      const c = Number((prev * (1 + s.step(i))).toFixed(6));
      const o = Number((prev * (1 + (s.gap ?? 0))).toFixed(6));
      stmts.push({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'zz', 't', 't')`,
        args: [
          s.code,
          d,
          o,
          Math.max(o, c) * 1.01,
          Math.min(o, c) * 0.99,
          c,
          (s.vol ?? (() => 1000))(i),
        ],
      });
      prev = c;
    });
  }
  // index: +0.2 % on D
  stmts.push({
    sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
          VALUES ('AU', 'AXJO', ?, 1, 1, 1, ?, 'zz', 't', 't')`,
    args: [PREV, 8_000_000_000],
  });
  stmts.push({
    sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
          VALUES ('AU', 'AXJO', ?, 1, 1, 1, ?, 'zz', 't', 't')`,
    args: [D, 8_016_000_000],
  });
  // E01: price-sensitive news Tue 09:00 Sydney (before the open); M02 had a routine (not sensitive) notice
  stmts.push({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
          VALUES ('AU', 'E01', 'a1', '2026-11-09T22:00:00.000Z', 't', 'x', 1, 'Production upgrade', 'zz')`,
    args: [],
  });
  stmts.push({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source)
          VALUES ('AU', 'M02', 'a2', '2026-11-09T22:00:00.000Z', 't', 'x', 0, 'Appendix 3Y', 'zz')`,
    args: [],
  });
  // a strategy signal on M03 the evening before, blocked by the stop distance
  stmts.push({
    sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
            evidence_json, schema_version, agent_version, inputs_ref, decided_at)
          VALUES ('sig:1', 'AU', ?, 'F1', 'F1.v1', 'A', 'M03', 'NEUTRAL', '1', '{}', '{}', 1, 'x', 'r', 't')`,
    args: [PREV],
  });
  stmts.push({
    sql: `INSERT INTO blocked_trade (signal_id, execution_id, market, d, reason) VALUES ('sig:1', 'e1', 'AU', ?, 'skipped_stop_distance')`,
    args: [PREV],
  });
  await db.batch(stmts, "write");
}

async function fileDb(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl() }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await seed(db);
  return db;
}

const NOW = "2026-11-10T09:00:00.000Z";
const run = (db: Client, hooks?: PickHooks) =>
  runDailyLearning(db, { market: "AU", d: D, calendar: [], now: NOW, hooks });

const hooks: PickHooks = {
  pickedBefore: async () => new Map([["M04", "Picked (Balanced #2)"]]),
  publishedDays: async (_db, _m, ds) => new Set(ds.filter((d) => d !== PREV)),
  shortlistNotes: (_s, _p, codes) =>
    new Map(
      codes.map((c) => [
        c,
        { note: `missed the shortlist: test note for ${c}`, onShortlist: c === "E02" },
      ]),
    ),
};

describe("runDailyLearning", () => {
  it("explains the movers, lessons and improvements, and stores the night", async () => {
    const db = await fileDb();
    const r = await run(db, hooks);
    expect(r.lessons).toBe(8);
    expect(r.movers).toBeGreaterThan(10);
    const day = (await loadDailyLearning(db, "AU", D))!;
    expect(day.d).toBe(D);
    expect(day.movers).toHaveLength(r.movers);
    // D-923: the night's World and movers go on to the learning Cortex; nothing of it is stored here
    expect(r.night!.world.d).toBe(D);
    expect(r.night!.movers).toEqual(day.movers);
    expect(day.cortex).toBeUndefined();
    const by = (code: string) => day.movers.find((m) => m.code === code)!;

    // company news before the open wins over everything else
    expect(by("E01")).toMatchObject({
      cause: "news_before_open",
      side: "gainer",
      name: "E01 Limited",
    });
    expect(by("E01").causeText).toContain("Production upgrade");
    // the other Materials shares moved +4 % with a sector of 6: sector-wide, and the average excludes itself
    expect(by("M01").cause).toBe("sector_move");
    expect(by("M01").sectorName).toBe("Materials");
    expect(by("M01").sectorMovePpm).toBe(40_000);
    expect(by("M01").causeText).toBe(
      "Sector-wide: Materials +4.0% on the day; it moved with its sector (+4.0%).",
    );
    // the small share rose 15 % on five times its usual volume, with no news, no sector and a +0.2 % index
    expect(by("Z01")).toMatchObject({
      cause: "volume_no_news",
      sectorName: null,
      indexMovePpm: 2_000,
    });
    expect(by("Z01").volumeVsUsualPpm).toBe(5_000_000);
    expect(by("Z01").causeText).toContain("5x its usual level");
    // who had it on the radar the evening before
    expect(by("M04").caughtBy).toBe("Picked (Balanced #2)");
    expect(by("M03").caughtBy).toBe(
      "Signalled by Follow the trend, trade blocked: the stop was too far away",
    );
    expect(by("E02").caughtBy).toBe("On the shortlist");
    expect(by("M01").caughtBy).toBeNull();
    expect(by("M01").nearMiss).toBe("missed the shortlist: test note for M01");
    expect(by("E02").nearMiss).toBeNull();
    // the gap-up shares were up 5 % at the open the evening before the close (their setup is listed in words)
    expect(by("W01").setupBefore).toContain("gapped up more than 3% at the open");

    // plain words everywhere a person reads
    const text = JSON.stringify([
      day.summary,
      day.improvements,
      day.movers.map((m) => m.causeText),
    ]);
    expect(text).not.toMatch(/\?|skipped_|sig:|\bF[1-6]\b|\bM0\d\b|\bE0\d\b|Z01/);
    expect(day.summary.length).toBeGreaterThanOrEqual(3);
    expect(day.summary.length).toBeLessThanOrEqual(4);
    expect(day.summary[0]).toContain("Tue 10 Nov");
    // improvements: the night without a published pick, the gap-up setup that beats the market, uncaught gainers
    expect(day.improvements.length).toBeLessThanOrEqual(6);
    expect(day.improvements[0]).toMatchObject({ area: "picks" });
    expect(day.improvements[0]!.evidence).toContain("Mon 9 Nov");
    expect(day.improvements.some((i) => i.area === "learning")).toBe(true);
    expect(await loadDailyLearning(db, "AU", "2026-11-09")).toBeNull();
  });

  it("is deterministic and a re-run of the same night rewrites the same document", async () => {
    const db = await fileDb();
    await run(db, hooks);
    const first = JSON.stringify(await loadDailyLearning(db, "AU", D));
    const again = await run(db, hooks);
    expect(again.hypotheses).toBe(0);
    expect(JSON.stringify(await loadDailyLearning(db, "AU", D))).toBe(first);
    const rows = await db.execute("SELECT COUNT(*) AS n FROM daily_learning");
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("works from strategy signals alone when no picks hooks are given", async () => {
    const db = await fileDb();
    await run(db);
    const day = (await loadDailyLearning(db, "AU", D))!;
    expect(day.movers.find((m) => m.code === "M04")!.caughtBy).toBeNull();
    expect(day.movers.find((m) => m.code === "M03")!.caughtBy).toContain(
      "Signalled by Follow the trend",
    );
    expect(day.improvements.every((i) => i.area !== "picks")).toBe(true); // pick days unknown: no claim
  });

  it("writes nothing on a day without a session, a weekend, or without bars", async () => {
    const db = await fileDb();
    expect(
      await runDailyLearning(db, { market: "AU", d: "2026-11-14", calendar: [], now: NOW }),
    ).toEqual({
      movers: 0,
      lessons: 0,
      improvements: 0,
      hypotheses: 0,
    });
    expect(
      await runDailyLearning(db, { market: "AU", d: "2026-12-01", calendar: [], now: NOW }),
    ).toEqual({ movers: 0, lessons: 0, improvements: 0, hypotheses: 0 });
    const n = await db.execute("SELECT COUNT(*) AS n FROM daily_learning");
    expect(n.rows[0]!.n).toBe(0);
  });

  it("uses no later bar: a bar after D changes nothing", async () => {
    const db = await fileDb();
    await run(db);
    const first = JSON.stringify(await loadDailyLearning(db, "AU", D));
    await db.execute(
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES ('AU', 'W01', '2026-11-11', 1, 1000, 1, 1000, 1, 'zz', 't', 't')`,
    );
    await run(db);
    expect(JSON.stringify(await loadDailyLearning(db, "AU", D))).toBe(first);
  });
});

/** Fourteen stored nights before D on which the gap-up setup beat the market. */
async function storeNights(db: Client, beatNights: number): Promise<void> {
  const ds = days()
    .filter((d) => d < D)
    .slice(-14);
  const stmts: InStatement[] = ds.map((d, i) => {
    const body: DailyLearning = {
      d,
      summary: [],
      movers: [],
      improvements: [],
      hypothesesOpened: [],
      lessons: [
        {
          feature: "gapped up more than 3% at the open",
          sessions: 40,
          n: 200,
          nextDayAvgPpm: 12_000,
          baseAvgPpm: 1_000,
          liftPpm: 11_000,
          hitRatePpm: 700_000,
          verdict: i < beatNights ? "beats the market" : "no clear edge yet",
          change: "unchanged",
        },
      ],
    };
    return {
      sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, 't')",
      args: [d, JSON.stringify(body)],
    };
  });
  await db.batch(stmts, "write");
}

describe("D-990 the top-5 gainer target in the stored night", () => {
  it("names the picked and early intraday gainers, keeps the causes, chance and four weeks", async () => {
    const db = await fileDb();
    // the night before, stored with its own top-5 measure (one of five named, chance 0.5)
    await db.execute({
      sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, 't')",
      args: [
        PREV,
        JSON.stringify({
          d: PREV,
          summary: [],
          movers: [],
          lessons: [],
          improvements: [],
          hypothesesOpened: [],
          top5: {
            d: PREV,
            gainers: [{}, {}, {}, {}, {}],
            gainersHad: 1,
            chanceHits: 0.5,
            rolling: {},
          },
        }),
      ],
    });
    // M02 was found intraday at +1 % of its +4 % day; M03 at +3 % (most of the move made)
    // D-1044: M01 was an "avoid / watch" faller at that time (bad news, price down, then it rebounded):
    // never credited as found intraday
    for (const [code, move, polarity] of [
      ["M01", -20_000, "negative"],
      ["M02", 10_000, "positive"],
      ["M03", 30_000, "positive"],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source,
                item_ann_id, materiality, polarity, move_ppm, gates_json)
              VALUES ('AU', ?, ?, '11:00', ?, 'zz', 'a', 2, ?, ?, '{}')`,
        args: [D, code, `${D}T00:00:00.000Z`, polarity, move],
      });
    }
    await run(db, {
      ...hooks,
      picksOf: async () =>
        new Map([
          ["M04", { where: "Balanced #2", source: "strategy" as const }],
          ["E03", { where: "Growth #1", source: "candidate" as const }],
        ]),
    });
    const t = (await loadDailyLearning(db, "AU", D))!.top5!;
    expect(t.gainers.map((g) => [g.code, g.via, g.missed])).toEqual([
      ["E01", null, "news_before_open"],
      ["M01", null, "sector_move"],
      ["M02", "intraday", null],
      ["M03", null, "sector_move"],
      ["M04", "strategy", null],
    ]);
    expect(t.gainersHad).toBe(2);
    expect(t.named).toBe(4);
    expect(t.liquid).toBe(14);
    expect(t.chanceHits).toBeCloseTo((4 / 14) * 5, 10);
    expect(t.rolling).toMatchObject({ nights: 2, gainers: 10, had: 3 });
    expect(t.picks.n).toBe(2);
    // the review words read from the stored night
    expect(t.gainers[0]!.name).toBe("E01 Limited");
    db.close();
  });

  it("without the picks hook or an intraday table only the evening's signals are known", async () => {
    const db = await fileDb();
    await db.execute("DROP TABLE intraday_candidate");
    await run(db);
    const t = (await loadDailyLearning(db, "AU", D))!.top5!;
    expect(t.gainersHad).toBe(0);
    expect(t.named).toBe(0);
    expect(t.rolling.nights).toBe(1);
    db.close();
  });
});

describe("feeding the learning system", () => {
  const clusters = async (db: Client) =>
    (
      await db.execute(
        "SELECT id, category, testability FROM cluster WHERE id LIKE 'dl-%' ORDER BY id",
      )
    ).rows;

  it("opens one proposed hypothesis, once, when a feature beat the market on 10 of the last 15 nights", async () => {
    const db = await fileDb();
    await storeNights(db, 9); // 9 earlier nights + tonight = 10 of 15
    const r = await run(db, hooks);
    expect(r.hypotheses).toBeGreaterThanOrEqual(1);
    const day = (await loadDailyLearning(db, "AU", D))!;
    expect(
      day.hypothesesOpened.some((h) =>
        h.startsWith(
          "gapped up more than 3% at the open: beat the market on 10 of the last 15 nights",
        ),
      ),
    ).toBe(true);
    const rows = await clusters(db);
    expect(rows.map((x) => String(x.id))).toContain("dl-gapUp");
    // it flows into the existing expert-claim pipeline: a proposed cluster, a claim that supports it
    const st = await db.execute(
      "SELECT state, actor FROM cluster_state WHERE cluster_id = 'dl-gapUp'",
    );
    expect(st.rows.map((x) => [x.state, x.actor])).toEqual([["proposed", "daily-learning"]]);
    const claim = await db.execute(
      `SELECT c.type, c.cluster_id, s.status FROM claim c JOIN claim_status s ON s.claim_id = c.id
       JOIN claim_cluster k ON k.claim_id = c.id WHERE c.id = 'dlc-gapUp' AND k.role = 'supports'`,
    );
    expect(claim.rows.map((x) => [x.type, x.cluster_id, x.status])).toEqual([
      ["method", "dl-gapUp", "extracted"],
    ]);
    // nothing about a strategy rule or the shortlist changed
    const rules = await db.execute("SELECT COUNT(*) AS n FROM rule_version");
    expect(rules.rows[0]!.n).toBe(0);
    // the improvement says the hypothesis was opened
    expect(day.improvements.find((i) => i.title.includes("gapped up"))!.action).toContain(
      "hypothesis was opened",
    );

    // a later night never opens it a second time
    const before = (await clusters(db)).length;
    const again = await run(db, hooks);
    expect(again.hypotheses).toBe(0);
    expect((await clusters(db)).length).toBe(before);
    expect(
      (await db.execute("SELECT COUNT(*) AS n FROM claim WHERE id = 'dlc-gapUp'")).rows[0]!.n,
    ).toBe(1);
  });

  it("opens nothing with 9 of 15 nights", async () => {
    const db = await fileDb();
    await storeNights(db, 8);
    const r = await run(db, hooks);
    expect(r.hypotheses).toBe(0);
    expect((await clusters(db)).map((x) => String(x.id))).not.toContain("dl-gapUp");
  });
});

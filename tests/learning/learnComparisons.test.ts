// @vitest-environment node
// The nightly comparison pairs of the `learn` phase (M6 T11; ARN-062, EML-037; design 2.5; D-114):
// which pairs the forward ledger can answer, their blocks, labels, determinism and the look-ahead bound
// (only rows entered by D, only the attribution version known by D).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { addDays, isWeekend } from "@/lib/data/calendar";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { comparisonPairs, learnDay } from "@/lib/learning/learnStage";
import { cleanupTempDbs } from "../db/helpers";
import { D, MARKET, PARAMS, addNight, lightWorld, nowFor, rows } from "./learnHelpers";

afterEach(cleanupTempDbs);

function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  for (let d = from; out.length < n; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
  return out;
}

/** 2026-08-03 .. : 55 sessions, all before 2026-10-20 (the weekday calendar has no holidays here). */
const DAYS = weekdays("2026-08-03", 55);

type Seed = {
  family: string;
  version?: string;
  n: number;
  tiers?: string[];
  regimes?: string[];
  excess: (i: number) => number;
  /** Days offset to start from (an index into DAYS). */
  from?: number;
  /** Explicit entry dates (override `from`). */
  entryD?: (i: number) => string;
  /** 0 = the row is still open (a later version may follow). */
  final?: 0 | 1;
  id?: string;
};

let serial = 0;
async function seedAttribution(db: Client, s: Seed): Promise<void> {
  const version = s.version ?? `${s.family}.v1`;
  for (let i = 0; i < s.n; i += 1) {
    const entry = s.entryD ? s.entryD(i) : DAYS[(s.from ?? 0) + i]!;
    serial += 1;
    const tags = {
      family: s.family,
      rule_version: version,
      variant: s.family,
      tier: s.tiers ? s.tiers[i % s.tiers.length] : null,
      regime: s.regimes ? s.regimes[i % s.regimes.length] : null,
      entry_d: entry,
    };
    await db.execute({
      sql: `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm,
              mae_ppm, hold_sessions, cost_micro, slippage_micro, net_micro, excess_ppm, stress_ppm)
            VALUES ('ledger_row', ?, 1, ?, ?, ?, ?, 10, -10, 3, 1, 1, 100, ?, 5)`,
      args: [
        s.id ?? `row-${serial}`,
        MARKET,
        addDays(entry, 4),
        s.final ?? 1,
        JSON.stringify(tags),
        s.excess(i),
      ],
    });
  }
}

async function seedWorld(): Promise<Client> {
  const db = await lightWorld();
  await seedAttribution(db, {
    family: "F1",
    n: 40,
    tiers: ["U1", "U2"],
    regimes: ["R1", "R2"],
    excess: (i) => 1000 + (i % 7) * 50,
  });
  await seedAttribution(db, { family: "F2", n: 40, excess: (i) => 400 + (i % 5) * 80 });
  await seedAttribution(db, { family: "F4", n: 12, excess: (i) => 900 - i * 10 });
  // one open row of F2: a later version may exist, but only the version known by D is read
  await seedAttribution(db, {
    family: "F2",
    n: 1,
    id: "open-row",
    final: 0,
    entryD: () => "2026-10-01",
    excess: () => 777,
  });
  return db;
}

const calendarOf = (db: Client) => loadCalendar(db, MARKET);

describe("the pairs list v1 the forward ledger can answer", () => {
  it("family pairs, tiers and regimes inside a family, and event vs technical", async () => {
    const db = await seedWorld();
    const pairs = await comparisonPairs(db, {
      market: MARKET,
      d: D,
      calendar: await calendarOf(db),
      params: PARAMS,
    });
    expect(pairs.map((p) => p.pairId)).toEqual([
      "F1.v1|F2.v1",
      "F1.v1|F4.v1",
      "F2.v1|F4.v1",
      "F1.v1:U1|F1.v1:U2",
      "F1.v1:R1|F1.v1:R2",
      "EVENT|TECH",
    ]);
    const fam = pairs.find((p) => p.pairId === "F1.v1|F2.v1")!;
    expect([fam.a.length, fam.b.length]).toEqual([40, 41]);
    const evtech = pairs.find((p) => p.pairId === "EVENT|TECH")!;
    expect([evtech.a.length, evtech.b.length]).toEqual([41, 52]); // F2 vs F1 + F4
    // session indexes refer to the window from the first entry to D
    expect(fam.sessionCount).toBeGreaterThan(55);
    expect(Math.max(...fam.a.map((r) => r.session))).toBeLessThan(fam.sessionCount);
  });

  it("the block is the larger frozen block of the lineages involved, else the registry minimum", async () => {
    const db = await seedWorld();
    await db.execute({
      sql: `INSERT INTO lesson_window (lineage_id, split_version, l1_start_d, l1_end_d, purge, l2_start_d, l2_end_d, block, frozen_run)
            VALUES ('AU:F1', 1, '2026-01-01', '2026-03-01', 5, '2026-03-10', '2026-05-01', 9, 'run-x')`,
    });
    const pairs = await comparisonPairs(db, {
      market: MARKET,
      d: D,
      calendar: await calendarOf(db),
      params: PARAMS,
    });
    const by = Object.fromEntries(pairs.map((p) => [p.pairId, p.block]));
    const min = PARAMS.stats.bootstrapBlockMinSessions;
    expect(by["F1.v1|F2.v1"]).toBe(Math.max(9, min));
    expect(by["F2.v1|F4.v1"]).toBe(min);
    expect(by["EVENT|TECH"]).toBe(Math.max(9, min)); // includes F1
  });

  it("a pair needs rows on both sides, and rows without an excess figure are not compared", async () => {
    const db = await lightWorld();
    await seedAttribution(db, { family: "F1", n: 40, excess: () => 10 });
    expect(
      await comparisonPairs(db, {
        market: MARKET,
        d: D,
        calendar: await calendarOf(db),
        params: PARAMS,
      }),
    ).toEqual([]);
    await db.execute(
      'INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm, mae_ppm, hold_sessions, cost_micro, slippage_micro) VALUES (\'ledger_row\', \'no-excess\', 1, \'AU\', \'2026-09-01\', 1, \'{"family":"F2","rule_version":"F2.v1","variant":"F2","entry_d":"2026-08-20"}\', 1, -1, 1, 1, 1)',
    );
    expect(
      await comparisonPairs(db, {
        market: MARKET,
        d: D,
        calendar: await calendarOf(db),
        params: PARAMS,
      }),
    ).toEqual([]);
  });

  it("only the family's own variant is compared, and trades or blocked subjects are not pair rows", async () => {
    const db = await lightWorld();
    await seedAttribution(db, { family: "F1", n: 40, excess: () => 10 });
    await db.execute({
      sql: `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm, mae_ppm, hold_sessions, cost_micro, slippage_micro, excess_ppm)
            VALUES ('ledger_row', 'tier-variant', 1, 'AU', '2026-09-01', 1, ?, 1, -1, 1, 1, 1, 50)`,
      args: [
        JSON.stringify({
          family: "F2",
          rule_version: "F2.v1",
          variant: "F2-U1",
          entry_d: "2026-08-20",
        }),
      ],
    });
    expect(
      await comparisonPairs(db, {
        market: MARKET,
        d: D,
        calendar: await calendarOf(db),
        params: PARAMS,
      }),
    ).toEqual([]);
  });
});

describe("the nightly rows", () => {
  const learn = (db: Client, d = D) =>
    learnDay(db, { market: MARKET, d, now: nowFor(d), params: PARAMS });

  it("one labelled row per pair; below comparison_min_rows per side it says so (n = ...)", async () => {
    const db = await seedWorld();
    await addNight(db, D);
    const r = await learn(db);
    expect(r.stats.comparisons).toBe(6);
    const out = await rows(
      db,
      "SELECT pair_id, n_a, n_b, estimate, label FROM comparison_result WHERE kind = 'nightly' ORDER BY pair_id",
    );
    const label = Object.fromEntries(out.map((x) => [x.pair_id, x]));
    expect(label["F1.v1|F2.v1"]!.label).toBe("descriptive — not a finding");
    expect(label["F1.v1|F2.v1"]!.estimate).not.toBeNull();
    expect(label["F2.v1|F4.v1"]!.label).toBe("not enough data (n = 12)"); // F4 has 12 rows
    expect(label["F2.v1|F4.v1"]!.estimate).toBeNull();
    expect(label["F1.v1:U1|F1.v1:U2"]!.label).toBe("not enough data (n = 20)"); // 20 per tier < 30
    expect(
      out.every((x) => x.estimate !== null || String(x.label).startsWith("not enough data")),
    ).toBe(true);
  });

  it("is deterministic: the same attribution on two databases gives identical rows", async () => {
    const dump = async (): Promise<string> => {
      const db = await seedWorld();
      await addNight(db, D);
      await learn(db);
      return JSON.stringify(await rows(db, "SELECT * FROM comparison_result ORDER BY pair_id"));
    };
    expect(await dump()).toBe(await dump());
  });

  it("looks ahead at nothing: rows entered after D and attribution versions after D change no figure", async () => {
    const clean = await seedWorld();
    await addNight(clean, D);
    await learn(clean);
    const poisoned = await seedWorld();
    await addNight(poisoned, D);
    // rows entered after D (a later night's work), with extreme excess
    await seedAttribution(poisoned, {
      family: "F1",
      n: 10,
      entryD: (i) => addDays("2026-10-27", i * 7),
      excess: () => 9_000_000,
    });
    // a later version of an open row, dated after D, must not be read
    await poisoned.execute({
      sql: `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm, mae_ppm, hold_sessions, cost_micro, slippage_micro, excess_ppm)
            SELECT subject_kind, subject_id, 2, market, '2026-11-02', 1, tags_json, mfe_ppm, mae_ppm, hold_sessions, cost_micro, slippage_micro, -9000000
            FROM attribution WHERE subject_id = 'open-row' AND version = 1`,
    });
    await learn(poisoned);
    const a = await rows(clean, "SELECT * FROM comparison_result ORDER BY pair_id");
    const b = await rows(poisoned, "SELECT * FROM comparison_result ORDER BY pair_id");
    expect(b).toEqual(a);
  });
});

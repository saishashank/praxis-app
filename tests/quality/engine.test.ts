// @vitest-environment node
// Data quality engine against a real local libSQL file and synthetic bars (M2 T7): DAT-200,
// DAT-201, DAT-210, DAT-211, DAT-003, DAT-141, AT-07. Fake codes ZZA.. only (SEC-110).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { setConfig } from "@/lib/config/store";
import { runBatch1, type RunOptions } from "@/lib/data/pipeline/batch1";
import { readQualityConfig, runQuality } from "@/lib/data/quality/engine.mjs";
import { entriesAllowed, exitsAllowed } from "@/lib/data/quality/gate";
import { RULES } from "@/lib/data/quality/rules.mjs";
import { cleanupTempDbs, ROOT } from "../db/helpers";
import { at1730, bar, barsFor, count, pipelineDb, runs, text } from "../pipeline/helpers";

afterEach(cleanupTempDbs);

const FRI0 = "2026-10-09";
const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";
const NOW = "2026-10-13T07:00:00.000Z";
const CODES = "ABCDEFGHIJKLMNOPQRST".split("").map((c) => `ZZ${c}`); // 20 codes

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: unknown[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args: args as never })).rows.map((r) => ({ ...r }));
const details = (r: Row) => JSON.parse(String(r.details_json));

const go = (db: Client, date: string, bars: unknown[], o: Partial<RunOptions> = {}) =>
  runBatch1(db, {
    nowMs: () => at1730(date),
    barsText: text(bars),
    commitSha: "a".repeat(40),
    ...o,
  });

/** 20 U1 codes with a snapshot on the Friday before, so the tier is carried forward. */
async function u1Db(codes = CODES) {
  const db = await pipelineDb({ codes });
  for (const code of codes) {
    await db.execute({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted)
            VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
      args: [FRI0, code],
    });
  }
  return db;
}
/** Monday good, then call for Tuesday with the given bars (volume differs so nothing is identical). */
const tue = (over: Record<string, Partial<ReturnType<typeof bar>>> = {}, drop: string[] = []) =>
  CODES.filter((c) => !drop.includes(c)).map((c) => bar(c, TUE, { volume: 1100, ...over[c] }));

async function twoDays(over: Record<string, Partial<ReturnType<typeof bar>>> = {}) {
  const db = await u1Db();
  await go(db, MON, barsFor([MON], CODES));
  const res = await go(db, TUE, tue(over));
  return { db, res };
}
const flagsOf = (db: Client, d = TUE) =>
  rows(
    db,
    "SELECT code, check_id, severity, blocks_entries, cleared_at, d FROM data_quality_flag WHERE d = ? ORDER BY code, check_id",
    [d],
  );

describe("pipeline stage 8 (default hook)", () => {
  it("a clean night: three scores, no flags, summary in the run record, rows counted", async () => {
    const { db, res } = await twoDays();
    expect(res).toMatchObject({ exit: 0, status: "ok" });
    expect(await count(db, "data_quality_flag")).toBe(0);
    const sc = await rows(db, "SELECT * FROM quality_score WHERE d = ? ORDER BY tier", [TUE]);
    expect(sc.map((r) => [r.tier, r.valid, r.expected, r.score, r.gate_pass])).toEqual([
      ["U1", 20, 20, 1, 1],
      ["U2", 0, 0, 1, 1],
      ["U3", 0, 0, 1, 1],
    ]);
    const rec = (await runs(db)).find((r) => r.scheduled_for === TUE)!;
    expect(rec.rows_written).toBe(20 + 20 + 1 + 3); // bars, snapshot, marker, scores
    const q = details(rec).stages.quality;
    expect(q).toMatchObject({
      flags: 0,
      gate: { pass: true, threshold_pct: 95, consecutive_failures: 0 },
      counts: {
        suspect: 0,
        missing: 0,
        cross_source_disagreements: 0,
        unresolved_corporate_actions: 0,
      },
      scores: { U1: { valid: 20, expected: 20, score: 1 }, U2: { empty: true } },
    });
  });

  it("AT-07: high<close, zero price and a 60% jump are flagged and their entries blocked", async () => {
    const db = await u1Db();
    await go(db, MON, barsFor([MON], CODES));
    const bars = [
      ...tue({}, ["ZZA", "ZZB", "ZZC"]),
      bar("ZZA", TUE, { high: 11, close: 11.5 }), // high < close
      bar("ZZB", TUE, { open: 0, high: 0, low: 0, close: 0, adj_close: 0 }), // zero price
      bar("ZZC", TUE, { open: 16, high: 17, low: 15, close: 16, volume: 1100 }), // 10.5 -> 16
    ];
    // ZZC's Monday close is 12.5 (base 12 + 0.5), so a 60% jump is 20.
    bars[bars.length - 1] = bar("ZZC", TUE, {
      open: 20,
      high: 21,
      low: 19,
      close: 20,
      volume: 1100,
    });
    const res = await go(db, TUE, bars);
    expect(res.status).toBe("ok");
    const f = await flagsOf(db);
    const by = (code: string | null) =>
      f
        .filter((x) => x.code === code)
        .map((x) => `${x.check_id}:${x.severity}:${x.blocks_entries}`);
    expect(by("ZZA")).toEqual([
      `${RULES.ohlc_inconsistent.id}:error:1`,
      `${RULES.missing_bar.id}:error:1`,
    ]);
    expect(by("ZZB")).toEqual([
      `${RULES.price_not_positive.id}:error:1`,
      `${RULES.missing_bar.id}:error:1`,
    ]);
    expect(by("ZZC")).toEqual([`${RULES.suspect_move.id}:warning:1`]);
    // 17 of 20 = 85%: the U1 gate fails and the market-wide flag is raised.
    expect(by(null)).toEqual([`${RULES.u1_gate.id}:critical:1`]);
    const u1 = (
      await rows(db, "SELECT * FROM quality_score WHERE d = ? AND tier = 'U1'", [TUE])
    )[0];
    expect(u1).toMatchObject({ valid: 17, expected: 20, gate_pass: 0 });
    expect(u1.score).toBeCloseTo(0.85, 6);
    // Entries blocked everywhere that night, exits not (DAT-210).
    for (const code of ["ZZA", "ZZC", "ZZT"]) {
      expect(await entriesAllowed(db, code, TUE)).toEqual({
        allowed: false,
        reason: "u1_gate_failed",
      });
    }
    expect(exitsAllowed()).toBe(true);
    const q = details((await runs(db)).find((r) => r.scheduled_for === TUE)!).stages.quality;
    expect(q.gate.pass).toBe(false);
    expect(q.counts).toMatchObject({ suspect: 1, missing: 2 });
    expect(q.flags).toBe(f.length);
    expect(q.flags_by_rule[RULES.missing_bar.id]).toBe(2);
    // The marker still records the night as partial; nothing was filled in.
    const m = (await rows(db, "SELECT outcome FROM completion_marker WHERE d = ?", [TUE]))[0];
    expect(m.outcome).toBe("partial:18/20");
  });

  it("one bad bar of 20 is 95%: the gate passes, only that code is blocked", async () => {
    const { db } = await twoDays({ ZZA: { open: 20, high: 21, low: 19, close: 20 } }); // 60% jump
    const u1 = (
      await rows(db, "SELECT * FROM quality_score WHERE d = ? AND tier = 'U1'", [TUE])
    )[0];
    expect(u1).toMatchObject({ valid: 19, expected: 20, gate_pass: 1 });
    expect(await entriesAllowed(db, "ZZA", TUE)).toEqual({
      allowed: false,
      reason: "code_blocked",
    });
    expect(await entriesAllowed(db, "ZZB", TUE)).toEqual({ allowed: true, reason: "ok" });
    expect(await entriesAllowed(db, "ZZB", WED)).toEqual({
      allowed: false,
      reason: "no_quality_score",
    });
    expect(exitsAllowed()).toBe(true);
  });

  it("zero volume on a U1 code and identical OHLCV are flagged", async () => {
    const db = await u1Db();
    await go(db, MON, barsFor([MON], CODES));
    const bars = tue({ ZZD: { volume: 0 } }, ["ZZE"]);
    bars.push(bar("ZZE", TUE)); // identical to Monday's ZZE (volume 1000)
    await go(db, TUE, bars);
    const f = await flagsOf(db);
    expect(f.map((x) => `${x.code}:${x.check_id}`)).toEqual([
      `null:${RULES.u1_gate.id}`, // 18 of 20 is 90%
      `ZZD:${RULES.zero_volume_u1.id}`,
      `ZZE:${RULES.identical_ohlcv.id}`,
    ]);
    const q = details((await runs(db)).find((r) => r.scheduled_for === TUE)!).stages.quality;
    expect(q.counts.suspect).toBe(2);
    expect(q.scores.U1.valid).toBe(18);
  });

  it("a re-fetch above 0.1% raises a non-blocking flag on the previous session's bar", async () => {
    const db = await u1Db();
    await go(db, MON, barsFor([MON], CODES));
    const monFetch = CODES.map((c) =>
      // 0.3% higher close on ZZA (spec/06 line 129), the rest identical
      bar(c, MON, c === "ZZA" ? { close: 10.5 * 1.003 } : {}),
    );
    await go(db, TUE, [...monFetch, ...tue()]);
    const f = await flagsOf(db, MON);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      code: "ZZA",
      check_id: RULES.refetch_diff.id,
      severity: "warning",
      blocks_entries: 0,
      cleared_at: null,
    });
    expect(await count(db, "bar_refetch")).toBe(1);
    // A flag only: entries on that code are not blocked by it (DAT-002).
    await db.execute({
      sql: `INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass)
            VALUES ('AU', ?, 'U1', 20, 20, 1, 1)`,
      args: ["2026-10-20"],
    });
    expect(await entriesAllowed(db, "ZZA", "2026-10-20")).toEqual({ allowed: true, reason: "ok" });
  });

  it("the re-fetch threshold is the Owner-editable refetch_diff_flag key", async () => {
    const db = await u1Db();
    await setConfig(db, { key: "refetch_diff_flag", value: 0.5, userId: null, now: NOW });
    await go(db, MON, barsFor([MON], CODES));
    const monFetch = CODES.map((c) => bar(c, MON, c === "ZZA" ? { close: 10.5 * 1.003 } : {}));
    await go(db, TUE, [...monFetch, ...tue()]);
    expect(await count(db, "data_quality_flag")).toBe(0);
    expect(await count(db, "bar_refetch")).toBe(0);
  });

  it("two failing nights: the second reports consecutive_failures = 2 (DAT-210)", async () => {
    const db = await u1Db();
    const bad = (d: string, vol: number) =>
      CODES.map((c) =>
        bar(
          c,
          d,
          ["ZZA", "ZZB"].includes(c) ? { high: 1, low: 0.5, open: 5, close: 5 } : { volume: vol },
        ),
      );
    await go(db, MON, bad(MON, 1000));
    await go(db, TUE, [...bad(TUE, 1100)]);
    const recs = await runs(db);
    const qs = recs.map((r) => details(r).stages.quality.gate);
    expect(qs.map((g: { pass: boolean }) => g.pass)).toEqual([false, false]);
    expect(qs.map((g: { consecutive_failures: number }) => g.consecutive_failures)).toEqual([1, 2]);
  });

  it("the U1 gate level is the Owner-editable u1_quality_gate key", async () => {
    const db = await u1Db();
    await setConfig(db, { key: "u1_quality_gate", value: 85, userId: null, now: NOW });
    await go(db, MON, barsFor([MON], CODES));
    const bad = { open: 20, high: 21, low: 19, close: 20 };
    await go(db, TUE, tue({ ZZA: bad, ZZB: bad, ZZC: bad })); // 17 of 20 = 85%: passes at 85
    const u1 = (
      await rows(db, "SELECT gate_pass FROM quality_score WHERE d = ? AND tier = 'U1'", [TUE])
    )[0];
    expect(u1.gate_pass).toBe(1);
    expect(await count(db, "data_quality_flag", "check_id = 'DAT-210:u1_gate'")).toBe(0);
  });

  it("is not run for non-trading days and the noop hook writes nothing", async () => {
    const db = await u1Db();
    await go(db, "2026-10-17", barsFor([MON], CODES)); // Saturday
    expect(await count(db, "quality_score")).toBe(0);
    expect(await count(db, "data_quality_flag")).toBe(0);
  });
});

describe("re-evaluation: idempotent, clearing, append-only", () => {
  const jump = { open: 20, high: 21, low: 19, close: 20 };
  const call = (db: Client, extra: Record<string, unknown> = {}) => {
    const io = { read: 0, written: 0 };
    return runQuality({
      db,
      market: "AU",
      d: TUE,
      io,
      now: "2026-10-13T07:30:00.000Z",
      ...extra,
    }).then((r) => ({ ...r, io }));
  };

  it("a second run adds no flag and no score (DAT-003)", async () => {
    const { db } = await twoDays({ ZZA: jump });
    const before = [await count(db, "data_quality_flag"), await count(db, "quality_score")];
    const r = await call(db);
    expect(r).toMatchObject({ flags: 0, cleared: 0 });
    expect(r.io.written).toBe(0);
    expect(r.io.read).toBeGreaterThan(0);
    expect([await count(db, "data_quality_flag"), await count(db, "quality_score")]).toEqual(
      before,
    );
  });

  it.each([
    [
      "a corporate action",
      `INSERT INTO corporate_action (market, code, type, ex_date, payload_json)
       VALUES ('AU', 'ZZA', 'split', '2026-10-13', '{}')`,
    ],
    [
      "an adjustment factor",
      `INSERT INTO adjustment_factor (market, code, ex_date, factor, corporate_action_id, computed_at)
       VALUES ('AU', 'ZZA', '2026-10-13', 0.5, 1, '2026-10-13T07:00:00.000Z')`,
    ],
    [
      "a price-sensitive announcement",
      `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, price_sensitive, title, source)
       VALUES ('AU', 'ZZA', 'a1', '2026-10-13T01:00:00.000Z', '2026-10-13T01:01:00.000Z', 1, 'Synthetic', 'asx')`,
    ],
  ])("the suspect move clears once %s explains it; the row stays", async (_n, sql) => {
    const { db } = await twoDays({ ZZA: jump });
    expect(await count(db, "data_quality_flag", "cleared_at IS NULL")).toBe(1);
    await db.execute(sql);
    const r = await call(db);
    expect(r).toMatchObject({ flags: 0, cleared: 1 });
    const f = await flagsOf(db);
    expect(f).toHaveLength(1);
    expect(f[0].cleared_at).toBe("2026-10-13T07:30:00.000Z");
    expect(await entriesAllowed(db, "ZZA", TUE)).toEqual({ allowed: true, reason: "ok" });
    expect((await call(db)).cleared).toBe(0); // nothing left to clear
    // the same condition reappearing raises a fresh row (the cleared one is history)
    expect(await count(db, "data_quality_flag")).toBe(1);
  });

  it("a non-price-sensitive announcement does not explain a move", async () => {
    const { db } = await twoDays({ ZZA: jump });
    await db.execute(
      `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, price_sensitive, title, source)
       VALUES ('AU', 'ZZA', 'a2', '2026-10-13T01:00:00.000Z', '2026-10-13T01:01:00.000Z', 0, 'Synthetic', 'asx')`,
    );
    expect((await call(db)).cleared).toBe(0);
  });

  it("the stored scores are append-only: a later run never changes them", async () => {
    const { db } = await twoDays({ ZZA: jump });
    await db.execute(
      `INSERT INTO corporate_action (market, code, type, ex_date, payload_json)
       VALUES ('AU', 'ZZA', 'split', '2026-10-13', '{}')`,
    );
    const first = await rows(db, "SELECT * FROM quality_score WHERE d = ? ORDER BY tier", [TUE]);
    const r = await call(db);
    expect(r.summary.scores.U1.valid).toBe(20); // the re-evaluation sees ZZA as valid now
    expect(await rows(db, "SELECT * FROM quality_score WHERE d = ? ORDER BY tier", [TUE])).toEqual(
      first,
    );
    await expect(db.execute("UPDATE quality_score SET score = 1")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM quality_score")).rejects.toThrow(/append-only/);
  });

  it("the flag table only ever changes cleared_at (trigger), never other columns", async () => {
    const { db } = await twoDays({ ZZA: jump });
    await expect(db.execute("UPDATE data_quality_flag SET severity = 'info'")).rejects.toThrow();
    await expect(db.execute("DELETE FROM data_quality_flag")).rejects.toThrow();
  });

  it("counts unresolved corporate actions (latest event queued) in the summary (DAT-201)", async () => {
    const { db } = await twoDays();
    await db.execute(
      `INSERT INTO corporate_action (id, market, code, type, ex_date, payload_json)
       VALUES (1, 'AU', 'ZZB', 'split', '2026-10-20', '{}'), (2, 'AU', 'ZZC', 'split', '2026-10-20', '{}')`,
    );
    await db.execute(
      `INSERT INTO corporate_action_event (action_id, at, status, by) VALUES
       (1, '2026-10-13T00:00:00Z', 'queued', 'sys'),
       (2, '2026-10-13T00:00:00Z', 'queued', 'sys'),
       (2, '2026-10-13T01:00:00Z', 'resolved', 'owner')`,
    );
    expect((await call(db)).summary.counts.unresolved_corporate_actions).toBe(1);
  });
});

describe("direct calls: inputs the pipeline does not produce today", () => {
  const putBar = (db: Client, code: string, d: string, o: number, volume = 1000) =>
    db.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'yahoo_eod', 'x', 'x')`,
      args: [code, d, o, o + 1, o - 1, o + 0.5, volume] as never,
    });
  const run = (db: Client, extra: Record<string, unknown> = {}) =>
    runQuality({ db, market: "AU", d: TUE, io: { read: 0, written: 0 }, now: NOW, ...extra });

  it("falls back to active instruments with the last known tier when the date has no snapshot", async () => {
    const db = await pipelineDb({ codes: ["ZZA", "ZZB", "ZZC"] });
    await db.execute(
      `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES
       ('AU', '${MON}', 'ZZA', 'active', 'U1', 0), ('AU', '${MON}', 'ZZB', 'active', 'U2', 0)`,
    );
    await putBar(db, "ZZA", TUE, 10);
    const r = await run(db);
    expect(r.summary.scores.U1).toMatchObject({ valid: 1, expected: 1 });
    expect(r.summary.scores.U2).toMatchObject({ valid: 0, expected: 1 }); // missing
    expect(r.summary.scores.U3).toMatchObject({ valid: 0, expected: 1 }); // ZZC has no tier: U3
    expect(r.summary.counts.missing).toBe(2);
  });

  it("a halted U1 code with zero volume is not suspect; a non-halted one is", async () => {
    const db = await pipelineDb({ codes: ["ZZA", "ZZB"] });
    await db.execute(
      `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES
       ('AU', '${TUE}', 'ZZA', 'halted', 'U1', 1), ('AU', '${TUE}', 'ZZB', 'active', 'U1', 0)`,
    );
    await putBar(db, "ZZA", TUE, 10, 0);
    await putBar(db, "ZZB", TUE, 10, 0);
    await run(db);
    const f = await flagsOf(db);
    expect(f.map((x) => `${x.code}:${x.check_id}`)).toEqual([
      `null:${RULES.u1_gate.id}`, // 1 of 2 is 50%
      `ZZB:${RULES.zero_volume_u1.id}`,
    ]);
  });

  it("a bar on a non-trading day is flagged when the caller says so", async () => {
    const db = await pipelineDb({ codes: ["ZZA"] });
    await putBar(db, "ZZA", TUE, 10);
    await run(db, { tradingDay: false });
    expect((await flagsOf(db)).map((x) => x.check_id)).toEqual([RULES.not_trading_day.id]);
  });

  it("duplicate rows, rows without a code and re-fetches of unknown codes", async () => {
    const db = await pipelineDb({ codes: ["ZZA"] });
    await putBar(db, "ZZA", TUE, 10);
    await run(db, {
      rejected: [
        { code: "ZZA", date: TUE, reason: "duplicate_key" },
        { code: "ZZA", date: TUE, reason: "bad_number" },
        { code: null, date: TUE, reason: "bad_code" },
      ],
      refetchDiffs: [
        { code: "QQQ", d: MON, maxDiffPct: 5 },
        { code: "ZZA", d: MON, maxDiffPct: 0.05 },
      ],
    });
    expect((await flagsOf(db)).map((x) => x.check_id)).toEqual([RULES.duplicate_bar.id]);
    expect(await count(db, "data_quality_flag")).toBe(1);
  });

  it("zero stored bars: everything is missing and the gate fails, never filled", async () => {
    const db = await u1Db(["ZZA", "ZZB"]);
    await db.execute(
      `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES
       ('AU', '${TUE}', 'ZZA', 'active', 'U1', 0), ('AU', '${TUE}', 'ZZB', 'active', 'U1', 0)`,
    );
    const r = await run(db);
    expect(r.summary.gate.pass).toBe(false);
    expect(r.summary.counts.missing).toBe(2);
    expect(await entriesAllowed(db, "ZZA", TUE)).toMatchObject({ allowed: false });
  });
});

describe("configuration read", () => {
  it("uses stored values within bounds, defaults otherwise (including unreadable JSON)", async () => {
    const db = await pipelineDb();
    expect(await readQualityConfig(db)).toEqual({
      refetchDiffPct: 0.1,
      suspectMovePct: 40,
      u1GatePct: 95,
    });
    await setConfig(db, { key: "suspect_move", value: 55, userId: null, now: NOW });
    await db.execute(
      "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('u1_quality_gate', 'global', 'not json', 'x')",
    );
    await db.execute(
      "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('refetch_diff_flag', 'global', '99', 'x')",
    );
    expect(await readQualityConfig(db)).toEqual({
      refetchDiffPct: 0.1,
      suspectMovePct: 55,
      u1GatePct: 95,
    });
  });
});

describe("write surface", () => {
  it("the engine writes only data_quality_flag and quality_score, never DELETE or REPLACE", () => {
    const src = readFileSync(path.join(ROOT, "src/lib/data/quality/engine.mjs"), "utf8");
    const writes = [...src.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(new Set(writes)).toEqual(
      new Set([
        "INSERT INTO data_quality_flag",
        "UPDATE data_quality_flag",
        "INSERT INTO quality_score",
      ]),
    );
    expect(src).not.toMatch(/\bDELETE\b|\bDROP\b|\bREPLACE\b|DO UPDATE/i);
    expect(src).toContain("ON CONFLICT DO NOTHING");
  });
});

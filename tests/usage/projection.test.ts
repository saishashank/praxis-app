// @vitest-environment node
// M20 S1 (F: quota). MKT-113, MKT-105, D-1099, D-1190: the projection of a market that is not on yet. Every answer
// below is computed by hand in the comment above it; the edges (Turso exactly 20 % of the free plan, every other
// metric exactly 90 %) are asserted on both sides, because a switch-on rests on them.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fits,
  fixedOf,
  limitsOf,
  loadProjectionReport,
  projectMarket,
  readAuMeasured,
  sessionsInNextMonth,
  type Figures,
} from "@/lib/usage/projection";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const fig = (o: Partial<Record<keyof Figures, number>> = {}): Figures => ({
  turso_reads: 0,
  turso_writes: 0,
  actions_minutes: 0,
  worker_requests: 0,
  host_requests: 0,
  ...o,
});
const LIMITS = limitsOf({ tursoCeilingPct: 20, actionsSoftCeiling: 3000 });

describe("projectMarket (D-1099)", () => {
  // scale = cap / auCodes = 1000 / 2000 = 1/2; sessions 21 / 20 = 1.05; together 0.525
  // reads   30,000,000 x 0.525 = 15,750,000   + fixed 21 x 500            = 10,500   -> 15,760,500
  // writes     600,000 x 0.525 =    315,000   + fixed 21 x 50             =  1,050   ->    316,050
  // actions        600 x 0.525 =        315   + fixed 0                              ->        315
  // worker      90,000 x 0.525 =     47,250   + fixed 21 sessions x 11 slots x 6     =  1,386 -> 48,636
  // host        20,000 x 0.525 =     10,500   + fixed 21 x 11 x 1                   =    231 -> 10,731
  it("scales the AU figures by cap/auCodes and by the session ratio, then adds the fixed part", () => {
    expect(fixedOf(21, 11)).toEqual(
      fig({ turso_reads: 10_500, turso_writes: 1_050, worker_requests: 1_386, host_requests: 231 }),
    );
    const p = projectMarket({
      auMeasured: fig({
        turso_reads: 30_000_000,
        turso_writes: 600_000,
        actions_minutes: 600,
        worker_requests: 90_000,
        host_requests: 20_000,
      }),
      auCodes: 2000,
      cap: 1000,
      sessionsMarket: 21,
      sessionsAu: 20,
      fixed: fixedOf(21, 11),
    });
    expect(p).toEqual({
      turso_reads: 15_760_500,
      turso_writes: 316_050,
      actions_minutes: 315,
      worker_requests: 48_636,
      host_requests: 10_731,
    });
  });

  it("rounds the scaled part UP, never down: 1 x 1 / 3 = 1, 3 x 1 / 3 = 1 exactly, 4 x 1 / 3 = 2", () => {
    const base = { auCodes: 3, cap: 1, sessionsMarket: 1, sessionsAu: 1, fixed: fig() };
    expect(projectMarket({ ...base, auMeasured: fig({ turso_reads: 1 }) }).turso_reads).toBe(1);
    expect(projectMarket({ ...base, auMeasured: fig({ turso_reads: 3 }) }).turso_reads).toBe(1);
    expect(projectMarket({ ...base, auMeasured: fig({ turso_reads: 4 }) }).turso_reads).toBe(2);
  });

  it("is exact beyond double precision (BigInt): 9,007,199,254 x 999 x 31 / (1,999 x 30) rounded up", () => {
    const got = projectMarket({
      auMeasured: fig({ turso_reads: 9_007_199_254 }),
      auCodes: 1999,
      cap: 999,
      sessionsMarket: 31,
      sessionsAu: 30,
      fixed: fig(),
    }).turso_reads;
    const num = 9_007_199_254n * 999n * 31n;
    const den = 1999n * 30n;
    expect(got).toBe(Number((num + den - 1n) / den));
  });

  it("refuses a zero divisor and a negative or fractional input", () => {
    const ok = {
      auMeasured: fig(),
      auCodes: 1,
      cap: 1,
      sessionsMarket: 1,
      sessionsAu: 1,
      fixed: fig(),
    };
    expect(() => projectMarket({ ...ok, auCodes: 0 })).toThrow(RangeError);
    expect(() => projectMarket({ ...ok, sessionsAu: 0 })).toThrow(RangeError);
    expect(() => projectMarket({ ...ok, cap: -1 })).toThrow(RangeError);
    expect(() => projectMarket({ ...ok, cap: 1.5 })).toThrow(RangeError);
  });
});

describe("fits: the 20 % Turso line and the 90 % line of every other metric (MKT-105)", () => {
  // Free plan: 500,000,000 reads x 20 % = 100,000,000; 10,000,000 writes x 20 % = 2,000,000;
  // actions 3,000 x 90 % = 2,700; Worker 3,000,000 x 90 % = 2,700,000; host 1,000,000 x 90 % = 900,000.
  it("states the limits", () => {
    const r = fits({ au: fig(), markets: [], limits: LIMITS });
    expect(r.verdicts.map((v) => [v.metric, v.limit])).toEqual([
      ["turso_reads", 100_000_000],
      ["turso_writes", 2_000_000],
      ["actions_minutes", 2_700],
      ["worker_requests", 2_700_000],
      ["host_requests", 900_000],
    ]);
  });

  it.each([
    ["turso_reads", 100_000_000],
    ["turso_writes", 2_000_000],
    ["actions_minutes", 2_700],
    ["worker_requests", 2_700_000],
    ["host_requests", 900_000],
  ] as const)(
    "%s: AU + market exactly on the line fits, one unit more does not",
    (metric, line) => {
      const half = Math.floor(line / 2);
      const on = fits({
        au: fig({ [metric]: half }),
        markets: [fig({ [metric]: line - half })],
        limits: LIMITS,
      });
      expect(on.fits).toBe(true);
      expect(on.verdicts.find((v) => v.metric === metric)!.ok).toBe(true);
      const over = fits({
        au: fig({ [metric]: half }),
        markets: [fig({ [metric]: line - half + 1 })],
        limits: LIMITS,
      });
      expect(over.fits).toBe(false);
      expect(over.verdicts.filter((v) => !v.ok).map((v) => v.metric)).toEqual([metric]);
    },
  );

  it("counts every projected market: AU 60 M + IN 25 M + US 15 M reads = 100 M fits; one more row does not", () => {
    const au = fig({ turso_reads: 60_000_000 });
    const inM = fig({ turso_reads: 25_000_000 });
    expect(
      fits({ au, markets: [inM, fig({ turso_reads: 15_000_000 })], limits: LIMITS }).fits,
    ).toBe(true);
    expect(
      fits({ au, markets: [inM, fig({ turso_reads: 15_000_001 })], limits: LIMITS }).fits,
    ).toBe(false);
  });

  it("follows turso_free_ceiling_pct: at 15 % the read line is 75,000,000", () => {
    const lim = limitsOf({ tursoCeilingPct: 15, actionsSoftCeiling: 3000 });
    expect(fits({ au: fig({ turso_reads: 75_000_000 }), markets: [], limits: lim }).fits).toBe(
      true,
    );
    expect(fits({ au: fig({ turso_reads: 75_000_001 }), markets: [], limits: lim }).fits).toBe(
      false,
    );
  });
});

describe("sessionsInNextMonth (calendar rules, not rows)", () => {
  // December 2026 has 23 weekdays (Tue 1 ... Thu 31). AU: Fri 25 Christmas and Mon 28 (Boxing Day moved) are holidays;
  // the early closes of 24 and 31 are still sessions: 21. US: Fri 25 is the only closed weekday: 22.
  it("counts December 2026 from a day in November", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    expect(sessionsInNextMonth("AU", now)).toBe(21);
    expect(sessionsInNextMonth("US", now)).toBe(22);
  });
  it("wraps the year: from December the next month is January of the next year", () => {
    expect(sessionsInNextMonth("US", new Date("2026-12-15T00:00:00Z"))).toBeGreaterThan(17);
  });
  it("is 0 for a market without rules", () => {
    expect(sessionsInNextMonth("ZZ", new Date("2026-11-20T00:00:00Z"))).toBe(0);
  });
});

describe("readAuMeasured and loadProjectionReport", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
  });
  const NOW = new Date("2026-11-20T00:00:00.000Z");
  const run = (
    job: string,
    market: string | null,
    key: string,
    at: string,
    r: number,
    w: number,
    ms: number,
  ) =>
    db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, status, rows_read, rows_written, duration_ms)
            VALUES (?, ?, ?, ?, 'success', ?, ?, ?)`,
      args: [job, market, key, at, r, w, ms],
    });

  it("reads the trailing 30 days of AU only, the Actions minutes (rounded up) and the AU universe size", async () => {
    await allowMarket(db, "IN"); // run_record carries the market: the guard needs the market enabled
    await run("arena-close", "AU", "k1", "2026-11-10T08:00:00.000Z", 1000, 100, 0);
    await run("data-batch1", "AU", "k2", "2026-11-11T08:00:00.000Z", 2000, 200, 0);
    await run("data-batch1", "IN", "k3", "2026-11-11T09:00:00.000Z", 9999, 999, 0); // another market
    await run("data-batch1", "AU", "k4", "2026-10-01T08:00:00.000Z", 7777, 777, 0); // before the window
    await run("actions-nightly", null, "k5", "2026-11-12T08:00:00.000Z", 0, 0, 61_000); // 61 s -> 2 min
    await run("worker-clock", null, "k6", "2026-11-12T09:00:00.000Z", 0, 0, 0);
    for (const code of ["AAA", "BBB", "CCC"]) {
      await db.execute({
        sql: "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('AU', '2026-11-19', ?, 'ok', 'U1')",
        args: [code],
      });
    }
    const m = await readAuMeasured(db, NOW);
    expect(m.figures.turso_reads).toBe(3000);
    expect(m.figures.turso_writes).toBe(300);
    expect(m.figures.actions_minutes).toBe(2);
    expect(m.auCodes).toBe(3);
    // the Worker clock ticked in the window (a worker-clock record exists): 30 days x 1440 minutes
    expect(m.figures.worker_requests).toBe(43_200);
    // signed calls: the records that are not email-, actions-, heartbeat-, watchdog or worker-clock jobs: k1, k2, k3
    expect(m.figures.host_requests).toBe(3);
  });

  it("projects IN and US from the profile caps, off and enabled, and counts the enabled ones in each verdict", async () => {
    const measured = {
      figures: fig({ turso_reads: 21_000_000, turso_writes: 420_000 }),
      auCodes: 2000,
      from: "2026-10-21T00:00:00.000Z",
      to: NOW.toISOString(),
    };
    // US: cap 2500 (profile universe_max), sessions December 22, AU December 21:
    // reads 21,000,000 x 2500 x 22 / (2000 x 21) = 1,155,000,000,000 / 42,000 = 27,500,000; fixed 22 x 500 = 11,000
    const rep = await loadProjectionReport(db, NOW, { measured });
    const us = rep.markets.find((x) => x.market === "US")!;
    expect(us.enabled).toBe(false);
    expect(us.cap).toBe(2500);
    expect(us.sessions).toBe(22);
    expect(us.projected!.turso_reads).toBe(27_511_000);
    // writes 420,000 x 2500 x 22 / 42,000 = 550,000; fixed 22 x 50 = 1,100
    expect(us.projected!.turso_writes).toBe(551_100);
    expect(rep.markets.map((x) => x.market)).toEqual(["IN", "US"]);
    // AU + US: reads 21,000,000 + 27,511,000 = 48,511,000 (<= 100 M); writes 420,000 + 551,100 = 971,100 (<= 2 M)
    const v = rep.fitsWith.US!;
    expect(v.fits).toBe(true);
    expect(v.verdicts.find((x) => x.metric === "turso_reads")!.total).toBe(48_511_000);
    expect(v.verdicts.find((x) => x.metric === "turso_writes")!.total).toBe(971_100);
    // with IN enabled, US is judged with IN's projection added
    await allowMarket(db, "IN");
    const rep2 = await loadProjectionReport(db, NOW, { measured });
    const inRow = rep2.markets.find((x) => x.market === "IN")!;
    expect(inRow.enabled).toBe(true);
    const total = rep2.fitsWith.US!.verdicts.find((x) => x.metric === "turso_reads")!.total;
    expect(total).toBe(21_000_000 + inRow.projected!.turso_reads + us.projected!.turso_reads);
  });

  it("gives no projection, and says why, when AU has no universe snapshot yet", async () => {
    const rep = await loadProjectionReport(db, NOW, {
      measured: { figures: fig(), auCodes: 0, from: "x", to: "y" },
    });
    expect(rep.markets.every((m) => m.projected === null && m.note !== null)).toBe(true);
    expect(rep.fitsWith.US).toBeNull();
  });
});

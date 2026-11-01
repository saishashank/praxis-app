// @vitest-environment node
// M17 WP5 (AT-61 a b c; D-398, D-442): the intraday scan run on a migrated test DB with ZZ fixtures and
// an injected fetch. A refused source writes nothing; the pause cool-down skips; the quote_run claim
// exists before the first request; the session date is the Melbourne market date; the early close
// ends the day; candidates are shadow rows; a repeat of the slot is already_done. No network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import { intradayScanHealth, runIntradayScan, type ScanRunDeps } from "@/lib/intraday/run";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

// Wed 2026-11-04 (AEDT, UTC+11). 10:45 Melbourne is 2026-11-03T23:45Z: the UTC date is yesterday.
const SESSION = "2026-11-04";
const NOW = new Date("2026-11-03T23:45:00.000Z");
let quoteS = (NOW.getTime() - 20 * 60_000) / 1000; // 20 minutes behind: fresh by D-441
const MIN = 60_000;

let db: Client;
let calls: string[];

type Spec = { price: number; prev: number; volume: number | null; status?: number };
let specs: Map<string, Spec>;
let onFetch: (() => Promise<void>) | null;

const fetchStub: ScanRunDeps["fetch"] = async (url) => {
  calls.push(url);
  if (onFetch) {
    const hook = onFetch;
    onFetch = null;
    await hook();
  }
  const code = /chart\/([A-Z0-9]+)\.AX/.exec(url)![1];
  const s = specs.get(code);
  if (!s) return { ok: false, status: 404, json: async () => ({}) };
  if (s.status) return { ok: false, status: s.status, json: async () => ({}) };
  return {
    ok: true,
    status: 200,
    json: async () =>
      syntheticChart({
        price: s.price,
        prevClose: s.prev,
        volume: s.volume,
        timeS: quoteS,
        symbol: `${code}.AX`,
      }),
  };
};

const deps = (now: Date = NOW): ScanRunDeps => ({
  db,
  now: () => now,
  fetch: fetchStub,
  sleep: async () => {},
});

async function accept(): Promise<void> {
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'");
  await db.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
  );
}

async function seedBars(code: string): Promise<void> {
  const base = new Date("2026-11-03T00:00:00Z").getTime();
  for (let i = 0; i < 70; i++) {
    const d = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
    const c = 10 + (i % 2) * 0.1;
    await db.execute({
      sql:
        "INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at) " +
        "VALUES ('AU', ?, ?, ?, ?, ?, ?, 100000, 'zz', 't', 't')",
      args: [code, d, c, c + 0.05, c - 0.05, c],
    });
  }
}

async function seedCatalyst(code: string, materiality: number, n: number): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source) " +
      "VALUES ('AU', ?, ?, '2026-11-03T23:35:00.000Z', 't', 'results', 1, 'ZZ result', 'zz')",
    args: [code, `a${n}`],
  });
  await db.execute({
    sql:
      "INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity, held, watch, " +
      "candidate, tracked, assessed_at) VALUES ('zz', ?, 'AU', ?, ?, 'v1', 1, 0, 0, 0, 0, 't')",
    args: [`a${n}`, code, materiality],
  });
}

const scalar = async (sql: string): Promise<number> => Number((await db.execute(sql)).rows[0].n);

beforeEach(async () => {
  db = await freshDb("main");
  calls = [];
  onFetch = null;
  specs = new Map([
    ["ZZ01", { price: 10.5, prev: 10, volume: 50_000 }], // +5 % with heavy volume
    ["ZZ02", { price: 10.01, prev: 10, volume: 50_000 }], // catalyst, but no move
  ]);
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  for (const [code, tier] of [
    ["ZZ01", "U1"],
    ["ZZ02", "U2"],
    ["ZZ03", "U3"],
    ["ZZ04", "U1"],
  ]) {
    await db.execute({
      sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, adv, halted) VALUES ('AU', '2026-11-03', ?, 'active', ?, 5000000, 0)",
      args: [code, tier],
    });
  }
  await db.execute(
    "INSERT INTO index_change (market, code, index_name, kind, effective_d, source, loaded_at) VALUES ('AU', 'ZZ99', 'ZZIDX', 'add', '2020-01-01', 'zz', 't')",
  );
  await seedBars("ZZ01");
  await seedBars("ZZ02");
  await seedCatalyst("ZZ01", 3, 1);
  await seedCatalyst("ZZ02", 2, 2);
  await seedCatalyst("ZZ03", 3, 3); // tier 3: outside the scan universe, never fetched
});

describe("refusal comes first (D-398)", () => {
  it("a pending source: skipped, no request, nothing written", async () => {
    await db.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
    );
    expect(await runIntradayScan(deps())).toEqual({
      status: "skipped",
      reason: "source_not_accepted",
    });
    expect(calls).toEqual([]);
    expect(await scalar("SELECT COUNT(*) AS n FROM quote_run")).toBe(0);
    expect(await scalar("SELECT COUNT(*) AS n FROM intraday_candidate")).toBe(0);
    expect(await intradayScanHealth(db, NOW)).toEqual(["Intraday scan off: source not accepted"]);
  });

  it("dispatch switch off: skipped", async () => {
    await db.execute(
      "UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'",
    );
    expect(await runIntradayScan(deps())).toEqual({ status: "skipped", reason: "dispatch_off" });
    expect(calls).toEqual([]);
  });
});

describe("cool-down after a paused run (D-442)", () => {
  const pauseRow = (minutesAgo: number) =>
    db.execute({
      sql: "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, paused) VALUES ('AU', ?, '10:00+paused', 'poll', ?, 0, 'rate_limited')",
      args: [SESSION, new Date(NOW.getTime() - minutesAgo * MIN).toISOString()],
    });

  it("inside quote_pause_cooldown_min: skipped; after it: runs", async () => {
    await accept();
    await pauseRow(10);
    expect(await runIntradayScan(deps())).toEqual({ status: "skipped", reason: "cooldown" });
    expect(calls).toEqual([]);
  });

  it("a pause older than the cool-down no longer blocks", async () => {
    await accept();
    await pauseRow(31);
    const r = await runIntradayScan(deps());
    expect(r.status).toBe("ok");
  });

  it("a rate-limited fetch records its own pause row and the next run waits", async () => {
    await accept();
    specs.set("ZZ01", { price: 1, prev: 1, volume: 1, status: 429 });
    const r = await runIntradayScan(deps());
    expect(r).toMatchObject({ status: "ok", paused: "rate_limited", written: 0 });
    expect(await scalar("SELECT COUNT(*) AS n FROM quote_run WHERE paused = 'rate_limited'")).toBe(
      1,
    );
    const next = await runIntradayScan(deps(new Date(NOW.getTime() + 5 * MIN)));
    expect(next).toEqual({ status: "skipped", reason: "cooldown" });
    expect(await intradayScanHealth(db, NOW)).toContain("Prices paused");
  });
});

describe("claim first, Melbourne date", () => {
  it("the quote_run row exists, with requests = allowed, before the first request", async () => {
    await accept();
    let seen: Record<string, unknown> | null = null;
    onFetch = async () => {
      const r = await db.execute("SELECT * FROM quote_run");
      seen = r.rows.length === 1 ? { ...r.rows[0] } : null;
    };
    const r = await runIntradayScan(deps());
    expect(r.status).toBe("ok");
    expect(seen).toMatchObject({
      market: "AU",
      session_d: SESSION,
      slot_minute: "10:30",
      purpose: "scan",
      requests: 40,
    });
  });

  it("10:15 Melbourne: the session is the Melbourne date, not the UTC date", async () => {
    await accept();
    await db.execute(
      "INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason) VALUES ('intraday_scan_start', 'global', '\"10:00\"', NULL, NULL, 't', 'test')",
    );
    const at = new Date("2026-11-03T23:15:00.000Z");
    expect(at.toISOString().slice(0, 10)).toBe("2026-11-03"); // UTC date is yesterday
    const r = await runIntradayScan(deps(at));
    expect(r).toMatchObject({ status: "ok", sessionD: SESSION, slot: "10:00" });
    expect(
      await scalar(
        `SELECT COUNT(*) AS n FROM quote_run WHERE session_d = '${SESSION}' AND slot_minute NOT LIKE '%+%'`,
      ),
    ).toBe(1);
  });

  it("a repeat of the same slot is already_done and makes no request", async () => {
    await accept();
    await runIntradayScan(deps());
    const n = calls.length;
    expect(await runIntradayScan(deps(new Date(NOW.getTime() + 2 * MIN)))).toEqual({
      status: "skipped",
      reason: "already_done",
    });
    expect(calls).toHaveLength(n);
  });
});

describe("early close and window", () => {
  // The migration seeds the calendar: 2026-12-24 is an early close (14:10), 2026-12-25 a holiday.
  it("after an early close nothing is claimed or requested", async () => {
    await accept();
    const late = new Date("2026-12-24T03:30:00.000Z"); // 14:30 Melbourne, after the 14:10 close
    expect(await runIntradayScan(deps(late))).toEqual({ status: "skipped", reason: "after_close" });
    expect(await scalar("SELECT COUNT(*) AS n FROM quote_run")).toBe(0);
    expect(calls).toEqual([]);
    // before the early close it still runs
    const ok = await runIntradayScan(deps(new Date("2026-12-24T02:45:00.000Z"))); // 13:45
    expect(ok).toMatchObject({ status: "ok", sessionD: "2026-12-24", slot: "13:30" });
  });

  it("a holiday is a non-trading day", async () => {
    await accept();
    const xmas = new Date("2026-12-25T00:00:00.000Z"); // 11:00 Melbourne
    expect(await runIntradayScan(deps(xmas))).toEqual({
      status: "skipped",
      reason: "non_trading_day",
    });
  });

  it("before the window opens: skipped", async () => {
    await accept();
    expect(await runIntradayScan(deps(new Date("2026-11-03T23:15:00.000Z")))).toEqual({
      status: "skipped",
      reason: "before_window",
    });
  });
});

describe("shadow candidates", () => {
  it("writes the candidate with a catalyst, move and volume; only universe codes with a catalyst are requested", async () => {
    await accept();
    const r = await runIntradayScan(deps());
    expect(r).toMatchObject({ status: "ok", codes: 2, quotes: 2, written: 1 });
    expect(calls.map((u) => /chart\/(\w+)\./.exec(u)![1]).sort()).toEqual(["ZZ01", "ZZ02"]);
    const rows = (await db.execute("SELECT * FROM intraday_candidate")).rows;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      market: "AU",
      session_d: SESSION,
      code: "ZZ01",
      found_slot: "10:30",
      materiality: 3,
      polarity: "positive",
      move_ppm: 50_000,
    });
    expect(Number(row.rel_volume_ppm)).toBeGreaterThan(2_000_000);
    expect(Number(row.indicative_stop_micro)).toBeGreaterThan(0);
    expect(Number(row.indicative_limit_micro)).toBeGreaterThan(Number(row.indicative_stop_micro));
    const gates = JSON.parse(String(row.gates_json));
    expect(gates).toMatchObject({ stream_state: "shadow", failed: null, delayed: true });
    expect(row.email_key).toBeNull();
    expect(row.decision_outcome).toBeNull();
  });

  it("a candidate failing a gate is recorded with the gate", async () => {
    await accept();
    await db.execute(
      "INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro) VALUES ('c1', '2026-11-03', 'ZZ01', 10, 10000000, 100000000)",
    );
    await runIntradayScan(deps());
    const g = JSON.parse(
      String((await db.execute("SELECT gates_json FROM intraday_candidate")).rows[0].gates_json),
    );
    expect(g.failed).toBe("already_held");
  });

  it("unknown cumulative volume fails the volume condition: no row (D-382)", async () => {
    await accept();
    specs.set("ZZ01", { price: 10.5, prev: 10, volume: null });
    const r = await runIntradayScan(deps());
    expect(r).toMatchObject({ status: "ok", written: 0, volumeUnavailable: 1 });
    expect(await scalar("SELECT COUNT(*) AS n FROM intraday_candidate")).toBe(0);
  });

  it("touches no order, book or ledger table", async () => {
    await accept();
    await runIntradayScan(deps());
    for (const t of [
      "arena_order",
      "fill",
      "trade",
      "cash_ledger",
      "nav_daily",
      "lesson",
      "pick",
    ]) {
      expect(await scalar(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    }
  });

  it("budget: narrows to tier 1 at 80 %, stops at 95 %", async () => {
    await accept();
    const claim = (slot: string, n: number) =>
      db.execute({
        sql: "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) VALUES ('AU', ?, ?, 'poll', 't', ?)",
        args: [SESSION, slot, n],
      });
    await claim("10:05", 1600); // 80 % of 2000
    const r = await runIntradayScan(deps());
    expect(r).toMatchObject({ status: "ok", narrowed: true, codes: 1 });
    expect(calls).toHaveLength(1); // ZZ01 (tier 1) only
    expect(await intradayScanHealth(db, NOW)).toContain("Intraday scan narrowed");
    await claim("10:10", 300); // 1900 = 95 %
    expect(await runIntradayScan(deps(new Date(NOW.getTime() + 30 * MIN)))).toEqual({
      status: "skipped",
      reason: "budget_stop",
    });
    expect(await intradayScanHealth(db, NOW)).toContain(
      "Intraday scan stopped for the day (request budget)",
    );
  });

  it("a later slot refreshes the follow-up columns of an existing row, whatever the new verdict (S5)", async () => {
    await accept();
    await runIntradayScan(deps());
    const first = (await db.execute("SELECT * FROM intraday_candidate WHERE code = 'ZZ01'"))
      .rows[0];
    const later = new Date(NOW.getTime() + 30 * MIN);
    quoteS = (later.getTime() - 20 * 60_000) / 1000;
    specs.set("ZZ01", { price: 10.1, prev: 10, volume: 50_000 }); // +1 %: no longer a candidate
    expect(await runIntradayScan(deps(later))).toMatchObject({ status: "ok", written: 0 });
    const row = (await db.execute("SELECT * FROM intraday_candidate WHERE code = 'ZZ01'")).rows[0];
    expect(row.move_ppm).toBe(first.move_ppm); // the finding itself is never re-decided
    expect(row.latest_move_ppm).toBe(10_000); // +1 %
    expect(String(row.latest_quote_at) > String(first.latest_quote_at)).toBe(true);
    quoteS = (NOW.getTime() - 20 * 60_000) / 1000;
  });
});

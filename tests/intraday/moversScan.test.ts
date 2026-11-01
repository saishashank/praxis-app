// @vitest-environment node
// The movers gap additions in the intraday scan (CR-MOV-A1, A3, A8; D-744, D-750): an armed code (a halt
// resume, a volume-creep name) is quoted without a catalyst of the day and becomes a shadow candidate
// from its arm time; a real catalyst wins over an arm; sector_adj_ppm is filled from the last end-of-day
// composite when the industry has enough members and stays null (the market fallback) otherwise.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import { runIntradayScan, type ScanRunDeps } from "@/lib/intraday/run";
import { sectorAdjustedMove } from "@/lib/intraday/scan";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

// Wed 2026-11-04 (AEDT, UTC+11); 10:45 Melbourne is 2026-11-03T23:45Z.
const NOW = new Date("2026-11-03T23:45:00.000Z");
const quoteS = (NOW.getTime() - 20 * 60_000) / 1000;

let db: Client;
let calls: string[];

const fetchStub: ScanRunDeps["fetch"] = async (url) => {
  calls.push(url);
  const code = /chart\/([A-Z0-9]+)\.AX/.exec(url)![1];
  return {
    ok: true,
    status: 200,
    json: async () =>
      syntheticChart({
        price: 10.5,
        prevClose: 10,
        volume: 50_000,
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

const rows = async (sql: string) => (await db.execute(sql)).rows.map((r) => ({ ...r }));

beforeEach(async () => {
  db = await freshDb("main");
  calls = [];
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'");
  await db.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
  );
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  for (const c of ["ZZ01", "ZZ02"]) {
    await db.execute({
      sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, adv, halted) VALUES ('AU', '2026-11-03', ?, 'active', 'U1', 5000000, 0)",
      args: [c],
    });
    await seedBars(c);
  }
  await db.execute(
    "INSERT INTO index_change (market, code, index_name, kind, effective_d, source, loaded_at) VALUES ('AU', 'ZZ99', 'ZZIDX', 'add', '2020-01-01', 'zz', 't')",
  );
});

const seedHalt = (code: string, since: string) =>
  db.execute({
    sql:
      "INSERT INTO halt_watch (market, code, since_d, seq, status, reason_class, expected_sign, known_at) " +
      "VALUES ('AU', ?, ?, 1, 'open', 'capital_raise', -1, 't')",
    args: [code, since],
  });

describe("armed codes are quoted without a catalyst (A1, A3)", () => {
  it("an open halt watch from the day before arms the code: it is fetched and written as a shadow candidate", async () => {
    await seedHalt("ZZ01", "2026-11-03");
    const r = await runIntradayScan(deps());
    expect(r).toMatchObject({ status: "ok", codes: 1, written: 1 });
    expect(calls).toHaveLength(1);
    const c = await rows(
      "SELECT code, item_source, item_category, materiality, polarity, sector_adj_ppm FROM intraday_candidate",
    );
    expect(c).toEqual([
      {
        code: "ZZ01",
        item_source: "arm",
        item_category: "halt_resume",
        materiality: 2,
        polarity: "negative",
        sector_adj_ppm: null,
      },
    ]);
    expect(await rows("SELECT code, reason FROM intraday_arm")).toEqual([
      { code: "ZZ01", reason: "halt_resume" },
    ]);
  });

  it("a real catalyst of the day wins over the arm", async () => {
    await seedHalt("ZZ01", "2026-11-03");
    await db.execute(
      "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, source) " +
        "VALUES ('AU', 'ZZ01', 'a1', '2026-11-03T23:35:00.000Z', 't', 'results', 1, 'ZZ result', 'zz')",
    );
    await db.execute(
      "INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity, held, watch, candidate, tracked, assessed_at) " +
        "VALUES ('zz', 'a1', 'AU', 'ZZ01', 3, 'v1', 1, 0, 0, 0, 0, 't')",
    );
    await runIntradayScan(deps());
    expect(await rows("SELECT item_source, materiality FROM intraday_candidate")).toEqual([
      { item_source: "zz", materiality: 3 },
    ]);
  });

  it("nothing is armed and nothing quoted when intraday_arm_codes_max is 0 (the keys are the switch)", async () => {
    await seedHalt("ZZ01", "2026-11-03");
    await db.execute(
      "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('intraday_arm_codes_max', 'global', '0', 't')",
    );
    const r = await runIntradayScan(deps());
    expect(r).toMatchObject({ status: "ok", codes: 0, written: 0 });
    expect(calls).toEqual([]);
  });

  it("a volume-creep arm written the night before is quoted in the first slot after its arm time", async () => {
    await db.execute(
      "INSERT INTO intraday_arm (market, session_d, code, reason, expected_sign, armed_from, ref, created_at) " +
        "VALUES ('AU', '2026-11-04', 'ZZ02', 'volume_creep', 0, '10:00', 'A-D2-07', 't')",
    );
    await runIntradayScan(deps());
    expect(await rows("SELECT code, item_category, polarity FROM intraday_candidate")).toEqual([
      { code: "ZZ02", item_category: "volume_creep", polarity: "neutral" },
    ]);
  });
});

describe("sector-adjusted move (A8)", () => {
  it("sectorAdjustedMove: taken off only when the sector points the same way; null below the member floor", () => {
    expect(sectorAdjustedMove(50_000, { retPpm: 20_000, members: 6 }, 5)).toBe(30_000);
    expect(sectorAdjustedMove(50_000, { retPpm: -20_000, members: 6 }, 5)).toBe(50_000);
    expect(sectorAdjustedMove(-50_000, { retPpm: -20_000, members: 6 }, 5)).toBe(-30_000);
    expect(sectorAdjustedMove(50_000, { retPpm: 20_000, members: 4 }, 5)).toBeNull();
    expect(sectorAdjustedMove(50_000, undefined, 5)).toBeNull();
  });

  const seedIndustry = async (members: number, retPpm = 10_000) => {
    await db.execute(
      "INSERT INTO instrument_class (market, code, industry, source, as_of, loaded_at) VALUES ('AU', 'ZZ01', 'ZZIND', 'zz', '2026-10-01', 't')",
    );
    await db.execute({
      sql: "INSERT INTO sector_composite_daily (market, d, industry, ret_ppm, n_members, map_as_of, created_at) VALUES ('AU', '2026-11-03', 'ZZIND', ?, ?, '2026-10-01', 't')",
      args: [retPpm, members],
    });
    await seedHalt("ZZ01", "2026-11-03");
  };

  it("fills sector_adj_ppm from the last completed composite (move 5 % less 1 %)", async () => {
    await seedIndustry(6, 10_000);
    await runIntradayScan(deps());
    expect(await rows("SELECT move_ppm, sector_adj_ppm FROM intraday_candidate")).toEqual([
      { move_ppm: 50_000, sector_adj_ppm: 40_000 },
    ]);
  });

  it("a sector wave that explains most of the move takes the candidate out (5 % less 2 % is under the 4 % line)", async () => {
    await seedIndustry(6, 20_000);
    const r = await runIntradayScan(deps());
    expect(r).toMatchObject({ status: "ok", written: 0 });
    expect(await rows("SELECT * FROM intraday_candidate")).toEqual([]);
  });

  it("an industry below the member floor keeps the market fallback (null)", async () => {
    await seedIndustry(4);
    await runIntradayScan(deps());
    expect(await rows("SELECT sector_adj_ppm FROM intraday_candidate")).toEqual([
      { sector_adj_ppm: null },
    ]);
  });
});

// @vitest-environment node
// TST-139 (D-970; AT-85 "the market matrix runs ... profile fixtures", AU in M18, IN/US in M19/M20): the harness
// reads one profile fixture per built market, the AU fixture equals today's constants, and the production shape
// (no market without a `market` row) is checkable. Pure, plus one migrated database.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { AU_TIME_ZONE } from "@/lib/agents/decisionView";
import { CONFIG_KEYS, MODE_MARKETS } from "@/lib/config/keys";
import { CALENDAR_MARKETS } from "@/lib/data/calendar";
import { DEFAULT_HOURS } from "@/lib/sentinel/archive";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  builtMarketFixtures,
  describeEachMarket,
  marketsWithoutRow,
  type MarketProfileFixture,
} from "./profiles";

afterEach(cleanupTempDbs);

describe("the fixtures", () => {
  it("M18 has exactly one built market: AU", () => {
    expect(builtMarketFixtures().map((m) => m.code)).toEqual(["AU"]);
  });

  it("a new market is a new file: the harness picks it up with no code change (planted)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "praxis-market-profiles-"));
    try {
      const au = builtMarketFixtures()[0]!;
      writeFileSync(path.join(dir, "AU.json"), JSON.stringify(au));
      writeFileSync(
        path.join(dir, "ZZ.json"),
        JSON.stringify({ ...au, code: "ZZ", name: "Planted" }),
      );
      writeFileSync(path.join(dir, "notes.txt"), "ignored");
      expect(builtMarketFixtures(dir).map((m) => m.code)).toEqual(["AU", "ZZ"]);
      writeFileSync(path.join(dir, "QQ.json"), JSON.stringify({ ...au, code: "XX" }));
      expect(() => builtMarketFixtures(dir)).toThrow(/must hold its own code/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the AU fixture equals today's constants", () => {
  const au = builtMarketFixtures().find((m) => m.code === "AU")!;

  it("the market row a fresh database seeds", async () => {
    const db = await freshDb("main");
    const r = (await db.execute("SELECT * FROM market WHERE code = 'AU'")).rows[0]!;
    expect({
      tz: String(r.tz),
      openTime: String(r.open_time),
      closeTime: String(r.close_time),
      cutoffTime: String(r.cutoff_time),
      currency: String(r.currency),
      seededMode: String(r.mode),
    }).toEqual({
      tz: au.tz,
      openTime: au.openTime,
      closeTime: au.closeTime,
      cutoffTime: au.cutoffTime,
      currency: au.currency,
      seededMode: au.seededMode,
    });
  });

  it("the code constants: decision zone, sentinel hours, cut-off default, market lists", () => {
    expect(AU_TIME_ZONE).toBe(au.decisionTz);
    expect(DEFAULT_HOURS).toEqual({
      tz: AU_TIME_ZONE,
      open_time: au.openTime,
      close_time: au.closeTime,
    });
    expect(CONFIG_KEYS.decision_cutoff.default).toBe(au.cutoffTime);
    expect([...CALENDAR_MARKETS]).toEqual([au.code]);
    expect([...MODE_MARKETS]).toEqual([au.code]);
    // the cut-off reads the same instant through the helper: 18:10 Melbourne is 07:10 UTC in summer time
    expect(decisionCutoffUtc("2026-12-01", au.cutoffTime)).toBe("2026-12-01T07:10:00.000Z");
  });

  it("production runs AU in full and nothing else", () => {
    expect(au.productionMode).toBe("full");
    expect(builtMarketFixtures().filter((m) => m.productionMode !== "off")).toEqual([au]);
  });
});

describe("marketsWithoutRow: the production shape", () => {
  it("is empty for AU's own records and names a market that has no row", async () => {
    const db = await freshDb("main");
    const run = (market: string | null, key: string) =>
      db.execute({
        sql: "INSERT INTO run_record (job, market, concurrency_key, started_at, status) VALUES ('x', ?, ?, 't', 'success')",
        args: [market, key],
      });
    await run("AU", "k1");
    await run(null, "k2");
    expect(await marketsWithoutRow(db)).toEqual([]);
    await run("ZQ", "k3");
    expect(await marketsWithoutRow(db)).toEqual(["ZQ"]);
  });
});

// The harness itself: this suite runs once per built market and is named with its code.
const seen: string[] = [];
describeEachMarket("a market suite", (m: MarketProfileFixture) => {
  it(`runs for ${m.code} with its own profile`, () => {
    seen.push(m.code);
    expect(m.built).toBe(true);
    expect(m.currency).toMatch(/^[A-Z]{3}$/);
  });
});

describe("describeEachMarket", () => {
  it("ran the suite above once for AU (and would for every other fixture)", () => {
    expect(seen).toEqual(["AU"]);
  });
});

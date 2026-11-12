// M19 C2/C3 (D-1051, D-1053; CXA-001 AU byte-identical): the home-market constants the Actions scripts and the
// data/health modules read are the values the removed literals had, and the Worker's zone and feed tables are the
// ones the AU seed implies. The values below are the pre-refactor constants, written down once here as the proof.
import { describe, expect, it } from "vitest";
import {
  HOME_BENCHMARK,
  HOME_BENCHMARK_YAHOO,
  HOME_CURRENCY,
  HOME_CUTOFF,
  HOME_MARKET,
  HOME_SLOTS,
  HOME_TZ,
  HOME_YAHOO_SUFFIX,
  seedEnabledMarkets,
  seedSlots,
} from "@/lib/market/homeMarket.mjs";
import { FEED_SLOT_TIMES, ZONE_RULES } from "@/lib/market/clockTables.mjs";
import { OWNER_TZ, OPS_SLOT_TIMES } from "@/lib/market/profileCore.mjs";
import { MARKET, TZ } from "@/lib/data/pipeline/rules.mjs";
import { SHORT_MARKET } from "@/lib/data/shortInterest.mjs";
import {
  VENDOR_ACTION_CURRENCY,
  VENDOR_ACTION_MARKET,
} from "@/lib/data/vendorActions/vendorActions.mjs";
import { UNIVERSE_MARKET } from "@/lib/data/universe/import";
import { RUN_NOW_MARKET } from "@/lib/jobs/runNow";
import { DEADLINE_MARKET, DEADLINE_TZ, STEPS } from "@/lib/runs/deadlines";
import { JOBS } from "@/lib/jobs/registry.mjs";
import { MARKET as HEARTBEAT_MARKET, TZ as HEARTBEAT_TZ } from "@/lib/heartbeat/checks";
import { REVIEW_MARKET } from "@/lib/kb/documents";
import { OPS_TZ } from "@/lib/ops/checklist";
import { cleanupTempDbs, freshDb } from "../db/helpers";

describe("the home market constants equal the removed literals (CXA-001)", () => {
  it("market, zone, currency, cut-off, benchmark and Yahoo suffix", () => {
    expect(HOME_MARKET).toBe("AU");
    expect(HOME_TZ).toBe("Australia/Sydney");
    expect(OWNER_TZ).toBe("Australia/Melbourne");
    expect(HOME_CURRENCY).toBe("AUD");
    expect(HOME_CUTOFF).toBe("18:10");
    expect(HOME_BENCHMARK).toBe("AXJO");
    expect(HOME_BENCHMARK_YAHOO).toBe("^AXJO");
    expect(HOME_YAHOO_SUFFIX).toBe(".AX");
  });

  it("every module that held one of them reads the same value now", () => {
    expect([MARKET, TZ]).toEqual(["AU", "Australia/Sydney"]);
    expect(SHORT_MARKET).toBe("AU");
    expect([VENDOR_ACTION_MARKET, VENDOR_ACTION_CURRENCY]).toEqual(["AU", "AUD"]);
    expect([UNIVERSE_MARKET, RUN_NOW_MARKET, REVIEW_MARKET]).toEqual(["AU", "AU", "AU"]);
    expect([DEADLINE_MARKET, DEADLINE_TZ]).toEqual(["AU", "Australia/Melbourne"]);
    expect([HEARTBEAT_MARKET, HEARTBEAT_TZ]).toEqual(["AU", "Australia/Sydney"]);
    expect(OPS_TZ).toBe("Australia/Melbourne");
  });

  it("the slot anchors are today's batch, cut-off, pre-open and quote times", () => {
    expect(HOME_SLOTS).toEqual({
      b1: "17:30",
      b2a: "17:50",
      b2b: "18:10",
      late_2a_after: "18:40",
      cutoff: "18:10",
      cutoff_poll: "18:10",
      preopen_recheck: ["09:54", "09:58"],
      quote_from: "10:00",
      quote_until: "16:00",
      intraday_scan_from: "10:32",
      intraday_scan_until: "15:32",
    });
    expect(seedSlots("IN")).not.toBeNull();
    expect(seedSlots("ZZ")).toBeNull();
    expect(seedEnabledMarkets()).toEqual(["AU"]);
  });

  it("the deadline steps and the registry times are the AU times they were", () => {
    const step = (id: string) => STEPS.find((s) => s.id === id)!;
    expect(step("preopen").start).toBe("09:54");
    expect([step("batch1").start, step("batch1").deadline]).toEqual(["17:30", "18:10"]);
    expect([step("batch2").start, step("batch2").deadline]).toEqual(["18:10", "18:40"]);
    expect(step("batch3").start).toBe("18:40");
    const job = (id: string) => JOBS.find((j) => j.id === id)!;
    expect(job("ingest-batch1")).toMatchObject({ time: "17:30", schedule: "Every day at 17:30" });
    expect(job("arena-close")).toMatchObject({ time: "17:50", schedule: "Trading days at 17:50" });
    expect(job("arena-signals")).toMatchObject({
      time: "18:10",
      schedule: "Trading days at 18:10",
    });
    expect(job("decision-cutoff")).toMatchObject({ time: "18:10" });
    expect(job("pre-open")).toMatchObject({ time: "09:54", schedule: "Trading days at 09:54" });
  });
});

describe("the Worker's zone rule and feed tables (D-1046)", () => {
  it("the zones with a rule are Sydney, Melbourne, Kolkata and New York (M20); the feed (home market only) and ops tables are today's times", () => {
    expect(ZONE_RULES).toEqual({
      "Australia/Sydney": "au-south-dst",
      "Australia/Melbourne": "au-south-dst",
      "Asia/Kolkata": "asia-kolkata",
      "America/New_York": "us-eastern-dst",
    });
    expect(Object.keys(FEED_SLOT_TIMES)).toEqual([HOME_MARKET]); // IN and US have no feed slots (D-1117)
    expect(FEED_SLOT_TIMES[HOME_MARKET]!.poll).toEqual({
      from: "07:00",
      until: "19:30",
      everyMin: 4,
    });
    expect(FEED_SLOT_TIMES[HOME_MARKET]!.fetch).toEqual({
      from: "08:00",
      until: "19:00",
      everyMin: 30,
    });
    expect([
      FEED_SLOT_TIMES[HOME_MARKET]!.universe.at,
      FEED_SLOT_TIMES[HOME_MARKET]!.late_sweep.at,
      FEED_SLOT_TIMES[HOME_MARKET]!.marker_check.at,
    ]).toEqual(["07:30", "19:35", "19:50"]);
    expect(OPS_SLOT_TIMES.maintenance).toEqual({ at: "22:30" });
  });

  it("the AU market row of migration 0034 carries exactly the anchors the registry reads from the seed", async () => {
    const db = await freshDb("main");
    try {
      const r = await db.execute("SELECT slots_json FROM market WHERE code = 'AU'");
      expect(JSON.parse(String(r.rows[0].slots_json))).toEqual(HOME_SLOTS);
    } finally {
      cleanupTempDbs();
    }
  });
});

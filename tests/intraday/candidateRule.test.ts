// @vitest-environment node
// M17 WP5 (AT-61 a b): the candidate rule, indicative levels, gates and today's catalysts. ZZ data only.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { isCandidate, moveThresholdPpm, type CandidateInput } from "@/lib/intraday/candidate";
import { scanGates, type ScanGateInput } from "@/lib/intraday/gates";
import { indicativeLevels } from "@/lib/intraday/levels";
import { scanUniverse } from "@/lib/intraday/universe";
import { todayCatalysts, type Catalyst } from "@/lib/sentinel/todayItems";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const CAT: Catalyst = {
  source: "zz",
  annId: "a1",
  title: "ZZ",
  publishedAt: "t",
  category: "results",
  materiality: 2,
  polarity: 1,
};
const OK: CandidateInput = {
  catalyst: CAT,
  movePpm: 50_000,
  sectorAdjPpm: null,
  sd60Ppm: 10_000,
  relVolumePpm: 3_000_000,
  quoteAgeMin: 22,
  params: { moveMinPct: 4, relVolumeMin: 2, maxAgeMin: 30 },
};

describe("isCandidate", () => {
  it("passes when catalyst, move, volume and freshness all hold", () => {
    expect(isCandidate(OK)).toEqual({ ok: true, polarityConsistent: true });
  });

  it.each([
    ["no catalyst", { catalyst: null }, ["catalyst"]],
    [
      "a move without a catalyst is not a candidate",
      { catalyst: null, movePpm: 90_000 },
      ["catalyst"],
    ],
    ["small move", { movePpm: 30_000 }, ["move"]],
    ["move below 1.5 sd", { sd60Ppm: 40_000, movePpm: 50_000 }, ["move"]],
    ["low volume", { relVolumePpm: 1_900_000 }, ["volume"]],
    ["unknown volume fails closed (D-382)", { relVolumePpm: null }, ["volume"]],
    ["stale quote", { quoteAgeMin: 31 }, ["fresh"]],
    ["several", { movePpm: 0, relVolumePpm: null }, ["move", "volume"]],
  ] as [string, Partial<CandidateInput>, string[]][])("%s", (_n, over, failed) => {
    expect(isCandidate({ ...OK, ...over })).toEqual({ ok: false, failed });
  });

  it("a down move against a positive catalyst is a candidate flagged as inconsistent", () => {
    expect(isCandidate({ ...OK, movePpm: -50_000 })).toEqual({
      ok: true,
      polarityConsistent: false,
    });
  });

  it("the move threshold is max(key, 1.5 x sd)", () => {
    expect(moveThresholdPpm(null, 4)).toBe(40_000);
    expect(moveThresholdPpm(10_000, 4)).toBe(40_000);
    expect(moveThresholdPpm(40_000, 4)).toBe(60_000);
  });
});

describe("indicativeLevels (AGT-143)", () => {
  it("stop = last - k x ATR; limit = min(last x 1.08, stop / 0.88)", () => {
    const r = indicativeLevels(10_000_000n, { atrMicro: 200_000n, multPpm: 2_000_000n })!;
    expect(r.stopMicro).toBe(9_600_000n);
    expect(r.limitMicro).toBe(10_800_000n); // last x 1.08 < stop / 0.88 = 10,909,090
    const tight = indicativeLevels(10_000_000n, { atrMicro: 800_000n, multPpm: 2_000_000n })!;
    expect(tight.stopMicro).toBe(8_400_000n);
    expect(tight.limitMicro).toBe(9_545_454n); // stop / 0.88 is the lower
  });

  it("null when it cannot be computed", () => {
    expect(indicativeLevels(10_000_000n, null)).toBeNull();
    expect(indicativeLevels(10_000_000n, { atrMicro: 6_000_000n, multPpm: 2_000_000n })).toBeNull();
  });
});

describe("scanGates", () => {
  const bar = {
    d: "2026-11-03",
    open: 10_000_000n,
    high: 10_100_000n,
    low: 9_900_000n,
    close: 10_000_000n,
    volume: 1000n,
  };
  const base: ScanGateInput = {
    bar,
    barCount: 70,
    advMicro: 5_000_000_000_000n,
    heldAlready: false,
    portfolio: null,
    eventState: {
      d: "2026-11-04",
      fillD: "2026-11-04",
      indexChangesLoaded: true,
      indexChanges: [],
      sessions: ["2026-11-03", "2026-11-04"],
      indexChangeWindowSessions: 1,
      promotionState: null,
      haltState: null,
      haltedNow: false,
      corpActionState: null,
      events: [],
    },
  };

  it("passes every gate", () => {
    expect(scanGates(base)).toEqual({
      passed: ["L0_code", "eligibility", "event_state", "liquidity_floor", "not_held"],
      failed: null,
    });
  });

  it("names the first failing gate", () => {
    expect(scanGates({ ...base, bar: null }).failed).toMatch(/^G01_l0_veto/);
    expect(scanGates({ ...base, barCount: 10 }).failed).toMatch(/^G02_eligibility/);
    expect(
      scanGates({ ...base, eventState: { ...base.eventState, haltedNow: true } }).failed,
    ).toMatch(/^G08_event_state/);
    expect(
      scanGates({ ...base, eventState: { ...base.eventState, indexChangesLoaded: false } }).failed,
    ).toMatch(/list_missing/);
    expect(scanGates({ ...base, advMicro: 1n }).failed).toBe("liquidity_floor");
    expect(scanGates({ ...base, advMicro: null }).failed).toBe("liquidity_floor");
    expect(scanGates({ ...base, heldAlready: true }).failed).toBe("already_held");
  });
});

describe("universe and catalysts (read only)", () => {
  let db: Client;

  it("tiers 1 and 2, then watch and held, capped; the scan adds no other code", async () => {
    db = await freshDb("main");
    for (const [c, t] of [
      ["ZZ01", "U1"],
      ["ZZ02", "U2"],
      ["ZZ03", "U3"],
    ]) {
      await db.execute({
        sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, adv, halted) VALUES ('AU', '2026-11-03', ?, 'active', ?, 1, 0)",
        args: [c, t],
      });
    }
    await db.execute(
      "INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d) VALUES ('w1', 'AU', 'ZZ05', 1, '2026-11-01T00:00:00Z', '2026-12-01')",
    );
    await db.execute(
      "INSERT INTO nav_daily_pos (cohort_id, d, code, qty, close_micro, value_micro) VALUES ('c1', '2026-11-03', 'ZZ06', 1, 1, 1)",
    );
    const all = await scanUniverse(db, "AU", "2026-11-04", 800);
    expect(all.map((x) => `${x.code}:${x.kind}`)).toEqual([
      "ZZ01:U1",
      "ZZ02:U2",
      "ZZ05:watch",
      "ZZ06:held",
    ]);
    expect((await scanUniverse(db, "AU", "2026-11-04", 2)).map((x) => x.code)).toEqual([
      "ZZ01",
      "ZZ02",
    ]);
    expect(await scanUniverse(db, "AU", "2026-11-04", 0)).toEqual([]);
  });

  it("todayCatalysts: materiality 2 or more, today only, best item per code", async () => {
    db = await freshDb("main");
    const ann = async (code: string, id: string, at: string, mat: number) => {
      await db.execute({
        sql: "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, title, source) VALUES ('AU', ?, ?, ?, 't', 'results', 'ZZ', 'zz')",
        args: [code, id, at],
      });
      await db.execute({
        sql: "INSERT INTO item_assessment (source, ann_id, market, code, materiality, rule_version, polarity, held, watch, candidate, tracked, assessed_at) VALUES ('zz', ?, 'AU', ?, ?, 'v1', -1, 0, 0, 0, 0, 't')",
        args: [id, code, mat],
      });
    };
    await ann("ZZ01", "x1", "2026-11-03T23:00:00.000Z", 2);
    await ann("ZZ01", "x2", "2026-11-03T23:30:00.000Z", 3);
    await ann("ZZ02", "x3", "2026-11-03T23:00:00.000Z", 1); // below 2
    await ann("ZZ03", "x4", "2026-11-03T10:00:00.000Z", 3); // yesterday, Melbourne
    await ann("ZZ04", "x5", "2026-11-04T00:30:00.000Z", 3); // after the cut-off
    const m = await todayCatalysts(db, "AU", "2026-11-04", "2026-11-04T00:00:00.000Z");
    expect([...m.keys()]).toEqual(["ZZ01"]);
    expect(m.get("ZZ01")).toMatchObject({
      annId: "x2",
      materiality: 3,
      polarity: -1,
      category: "results",
    });
  });
});

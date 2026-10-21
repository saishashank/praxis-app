// @vitest-environment node
// M8 T3 coverage (TST-121): the live day-input builder (A4 -> A3 -> A2) on a small synthetic night
// in a migrated database: a missing benchmark (no index data, or no bar for the day), the ASX source
// on, stored events with and without optional columns, a held code outside the universe, a code with
// an unreadable corporate action, a recent consolidation, and a code with no bar today.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDayInputs } from "@/lib/agents/candidates";
import { loadCalendar } from "@/lib/arena/closeBooks";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { MARKET, buildNight, DATES, testParams, trend } from "../agents/batch2bHarness";
import { freshReplayDb } from "../arena/replayHarness";

const params = testParams();
const NEW_DAYS = 5;
const HOURS = { tz: "Australia/Melbourne", open_time: "10:00", close_time: "16:00" };
const THROUGH = 130;
const D = DATES[THROUGH]!;

let db: Client;
beforeAll(async () => {
  db = await freshReplayDb();
  await buildNight(db, {
    through: THROUGH,
    codes: [
      { code: "ZZUP", close: trend(10_000_000n, 20_000n, 30_000n) },
      { code: "ZZLOW", tier: "U2", close: trend(5_000_000n, 5_000n, 20_000n) },
    ],
  });
  // a code listed only for the last few sessions: too little history for a volatility figure
  const stmts = DATES.slice(THROUGH - NEW_DAYS + 1, THROUGH + 1).flatMap((d) => [
    {
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES (?, 'ZZNEW', ?, 6, 6.1, 5.9, 6, 800000, 'synthetic', ?, ?)`,
      args: [MARKET, d, `${d}T06:30:00.000Z`, `${d}T07:00:00.000Z`],
    },
    {
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
            VALUES (?, ?, 'ZZNEW', 'active', 'U2', NULL, NULL, 0)`,
      args: [MARKET, d],
    },
  ]);
  await db.batch(stmts as never, "write");
}, 120_000);
afterAll(cleanupTempDbs);

async function day(over: Partial<Parameters<typeof loadDayInputs>[1]> = {}) {
  return loadDayInputs(db, {
    market: MARKET,
    d: D,
    calendar: await loadCalendar(db, MARKET),
    hours: HOURS,
    params,
    replay: true,
    heldCodes: [],
    actions: [],
    ...over,
  });
}

const action = (code: string, type: string, exDate: string, payload: unknown): CorpActionRecord =>
  ({ id: `${code}:${exDate}`, code, type, exDate, payload }) as never;

describe("loadDayInputs", () => {
  it("builds facts for the universe codes, a known regime and a data reference; asx off means no event cover", async () => {
    const r = await day();
    expect([...r.facts.keys()].sort()).toEqual(["ZZLOW", "ZZNEW", "ZZUP"]);
    expect(r.vol20.has("ZZNEW")).toBe(false);
    expect(r.regime?.d).toBe(D);
    expect(r.partial).toBe(r.partialReasons.length > 0);
    expect(typeof r.inputs.eventCoverage).toBe("boolean");
    expect(["on", "off"]).toContain(r.inputs.sources.asx);
    expect(r.inputsRef).toMatch(/^batch1:\d+@/);
    expect(r.vol20.has("ZZUP")).toBe(true);
  });

  it("a held code outside the universe still gets facts, with the U3 tier and no score", async () => {
    await db.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES (?, 'ZZHELD', ?, 4, 4.1, 3.9, 4, 1000000, 'synthetic', ?, ?)`,
      args: [MARKET, D, `${D}T06:30:00.000Z`, `${D}T07:00:00.000Z`],
    });
    const r = await day({ heldCodes: ["ZZHELD", "ZZNOBAR"] });
    expect(r.facts.get("ZZHELD")?.tier).toBe("U3");
    expect(r.facts.has("ZZNOBAR")).toBe(false);
    expect(r.inputs.codes.map((c) => c.code)).not.toContain("ZZHELD");
    expect(r.scores.map((s) => s.code)).not.toContain("ZZHELD");
  });

  it("a code whose split cannot be read is left out; a recent consolidation is counted in sessions", async () => {
    const r = await day({
      actions: [
        action("ZZLOW", "split", DATES[100]!, { new: "x", old: 0 }),
        action("ZZUP", "consolidation", DATES[120]!, { new: 1, old: 2 }),
        action("ZZUP", "consolidation", DATES[125]!, { new: 1, old: 2 }),
        action("ZZUP", "consolidation", DATES[110]!, { new: 1, old: 2 }),
        action("ZZUP", "dividend", DATES[126]!, {}),
      ],
    });
    expect(r.facts.has("ZZLOW")).toBe(false);
    expect(r.facts.get("ZZUP")?.consolidationSessionsAgo).toBe(5);
  });

  it("a consolidation dated outside the session window is ignored", async () => {
    const r = await day({ actions: [action("ZZUP", "consolidation", "2030-01-05", { new: 1, old: 2 })] });
    expect(r.facts.get("ZZUP")?.consolidationSessionsAgo).toBeNull();
  });

  it("stored events become facts; optional columns may be null; events for unknown codes are dropped", async () => {
    const ev = (id: string, code: string, day0: string, withAr: boolean, cat = "results") => ({
      sql: `INSERT INTO event (market, source, ann_id, code, published_at, timed, day0_d, group_key, category,
              price_sensitive, ar_ppm, ar_num, ar_den, vol_ratio_ppm, polarity, rule_version, category_llm, polarity_llm)
            VALUES (?, 'asx', ?, ?, ?, 1, ?, ?, ?, 1, ?, ?, ?, ?, 1, '1', ?, ?)`,
      args: [
        MARKET,
        id,
        code,
        `${day0}T01:00:00.000Z`,
        day0,
        `g-${id}`,
        cat,
        withAr ? 1200 : null,
        withAr ? "3" : null,
        withAr ? "7" : null,
        withAr ? 2_000_000 : null,
        withAr ? "results" : null,
        withAr ? -1 : null,
      ],
    });
    await db.batch(
      [
        ev("e1", "ZZUP", DATES[128]!, true),
        ev("e2", "ZZUP", DATES[128]!, false, "other"),
        ev("e3", "ZZLOW", DATES[129]!, false, "guidance_up"),
        ev("e4", "ZZGONE", DATES[129]!, false),
        ev("e5", "ZZUP", "2030-06-01", false),
      ] as never,
      "write",
    );
    const r = await day();
    expect(r.eventsByCode.get("ZZUP")).toHaveLength(3);
    expect(r.eventsByCode.get("ZZLOW")).toHaveLength(1);
    expect(r.eventsByCode.has("ZZGONE")).toBe(false);
    expect(r.inputs.events.map((e) => e.code).sort()).toEqual(["ZZLOW", "ZZUP", "ZZUP", "ZZUP"]);
  });

  it("with the ASX source on the event agent runs and event cover is reported", async () => {
    await db.execute("UPDATE source_status SET mode = 'on' WHERE source = 'asx_announcements'");
    const r = await day();
    expect(r.inputs.sources.asx).toBe("on");
    expect(r.inputs.eventCoverage || r.partialReasons.includes("a2_failed")).toBe(true);
    await db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'asx_announcements'");
  });

  it("no bar for the day: that code gives no decision input; no data marker reads none", async () => {
    const r = await day({ d: DATES[THROUGH + 1]! });
    expect(r.facts.size).toBe(0);
    expect(r.inputsRef).toBe("batch1:none@none");
    expect(r.partialReasons).toContain("a3_no_index_bar");
  });

  it("a benchmark with history but no bar for the day is a partial run with an unknown regime", async () => {
    const r = await day({ d: DATES[THROUGH + 1]! });
    expect(r.regime).toBeNull();
    expect(r.inputs.regime).toBe("unknown");
    expect(r.partial).toBe(true);
  });

  it("a day before any benchmark data is a partial run too", async () => {
    const r = await day({ d: "2029-12-28" });
    expect(r.regime).toBeNull();
    expect(r.partialReasons.length).toBeGreaterThan(0);
  });
});

describe("loadDayInputs on a database that returns plain numbers", () => {
  it("reads the halted flag as a number", async () => {
    const plain = await freshDb("main");
    await buildNight(plain, {
      through: 40,
      codes: [{ code: "ZZUP", close: trend(10_000_000n, 20_000n, 30_000n) }],
    });
    const r = await loadDayInputs(plain, {
      market: MARKET,
      d: DATES[40]!,
      calendar: await loadCalendar(plain, MARKET),
      hours: HOURS,
      params,
      replay: true,
      heldCodes: [],
      actions: [],
    });
    expect(r.facts.get("ZZUP")?.halted).toBe(false);
  }, 120_000);
});

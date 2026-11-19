// @vitest-environment node
// AT-78 (M21 R1; VAL-121, D-1228, D-1295): the shadow short writes decisions and would-have outcomes only. The AT-32 golden ZZ
// world is run twice and reviewed night by night through batch 3, once with the shadow short off and once with it on; every
// table dumps identically except the two shadow tables, which gain rows. The golden hash baselines are only read. Synthetic
// ZZ data only (SEC-110).
import { afterAll, describe, expect, it, vi } from "vitest";
import { reviewDay } from "@/lib/agents/batch3";
import { cleanupTempDbs } from "../../db/helpers";
import { DATES, MARKET, NOW, testParams } from "../../agents/batch2bHarness";
import { MASTER_SEED } from "../../arena/replayHarness";
import { seedDecision, seedEvent, seedTier } from "../../shortShadow/shortHarness";
import { at32World, dump } from "./at32World";

const sw = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/shortShadow/enabled", () => ({
  SHORT_SHADOW_KEY: "short_shadow_enabled",
  shortShadowEnabled: async () => sw.on,
}));

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const FIRST = 297;
const LAST = 301;
const SHADOW = ["short_shadow_decision", "short_shadow_outcome"];

// The golden world blocks every Cortex candidate (G03/G11), so the same rows are planted in BOTH worlds before the reviews: a
// passing decision of a shortable code, a polarity -1 event, and a U3 decision (recorded not shortable at once).
async function plant(db: Awaited<ReturnType<typeof at32World>>): Promise<void> {
  const d = DATES[FIRST]!;
  await seedDecision(db, { d, code: "ZZD1", key: [-1, 0, 0] });
  await seedEvent(db, d, "ZZD2", -1);
  await seedTier(db, d, "ZZNS", "U3");
  await seedDecision(db, { d, code: "ZZNS", key: [-2, 0, 0] });
}

async function reviewed(on: boolean) {
  sw.on = on;
  const db = await at32World();
  await plant(db);
  for (let i = FIRST; i <= LAST; i += 1) {
    const r = await reviewDay(db, {
      market: MARKET,
      d: DATES[i]!,
      replay: true,
      now: NOW,
      masterSeed: MASTER_SEED,
      params: testParams(),
    });
    expect(["success", "degraded"], `review of ${DATES[i]}`).toContain(r.status);
  }
  return db;
}

describe("AT-78: the shadow short writes decisions and would-have outcomes only", () => {
  it("every table of the golden world is identical with the step on and off, except the two shadow tables", async () => {
    const off = await reviewed(false);
    const on = await reviewed(true);
    const a = await dump(off);
    const b = await dump(on);
    // off: the stream writes nothing at all
    for (const t of SHADOW) expect(a.rows[t], `${t} off`).toBe(0);
    // on: the stream gained rows (not vacuous)
    expect(b.rows.short_shadow_decision).toBeGreaterThan(0);
    expect(b.rows.short_shadow_outcome).toBeGreaterThan(0);
    // the world is a real one: it has cards, signals, orders and Cortex decisions
    expect(a.rows.signal).toBeGreaterThan(0);
    expect(a.rows.arena_order).toBeGreaterThan(0);
    expect(a.rows.cortex_decision).toBeGreaterThan(0);
    expect(Object.keys(b.perTable).sort()).toEqual(Object.keys(a.perTable).sort());
    const differing = Object.keys(a.perTable)
      .filter((t) => a.perTable[t] !== b.perTable[t])
      .sort();
    expect(differing).toEqual([...SHADOW].sort());
    for (const t of Object.keys(a.rows).filter((t) => !SHADOW.includes(t))) {
      expect(b.rows[t], `${t} row count`).toBe(a.rows[t]);
    }
    // no log line on success, and no look (the sample is far below 60)
    expect(b.rows.app_log).toBe(a.rows.app_log);
    expect(b.rows.holdout_look).toBe(0);
  });
});

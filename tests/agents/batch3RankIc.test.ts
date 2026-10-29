// @vitest-environment node
// VAL-114 in batch 3 (M14 WP4, D-232): stage 6 writes one rank_ic_daily row per (family, rank variant)
// for D' = two sessions before the run date, source `live`, insert-or-ignore, and never fails the
// review. The scenario is the batch 2b golden world; its universe is small, so the IC itself is
// skipped (fewer than 10 scored codes) and the rows document that with a null IC.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay, type ReviewResult } from "@/lib/agents/batch3";
import { RANK_SPECS } from "@/lib/learning/rankIcStage";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden } from "./batch2bScenario";

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const FIRST = 295;
const LAST = 300;

let db: Client;
const reviews = new Map<string, ReviewResult>();
beforeAll(async () => {
  db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, FIRST, KEEP);
  await runNights(db, params, FIRST, LAST, async (day) => {
    reviews.set(
      day,
      await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params }),
    );
  });
});
afterAll(cleanupTempDbs);

describe("batch 3 stage 6: rank_ic_daily", () => {
  it("every night succeeds and writes the live rows of D' (two sessions earlier)", async () => {
    for (const [, r] of reviews) expect(r.status).toBe("success");
    const rows = (await db.execute("SELECT * FROM rank_ic_daily ORDER BY d, family, rank_variant"))
      .rows;
    expect(rows.length).toBeGreaterThan(0);
    const days = [...new Set(rows.map((r) => String(r.d)))];
    // the run date itself and the night before it are not scored yet (their forward returns are open)
    expect(days).not.toContain(DATES[LAST]);
    expect(days).not.toContain(DATES[LAST - 1]);
    expect(days).toContain(DATES[LAST - 2]);
    const last = rows.filter((r) => String(r.d) === DATES[LAST - 2]);
    expect(last).toHaveLength(RANK_SPECS.length);
    expect(new Set(last.map((r) => `${String(r.family)}|${String(r.rank_variant)}`))).toEqual(
      new Set(RANK_SPECS.map((s) => `${s.family}|${s.variant}`)),
    );
    for (const r of rows) {
      expect(String(r.source)).toBe("live");
      expect(String(r.market)).toBe(MARKET);
      if (r.ic !== null) {
        expect(Number(r.ic)).toBeGreaterThanOrEqual(-1);
        expect(Number(r.ic)).toBeLessThanOrEqual(1);
        expect(Number(r.n)).toBeGreaterThanOrEqual(params.stats.rankIcMinCodes);
      }
    }
  });

  it("is append-only and a second review of a finished night writes nothing new", async () => {
    const before = Number((await db.execute("SELECT COUNT(*) AS n FROM rank_ic_daily")).rows[0]!.n);
    const again = await reviewDay(db, {
      market: MARKET,
      d: DATES[LAST]!,
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("already_done");
    expect(Number((await db.execute("SELECT COUNT(*) AS n FROM rank_ic_daily")).rows[0]!.n)).toBe(
      before,
    );
    await expect(db.execute("UPDATE rank_ic_daily SET ic = 0")).rejects.toThrow(/append-only/);
  });
});

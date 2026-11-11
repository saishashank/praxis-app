// @vitest-environment node
// D-923: the picks entry runs the learning Cortex's scorecard right after the daily learning loop, on
// the loop's World, in its own try/catch: its line is counts only, and neither its failure nor the
// loop's failure stops the picks (exit 0). The loop and the stage are stubbed here; both run for real
// in tests/learning/dailyRun.test.ts and tests/cortex/learn/stage.test.ts.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

const learn = vi.hoisted(() => ({
  daily: vi.fn(),
  cortex: vi.fn(),
}));
vi.mock("@/lib/learning/daily", async (orig) => ({
  ...(await orig<typeof import("@/lib/learning/daily")>()),
  runDailyLearning: learn.daily,
}));
vi.mock("@/lib/cortex/learn/stage", () => ({ cortexLearnNight: learn.cortex }));

import { picksMain } from "@/lib/picks/cli";

afterEach(cleanupTempDbs);
beforeEach(() => {
  learn.daily.mockReset();
  learn.cortex.mockReset();
});

const D = "2026-10-20";
const NIGHT = { world: { d: D }, movers: [] };

async function fileDb(): Promise<string> {
  const url = tempDbUrl();
  const db: Client = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
          VALUES ('arena-review', 'AU', ?, ?, ?, ?, 'success')`,
    args: [`arena-3:AU:${D}`, D, `${D}T08:00:00.000Z`, `${D}T08:05:00.000Z`],
  });
  return url;
}

async function cli(url: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await picksMain(
    ["--date", D],
    { TURSO_MAIN_URL: url },
    {
      nowMs: () => Date.parse("2026-10-20T08:00:00.000Z"),
      out: (s) => lines.push(s),
      openDb: (u) => createClient({ url: u }),
    },
  );
  return { code, lines };
}

const counts = { movers: 40, lessons: 8, improvements: 2, hypotheses: 0 };

describe("picks entry: the learning Cortex", () => {
  it("prints counts after the daily learning, handing it the loop's World and movers", async () => {
    const url = await fileDb();
    learn.daily.mockResolvedValue({ ...counts, night: NIGHT });
    learn.cortex.mockResolvedValue({
      lines: ["x"],
      numbers: { rows: 6, angles: 3, nextDayOf: 2, nextDayRight: 1, dataBreaks: 0, coverage: null },
    });
    const r = await cli(url);
    expect(r.code).toBe(0);
    expect(r.lines.slice(2)).toEqual([
      `arena-learning AU ${D}: movers=40 lessons=8 improvements=2 hypotheses=0`,
      `arena-cortex-learn AU ${D}: angles=3 rows=6 next_day_right=1/2 data_breaks=0`,
    ]);
    expect(learn.cortex).toHaveBeenCalledTimes(1);
    expect(learn.cortex.mock.calls[0]![1]).toMatchObject({
      market: "AU",
      d: D,
      world: NIGHT.world,
      movers: [],
    });
  });

  it("a failing scorecard prints one line and never stops the picks; an off-session stage is skipped", async () => {
    const url = await fileDb();
    learn.daily.mockResolvedValue({ ...counts, night: NIGHT });
    learn.cortex.mockRejectedValueOnce(new TypeError("boom"));
    const r = await cli(url);
    expect(r.code).toBe(0);
    expect(r.lines[3]).toBe(`arena-cortex-learn AU ${D}: failed (TypeError)`);
    learn.cortex.mockRejectedValueOnce("not an error");
    expect((await cli(url)).lines[3]).toBe(`arena-cortex-learn AU ${D}: failed (unknown)`);
    learn.cortex.mockResolvedValueOnce(null);
    expect((await cli(url)).lines[3]).toBe(
      `arena-cortex-learn AU ${D}: skipped (no daily learning tonight)`,
    );
  });

  it("when the daily learning fails the scorecard is skipped, not run", async () => {
    const url = await fileDb();
    learn.daily.mockRejectedValue(new RangeError("x"));
    const r = await cli(url);
    expect(r.code).toBe(0);
    expect(r.lines.slice(2)).toEqual([
      `arena-learning AU ${D}: failed (RangeError)`,
      `arena-cortex-learn AU ${D}: skipped (no daily learning tonight)`,
    ]);
    expect(learn.cortex).not.toHaveBeenCalled();
  });
});

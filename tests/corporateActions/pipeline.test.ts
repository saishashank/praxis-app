// @vitest-environment node
// Batch 1 stage 4 (corporate actions) wired into the pipeline (M2 T8, DAT-020, DAT-221, AT-07/08):
// the default hook, the stage summary in the run record, the quality stage seeing the result.
// Synthetic ZZ* codes only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { noopCorporateActionsHook, runBatch1, type RunOptions } from "@/lib/data/pipeline/batch1";
import { RULES } from "@/lib/data/quality/rules.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { at1730, bar, barsFor, count, pipelineDb, runs, text } from "../pipeline/helpers";

afterEach(cleanupTempDbs);

const MON = "2026-10-12";
const TUE = "2026-10-13";
const CODES = ["ZZA", "ZZB", "ZZC"];

const go = (db: Client, date: string, bars: unknown[], o: Partial<RunOptions> = {}) =>
  runBatch1(db, {
    nowMs: () => at1730(date),
    barsText: text(bars),
    commitSha: "a".repeat(40),
    ...o,
  });
const details = (r: Record<string, unknown>) => JSON.parse(String(r.details_json));
const openFlags = async (db: Client) =>
  (
    await db.execute(
      "SELECT code, check_id FROM data_quality_flag WHERE cleared_at IS NULL ORDER BY code, check_id",
    )
  ).rows.map((r) => `${r.code}|${r.check_id}`);

/** Tuesday: ZZA halves (10.50 -> about 5.25); the other two are unchanged. */
const tue = (): ReturnType<typeof bar>[] => [
  bar("ZZA", TUE, { open: 5.2, high: 5.4, low: 5.1, close: 5.25, adj_close: 5.25, volume: 1100 }),
  bar("ZZB", TUE, { volume: 1100 }),
  bar("ZZC", TUE, { volume: 1100 }),
];

describe("stage 4 in the pipeline", () => {
  it("an announced split that the price confirms is auto-confirmed; quality sees it as explained", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON], CODES));
    const res = await go(db, TUE, tue(), {
      corporateActionCandidates: (d) =>
        d === TUE
          ? [
              {
                code: "ZZA",
                type: "split",
                ex_date: TUE,
                payload: { new: 2, old: 1 },
                source: "announcement",
              },
            ]
          : [],
    });
    expect(res).toMatchObject({ exit: 0, status: "ok" });
    const rec = (await runs(db)).find((r) => r.scheduled_for === TUE)!;
    expect(details(rec).stages.corporate_actions).toMatchObject({
      captured: 1,
      auto_confirmed: 1,
      queued_owner: 0,
      factors_written: 1,
    });
    expect(details(rec).stages.quality.counts.unresolved_corporate_actions).toBe(0);
    expect(await count(db, "adjustment_factor")).toBe(1);
    expect(await openFlags(db)).toEqual([]); // not suspect: a confirmed action explains the move
    // rows counted in the run record: bars 3, snapshot 3, marker 1, scores 3, then stage 4:
    // 1 action + 2 events (pending, auto_confirmed) + 1 factor
    expect(Number(rec.rows_written)).toBe(3 + 3 + 1 + 3 + 1 + 2 + 1);
  });

  it("an unannounced 50% drop is queued: a suspect bar AND an entry block, summary counts it", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON], CODES));
    await go(db, TUE, tue());
    const rec = (await runs(db)).find((r) => r.scheduled_for === TUE)!;
    expect(details(rec).stages.corporate_actions).toMatchObject({ captured: 1, queued_owner: 1 });
    expect(details(rec).stages.quality.counts.unresolved_corporate_actions).toBe(1);
    expect(await openFlags(db)).toEqual([
      `ZZA|${RULES.suspect_move.id}`,
      `ZZA|DAT-222:unresolved_corporate_action`,
    ]);
    expect(await count(db, "adjustment_factor")).toBe(0);
  });

  it("re-running the same date adds nothing (DAT-003)", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON], CODES));
    await go(db, TUE, tue());
    const before = [
      await count(db, "corporate_action"),
      await count(db, "corporate_action_event"),
      await count(db, "data_quality_flag"),
    ];
    await go(db, TUE, tue());
    expect([
      await count(db, "corporate_action"),
      await count(db, "corporate_action_event"),
      await count(db, "data_quality_flag"),
    ]).toEqual(before);
  });

  it("a clean night records zeros", async () => {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([TUE], CODES));
    const [rec] = await runs(db);
    expect(details(rec).stages.corporate_actions).toMatchObject({
      captured: 0,
      auto_confirmed: 0,
      queued_owner: 0,
      pending: 0,
    });
  });

  it("the hook can be switched off for stage tests (noop)", async () => {
    const db = await pipelineDb();
    await go(db, MON, barsFor([MON], CODES));
    await go(db, TUE, tue(), { corporateActionsHook: noopCorporateActionsHook });
    const rec = (await runs(db)).find((r) => r.scheduled_for === TUE)!;
    expect(details(rec).stages.corporate_actions).toBe("noop");
    expect(await count(db, "corporate_action")).toBe(0);
  });

  it("a hook that returns nothing is recorded as done", async () => {
    const db = await pipelineDb();
    await go(db, TUE, barsFor([TUE], CODES), { corporateActionsHook: async () => undefined });
    const [rec] = await runs(db);
    expect(details(rec).stages.corporate_actions).toBe("done");
  });

  it("a failing stage fails the date with the stage name and no row data (SEC-110)", async () => {
    const db = await pipelineDb();
    const res = await go(db, TUE, barsFor([TUE], CODES), {
      corporateActionsHook: async () => {
        throw new Error("secret row ZZA 10.5");
      },
    });
    expect(res.exit).toBe(1);
    const [rec] = await runs(db);
    expect(rec.status).toBe("failed");
    expect(String(rec.error_summary)).toBe("corporate_actions: unexpected error");
    expect(JSON.stringify(rec)).not.toContain("secret");
  });
});

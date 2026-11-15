// @vitest-environment node
// Migration 0033_pick_scorecard (D-1061, Owner O-84): the two write-once report tables and the new
// `report_look` kind of the trial ledger. Rolls back to the older ledger shape (report-only looks go,
// every other row stays) and comes back identical; the CHECKs and triggers hold.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const LEDGER = (id: string, kind: string) =>
  `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d)
   VALUES ('${id}', 'AU', 'AU:F1', 1, '${kind}', NULL, NULL, NULL, '2026-11-16')`;
const RUN = (id: string, extra = "") =>
  `INSERT INTO pick_scorecard_run (id, market, created_at, commit_sha, sessions, first_d, last_d, status, summary_json)
   VALUES ('${id}', 'AU', '2026-11-16T00:00:00.000Z', 'abc', 40, '2026-09-21', '2026-11-13', 'complete', '${extra || "{}"}')`;
const DAY = (runId: string, d: string, gainerHits: number) =>
  `INSERT INTO pick_scorecard_day (run_id, d, next_d, picks_n, gainers_n, gainer_hits, losers_n, loser_hits,
     liquid_n, named_n, chance_ppm, cortex_scored, profiles_json, detail_json)
   VALUES ('${runId}', '${d}', '2026-11-13', 3, 5, ${gainerHits}, 5, 0, 400, 12, 150000, 0, '{}', '{}')`;

describe("0033_pick_scorecard", () => {
  it("rolls back to the older ledger shape and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[32]).toMatchObject({ version: 33, name: "pick_scorecard" });
    await migrateUp(
      db,
      ms.filter((m) => m.version <= 32),
    );
    await db.execute(LEDGER("keep-1", "validation_access"));
    await db.execute(LEDGER("keep-2", "challenger"));
    const before = await schemaOf(db);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 33 });
    const after = await schemaOf(db);
    for (const t of ["pick_scorecard_run", "pick_scorecard_day"])
      expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);
    // the ledger keeps its rows and its append-only triggers through the rebuild
    const kept = await db.execute("SELECT id FROM trial_ledger ORDER BY id");
    expect(kept.rows.map((r) => String(r.id))).toEqual(["keep-1", "keep-2"]);
    await expect(db.execute("DELETE FROM trial_ledger")).rejects.toThrow(/append-only/);
    await db.execute(LEDGER("look-1", "report_look"));
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 32 });
    expect(await schemaOf(db)).toEqual(before);
    const left = await db.execute("SELECT id FROM trial_ledger ORDER BY id");
    expect(left.rows.map((r) => String(r.id))).toEqual(["keep-1", "keep-2"]); // the look went with the report
    await expect(db.execute(LEDGER("look-2", "report_look"))).rejects.toThrow();
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 33 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("trial_ledger accepts report_look and still refuses an unknown kind", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(LEDGER("look-1", "report_look"));
    await expect(db.execute(LEDGER("x-1", "bogus"))).rejects.toThrow();
    await expect(db.execute("UPDATE trial_ledger SET d = '2026-01-01'")).rejects.toThrow(
      /append-only/,
    );
  });

  it("run and day rows are write-once and their ranges are checked", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(RUN("r1"));
    await expect(db.execute(RUN("r1"))).rejects.toThrow(); // primary key
    await expect(db.execute(RUN("r2", "not json"))).rejects.toThrow(); // json_valid
    await expect(db.execute("UPDATE pick_scorecard_run SET status = 'partial'")).rejects.toThrow(
      /write-once/,
    );
    await expect(db.execute("DELETE FROM pick_scorecard_run")).rejects.toThrow(/write-once/);
    await db.execute(DAY("r1", "2026-11-12", 1));
    await expect(db.execute(DAY("r1", "2026-11-12", 1))).rejects.toThrow(); // one row a night
    await expect(db.execute(DAY("r1", "2026-11-11", 6))).rejects.toThrow(); // at most five gainers
    await expect(db.execute("UPDATE pick_scorecard_day SET picks_n = 9")).rejects.toThrow(
      /write-once/,
    );
    await expect(db.execute("DELETE FROM pick_scorecard_day")).rejects.toThrow(/write-once/);
    await expect(
      db.execute(
        "INSERT INTO pick_scorecard_run (id, market, created_at, commit_sha, sessions, first_d, last_d, status, summary_json) VALUES ('r3','AU','t','c',61,'2026-09-21','2026-11-13','complete','{}')",
      ),
    ).rejects.toThrow(); // at most 60 sessions
  });
});

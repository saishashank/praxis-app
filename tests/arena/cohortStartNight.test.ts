// @vitest-environment node
// M8 T10: a REAL night (replay unset) of batch 2b in `full` mode on an empty-but-seeded calendar world:
// the cohort start stage opens every first cohort for the next session, records it in the run record,
// leaves tonight's signals and orders alone, and a repeat opens nothing and writes nothing.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { signalsDay } from "@/lib/agents/batch2b";
import { closeBooksKey } from "@/lib/arena/closeBooks";
import { ensureCohorts } from "@/lib/arena/cohortStart";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { finishRun, startRun } from "@/lib/runs/runRecord";
import { testParams } from "../agents/batch2bHarness";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const D = "2026-03-04"; // Wednesday; next session 2026-03-05
const NEXT = "2026-03-05";
const NOW = () => "2026-03-04T10:00:00.000Z";

const one = async (db: Client, sql: string): Promise<bigint> =>
  BigInt((await db.execute(sql)).rows[0]!.n as bigint | number);

async function world(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  const id = await startRun(db, {
    job: "arena-close",
    market: "AU",
    concurrencyKey: closeBooksKey("AU", D),
    scheduledFor: D,
    now: NOW(),
  });
  await finishRun(db, id, { status: "success", now: NOW() });
  return db;
}

const COUNTS = `SELECT (SELECT COUNT(*) FROM cohort) + (SELECT COUNT(*) FROM cash_ledger)
  + (SELECT COUNT(*) FROM cohort_event) + (SELECT COUNT(*) FROM arena_order)
  + (SELECT COUNT(*) FROM signal) AS n`;

describe("a real night of batch 2b in full mode (M8 T10)", () => {
  it("opens the first cohorts for the next session, once", async () => {
    const db = await world();
    const params = testParams();
    const r = await signalsDay(db, { market: "AU", d: D, now: NOW, params });
    expect(["success", "degraded"]).toContain(r.status);

    // default controls per family (20): 12 E + C1 + 6 x 20 C2 + 6 x 20 C3
    const slots = 12 + 1 + 6 * params.replay.c2LivePerFamily * 2;
    const cohorts = await db.execute("SELECT id, start_d, seed_micro FROM cohort");
    expect(cohorts.rows).toHaveLength(slots);
    for (const c of cohorts.rows) {
      expect(c.start_d).toBe(NEXT);
      expect(c.seed_micro).toBe(600_000_000n);
    }
    expect(await one(db, "SELECT COUNT(*) AS n FROM execution")).toBe(25n);
    expect(
      await one(
        db,
        "SELECT COUNT(*) AS n FROM cash_ledger WHERE account = 'cash_settled' AND delta_micro = 600000000",
      ),
    ).toBe(BigInt(slots));

    const rec = await db.execute(
      "SELECT details_json FROM run_record WHERE concurrency_key = 'arena-2b:AU:" + D + "'",
    );
    const details = JSON.parse(String(rec.rows[0]!.details_json)) as Record<string, unknown>;
    expect(details.cohortsOpened).toBe(slots);
    expect(details.cohortStartD).toBe(NEXT);

    // tonight: the new cohorts (start_d = next session) take no part in the signals and orders
    expect(details.cohorts).toBe(0);
    expect(await one(db, "SELECT COUNT(*) AS n FROM arena_order")).toBe(0n);

    // a second identical run opens nothing and writes no engine row (only a new run_record)
    const before = await one(db, COUNTS);
    const again = await signalsDay(db, { market: "AU", d: D, now: NOW, params });
    expect(again.status).toBe(r.status); // a degraded night is not a success, so it really re-runs
    expect(again.stats.signals + again.stats.orders).toBe(0);
    const stage = await ensureCohorts(db, {
      market: "AU",
      d: D,
      controlsPerFamily: params.replay.c2LivePerFamily,
    });
    expect(stage).toMatchObject({ status: "nothing_to_do", opened: 0 });
    expect(await one(db, COUNTS)).toBe(before);
  });
});

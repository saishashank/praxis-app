// @vitest-environment node
// M8 T10: the cohort start stage `ensureCohorts` (docs/M8_design.md decision 3; ARN-001, BLD-030).
// HIGH-RISK money path: known-answer seed cash (exact bigint), idempotent re-run, `full` only,
// arena_control respected, empty database safe. Synthetic data only.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { cohortSlots, buildExecutionRegistry, SEED_MICRO } from "@/lib/arena/cohort";
import { ensureCohorts } from "@/lib/arena/cohortStart";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const D = "2026-03-04"; // a Wednesday; the next session is Thursday 2026-03-05
const NEXT = "2026-03-05";
const CONTROLS = 2;
const SLOTS = cohortSlots(buildExecutionRegistry(), CONTROLS).length;

async function freshDb(mode: string = "full"): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = 'AU'", args: [mode] });
  return db;
}

const run = (db: Client, d = D) =>
  ensureCohorts(db, { market: "AU", d, controlsPerFamily: CONTROLS });

async function count(db: Client, table: string): Promise<number> {
  const rs = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rs.rows[0]!.n);
}

async function control(db: Client, scope: string, key: string, state: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason)
          VALUES (?, ?, ?, '2026-03-03T00:00:00.000Z', 'test', NULL)`,
    args: [scope, key, state],
  });
}

describe("ensureCohorts (M8 T10)", () => {
  it("opens the first cohort of every execution and control with the A$600 seed", async () => {
    const db = await freshDb();
    const r = await run(db);
    expect(r.status).toBe("opened");
    expect(r.startD).toBe(NEXT);
    expect(r.opened).toBe(SLOTS);
    expect(SLOTS).toBe(37); // 12 E + C1 + 6 x 2 C2 + 6 x 2 C3
    expect(await count(db, "execution")).toBe(25);
    const cohorts = await db.execute(
      "SELECT id, seed_micro, start_d, live FROM cohort ORDER BY id",
    );
    expect(cohorts.rows).toHaveLength(SLOTS);
    for (const c of cohorts.rows) {
      expect(c.seed_micro).toBe(600_000_000n);
      expect(c.start_d).toBe(NEXT);
      expect(c.live).toBe(1n);
    }
    // the seed cash ledger: exactly +A$600.000000 per cohort, nothing else
    const sums = await db.execute(
      "SELECT cohort_id, SUM(delta_micro) AS s, COUNT(*) AS n FROM cash_ledger WHERE account = 'cash_settled' GROUP BY cohort_id",
    );
    expect(sums.rows).toHaveLength(SLOTS);
    for (const s of sums.rows) {
      expect(s.s).toBe(SEED_MICRO);
      expect(s.s).toBe(600_000_000n);
      expect(s.n).toBe(1n);
    }
    const ids = cohorts.rows.map((c) => String(c.id));
    expect(ids).toContain(`E01@${NEXT}`);
    expect(ids).toContain(`C1@${NEXT}`);
    expect(ids).toContain(`C2-F1#02@${NEXT}`);
    expect(ids).toContain(`C3-F6#01@${NEXT}`);
    expect(await count(db, "cohort_event")).toBe(SLOTS);
  });

  it("is idempotent: a re-run on the same night opens nothing and writes nothing", async () => {
    const db = await freshDb();
    await run(db);
    const before = await db.execute(
      "SELECT (SELECT COUNT(*) FROM cohort) c, (SELECT COUNT(*) FROM cash_ledger) l, (SELECT COUNT(*) FROM cohort_event) e",
    );
    const again = await run(db);
    expect(again.status).toBe("nothing_to_do");
    expect(again.opened).toBe(0);
    // a later night also opens nothing: every slot already has its cohort
    const later = await run(db, NEXT);
    expect(later.opened).toBe(0);
    const after = await db.execute(
      "SELECT (SELECT COUNT(*) FROM cohort) c, (SELECT COUNT(*) FROM cash_ledger) l, (SELECT COUNT(*) FROM cohort_event) e",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it.each(["data_only", "off"])("is a no-op with a recorded reason in mode %s", async (mode) => {
    const db = await freshDb(mode);
    const r = await run(db);
    expect(r).toMatchObject({ status: "noop", reason: `mode_${mode}`, opened: 0 });
    expect(await count(db, "cohort")).toBe(0);
    expect(await count(db, "execution")).toBe(0);
    expect(await count(db, "cash_ledger")).toBe(0);
  });

  it("is a no-op for an unknown market and safe on an empty database (no executions, no cohorts)", async () => {
    const db = await freshDb();
    expect(await ensureCohorts(db, { market: "ZZ", d: D })).toMatchObject({
      status: "noop",
      reason: "market_missing",
    });
    expect(await count(db, "cohort")).toBe(0);
  });

  it("opens no cohort for a paused or killed execution, family or market", async () => {
    const db = await freshDb();
    await control(db, "execution", "E01", "paused");
    await control(db, "family", "F2", "killed");
    const r = await run(db);
    // E01; F2 = E03, E04, C2-F2 x2, C3-F2 x2
    expect(r.held).toBe(1 + 6);
    expect(r.opened).toBe(SLOTS - 7);
    const rs = await db.execute("SELECT execution_id FROM cohort");
    const held = new Set(["E01", "E03", "E04", "C2-F2", "C3-F2"]);
    for (const row of rs.rows) expect(held.has(String(row.execution_id))).toBe(false);
    // lifting the pause opens the held execution on a later night; the kill stays sticky
    await control(db, "execution", "E01", "enabled");
    const next = await run(db, NEXT);
    expect(next.opened).toBe(1);
    expect(next.held).toBe(6);
  });

  it("opens nothing for a killed market", async () => {
    const db = await freshDb();
    await control(db, "market", "AU", "killed");
    const r = await run(db);
    expect(r.opened).toBe(0);
    expect(r.held).toBe(SLOTS);
    expect(await count(db, "cohort")).toBe(0);
  });
});

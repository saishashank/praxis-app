// @vitest-environment node
// Migration 0032_m18_outcome_basis (D-956, ARN-123): pick_outcome gains the money basis of a settlement.
// Existing rows read 'price_only'; the value is held by triggers (no CHECK, so the down path can drop the
// column); a closed row's basis never changes; the migration rolls back and comes back identical.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const SHA = "a".repeat(64);
const PICK = `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
  reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm, typical_ppm,
  good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json, pick_sha, created_at)
  VALUES ('AU','2030-01-02','aggressive',1,'ZZA','F1','U1','F1.v1','sig','UNVALIDATED',10000000,10050000,
  '2030-02-01',9200000,11000000,50,-60000,20000,110000,10,1000000000,100000000,'[]','[]','${SHA}',
  '2030-01-02T07:00:00.000Z')`;
const OUTCOME = `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
  VALUES ('AU','2030-01-02','aggressive',1,'pick','ZZA','${SHA}','waiting','2030-01-02')`;

describe("0032_m18_outcome_basis", () => {
  it("adds the column, rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    const m = ms.find((x) => x.name === "m18_outcome_basis");
    expect(m).toBeDefined();
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    const cols = (await db.execute("SELECT name FROM pragma_table_info('pick_outcome')")).rows.map(
      (r) => String(r.name),
    );
    expect(cols).toContain("outcome_basis");
    expect(await migrateDown(db, ms, 3)).toMatchObject({ rolledBack: 3 });
    const back = (await db.execute("SELECT name FROM pragma_table_info('pick_outcome')")).rows.map(
      (r) => String(r.name),
    );
    expect(back).not.toContain("outcome_basis");
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(after);
  });

  it("a row reads price_only until a settlement writes total_return; a closed row never changes", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(PICK);
    await db.execute(OUTCOME);
    const basis = async () =>
      String((await db.execute("SELECT outcome_basis AS b FROM pick_outcome")).rows[0]!.b);
    expect(await basis()).toBe("price_only");
    await db.execute(
      "UPDATE pick_outcome SET state='bought', entry_d='2030-01-03', entry_micro=10000000, updated_d='2030-01-03'",
    );
    // a bad value is refused; a bought row may take its basis with the closing update
    await expect(db.execute("UPDATE pick_outcome SET outcome_basis = 'x'")).rejects.toThrow(
      /outcome_basis/,
    );
    await db.execute(
      `UPDATE pick_outcome SET state='closed', exit_d='2030-01-04', exit_micro=11000000, exit_reason='aim',
         net_micro=95000000, net_ppm=95000, outcome_basis='total_return', updated_d='2030-01-04'`,
    );
    expect(await basis()).toBe("total_return");
    await expect(
      db.execute("UPDATE pick_outcome SET outcome_basis = 'price_only'"),
    ).rejects.toThrow(/fixed with the settlement/);
    await expect(
      db.execute(
        "INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d, outcome_basis) VALUES ('AU','2030-01-02','aggressive',1,'luck','ZZA','" +
          SHA +
          "','waiting','2030-01-02','bogus')",
      ),
    ).rejects.toThrow(/outcome_basis/);
  });
});

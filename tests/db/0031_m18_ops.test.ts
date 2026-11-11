// @vitest-environment node
// Migration 0031_m18_ops (M18 stream C; D-954, D-958, D-960, D-971): usage_sample, market_row_count,
// the two quote_run columns and the news_assess_per_run config rename. Rolls back and comes back
// identical; the CHECKs and triggers hold.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const T = "2026-11-12T06:40:00.000Z";
const sample = (cols: string, vals: string) =>
  `INSERT INTO usage_sample (sampled_at, ${cols}) VALUES ('${T}', ${vals})`;

describe("0031_m18_ops", () => {
  it("rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[30]).toMatchObject({ version: 31, name: "m18_ops" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    expect(await migrateDown(db, ms, 3)).toEqual({ rolledBack: 3, version: 30 });
    const left = await db.execute(
      "SELECT name FROM sqlite_master WHERE name IN ('usage_sample','market_row_count')",
    );
    expect(left.rows).toHaveLength(0);
    const cols = await db.execute("SELECT name FROM pragma_table_info('quote_run')");
    expect(cols.rows.map((r) => String(r.name))).not.toContain("skipped");
    expect(await migrateUp(db, ms)).toEqual({ applied: 3, version: 33 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("usage_sample holds a platform row or an all-NULL unavailable row, append-only", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(
      sample(
        "rows_read_month, rows_written_month, storage_bytes, plan_name, source",
        "10, 2, 4096, 'free', 'platform'",
      ),
    );
    await expect(db.execute(sample("source", "'platform'"))).rejects.toThrow(); // primary key
    await expect(
      db.execute(sample("source", "'guess'").replace(T, "2026-11-13T06:40:00.000Z")),
    ).rejects.toThrow(); // source list
    await expect(
      db.execute(
        sample("rows_read_month, source", "5, 'unavailable'").replace(
          T,
          "2026-11-13T06:40:00.000Z",
        ),
      ),
    ).rejects.toThrow(); // an unavailable sample carries no figures
    await db.execute(sample("source", "'unavailable'").replace(T, "2026-11-14T06:40:00.000Z"));
    await expect(db.execute("UPDATE usage_sample SET plan_name = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM usage_sample")).rejects.toThrow(/append-only/);
  });

  it("market_row_count is one row per day, table and market", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const ins = (d: string, n: number) =>
      `INSERT INTO market_row_count (d, tbl, market, n) VALUES ('${d}','bar','AU',${n})`;
    await db.execute(ins("2026-11-12", 3));
    await expect(db.execute(ins("2026-11-12", 4))).rejects.toThrow();
    await expect(db.execute(ins("12 Nov", 1))).rejects.toThrow();
    await expect(db.execute(ins("2026-11-13", -1))).rejects.toThrow();
  });

  it("quote_run gains skipped and plan without disturbing old rows", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms.slice(0, 30));
    await db.execute(
      "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) VALUES ('AU','2026-11-12','10:30','poll','t',4)",
    );
    await migrateUp(db, ms);
    const old = await db.execute("SELECT skipped, plan FROM quote_run");
    expect(old.rows[0]).toMatchObject({ skipped: 0, plan: null });
    const ins = (plan: string) =>
      `INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, skipped, plan)
       VALUES ('AU','2026-11-12','10:35','poll','t',4,2,'${plan}')`;
    await db.execute(ins('{"armed":1,"watch":2,"held":3}'));
    await expect(db.execute(ins("not json"))).rejects.toThrow();
  });

  it("renames the stored sentinel cap to news_assess_per_run, raised to the new floor", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms.slice(0, 30));
    const put = (key: string, scope: string, v: string) =>
      db.execute({
        sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES (?,?,?,'t')",
        args: [key, scope, v],
      });
    await put("sentinel_max_items_per_run", "global", "35");
    await put("sentinel_max_items_per_run", "global", "5"); // the latest wins, raised to 20
    await put("sentinel_max_items_per_run", "AU", "30");
    await put("llm_daily_budget_total", "global", "240000");
    await migrateUp(db, ms);
    const r = await db.execute(
      "SELECT scope, value_json FROM config_version WHERE key = 'news_assess_per_run' ORDER BY scope",
    );
    expect(r.rows.map((x) => [x.scope, x.value_json])).toEqual([
      ["AU", "30"],
      ["global", "20"],
    ]);
    // the rename rows are the only ones a down section removes; history stays append-only
    await expect(db.execute("DELETE FROM config_version")).rejects.toThrow(/append-only/);
    await migrateDown(db, ms, 3);
    const left = await db.execute(
      "SELECT key, COUNT(*) AS n FROM config_version GROUP BY key ORDER BY key",
    );
    expect(left.rows.map((x) => [x.key, Number(x.n)])).toEqual([
      ["llm_daily_budget_total", 1],
      ["sentinel_max_items_per_run", 3],
    ]);
    await expect(db.execute("DELETE FROM config_version")).rejects.toThrow(/append-only/);
  });
});

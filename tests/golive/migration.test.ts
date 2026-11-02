// @vitest-environment node
// M8 T11: main migration 0012_golive (go_live_signoff). Up, idempotent runner, checks, the
// append-only triggers, down and up again.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

async function fresh() {
  const db = track(createClient({ url: tempDbUrl() }));
  const ms = await loadMigrations(MIGRATIONS("main"));
  await migrateUp(db, ms);
  return { db, ms };
}

const SHA = "a".repeat(40);
const add = (
  db: Awaited<ReturnType<typeof fresh>>["db"],
  o: { commit?: string; items?: string; note?: string; by?: number; market?: string } = {},
) =>
  db.execute({
    sql: "INSERT INTO go_live_signoff (market, signed_by, signed_at, release_commit, items_json, note, audit_ref) VALUES (?, ?, 't', ?, ?, ?, 'audit:1')",
    args: [o.market ?? "AU", o.by ?? 1, o.commit ?? SHA, o.items ?? "[]", o.note ?? ""],
  });

describe("main 0012_golive", () => {
  it("is the twelfth main migration and the runner is idempotent", async () => {
    const { db, ms } = await fresh();
    expect(ms[11]).toMatchObject({ version: 12, name: "golive" });
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 26 });
    const cols = (await db.execute("PRAGMA table_info(go_live_signoff)")).rows.map((c) => c.name);
    expect(cols).toEqual([
      "id",
      "market",
      "signed_by",
      "signed_at",
      "release_commit",
      "items_json",
      "note",
      "audit_ref",
    ]);
  });

  it("checks: commit is 7 to 64 lower-case hex, items is a JSON array, note is at most 500", async () => {
    const { db } = await fresh();
    await add(db);
    await add(db, { commit: "abc1234" });
    await expect(add(db, { commit: "abc123" })).rejects.toThrow(/CHECK/);
    await expect(add(db, { commit: "ABC1234" })).rejects.toThrow(/CHECK/);
    await expect(add(db, { commit: "g".repeat(10) })).rejects.toThrow(/CHECK/);
    await expect(add(db, { items: "not json" })).rejects.toThrow(/CHECK/);
    await expect(add(db, { items: "{}" })).rejects.toThrow(/CHECK/);
    await expect(add(db, { note: "x".repeat(501) })).rejects.toThrow(/CHECK/);
    await add(db, { note: "x".repeat(500) });
    await expect(add(db, { by: 0 })).rejects.toThrow(/CHECK/);
    await expect(add(db, { market: "" })).rejects.toThrow(/CHECK/);
  });

  it("is append-only: UPDATE and DELETE are refused", async () => {
    const { db } = await fresh();
    await add(db);
    await expect(db.execute("UPDATE go_live_signoff SET note = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM go_live_signoff")).rejects.toThrow(/append-only/);
    // INSERT OR REPLACE with a used id would delete the row without firing the delete trigger.
    await expect(
      db.execute(
        "INSERT OR REPLACE INTO go_live_signoff (id, market, signed_by, signed_at, release_commit, items_json, note, audit_ref) VALUES (1, 'AU', 1, 't', 'abcdef1', '[]', '', 'a')",
      ),
    ).rejects.toThrow(/append-only/);
    expect((await db.execute("SELECT COUNT(*) AS n FROM go_live_signoff")).rows[0]!.n).toBe(1);
  });

  it("down drops the table; up again restores the same schema", async () => {
    const { db, ms } = await fresh();
    const before = await schemaOf(db);
    // 0015 (vendor actions), 0014 (pick checks, D-187) and 0013 (calendar history, D-175) sit on top: three steps reach the schema before 0012
    expect(await migrateDown(db, ms, 15)).toEqual({ rolledBack: 15, version: 11 });
    expect((await schemaOf(db)).join("\n")).not.toContain("go_live_signoff");
    await migrateUp(db, ms);
    expect(await schemaOf(db)).toEqual(before);
  });
});

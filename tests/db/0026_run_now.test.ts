// @vitest-environment node
// Migration 0026_run_now (D-840..D-849): applies, rolls back and comes back identical; the request table
// is shape-checked (job id, JSON parameters, status list), the status only moves forward, the request
// itself never changes, and a row is deleted only beyond the 90-day floor.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const fails = async (db: { execute: (s: string) => Promise<unknown> }, sql: string) => {
  try {
    await db.execute(sql);
    return "";
  } catch (e) {
    return String(e);
  }
};

const ins = (over: Record<string, string> = {}) => {
  const v = {
    job_id: "backup",
    params_json: "{}",
    hmac: "a".repeat(64),
    at: new Date().toISOString(),
    ...over,
  };
  return `INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, requested_at,
    audit_ref, status, updated_at) VALUES ('${v.job_id}', 'AU', '${v.params_json}', '${v.hmac}',
    '${v.at}', 'audit:1', 'pending', '${v.at}')`;
};

describe("0026_run_now", () => {
  it("is the 26th main migration; rolls back (table, indexes, triggers) and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    expect(ms[25]).toMatchObject({ version: 26, name: "run_now" });
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 25 });
    const names = (await db.execute("SELECT name FROM sqlite_master")).rows.map((r) =>
      String(r.name),
    );
    expect(names.filter((n) => n.includes("run_now"))).toEqual([]);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 26 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("checks the job id, the JSON parameters, the status list and the hash length", async () => {
    const db = await freshDb("main");
    await db.execute(ins());
    expect(await fails(db, ins({ job_id: "Bad Job" }))).toMatch(/CHECK/);
    expect(await fails(db, ins({ job_id: "" }))).toMatch(/CHECK/);
    expect(await fails(db, ins({ params_json: "not json" }))).toMatch(/CHECK/);
    expect(await fails(db, ins({ hmac: "short" }))).toMatch(/CHECK/);
    expect(await fails(db, "UPDATE run_now_request SET status = 'weird'")).toMatch(/CHECK/);
    expect(
      await fails(
        db,
        "UPDATE run_now_request SET status = 'done', result = '" + "x".repeat(201) + "'",
      ),
    ).toMatch(/CHECK/);
  });

  it("the status only moves forward and the request never changes", async () => {
    const db = await freshDb("main");
    await db.execute(ins());
    const up = (sql: string) => fails(db, `UPDATE run_now_request SET ${sql}`);
    expect(await up("status = 'pending'")).toMatch(/forward/);
    expect(await up("job_id = 'other'")).toMatch(/forward/);
    expect(await up('params_json = \'{"d":"2026-01-01"}\'')).toMatch(/forward/);
    expect(await up("requested_at = 'x'")).toMatch(/forward/);
    expect(await up("audit_ref = 'audit:2'")).toMatch(/forward/);
    expect(await up("requested_by_hmac = '" + "b".repeat(64) + "'")).toMatch(/forward/);
    expect(await up("status = 'dispatched'")).toBe("");
    expect(await up("status = 'dispatched'")).toMatch(/forward/);
    expect(await up("status = 'done', result = 'ran: HTTP 200'")).toBe("");
    for (const s of ["pending", "dispatched", "refused", "expired", "done"]) {
      expect(await up(`status = '${s}'`), s).toMatch(/forward/);
    }
  });

  it("a pending row may go straight to refused or expired", async () => {
    const db = await freshDb("main");
    await db.execute(ins());
    await db.execute(ins({ job_id: "morning" }));
    expect(await fails(db, "UPDATE run_now_request SET status = 'refused' WHERE id = 1")).toBe("");
    expect(await fails(db, "UPDATE run_now_request SET status = 'expired' WHERE id = 2")).toBe("");
  });

  it("deletes only beyond the 90-day floor", async () => {
    const db = await freshDb("main");
    await db.execute(ins());
    await db.execute(ins({ at: "2020-01-01T00:00:00.000Z" }));
    expect(await fails(db, "DELETE FROM run_now_request")).toMatch(/append-only/);
    expect(await fails(db, "DELETE FROM run_now_request WHERE requested_at < '2021-01-01'")).toBe(
      "",
    );
    expect((await db.execute("SELECT COUNT(*) AS n FROM run_now_request")).rows[0]!.n).toBe(1);
  });
});

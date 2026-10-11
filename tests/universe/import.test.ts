// @vitest-environment node
// D-067 universe import against a real local libSQL file: apply rules end to end, run records,
// the shrink incident, idempotency per Sydney date, DAT-130 (delisted kept), and Batch 1 seeing
// the universe. Synthetic ZZ* codes only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importUniverse, universeKey, UNIVERSE_JOB } from "@/lib/data/universe/import";
import { prepareBatch1 } from "@/lib/data/pipeline/batch1";
import { cleanupTempDbs } from "../db/helpers";
import { at1730, pipelineDb } from "../pipeline/helpers";
import { codes, cos, csvOf, instruments, newDb, seedInstruments } from "./helpers";

afterEach(cleanupTempDbs);

const D1 = "2026-10-13";
const D2 = "2026-10-14";
const D3 = "2026-10-15";
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 13, 20, 30, 0) + clock++).toISOString();
const run = (db: Client, csv: string, today = D1) => importUniverse({ db, csv, today, now });
const runs = async (db: Client) =>
  (await db.execute("SELECT * FROM run_record WHERE job = ? ORDER BY id", [UNIVERSE_JOB])).rows.map(
    (r) => ({ ...r }) as Record<string, unknown>,
  );
const incidents = async (db: Client) =>
  (await db.execute("SELECT severity, kind, resolved_at, detail_json FROM incident")).rows.map(
    (r) => ({ ...r }) as Record<string, unknown>,
  );
const row = async (db: Client, code: string) =>
  (await instruments(db)).find((r) => r.code === code);

let db: Client;
beforeEach(async () => {
  clock = 0;
  db = await newDb();
});

describe("first import and idempotency", () => {
  it("inserts every code as active with listed_on = today, and records the run", async () => {
    const r = await run(db, csvOf(cos(10, 0)));
    expect(r).toMatchObject({ ok: true, status: "applied" });
    if (!r.ok || r.status !== "applied") throw new Error("unreachable");
    expect(r.counts).toMatchObject({ file: 10, inserted: 10, prevActive: 0 });
    const list = await instruments(db);
    expect(list).toHaveLength(10);
    expect(list[0]).toMatchObject({
      code: "ZZ00",
      name: "Synthetic ZZ00 Ltd",
      industry: "Materials",
      listed_on: D1,
      delisted_on: null,
      missing_count: 0,
    });
    const rr = await runs(db);
    expect(rr).toHaveLength(1);
    expect(rr[0]).toMatchObject({
      status: "success",
      market: "AU",
      concurrency_key: universeKey(D1),
      scheduled_for: D1,
      items_processed: 10,
      rows_read: 0,
      rows_written: 10,
    });
    expect(JSON.parse(String(rr[0].details_json)).counts.inserted).toBe(10);
  });

  it("a second call for the same Sydney date is a no-op, whatever the file says", async () => {
    await run(db, csvOf(cos(10)));
    const before = await instruments(db);
    const r = await run(db, csvOf([...cos(10), { code: "ZZNEW" }]));
    expect(r).toEqual({ ok: true, status: "already_applied" });
    expect(await instruments(db)).toEqual(before);
    expect(await runs(db)).toHaveLength(1);
  });

  it("two concurrent imports for one date apply once (no double counting)", async () => {
    await seedInstruments(db, cos(10));
    const file = csvOf(cos(9));
    const [a, b] = await Promise.all([run(db, file), run(db, file)]);
    const applied = [a, b].filter((x) => x.ok && x.status === "applied");
    expect(applied).toHaveLength(1);
    expect((await row(db, "ZZ09"))?.missing_count).toBe(1); // counted once, not twice
    expect((await runs(db)).filter((r) => r.status === "success")).toHaveLength(1);
  });

  it("the run record carries counts only: no company name or code", async () => {
    await run(db, csvOf([{ code: "ZZSECRET", name: "Synthetic Hidden Ltd" }]));
    const rr = JSON.stringify(await runs(db));
    expect(rr).not.toContain("ZZSECRET");
    expect(rr).not.toContain("Hidden");
  });
});

describe("apply rules on the database", () => {
  beforeEach(async () => {
    await run(db, csvOf(cos(10)), D1);
  });

  it("changed name or industry is updated; unchanged rows are not written", async () => {
    const list = cos(10);
    list[0] = { code: "ZZ00", name: "Synthetic Renamed Ltd", industry: "Materials" };
    list[1] = { code: "ZZ01", industry: "Banks" };
    const r = await run(db, csvOf(list), D2);
    if (!r.ok || r.status !== "applied") throw new Error("unreachable");
    expect(r.counts).toMatchObject({ updated: 2, unchanged: 8, inserted: 0 });
    expect(await row(db, "ZZ00")).toMatchObject({ name: "Synthetic Renamed Ltd", listed_on: D1 });
    expect(await row(db, "ZZ01")).toMatchObject({ industry: "Banks" });
    expect((await runs(db)).at(-1)).toMatchObject({ rows_written: 2 });
  });

  it("a new code is inserted with listed_on = that day", async () => {
    await run(db, csvOf([...cos(10), { code: "ZZNEW" }]), D2);
    expect(await row(db, "ZZNEW")).toMatchObject({ listed_on: D2, delisted_on: null });
  });

  it("missing once keeps the code active; missing twice in a row delists it (row kept)", async () => {
    await run(db, csvOf(cos(9)), D2);
    expect(await row(db, "ZZ09")).toMatchObject({ delisted_on: null, missing_count: 1 });
    await run(db, csvOf(cos(9)), D3);
    expect(await row(db, "ZZ09")).toMatchObject({
      delisted_on: D3,
      delist_reason: "absent_from_listed_companies",
    });
    expect(await instruments(db)).toHaveLength(10);
    // A delisted row can never be deleted (DAT-130).
    await expect(db.execute("DELETE FROM instrument WHERE code = 'ZZ09'")).rejects.toThrow(
      /forever table/,
    );
  });

  it("a miss that is not consecutive does not delist", async () => {
    await run(db, csvOf(cos(9)), D2);
    await run(db, csvOf(cos(10)), D3); // back: counter resets
    expect(await row(db, "ZZ09")).toMatchObject({ delisted_on: null, missing_count: 0 });
    await run(db, csvOf(cos(9)), "2026-10-16");
    expect(await row(db, "ZZ09")).toMatchObject({ delisted_on: null, missing_count: 1 });
  });

  it("a rejected or failed import does not count as a miss", async () => {
    await run(db, csvOf(cos(9)), D2); // miss 1
    await run(db, "<html>Just a moment</html>", D3); // unrecognised: no change
    expect(await row(db, "ZZ09")).toMatchObject({ delisted_on: null, missing_count: 1 });
  });

  it("a delisted code that returns is reactivated and kept", async () => {
    await run(db, csvOf(cos(9)), D2);
    await run(db, csvOf(cos(9)), D3);
    await run(db, csvOf([...cos(9), { code: "ZZ09", name: "Synthetic Back Ltd" }]), "2026-10-16");
    expect(await row(db, "ZZ09")).toMatchObject({
      name: "Synthetic Back Ltd",
      delisted_on: null,
      delist_reason: null,
      missing_count: 0,
    });
  });
});

describe("rejections", () => {
  it("unrecognised_format: no change, a failed run record, no incident", async () => {
    await seedInstruments(db, cos(5));
    const before = await instruments(db);
    const r = await run(db, "Code,Name\nZZ00,Synthetic\n");
    expect(r).toEqual({ ok: false, error: "unrecognised_format" });
    expect(await instruments(db)).toEqual(before);
    const rr = await runs(db);
    expect(rr).toHaveLength(1);
    expect(rr[0]).toMatchObject({ status: "failed", error_summary: "unrecognised_format" });
    expect(await incidents(db)).toEqual([]);
  });

  it("suspicious_shrink: nothing changes, failed run, S2 universe_shrink incident (once while open)", async () => {
    await seedInstruments(db, cos(10));
    const before = await instruments(db);
    const r = await run(db, csvOf(cos(7)), D2); // 70 % < 80 %
    expect(r).toEqual({ ok: false, error: "suspicious_shrink" });
    expect(await instruments(db)).toEqual(before); // not even the missing counters
    expect((await runs(db))[0]).toMatchObject({
      status: "failed",
      error_summary: "suspicious_shrink",
    });
    const inc = await incidents(db);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S2", kind: "universe_shrink", resolved_at: null });
    expect(JSON.parse(String(inc[0].detail_json))).toEqual({
      rule: "universe_shrink",
      prevActive: 10,
      fileCount: 7,
    });
    await run(db, csvOf(cos(6)), D3);
    expect(await incidents(db)).toHaveLength(1); // one open incident per kind
  });

  it("exactly 80 % is accepted", async () => {
    await seedInstruments(db, cos(10));
    expect((await run(db, csvOf(cos(8)))).ok).toBe(true);
  });

  it("after a rejection the same date can still be imported with a good file", async () => {
    await seedInstruments(db, cos(10));
    await run(db, csvOf(cos(3)));
    const r = await run(db, csvOf(cos(10)));
    expect(r).toMatchObject({ ok: true, status: "applied" });
    expect((await runs(db)).map((x) => x.status)).toEqual(["failed", "success"]);
  });

  it("a database fault is `unavailable`, never a throw", async () => {
    await db.execute("DROP TABLE run_record");
    expect(await run(db, csvOf(cos(3)))).toEqual({ ok: false, error: "unavailable" });
  });

  it("a fault while applying leaves the instruments unchanged and the run failed", async () => {
    await seedInstruments(db, cos(10));
    // Make the batch fail midway: a trigger refuses the update of one code.
    await db.execute(
      "CREATE TRIGGER boom BEFORE UPDATE ON instrument WHEN NEW.code = 'ZZ09' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const before = await instruments(db);
    const r = await run(db, csvOf(cos(9)));
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(await instruments(db)).toEqual(before);
    expect((await runs(db)).at(-1)).toMatchObject({ status: "failed", error_summary: "db_error" });
  });
});

describe("Batch 1 sees the universe", () => {
  it("imported codes are fetched; a delisted code drops out from its delisting date", async () => {
    const pdb = await pipelineDb({ codes: [] });
    await importUniverse({ db: pdb, csv: csvOf(cos(10)), today: D1, now });
    const prep = await prepareBatch1(pdb, { nowMs: at1730(D1) });
    expect(prep).toMatchObject({ action: "fetch", codes: 10 });
    if (prep.action !== "fetch") throw new Error("unreachable");
    expect(prep.request.codes).toEqual(codes(10));

    await importUniverse({ db: pdb, csv: csvOf(cos(9)), today: D2, now });
    await importUniverse({ db: pdb, csv: csvOf(cos(9)), today: D3, now });
    const later = await prepareBatch1(pdb, { nowMs: at1730(D3) });
    if (later.action !== "fetch") throw new Error("unreachable");
    expect(later.request.codes).toEqual(codes(9)); // ZZ09 delisted on D3
  });
});

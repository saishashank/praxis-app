// @vitest-environment node
// Should-fix batch A, V1-S7 (ARN-082, DAT-130): a delisted code that returns after a long gap, or under
// a different name after a real absence, may be a different company. It is quarantined (stays delisted,
// out of every universe read), an S2 incident is opened, and only the Owner (audited) can confirm that
// it is the same company, after which the next import reactivates it. A quick return is unchanged.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmRelisting } from "@/lib/data/relist";
import {
  normaliseName,
  planUniverse,
  RELIST_CONFIRMED,
  RENAME_GAP_DAYS,
  REUSE_GAP_DAYS,
  REUSE_SUSPECTED,
  reuseSuspicion,
  type ExistingInstrument,
} from "@/lib/data/universe/apply.mjs";
import { CODE_REUSE_INCIDENT, importUniverse } from "@/lib/data/universe/import";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { cos, csvOf, instruments, newDb, seedInstruments } from "./helpers";

afterEach(cleanupTempDbs);

const ex = (over: Partial<ExistingInstrument> = {}): ExistingInstrument => ({
  code: "ZZ09",
  name: "Synthetic ZZ09 Ltd",
  industry: "Materials",
  delistedOn: "2026-01-01",
  missingCount: 2,
  delistReason: "absent_from_listed_companies",
  ...over,
});

describe("reuseSuspicion (pure)", () => {
  it("constants and name normalisation", () => {
    expect(REUSE_GAP_DAYS).toBe(365);
    expect(RENAME_GAP_DAYS).toBe(30);
    expect(normaliseName("Synthetic  ZZ09, Limited")).toBe(normaliseName("SYNTHETIC ZZ09 LTD"));
    expect(normaliseName("Alpha Pty Ltd")).not.toBe(normaliseName("Beta Pty Ltd"));
  });
  it("a quick return, with or without a rename, is the same company", () => {
    expect(reuseSuspicion(ex(), { name: "Synthetic ZZ09 Ltd" }, "2026-01-05")).toBeNull();
    expect(reuseSuspicion(ex(), { name: "Renamed Co" }, "2026-01-20")).toBeNull();
  });
  it("a rename after a real absence, or any return after more than a year, is suspect", () => {
    expect(reuseSuspicion(ex(), { name: "Renamed Co" }, "2026-03-01")).toBe("name_changed");
    expect(reuseSuspicion(ex(), { name: "Synthetic ZZ09 Ltd" }, "2026-06-01")).toBeNull();
    expect(reuseSuspicion(ex(), { name: "Synthetic ZZ09 Ltd" }, "2027-01-02")).toBe("long_gap");
    expect(reuseSuspicion(ex(), { name: "Synthetic ZZ09 Ltd" }, "2027-01-01")).toBeNull();
  });
  it("an Owner-confirmed relisting is never suspect again", () => {
    const confirmed = ex({ delistReason: `${RELIST_CONFIRMED}:audit:7:absent` });
    expect(reuseSuspicion(confirmed, { name: "Renamed Co" }, "2030-01-01")).toBeNull();
  });
  it("planUniverse routes it to `quarantined`, not `reactivations`; counts are unchanged in shape", () => {
    const file = [
      { code: "ZZ09", name: "Other Company", industry: "Energy" },
      { code: "ZZ00", name: "Synthetic ZZ00 Ltd", industry: "Materials" },
    ];
    const existing = [
      ex(),
      ex({ code: "ZZ00", delistedOn: null, missingCount: 0, delistReason: null }),
    ];
    const p = planUniverse({ existing, file, today: "2026-06-01" });
    if (!p.ok) throw new Error("expected ok");
    expect(p.reactivations).toEqual([]);
    expect(p.quarantined).toEqual([
      {
        code: "ZZ09",
        name: "Other Company",
        oldName: "Synthetic ZZ09 Ltd",
        delistedOn: "2026-01-01",
        priorReason: "absent_from_listed_companies",
        why: "name_changed",
      },
    ]);
    expect(p.counts.reactivated).toBe(0);
  });
});

describe("import and the Owner decision", () => {
  let db: Client;
  let clock = 0;
  const now = () => new Date(Date.UTC(2027, 0, 5, 20, 30, 0) + clock++).toISOString();
  const run = (csv: string, today: string) => importUniverse({ db, csv, today, now });
  const row = async (code: string) => (await instruments(db)).find((r) => r.code === code)!;
  const incidents = async () =>
    (
      await db.execute("SELECT severity, kind, detail_json FROM incident WHERE kind = ?", [
        CODE_REUSE_INCIDENT,
      ])
    ).rows;

  beforeEach(async () => {
    clock = 0;
    db = await newDb();
    await seedInstruments(db, cos(10));
    await db.execute({
      sql: `UPDATE instrument SET delisted_on = '2025-06-01', delist_reason = 'absent_from_listed_companies',
            missing_count = 2 WHERE code = 'ZZ09'`,
    });
  });

  it("a code back after more than a year stays delisted with the old reason kept, and opens one S2 incident", async () => {
    const csv = csvOf([...cos(9), { code: "ZZ09", name: "A Different Business Ltd" }]);
    const r = await run(csv, "2027-01-05");
    expect(r).toMatchObject({ ok: true, status: "applied" });
    expect(await row("ZZ09")).toMatchObject({
      name: "Synthetic ZZ09 Ltd", // not overwritten with the new entity's name
      delisted_on: "2025-06-01",
      delist_reason: `${REUSE_SUSPECTED}:absent_from_listed_companies`,
    });
    const inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S2" });
    expect(JSON.parse(String(inc[0]!.detail_json))).toMatchObject({
      codes: [{ code: "ZZ09", why: "long_gap" }],
      count: 1,
    });
    // the next day nothing new is written and no second incident opens
    await run(csv, "2027-01-06");
    expect((await row("ZZ09")).delist_reason).toBe(
      `${REUSE_SUSPECTED}:absent_from_listed_companies`,
    );
    expect(await incidents()).toHaveLength(1);
  });

  it("a quick return is still reactivated exactly as before", async () => {
    await db.execute("UPDATE instrument SET delisted_on = '2027-01-01' WHERE code = 'ZZ09'");
    await run(csvOf([...cos(9), { code: "ZZ09", name: "Synthetic Back Ltd" }]), "2027-01-05");
    expect(await row("ZZ09")).toMatchObject({
      name: "Synthetic Back Ltd",
      delisted_on: null,
      delist_reason: null,
    });
    expect(await incidents()).toEqual([]);
  });

  describe("Owner confirmation", () => {
    let auth: Client;
    let ownerId: number;
    let editorId: number;
    const call = (over: Record<string, unknown> = {}) =>
      confirmRelisting({
        mainDb: db,
        authDb: auth,
        env: { PII_HASH_KEY: KEY } as Record<string, string | undefined>,
        actorId: ownerId,
        now: new Date("2027-01-05T01:00:00Z"),
        code: "ZZ09",
        confirm: true,
        ...over,
      } as never);
    const csv = () => csvOf([...cos(9), { code: "ZZ09", name: "A Different Business Ltd" }]);

    beforeEach(async () => {
      auth = await freshDb("auth");
      ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
      editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
      await run(csv(), "2027-01-05");
    });

    it("is audited first, changes only the reason, and the next import reactivates the code", async () => {
      expect(await call()).toEqual({ ok: true, changed: true });
      const audit = (await auditRows(auth)).filter((a) => a.action === "data.relisting_confirmed");
      expect(audit).toHaveLength(1);
      const r = await row("ZZ09");
      expect(String(r.delist_reason)).toMatch(
        new RegExp(`^${RELIST_CONFIRMED}:audit:\\d+:absent_from_listed_companies$`),
      );
      expect(r.delisted_on).toBe("2025-06-01"); // still delisted until the next import
      await run(csv(), "2027-01-06");
      expect(await row("ZZ09")).toMatchObject({
        name: "A Different Business Ltd",
        delisted_on: null,
        delist_reason: null,
      });
      expect(await call()).toEqual({ ok: false, error: "not_available" }); // nothing left to confirm
    });

    it("is idempotent while confirmed, and refuses a non-Owner, no confirmation, bad or unknown or untouched codes", async () => {
      expect(await call({ actorId: editorId })).toEqual({ ok: false, error: "forbidden" });
      expect(await call({ confirm: false })).toEqual({ ok: false, error: "confirm_required" });
      expect(await call({ code: "zz09" })).toEqual({ ok: false, error: "invalid" });
      expect(await call({ code: "NOPE" })).toEqual({ ok: false, error: "unknown_code" });
      expect(await call({ code: "ZZ01" })).toEqual({ ok: false, error: "not_available" }); // active code
      expect(await auditRows(auth)).toEqual([]);
      expect(await call()).toEqual({ ok: true, changed: true });
      expect(await call()).toEqual({ ok: true, changed: false });
      expect(
        (await auditRows(auth)).filter((a) => a.action === "data.relisting_confirmed"),
      ).toHaveLength(1);
    });
  });
});

// @vitest-environment node
// U1 gate (M2 T7): entriesAllowed / exitsAllowed, read-only (DAT-210, DAT-004, DAT-127).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entriesAllowed, exitsAllowed } from "@/lib/data/quality/gate";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const D = "2026-10-13";
const score = (gate: 0 | 1, d = D, market = "AU") =>
  db.execute({
    sql: `INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass)
          VALUES (?, ?, 'U1', 1, 1, 1, ?)`,
    args: [market, d, gate],
  });
const flag = (code: string | null, blocks: 0 | 1, over: { cleared?: boolean; d?: string } = {}) =>
  db.execute({
    sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at, cleared_at, blocks_entries)
          VALUES ('AU', ?, ?, 'DAT-210-x', 'error', '2026-10-13T07:00:00.000Z', ?, ?)`,
    args: [code, over.d ?? D, over.cleared ? "2026-10-13T08:00:00.000Z" : null, blocks],
  });
const counts = async () => [
  (await db.execute("SELECT COUNT(*) AS c FROM data_quality_flag")).rows[0].c,
  (await db.execute("SELECT COUNT(*) AS c FROM quality_score")).rows[0].c,
];

describe("entriesAllowed", () => {
  it("no stored U1 score for the date: blocked, nothing is assumed good (DAT-004)", async () => {
    expect(await entriesAllowed(db, "ZZA", D)).toEqual({
      allowed: false,
      reason: "no_quality_score",
    });
    await score(1, "2026-10-12");
    expect(await entriesAllowed(db, "ZZA", D)).toMatchObject({ reason: "no_quality_score" });
    await score(1, D, "IN");
    expect(await entriesAllowed(db, "ZZA", D)).toMatchObject({ reason: "no_quality_score" });
  });

  it("a passing gate with no flag allows the entry", async () => {
    await score(1);
    expect(await entriesAllowed(db, "ZZA", D)).toEqual({ allowed: true, reason: "ok" });
  });

  it("a failed gate blocks every code", async () => {
    await score(0);
    expect(await entriesAllowed(db, "ZZA", D)).toEqual({
      allowed: false,
      reason: "u1_gate_failed",
    });
    expect(await entriesAllowed(db, "ZZZ", D)).toMatchObject({ allowed: false });
  });

  it("an open blocking flag blocks that code and date only", async () => {
    await score(1);
    await score(1, "2026-10-14");
    await flag("ZZA", 1);
    expect(await entriesAllowed(db, "ZZA", D)).toEqual({ allowed: false, reason: "code_blocked" });
    expect(await entriesAllowed(db, "ZZB", D)).toMatchObject({ allowed: true });
    expect(await entriesAllowed(db, "ZZA", "2026-10-14")).toMatchObject({ allowed: true });
  });

  it("cleared and non-blocking flags do not block", async () => {
    await score(1);
    await flag("ZZA", 1, { cleared: true });
    await flag("ZZB", 0);
    expect(await entriesAllowed(db, "ZZA", D)).toMatchObject({ allowed: true });
    expect(await entriesAllowed(db, "ZZB", D)).toMatchObject({ allowed: true });
  });

  it("is read-only", async () => {
    await score(1);
    await flag("ZZA", 1);
    const before = await counts();
    await entriesAllowed(db, "ZZA", D);
    await entriesAllowed(db, "ZZB", D);
    expect(await counts()).toEqual(before);
  });
});

describe("exitsAllowed", () => {
  it("is always true: exits are never blocked (DAT-210, AT-07)", async () => {
    expect(exitsAllowed()).toBe(true);
    await score(0);
    await flag("ZZA", 1);
    expect(exitsAllowed()).toBe(true);
  });
});

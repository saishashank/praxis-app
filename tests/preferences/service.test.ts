// @vitest-environment node
// UX-110, UXN-280, ROL-102a, DAT-150, ROL-104: personal preferences service.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditKey, verifyAuditChain } from "@/lib/db/audit";
import { DEFAULT_PREFERENCES, getPreferences, updatePreferences } from "@/lib/preferences/service";
import { cleanupTempDbs } from "../db/helpers";
import { addUser, auditRows, authDb, ENV, KEY, NOW } from "../auth/helpers";

afterEach(cleanupTempDbs);

let db: Client;
let uid: number;
let other: number;
const META = { ip: "1.1.1.1", userAgent: "ua" };
const upd = (patch: unknown, id = uid) => updatePreferences(db, ENV, META, { id }, patch, NOW);
const stored = async (id: number) =>
  (await db.execute({ sql: "SELECT * FROM user_preference WHERE user_id = ?", args: [id] })).rows;

beforeEach(async () => {
  db = await authDb();
  uid = await addUser(db, { email: "v@example.test", role: "viewer" });
  other = await addUser(db, { email: "e@example.test", role: "editor" });
});

describe("defaults and merge", () => {
  it("returns the spec defaults when nothing is stored", async () => {
    expect(await getPreferences(db, uid)).toEqual({
      theme: "dark",
      default_market: "AU",
      time_format: "24h",
      alert_p1: "immediate",
      alert_p2: "digest",
    });
    expect(DEFAULT_PREFERENCES.theme).toBe("dark");
  });

  it("merges stored values over defaults and ignores bad stored values", async () => {
    await db.execute({
      sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)",
      args: [uid, JSON.stringify({ theme: "dim", time_format: "bogus", extra: 1 }), "x"],
    });
    expect(await getPreferences(db, uid)).toMatchObject({
      theme: "dim",
      time_format: "24h",
      default_market: "AU",
    });
  });

  it("falls back to defaults for unreadable stored JSON", async () => {
    for (const bad of ["{not json", "[]", "null", "5"]) {
      await db.execute({ sql: "DELETE FROM user_preference WHERE user_id = ?", args: [uid] });
      await db.execute({
        sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)",
        args: [uid, bad, "x"],
      });
      expect(await getPreferences(db, uid)).toEqual(DEFAULT_PREFERENCES);
    }
  });

  it("returns defaults for an unknown user id", async () => {
    expect(await getPreferences(db, 9999)).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("updatePreferences", () => {
  it("accepts every theme, both time formats and both digest options", async () => {
    for (const theme of ["dark", "light", "system", "midnight", "dim", "high_contrast"]) {
      expect(await upd({ theme })).toMatchObject({ ok: true });
      expect((await getPreferences(db, uid)).theme).toBe(theme);
    }
    for (const time_format of ["12h", "24h"]) {
      expect(await upd({ time_format })).toMatchObject({ ok: true });
    }
    expect(await upd({ alert_p1: "digest", alert_p2: "immediate" })).toMatchObject({ ok: true });
    expect(await getPreferences(db, uid)).toMatchObject({
      alert_p1: "digest",
      alert_p2: "immediate",
    });
  });

  it("writes the row and one audit event naming only the changed fields", async () => {
    const r = await upd({ theme: "light", time_format: "12h", default_market: "AU" });
    expect(r).toEqual({ ok: true, changed: ["theme", "time_format"] });
    const rows = await stored(uid);
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toBe(NOW.toISOString());
    expect(JSON.parse(String(rows[0].prefs_json))).toEqual({
      theme: "light",
      default_market: "AU",
      time_format: "12h",
      alert_p1: "immediate",
      alert_p2: "digest",
    });
    const audits = await auditRows(db);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "user.preferences_update",
      actor_user_id: uid,
      target_type: "user_preference",
      target_id: String(uid),
      ip: "1.1.1.1",
      user_agent: "ua",
    });
    expect(audits[0].detail).toEqual({ changed: ["theme", "time_format"] });
    expect(await verifyAuditChain(db, auditKey(KEY))).toBeNull();
  });

  it("a second update keeps earlier changes and replaces the row", async () => {
    await upd({ theme: "midnight" });
    expect(await upd({ time_format: "12h" })).toEqual({ ok: true, changed: ["time_format"] });
    expect(await getPreferences(db, uid)).toMatchObject({ theme: "midnight", time_format: "12h" });
    expect(await stored(uid)).toHaveLength(1);
  });

  it("an empty or no-op patch succeeds without a write or an audit event", async () => {
    expect(await upd({})).toEqual({ ok: true, changed: [] });
    expect(await upd({ theme: "dark" })).toEqual({ ok: true, changed: [] });
    expect(await stored(uid)).toHaveLength(0);
    expect(await auditRows(db)).toHaveLength(0);
  });

  it.each([
    ["theme", "neon"],
    ["theme", 3],
    ["theme", null],
    ["default_market", "US"],
    ["default_market", "au"],
    ["time_format", "36h"],
    ["alert_p1", "off"],
    ["alert_p2", "never"],
    ["alert_p2", true],
  ])("rejects %s = %j", async (k, v) => {
    expect(await upd({ [k]: v })).toEqual({ ok: false, error: "invalid" });
    expect(await stored(uid)).toHaveLength(0);
    expect(await auditRows(db)).toHaveLength(0);
  });

  it("rejects unknown fields (including userId and any P0 setting) and non-objects", async () => {
    for (const patch of [
      { theme: "light", userId: other },
      { user_id: other },
      { alert_p0: "digest" },
      { alert_p0: "immediate" },
      { __proto__x: 1 },
      null,
      [],
      "theme",
      42,
      undefined,
    ]) {
      expect(await upd(patch)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await stored(uid)).toHaveLength(0);
    expect(await stored(other)).toHaveLength(0);
  });

  it("one bad field rejects the whole patch", async () => {
    expect(await upd({ theme: "light", time_format: "bad" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect((await getPreferences(db, uid)).theme).toBe("dark");
  });

  it("only ever touches the actor's own row", async () => {
    await upd({ theme: "light" });
    expect(await stored(other)).toHaveLength(0);
    expect((await getPreferences(db, other)).theme).toBe("dark");
  });

  it("refuses a missing or non-active actor", async () => {
    expect(await upd({ theme: "light" }, 9999)).toEqual({ ok: false, error: "forbidden" });
    const gone = await addUser(db, { email: "g@example.test", status: "revoked" });
    expect(await upd({ theme: "light" }, gone)).toEqual({ ok: false, error: "forbidden" });
    expect(await auditRows(db)).toHaveLength(0);
  });

  it("rolls back the preference when the audit append fails", async () => {
    const bad = { ...ENV, PII_HASH_KEY: undefined };
    const r = await updatePreferences(db, bad, META, { id: uid }, { theme: "light" }, NOW);
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(await stored(uid)).toHaveLength(0);
    await db.execute("DROP TABLE audit_event"); // a real SQL failure inside the transaction
    expect(await upd({ theme: "light" })).toEqual({ ok: false, error: "unavailable" });
    expect(await stored(uid)).toHaveLength(0);
  });

  it("reports unavailable when no transaction can start", async () => {
    const broken = { transaction: () => Promise.reject(new Error("down")) } as unknown as Client;
    expect(
      await updatePreferences(broken, ENV, META, { id: uid }, { theme: "light" }, NOW),
    ).toEqual({ ok: false, error: "unavailable" });
  });
});

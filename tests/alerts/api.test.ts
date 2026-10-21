// @vitest-environment node
// M5 T6 (UX-052, UXN-157/160/161/251, ROL-102a, ROL-104; D-096 decision 32; D-101): the alert
// inbox back end. Acknowledge, snooze and quiet hours are per user (auth database, own rows only),
// audited in the same transaction, and quiet hours / snooze / the digest preference hide P1/P2
// from the badge only: P0 and the regime P1 are never hidden and cannot be snoozed.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ackAlert,
  countsInBadge,
  getQuietHours,
  inQuietHours,
  listInbox,
  melbourneMinute,
  parseQuietHours,
  setQuietHours,
  snoozeAlert,
  SNOOZE_MAX_DAYS,
  type ActionDeps,
} from "@/lib/alerts/api";
import { updatePreferences } from "@/lib/preferences/service";
import { addUser, auditRows, authDb as freshAuth, ENV as AUTH_ENV } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

// 2026-10-19 12:00 UTC = 23:00 AEDT (inside a 22:00-07:00 window); 02:00 UTC = 13:00 AEDT (outside).
const NIGHT = new Date("2026-10-19T12:00:00.000Z");
const DAY = new Date("2026-10-19T02:00:00.000Z");
const P0 = "ann:AU:asx_announcements:p0";
const P1 = "ann:AU:asx_announcements:p1";
const P2 = "ann:AU:asx_announcements:p2";
const REGIME = "regime:AU:2026-10-19";

let main: Client;
let auth: Client;
let a: number; // viewer
let b: number; // editor
let clock: Date;
const deps = (): ActionDeps => ({
  mainDb: main,
  authDb: auth,
  env: AUTH_ENV,
  meta: { ip: "1.1.1.1", userAgent: "ua" },
  now: () => clock,
});

async function seedAlert(key: string, tier: string, kind: string, at = DAY) {
  await main.execute({
    sql: `INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, facts_json)
          VALUES (?, 'AU', ?, ?, ?, ?, '{"rule":"r","why":"w","executions":[]}')`,
    args: [key, kind === "regime_shift" ? null : "ZZAA", kind, tier, at.toISOString()],
  });
}
const state = async (user: number, key: string) =>
  (
    await auth.execute({
      sql: "SELECT * FROM alert_user_state WHERE user_id = ? AND alert_key = ?",
      args: [user, key],
    })
  ).rows[0];
const inboxOf = (user: number, o = {}, now = NIGHT) =>
  listInbox({ mainDb: main, authDb: auth }, user, o, now);

beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshAuth();
  a = await addUser(auth, { email: "v@example.test", role: "viewer" });
  b = await addUser(auth, { email: "e@example.test", role: "editor" });
  clock = new Date(NIGHT);
  await seedAlert(P0, "P0", "halt");
  await seedAlert(P1, "P1", "announcement");
  await seedAlert(P2, "P2", "announcement");
  await seedAlert(REGIME, "P1", "regime_shift");
});

describe("acknowledge (own rows, final, audited)", () => {
  it("records the acknowledgement for this user only, with one audit event", async () => {
    const r = await ackAlert(deps(), { id: a }, P1);
    expect(r).toMatchObject({ ok: true, changed: true, ackedAt: NIGHT.toISOString() });
    expect((await state(a, P1)).acked_at).toBe(NIGHT.toISOString());
    expect(await state(b, P1)).toBeUndefined(); // another user's state is untouched
    const audits = (await auditRows(auth)).filter((x) => x.action === "alert.ack");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: a, target_type: "alert", target_id: P1 });
  });

  it("is idempotent: a second acknowledgement changes nothing and writes no second audit", async () => {
    await ackAlert(deps(), { id: a }, P1);
    clock = new Date(NIGHT.getTime() + 60_000);
    const again = await ackAlert(deps(), { id: a }, P1);
    expect(again).toMatchObject({ ok: true, changed: false, ackedAt: NIGHT.toISOString() });
    expect((await auditRows(auth)).filter((x) => x.action === "alert.ack")).toHaveLength(1);
  });

  it("an acknowledgement can never be undone (database trigger)", async () => {
    await ackAlert(deps(), { id: a }, P1);
    await expect(
      auth.execute({
        sql: "UPDATE alert_user_state SET acked_at = NULL WHERE user_id = ? AND alert_key = ?",
        args: [a, P1],
      }),
    ).rejects.toThrow();
  });

  it("refuses unknown alerts, malformed keys and inactive users", async () => {
    expect(await ackAlert(deps(), { id: a }, "ann:AU:asx_announcements:nope")).toEqual({
      ok: false,
      error: "not_found",
    });
    for (const bad of ["", "p0:x", "ann: bad", "x".repeat(400)]) {
      expect(await ackAlert(deps(), { id: a }, bad), bad).toEqual({ ok: false, error: "invalid" });
    }
    const gone = await addUser(auth, {
      email: "r@example.test",
      role: "viewer",
      status: "revoked",
    });
    expect(await ackAlert(deps(), { id: gone }, P1)).toEqual({ ok: false, error: "forbidden" });
    expect(await state(gone, P1)).toBeUndefined();
  });

  it("a P0 can be acknowledged (it just can never be hidden or snoozed)", async () => {
    expect(await ackAlert(deps(), { id: a }, P0)).toMatchObject({ ok: true });
  });
});

describe("snooze (P1/P2 only)", () => {
  const until = (days: number) => new Date(NIGHT.getTime() + days * 86_400_000).toISOString();

  it("sets, moves and clears a snooze for this user, with audit", async () => {
    const r = await snoozeAlert(deps(), { id: a }, P2, until(2));
    expect(r).toEqual({ ok: true, snoozedUntil: until(2) });
    expect((await state(a, P2)).snoozed_until).toBe(until(2));
    expect(await state(b, P2)).toBeUndefined();
    await snoozeAlert(deps(), { id: a }, P2, until(3));
    expect((await state(a, P2)).snoozed_until).toBe(until(3));
    expect(await snoozeAlert(deps(), { id: a }, P2, null)).toEqual({
      ok: true,
      snoozedUntil: null,
    });
    expect((await state(a, P2)).snoozed_until).toBeNull();
    const audits = (await auditRows(auth)).filter((x) => x.action === "alert.snooze");
    expect(audits).toHaveLength(3);
    expect(audits[2].detail).toEqual({ cleared: true });
  });

  it("refuses a P0 and the regime P1: they can never be silenced (UXN-160, UXN-251)", async () => {
    for (const key of [P0, REGIME]) {
      expect(await snoozeAlert(deps(), { id: a }, key, until(1)), key).toEqual({
        ok: false,
        error: "not_snoozable",
      });
      expect(await state(a, key)).toBeUndefined();
    }
  });

  it("refuses a past time, a time beyond the maximum and a non-date", async () => {
    for (const bad of [until(-1), until(SNOOZE_MAX_DAYS + 1), "tomorrow", NIGHT.toISOString()]) {
      expect(await snoozeAlert(deps(), { id: a }, P2, bad), bad).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await snoozeAlert(deps(), { id: a }, P2, until(SNOOZE_MAX_DAYS))).toMatchObject({
      ok: true,
    });
  });

  it("a snooze keeps an earlier acknowledgement (and an acknowledgement keeps the snooze)", async () => {
    await ackAlert(deps(), { id: a }, P2);
    await snoozeAlert(deps(), { id: a }, P2, until(1));
    const s = await state(a, P2);
    expect(s.acked_at).toBe(NIGHT.toISOString());
    expect(s.snoozed_until).toBe(until(1));
  });
});

describe("quiet hours (stored in the validated prefs_json)", () => {
  it("validates, stores per user, audits and reads back", async () => {
    expect(parseQuietHours({ start: "22:00", end: "07:00" })).toEqual({
      start: "22:00",
      end: "07:00",
    });
    for (const bad of [
      null,
      {},
      { start: "22:00" },
      { start: "22:00", end: "22:00" },
      { start: "24:00", end: "07:00" },
      { start: "7:00", end: "08:00" },
      { start: 1, end: 2 },
    ]) {
      expect(parseQuietHours(bad), JSON.stringify(bad)).toBeNull();
    }
    const r = await setQuietHours(deps(), { id: a }, { start: "22:00", end: "07:00" });
    expect(r).toEqual({ ok: true, quietHours: { start: "22:00", end: "07:00" } });
    expect(await getQuietHours(auth, a)).toEqual({ start: "22:00", end: "07:00" });
    expect(await getQuietHours(auth, b)).toBeNull(); // per user
    const audits = (await auditRows(auth)).filter((x) => x.action === "alert.quiet_hours");
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toEqual({ cleared: false }); // names the change, never the values
    expect(await setQuietHours(deps(), { id: a }, { start: "08:00", end: "08:00" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await setQuietHours(deps(), { id: a }, undefined)).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await setQuietHours(deps(), { id: a }, null)).toEqual({ ok: true, quietHours: null });
    expect(await getQuietHours(auth, a)).toBeNull();
  });

  it("survives a later change of the D-048 preferences and does not disturb them", async () => {
    await setQuietHours(deps(), { id: a }, { start: "22:00", end: "07:00" });
    const u = await updatePreferences(
      auth,
      AUTH_ENV,
      undefined,
      { id: a },
      { theme: "dim" },
      NIGHT,
    );
    expect(u).toMatchObject({ ok: true });
    expect(await getQuietHours(auth, a)).toEqual({ start: "22:00", end: "07:00" });
    const raw = await auth.execute({
      sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
      args: [a],
    });
    expect(JSON.parse(String(raw.rows[0].prefs_json))).toMatchObject({ theme: "dim" });
  });

  it("window arithmetic: Melbourne local time, wrapping midnight, end exclusive", () => {
    expect(melbourneMinute(NIGHT)).toBe(23 * 60);
    const q = { start: "22:00", end: "07:00" };
    expect(inQuietHours(NIGHT, q)).toBe(true);
    expect(inQuietHours(DAY, q)).toBe(false);
    expect(inQuietHours(new Date("2026-10-18T20:00:00.000Z"), q)).toBe(false); // 07:00 AEDT: end
    expect(inQuietHours(new Date("2026-10-18T19:59:00.000Z"), q)).toBe(true); // 06:59
    const day = { start: "09:00", end: "17:00" };
    expect(inQuietHours(DAY, day)).toBe(true);
    expect(inQuietHours(NIGHT, day)).toBe(false);
    expect(inQuietHours(NIGHT, null)).toBe(false);
  });
});

describe("the unread badge", () => {
  const prefs = { alert_p1: "immediate", alert_p2: "immediate" };
  const q = { start: "22:00", end: "07:00" };
  const item = (
    tier: "P0" | "P1" | "P2",
    kind: "announcement" | "regime_shift" = "announcement",
  ) => ({
    tier,
    kind,
    ackedAt: null,
    snoozedUntil: null,
  });

  it("quiet hours hide P1/P2 only: P0 and the regime P1 still count", () => {
    expect(countsInBadge(item("P0"), prefs, q, NIGHT)).toBe(true);
    expect(countsInBadge(item("P1", "regime_shift"), prefs, q, NIGHT)).toBe(true);
    expect(countsInBadge(item("P1"), prefs, q, NIGHT)).toBe(false);
    expect(countsInBadge(item("P2"), prefs, q, NIGHT)).toBe(false);
    expect(countsInBadge(item("P1"), prefs, q, DAY)).toBe(true); // outside the window
  });

  it("snooze and the digest preference hide P1/P2 only", () => {
    const snoozed = {
      ...item("P1"),
      snoozedUntil: new Date(NIGHT.getTime() + 3_600_000).toISOString(),
    };
    expect(countsInBadge(snoozed, prefs, null, NIGHT)).toBe(false);
    const expired = { ...item("P1"), snoozedUntil: new Date(NIGHT.getTime() - 1).toISOString() };
    expect(countsInBadge(expired, prefs, null, NIGHT)).toBe(true);
    expect(countsInBadge(item("P2"), { ...prefs, alert_p2: "digest" }, null, NIGHT)).toBe(false);
    expect(countsInBadge(item("P0"), { alert_p1: "digest", alert_p2: "digest" }, q, NIGHT)).toBe(
      true,
    );
    expect(
      countsInBadge(
        item("P1", "regime_shift"),
        { alert_p1: "digest", alert_p2: "digest" },
        q,
        NIGHT,
      ),
    ).toBe(true);
  });

  it("an acknowledged alert never counts", () => {
    expect(countsInBadge({ ...item("P0"), ackedAt: "x" }, prefs, null, NIGHT)).toBe(false);
  });

  it("end to end per user: defaults (P1 immediate, P2 digest), quiet hours, snooze, ack", async () => {
    // defaults at night with no quiet hours: P0 + regime + P1 count; P2 (digest) does not
    expect((await inboxOf(a)).badge).toBe(3);
    await setQuietHours(deps(), { id: a }, q);
    expect((await inboxOf(a)).badge).toBe(2); // P0 and the regime P1 only
    expect((await inboxOf(b)).badge).toBe(3); // the other user has no quiet hours
    expect((await inboxOf(a, {}, DAY)).badge).toBe(3);
    await setQuietHours(deps(), { id: a }, null);
    const hourLater = new Date(NIGHT.getTime() + 3_600_000);
    await snoozeAlert(deps(), { id: a }, P1, hourLater.toISOString());
    expect((await inboxOf(a)).badge).toBe(2); // the snoozed P1 is out of the badge
    expect((await inboxOf(a, {}, new Date(NIGHT.getTime() + 7_200_000))).badge).toBe(3); // expired
    await ackAlert(deps(), { id: a }, P0);
    expect((await inboxOf(a)).badge).toBe(1);
    expect((await inboxOf(b)).badge).toBe(3);
  });
});

describe("the inbox list", () => {
  it("filters by tier and by unacknowledged, shows per-user state and rules text, newest first", async () => {
    await seedAlert(
      "ann:AU:asx_announcements:new",
      "P1",
      "announcement",
      new Date(DAY.getTime() + 1000),
    );
    await ackAlert(deps(), { id: a }, P1);
    const all = await inboxOf(a);
    expect(all.alerts.map((x) => x.key)).toEqual([
      "ann:AU:asx_announcements:new",
      // the rest share a detection instant; order falls back to the key, descending
      REGIME,
      P2,
      P1,
      P0,
    ]);
    expect(all.alerts.find((x) => x.key === P1)?.ackedAt).toBe(NIGHT.toISOString());
    expect(all.alerts.find((x) => x.key === P0)?.text).toContain("P0");
    const p1 = await inboxOf(a, { tier: "P1" });
    expect(new Set(p1.alerts.map((x) => x.tier))).toEqual(new Set(["P1"]));
    expect(p1.badge).toBe((await inboxOf(a)).badge); // the badge ignores the list filter
    const un = await inboxOf(a, { unacked: true });
    expect(un.alerts.some((x) => x.key === P1)).toBe(false);
    expect((await inboxOf(b, { unacked: true })).alerts.some((x) => x.key === P1)).toBe(true);
  });

  it("alerts older than the badge window are not listed", async () => {
    await seedAlert(
      "ann:AU:asx_announcements:old",
      "P2",
      "announcement",
      new Date("2026-09-01T00:00:00Z"),
    );
    expect((await inboxOf(a)).alerts.some((x) => x.key.endsWith(":old"))).toBe(false);
  });
});

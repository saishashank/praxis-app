// @vitest-environment node
// M21 C3 (UXN-322, D-1207; AT-82): the per-alert unmute on a migrated test DB. A muted alert comes back by
// APPENDING one `armed` row (seq + 1); nothing is updated or deleted. Every other cleared reason stays
// final; the master toggle must be on; the pick must still be on the current list; a racing writer of the
// same seq leaves exactly one row.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unmuteAlert } from "@/lib/alerts/pick/unmute";
import { alertIdOf, insertTransition } from "@/lib/alerts/pick/store";
import type { AlertRow, ClearReason } from "@/lib/alerts/pick/types";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const SESSION = "2026-11-04";
const NOW = new Date("2026-11-04T00:10:00.000Z");
const SHA = "a".repeat(64);
const ALERT = alertIdOf("1", "AU", "2026-11-03", "P1", 1);

let main: Client;
let auth: Client;

const deps = (sessionD = SESSION) => ({ main, auth, now: () => NOW, sessionD });

const base: AlertRow = {
  alertId: ALERT,
  seq: 1,
  userId: "1",
  market: "AU",
  pickD: "2026-11-03",
  profile: "P1",
  rank: 1,
  code: "ZZ01",
  sessionD: SESSION,
  state: "armed",
  limitMicro: 10_000_000n,
  stopMicro: 9_000_000n,
  at: "2026-11-04T00:00:00.000Z",
  hitMicro: null,
  quoteAt: null,
  clearReason: null,
};

async function clearWith(reason: ClearReason): Promise<void> {
  await insertTransition(main, base);
  await insertTransition(main, {
    ...base,
    seq: 2,
    state: "cleared",
    at: "2026-11-04T00:05:00.000Z",
    clearReason: reason,
  });
}
const alertRows = async () =>
  (await main.execute("SELECT seq, state, clear_reason FROM pick_alert ORDER BY seq")).rows.map(
    (r) => `${r.seq}:${r.state}${r.clear_reason === null ? "" : ":" + r.clear_reason}`,
  );
const setPrefs = (prefs: Record<string, unknown>) =>
  auth.execute({
    sql: "INSERT OR REPLACE INTO user_preference (user_id, prefs_json, updated_at) VALUES (1, ?, 't')",
    args: [JSON.stringify(prefs)],
  });

beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  await auth.execute(
    "INSERT INTO app_user (id, email, role, status, created_at, updated_at) VALUES (1, 'u@example.test', 'editor', 'active', 't', 't')",
  );
  await setPrefs({ pick_alerts: "on" });
  await main.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', '2026-11-03', 'P1', 1, 'ZZ01', 'F1', 'U1', 'F1.v1', 'sig-ZZ01', 'Synthetic ZZ01',
            10000000, 10000000, '2026-11-12', 9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?,
            '2026-11-03T07:00:00.000Z')`,
    args: [SHA],
  });
});

describe("unmute (UXN-322, D-1207)", () => {
  it("mute then unmute appends an armed row at seq 3 with the same limit and stop", async () => {
    await clearWith("muted");
    expect(await unmuteAlert(deps(), "1", ALERT)).toEqual({ ok: true });
    expect(await alertRows()).toEqual(["1:armed", "2:cleared:muted", "3:armed"]);
    const r = (await main.execute("SELECT * FROM pick_alert WHERE seq = 3")).rows[0];
    expect(r.limit_micro).toBe(10_000_000);
    expect(r.stop_micro).toBe(9_000_000);
    expect(r.hit_micro).toBeNull();
    expect(r.quote_at).toBeNull();
    expect(r.clear_reason).toBeNull();
  });

  it("the earlier rows are untouched (append-only); an update or delete still aborts", async () => {
    await clearWith("muted");
    const before = (await main.execute("SELECT * FROM pick_alert ORDER BY seq")).rows.map((r) =>
      JSON.stringify(r),
    );
    await unmuteAlert(deps(), "1", ALERT);
    const after = (
      await main.execute("SELECT * FROM pick_alert WHERE seq <= 2 ORDER BY seq")
    ).rows.map((r) => JSON.stringify(r));
    expect(after).toEqual(before);
    await expect(
      main.execute("UPDATE pick_alert SET state = 'hit' WHERE seq = 3"),
    ).rejects.toThrow();
    await expect(main.execute("DELETE FROM pick_alert WHERE seq = 3")).rejects.toThrow();
  });

  it("a second unmute (latest row is armed) is refused: invalid", async () => {
    await clearWith("muted");
    await unmuteAlert(deps(), "1", ALERT);
    expect(await unmuteAlert(deps(), "1", ALERT)).toEqual({ error: "invalid" });
    expect(await alertRows()).toHaveLength(3);
  });

  it.each(["below_stop", "above_chase_cap", "left_list", "halted", "expired", "filled"] as const)(
    "a %s clear stays final: refused, nothing written",
    async (reason) => {
      await clearWith(reason);
      expect(await unmuteAlert(deps(), "1", ALERT)).toEqual({ error: "invalid" });
      expect(await alertRows()).toEqual(["1:armed", `2:cleared:${reason}`]);
    },
  );

  it("refused while Alerts for all picks is off", async () => {
    await clearWith("muted");
    await setPrefs({ pick_alerts: "off" });
    expect(await unmuteAlert(deps(), "1", ALERT)).toEqual({ error: "alerts_off" });
    expect(await alertRows()).toHaveLength(2);
  });

  it("refused when the pick is no longer on the current list", async () => {
    await clearWith("muted");
    await main.execute(
      "INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at) VALUES ('AU','2026-11-03','P1',1,'2026-11-04',0,'below_stop','t')",
    );
    expect(await unmuteAlert(deps("2026-11-05"), "1", ALERT)).toEqual({ error: "not_listed" });
    expect(await alertRows()).toHaveLength(2);
  });

  it("another user's alert and a malformed id are invalid", async () => {
    await clearWith("muted");
    expect(await unmuteAlert(deps(), "2", ALERT)).toEqual({ error: "invalid" });
    expect(await unmuteAlert(deps(), "1", "nope")).toEqual({ error: "invalid" });
    expect(await alertRows()).toHaveLength(2);
  });

  it("a race with a writer of the same seq leaves one row", async () => {
    await clearWith("muted");
    // a tick (or a double click) took seq 3 first
    await insertTransition(main, { ...base, seq: 3, at: "2026-11-04T00:09:00.000Z" });
    // the unmute read seq 2 as latest before that write: simulate by a second call after the row exists
    // (latest is then `armed`, refused) and by a direct duplicate insert (ignored)
    expect(await unmuteAlert(deps(), "1", ALERT)).toEqual({ error: "invalid" });
    expect(await insertTransition(main, { ...base, seq: 3, at: "2026-11-04T00:10:00.000Z" })).toBe(
      false,
    );
    expect(await alertRows()).toEqual(["1:armed", "2:cleared:muted", "3:armed"]);
  });

  it("an unmuted alert is mutable again: seq 4 is a fresh muted clear", async () => {
    await clearWith("muted");
    await unmuteAlert(deps(), "1", ALERT);
    await insertTransition(main, {
      ...base,
      seq: 4,
      state: "cleared",
      clearReason: "muted",
      at: "2026-11-04T00:11:00.000Z",
    });
    expect(await alertRows()).toEqual(["1:armed", "2:cleared:muted", "3:armed", "4:cleared:muted"]);
    expect(await unmuteAlert(deps(), "1", ALERT)).toEqual({ ok: true });
    expect(await alertRows()).toHaveLength(5);
  });
});

describe("alertsOnFor (the user's effective Alerts for all picks)", () => {
  it("is the stored choice: on, off, and off for an unknown or inactive user", async () => {
    const { alertsOnFor } = await import("@/lib/alerts/pick/unmute");
    await setPrefs({ pick_alerts: "on" });
    expect(await alertsOnFor(auth, main, "1")).toBe(true);
    await setPrefs({ pick_alerts: "off" });
    expect(await alertsOnFor(auth, main, "1")).toBe(false);
    expect(await alertsOnFor(auth, main, "999")).toBe(false);
    await setPrefs({ pick_alerts: "on" });
    await auth.execute("UPDATE app_user SET status = 'revoked' WHERE id = 1");
    expect(await alertsOnFor(auth, main, "1")).toBe(false);
  });

  it("with no stored choice, or unreadable preferences, a non-owner is off", async () => {
    const { alertsOnFor } = await import("@/lib/alerts/pick/unmute");
    await auth.execute("DELETE FROM user_preference");
    expect(await alertsOnFor(auth, main, "1")).toBe(false);
    for (const raw of ["not json", "[]", "5"]) {
      await auth.execute({
        sql: "INSERT OR REPLACE INTO user_preference (user_id, prefs_json, updated_at) VALUES (1, ?, 't')",
        args: [raw],
      });
      expect(await alertsOnFor(auth, main, "1"), raw).toBe(false);
    }
  });

  it("with no stored choice the Owner follows the Owner default config", async () => {
    const { alertsOnFor } = await import("@/lib/alerts/pick/unmute");
    const { setConfig } = await import("@/lib/config/store");
    await auth.execute("UPDATE app_user SET role = 'owner'");
    await auth.execute("DELETE FROM user_preference");
    for (const value of ["on", "off"]) {
      await setConfig(main, {
        key: "pick_alerts_default_owner",
        value,
        userId: null,
        reason: "test",
        now: "2026-11-04T00:00:00.000Z",
      });
      expect(await alertsOnFor(auth, main, "1"), value).toBe(value === "on");
    }
  });
});

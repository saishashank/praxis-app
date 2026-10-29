// @vitest-environment node
// TST-122 for updateAppearanceAction, updateRegionAction and setQuietHoursAction (UX-110, UXN-160,
// UXN-280..282, ROL-102a, SEC-013): guard first, own row only, audited, revalidated, codes only.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { addUser, auditRows, authDb, KEY } from "../auth/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));

import {
  setQuietHoursAction,
  updateAppearanceAction,
  updateRegionAction,
} from "@/app/(app)/settings/actions";
import { getQuietHours } from "@/lib/alerts/api";
import { getPreferences } from "@/lib/preferences/service";

afterEach(cleanupTempDbs);

let db: Client;
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const asUser = (id: number, role: string) =>
  requireUser.mockResolvedValue({ id, email: `${role}@example.test`, name: null, role });

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
  requireUser.mockReset();
  revalidatePath.mockReset();
  db = await authDb();
  dbMock.mockReset();
  dbMock.mockReturnValue(db);
});

describe("updateAppearanceAction", () => {
  it.each(["owner", "editor", "viewer"] as const)("%s sets theme and motion", async (role) => {
    const id = await addUser(db, { email: `${role}@example.test`, role });
    asUser(id, role);
    expect(await updateAppearanceAction(form({ theme: "midnight", motion: "off" }))).toEqual({
      ok: true,
    });
    expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings/appearance");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(await getPreferences(db, id)).toMatchObject({ theme: "midnight", motion: "off" });
    const last = (await auditRows(db)).at(-1);
    expect(last).toMatchObject({ action: "user.preferences_update", actor_user_id: id });
    expect(last?.detail).toEqual({ changed: ["theme", "motion"] });
  });

  it("ignores fields of other pages and a user id", async () => {
    const me = await addUser(db, { email: "me@example.test", role: "viewer" });
    const other = await addUser(db, { email: "o@example.test", role: "owner" });
    asUser(me, "viewer");
    await updateAppearanceAction(form({ theme: "dim", time_format: "12h", userId: String(other) }));
    expect(await getPreferences(db, me)).toMatchObject({ theme: "dim", time_format: "24h" });
    expect((await getPreferences(db, other)).theme).toBe("dark");
  });

  it("stops at the guard and writes nothing", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(updateAppearanceAction(form({ theme: "light" }))).rejects.toThrow(/REDIRECT/);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect((await db.execute("SELECT 1 FROM user_preference")).rows).toEqual([]);
    expect(await auditRows(db)).toEqual([]);
  });

  it("returns invalid for bad values, a code only on failure, forbidden for an inactive actor", async () => {
    const id = await addUser(db, { email: "v@example.test" });
    asUser(id, "viewer");
    expect(await updateAppearanceAction(form({ motion: "sometimes" }))).toEqual({
      error: "invalid",
    });
    expect(await updateAppearanceAction(form({ theme: "neon" }))).toEqual({ error: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
    dbMock.mockImplementation(() => {
      throw new Error("secret connection string");
    });
    expect(await updateAppearanceAction(form({ theme: "light" }))).toEqual({
      error: "unavailable",
    });
    dbMock.mockReturnValue(db);
    const gone = await addUser(db, { email: "g@example.test", status: "revoked" });
    asUser(gone, "viewer");
    expect(await updateAppearanceAction(form({ theme: "light" }))).toEqual({ error: "forbidden" });
  });
});

describe("updateRegionAction", () => {
  it("sets the opening market and the time zone choice for every role", async () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      const id = await addUser(db, { email: `${role}@example.test`, role });
      asUser(id, role);
      expect(
        await updateRegionAction(form({ default_market: "AU", times_in: "exchange" })),
      ).toEqual({ ok: true });
      expect((await getPreferences(db, id)).times_in).toBe("exchange");
    }
    expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings/region");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    const last = (await auditRows(db)).at(-1);
    expect(last?.detail).toEqual({ changed: ["times_in"] });
  });

  it("refuses an inactive market, bad values and a guard failure", async () => {
    const id = await addUser(db, { email: "v@example.test" });
    asUser(id, "viewer");
    expect(await updateRegionAction(form({ default_market: "US" }))).toEqual({ error: "invalid" });
    expect(await updateRegionAction(form({ times_in: "utc" }))).toEqual({ error: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(updateRegionAction(form({ times_in: "exchange" }))).rejects.toThrow(/REDIRECT/);
    expect(await auditRows(db)).toEqual([]);
  });

  it("returns a code only when the database fails", async () => {
    const id = await addUser(db, { email: "v@example.test" });
    asUser(id, "viewer");
    dbMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(await updateRegionAction(form({ times_in: "exchange" }))).toEqual({
      error: "unavailable",
    });
  });
});

describe("setQuietHoursAction", () => {
  it.each(["owner", "editor", "viewer"] as const)("%s sets and clears their own", async (role) => {
    const id = await addUser(db, { email: `${role}@example.test`, role });
    asUser(id, role);
    expect(await setQuietHoursAction(form({ quiet_start: "22:00", quiet_end: "07:00" }))).toEqual({
      ok: true,
    });
    expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(await getQuietHours(db, id)).toEqual({ start: "22:00", end: "07:00" });
    expect((await auditRows(db)).at(-1)).toMatchObject({
      action: "alert.quiet_hours",
      actor_user_id: id,
    });
    expect(await setQuietHoursAction(form({ quiet_off: "1" }))).toEqual({ ok: true });
    expect(await getQuietHours(db, id)).toBeNull();
  });

  it("keeps the other preferences when quiet hours change", async () => {
    const id = await addUser(db, { email: "v@example.test" });
    asUser(id, "viewer");
    await updateAppearanceAction(form({ theme: "dim" }));
    await setQuietHoursAction(form({ quiet_start: "21:30", quiet_end: "06:30" }));
    await updateAppearanceAction(form({ motion: "off" }));
    expect(await getPreferences(db, id)).toMatchObject({ theme: "dim", motion: "off" });
    expect(await getQuietHours(db, id)).toEqual({ start: "21:30", end: "06:30" });
  });

  it("returns invalid for a bad or empty window and does not revalidate", async () => {
    const id = await addUser(db, { email: "v@example.test" });
    asUser(id, "viewer");
    const bad: Array<Record<string, string>> = [
      { quiet_start: "22:00", quiet_end: "22:00" },
      { quiet_start: "25:00", quiet_end: "07:00" },
      { quiet_start: "22:00" },
      {},
    ];
    for (const f of bad) expect(await setQuietHoursAction(form(f))).toEqual({ error: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await auditRows(db)).toEqual([]);
  });

  it("stops at the guard; a revoked actor is forbidden; a failing database gives a code", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(setQuietHoursAction(form({ quiet_off: "1" }))).rejects.toThrow(/REDIRECT/);
    expect(await auditRows(db)).toEqual([]);
    const gone = await addUser(db, { email: "g@example.test", status: "revoked" });
    asUser(gone, "viewer");
    expect(await setQuietHoursAction(form({ quiet_start: "22:00", quiet_end: "07:00" }))).toEqual({
      error: "forbidden",
    });
    dbMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(await setQuietHoursAction(form({ quiet_start: "22:00", quiet_end: "07:00" }))).toEqual({
      error: "unavailable",
    });
  });
});

describe("signOutEverywhereSelfAction (UXR-027, PLT-033)", () => {
  it("requires admin, bumps the session version and audits it", async () => {
    const { signOutEverywhereSelfAction } = await import("@/app/(app)/settings/actions");
    const id = await addUser(db, { email: "owner@example.test", role: "owner" });
    asUser(id, "owner");
    await signOutEverywhereSelfAction();
    expect(requireUser).toHaveBeenCalledWith("admin", "/settings");
    const r = await db.execute({
      sql: "SELECT session_version FROM app_user WHERE id = ?",
      args: [id],
    });
    expect(Number(r.rows[0].session_version)).toBeGreaterThanOrEqual(2);
    expect((await auditRows(db)).at(-1)).toMatchObject({ action: "auth.signout_everywhere" });
  });
});

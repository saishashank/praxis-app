// @vitest-environment node
// UX-110, ROL-102a, AT-02, SEC-013: updatePreferencesAction.
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
vi.mock("@/lib/db/client", () => ({ authDb: () => dbMock() }));

import { updatePreferencesAction } from "@/app/(app)/settings/actions";
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

describe("updatePreferencesAction", () => {
  it.each(["owner", "editor", "viewer"] as const)(
    "%s can change their own preferences",
    async (role) => {
      const id = await addUser(db, { email: `${role}@example.test`, role });
      asUser(id, role);
      const r = await updatePreferencesAction(
        form({ theme: "midnight", time_format: "12h", alert_p2: "immediate" }),
      );
      expect(r).toEqual({ ok: true });
      expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings");
      expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      expect(await getPreferences(db, id)).toMatchObject({
        theme: "midnight",
        time_format: "12h",
        alert_p2: "immediate",
      });
      const audits = await auditRows(db);
      expect(audits.at(-1)).toMatchObject({ action: "user.preferences_update", actor_user_id: id });
      expect(audits.at(-1)?.detail).toEqual({ changed: ["theme", "time_format", "alert_p2"] });
      expect(audits.at(-1)).toMatchObject({ ip: "9.9.9.9", user_agent: "agent" });
    },
  );

  it("ignores a user id in the form and only changes the signed-in user", async () => {
    const me = await addUser(db, { email: "me@example.test", role: "viewer" });
    const other = await addUser(db, { email: "o@example.test", role: "owner" });
    asUser(me, "viewer");
    await updatePreferencesAction(form({ theme: "light", userId: String(other), user_id: "1" }));
    expect((await getPreferences(db, me)).theme).toBe("light");
    expect((await getPreferences(db, other)).theme).toBe("dark");
    expect((await db.execute("SELECT user_id FROM user_preference")).rows).toHaveLength(1);
  });

  it("an unauthenticated or refused caller stops at the guard and writes nothing", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(updatePreferencesAction(form({ theme: "light" }))).rejects.toThrow(/REDIRECT/);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect((await db.execute("SELECT 1 FROM user_preference")).rows).toEqual([]);
    expect(await auditRows(db)).toEqual([]);
  });

  it("returns invalid for bad values and does not revalidate", async () => {
    const id = await addUser(db, { email: "v@example.test" });
    asUser(id, "viewer");
    expect(await updatePreferencesAction(form({ theme: "neon" }))).toEqual({ error: "invalid" });
    expect(await updatePreferencesAction(form({ default_market: "US" }))).toEqual({
      error: "invalid",
    });
    const f = new FormData();
    f.set("theme", new File(["x"], "x.txt"));
    expect(await updatePreferencesAction(f)).toEqual({ error: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a code only when the database fails", async () => {
    const id = await addUser(db, { email: "v@example.test" });
    asUser(id, "viewer");
    dbMock.mockImplementation(() => {
      throw new Error("secret connection string");
    });
    expect(await updatePreferencesAction(form({ theme: "light" }))).toEqual({
      error: "unavailable",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns the service error code (inactive actor)", async () => {
    const id = await addUser(db, { email: "g@example.test", status: "revoked" });
    asUser(id, "viewer");
    expect(await updatePreferencesAction(form({ theme: "light" }))).toEqual({
      error: "forbidden",
    });
  });
});

// @vitest-environment node
// TST-122 for cycleThemeAction (UXN-280, ROL-102a): every role may cycle their OWN theme; the guard
// runs first; the service validates and audits; the layout is revalidated; failures give a code only.
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

import { cycleThemeAction } from "@/app/(app)/settings/themeActions";
import { getPreferences, THEMES } from "@/lib/preferences/service";
import { THEME_ORDER } from "@/lib/ui/nav";

afterEach(cleanupTempDbs);

let db: Client;
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

describe("cycleThemeAction", () => {
  it.each(["owner", "editor", "viewer"] as const)(
    "%s steps their own theme to the next one",
    async (role) => {
      const id = await addUser(db, { email: `${role}@example.test`, role });
      asUser(id, role);
      expect(await cycleThemeAction()).toEqual({ ok: true });
      expect(requireUser).toHaveBeenCalledWith("own_preferences", "/settings");
      expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
      expect((await getPreferences(db, id)).theme).toBe("light"); // default dark -> light
      const audits = await auditRows(db);
      expect(audits.at(-1)).toMatchObject({ action: "user.preferences_update", actor_user_id: id });
      expect(audits.at(-1)?.detail).toEqual({ changed: ["theme"] });
      expect(audits.at(-1)).toMatchObject({ ip: "9.9.9.9", user_agent: "agent" });
    },
  );

  it("six calls visit every theme once and come back to the start", async () => {
    const id = await addUser(db, { email: "v@example.test", role: "viewer" });
    asUser(id, "viewer");
    const seen: string[] = [];
    for (let i = 0; i < THEMES.length; i++) {
      await cycleThemeAction();
      seen.push((await getPreferences(db, id)).theme);
    }
    expect(new Set(seen).size).toBe(THEMES.length);
    expect(seen.at(-1)).toBe(THEME_ORDER[0]);
  });

  it("only changes the signed-in user, never another", async () => {
    const me = await addUser(db, { email: "me@example.test", role: "viewer" });
    const other = await addUser(db, { email: "o@example.test", role: "owner" });
    asUser(me, "viewer");
    await cycleThemeAction();
    expect((await getPreferences(db, other)).theme).toBe("dark");
    expect((await db.execute("SELECT user_id FROM user_preference")).rows).toHaveLength(1);
  });

  it("keeps the other preferences and quiet hours", async () => {
    const id = await addUser(db, { email: "k@example.test", role: "editor" });
    await db.execute({
      sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)",
      args: [
        id,
        JSON.stringify({ theme: "dim", time_format: "12h", quiet_hours: { start: "22:00" } }),
        "2026-10-01T00:00:00Z",
      ],
    });
    asUser(id, "editor");
    await cycleThemeAction();
    const stored = JSON.parse(
      String((await db.execute("SELECT prefs_json FROM user_preference")).rows[0]!.prefs_json),
    );
    expect(stored).toMatchObject({
      theme: "high_contrast",
      time_format: "12h",
      quiet_hours: { start: "22:00" },
    });
  });

  it("an unauthenticated or refused caller stops at the guard and writes nothing", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(cycleThemeAction()).rejects.toThrow(/REDIRECT/);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect((await db.execute("SELECT 1 FROM user_preference")).rows).toEqual([]);
    expect(await auditRows(db)).toEqual([]);
  });

  it("returns a code only when the database fails (rate/error shape, no internals)", async () => {
    const id = await addUser(db, { email: "x@example.test", role: "viewer" });
    asUser(id, "viewer");
    dbMock.mockImplementation(() => {
      throw new Error("secret connection string");
    });
    expect(await cycleThemeAction()).toEqual({ error: "unavailable" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns the service error code for an inactive actor", async () => {
    const id = await addUser(db, { email: "g@example.test", status: "revoked" });
    asUser(id, "viewer");
    expect(await cycleThemeAction()).toEqual({ error: "forbidden" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

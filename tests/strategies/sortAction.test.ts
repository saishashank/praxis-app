// @vitest-environment node
// TST-122 for setSortPreferenceAction (UXN-046a, ROL-102a): every role may keep its OWN sort; the guard
// runs first; only the four chips are accepted; the change and its audit event commit together; the
// page is revalidated; other stored preferences stay; failures give a code only.
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

import { setSortPreferenceAction } from "@/app/(app)/strategies/actions";
import { readStrategySort } from "@/lib/preferences/strategySort";
import { getPreferences, updatePreferences } from "@/lib/preferences/service";

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

describe("setSortPreferenceAction", () => {
  it.each(["owner", "editor", "viewer"] as const)(
    "%s keeps their own sort, with an audit event",
    async (role) => {
      const id = await addUser(db, { email: `${role}@example.test`, role });
      asUser(id, role);
      expect(await setSortPreferenceAction("risk")).toEqual({ ok: true });
      expect(requireUser).toHaveBeenCalledWith("own_preferences", "/strategies");
      expect(revalidatePath).toHaveBeenCalledWith("/strategies");
      expect(await readStrategySort(db, id)).toBe("risk");
      const last = (await auditRows(db)).at(-1);
      expect(last).toMatchObject({ action: "user.preferences_update", actor_user_id: id });
      expect(last?.detail).toEqual({ changed: ["strategies_sort"] });
      expect(last).toMatchObject({ ip: "9.9.9.9", user_agent: "agent" });
    },
  );

  it("asks the guard before anything else: a refusal changes nothing", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(setSortPreferenceAction("az")).rejects.toThrow("NEXT_REDIRECT");
    expect((await db.execute("SELECT * FROM user_preference")).rows).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["", "best ", "BEST", "newest", "__proto__"])("rejects %j", async (bad) => {
    const id = await addUser(db, { email: "v@example.test", role: "viewer" });
    asUser(id, "viewer");
    expect(await setSortPreferenceAction(bad)).toEqual({ error: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect((await db.execute("SELECT * FROM user_preference")).rows).toHaveLength(0);
    expect(await auditRows(db)).toHaveLength(0);
  });

  it("changes only the signed-in user, never another", async () => {
    const me = await addUser(db, { email: "me@example.test", role: "viewer" });
    const other = await addUser(db, { email: "o@example.test", role: "owner" });
    asUser(me, "viewer");
    await setSortPreferenceAction("az");
    expect(await readStrategySort(db, other)).toBeNull();
    expect((await db.execute("SELECT user_id FROM user_preference")).rows).toHaveLength(1);
  });

  it("is quiet when nothing changes: no second audit event", async () => {
    const id = await addUser(db, { email: "e@example.test", role: "editor" });
    asUser(id, "editor");
    await setSortPreferenceAction("closest");
    await setSortPreferenceAction("closest");
    expect(await auditRows(db)).toHaveLength(1);
  });

  it("keeps theme, quiet hours and other keys, and a later theme change keeps the sort", async () => {
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
    await setSortPreferenceAction("best");
    let stored = JSON.parse(
      String((await db.execute("SELECT prefs_json FROM user_preference")).rows[0]!.prefs_json),
    );
    expect(stored).toMatchObject({
      theme: "dim",
      time_format: "12h",
      quiet_hours: { start: "22:00" },
      strategies_sort: "best",
    });
    // The theme shortcut writes through the preferences service; it must not drop the sort.
    expect(
      (await updatePreferences(db, process.env, undefined, { id }, { theme: "light" })).ok,
    ).toBe(true);
    stored = JSON.parse(
      String((await db.execute("SELECT prefs_json FROM user_preference")).rows[0]!.prefs_json),
    );
    expect(stored).toMatchObject({ theme: "light", strategies_sort: "best" });
    expect((await getPreferences(db, id)).theme).toBe("light");
  });

  it("refuses a user who is no longer active", async () => {
    const id = await addUser(db, { email: "r@example.test", role: "viewer", status: "revoked" });
    asUser(id, "viewer");
    expect(await setSortPreferenceAction("az")).toEqual({ error: "forbidden" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("answers with a code when the store is down", async () => {
    asUser(1, "viewer");
    dbMock.mockImplementation(() => {
      throw new Error("down");
    });
    expect(await setSortPreferenceAction("az")).toEqual({ error: "unavailable" });
  });

  it("reads nothing (not an error) when the store is down", async () => {
    const broken = { execute: async () => Promise.reject(new Error("down")) };
    expect(await readStrategySort(broken, 1)).toBeNull();
  });
});

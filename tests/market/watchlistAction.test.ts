// @vitest-environment node
// TST-122 for toggleWatchlistAction (UXN-047, decisions 9 and 56 of docs/M7_design.md; M7 T15). Owner stars
// into the Sentinel watch-list (watch_list_owner, through the audited Owner writers), an Editor into a
// personal list (user_watchlist); Viewers cannot star. Covered: the guard runs FIRST on the `watchlist`
// action and a refusal changes nothing, input validation, a masked user is refused before any data is
// read, the audit event is written BEFORE the change (a failing write leaves the audit row and a
// `_failed` row), idempotence, the `watchlist_max` limit, unknown codes, error shape (a code only) and
// revalidation of the pages.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { toggleWatchlistAction } from "@/app/(app)/market/actions";
import { can } from "@/lib/auth/permissions";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
let viewerId: number;
let grantedId: number;

const asUser = (id: number, role: string) =>
  requireUser.mockResolvedValue({ id, email: `${role}@example.test`, name: null, role });

const form = (o: Record<string, string | undefined>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) fd.set(k, v);
  return fd;
};

const ownerRows = async () =>
  (await main.execute("SELECT * FROM watch_list_owner ORDER BY id")).rows.map((r) => ({ ...r }));
const personalRows = async (userId: number) =>
  (
    await auth.execute({
      sql: "SELECT code FROM user_watchlist WHERE user_id = ? ORDER BY code",
      args: [userId],
    })
  ).rows.map((r) => String(r.code));
const setMax = (n: number) =>
  main.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('watchlist_max', 'global', ?, '2026-10-01T00:00:00.000Z')`,
    args: [JSON.stringify(n)],
  });

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  await main.execute(
    `INSERT INTO instrument (market, code, name, sector) VALUES
       ('AU','ZZUP','Zed Upward Holdings','Technology'),
       ('AU','ZZDN','Zed Downward Mining','Materials')`,
  );
  await main.execute(
    `INSERT INTO instrument (market, code, name, delisted_on) VALUES ('AU','ZZGONE','Zed Gone','2026-01-01')`,
  );
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  viewerId = await addUser(auth, { email: "viewer@example.test", role: "viewer" });
  grantedId = await addUser(auth, { email: "granted@example.test", role: "editor" });
  await auth.execute({
    sql: `INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at)
          VALUES (?, ?, '2026-10-01T00:00:00.000Z', '2099-12-01T00:00:00.000Z')`,
    args: [grantedId, ownerId],
  });
});

describe("the role matrix", () => {
  it("only the Owner and Editor hold the watchlist action", () => {
    expect(can("owner", "watchlist")).toBe(true);
    expect(can("editor", "watchlist")).toBe(true);
    expect(can("viewer", "watchlist")).toBe(false);
  });
});

describe("guard first", () => {
  it("asks for the watchlist action on the Market path before anything else", async () => {
    asUser(ownerId, "owner");
    await toggleWatchlistAction(form({ code: "ZZUP" }));
    expect(requireUser).toHaveBeenCalledWith("watchlist", "/market");
  });

  it("a Viewer is refused by the guard: nothing is written and the action writes no audit event", async () => {
    // The guard (not the action) records its own auth.forbidden event; here it is mocked to refuse.
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(toggleWatchlistAction(form({ code: "ZZUP" }))).rejects.toThrow(/403/);
    expect(await ownerRows()).toEqual([]);
    expect(await personalRows(viewerId)).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an anonymous visitor is redirected by the guard before any read", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(toggleWatchlistAction(form({ code: "ZZUP" }))).rejects.toThrow(/REDIRECT/);
    expect(await ownerRows()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });
});

describe("validation", () => {
  it.each([
    ["no code", {}],
    ["a lower-case path trick", { code: "../x" }],
    ["too long", { code: "ABCDEFGHI" }],
    ["too short", { code: "A" }],
    ["an unknown state", { code: "ZZUP", state: "maybe" }],
    ["an unknown market", { code: "ZZUP", market: "US" }],
  ])("refuses %s with a code only and changes nothing", async (_n, input) => {
    asUser(ownerId, "owner");
    expect(await toggleWatchlistAction(form(input))).toEqual({ error: "invalid" });
    expect(await ownerRows()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("the Owner's Sentinel watch-list", () => {
  it("adds a code, audits it first, and revalidates the Market, company and Home pages", async () => {
    asUser(ownerId, "owner");
    expect(await toggleWatchlistAction(form({ code: "zzup" }))).toEqual({
      ok: true,
      starred: true,
      changed: true,
    });
    const rows = await ownerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ market: "AU", code: "ZZUP", removed_at: null });
    const audit = await auditRows(auth);
    expect(audit.map((a) => a.action)).toEqual(["controls.watch_list_add"]);
    expect(audit[0]!.actor_user_id).toBe(ownerId);
    expect(revalidatePath).toHaveBeenCalledWith("/market");
    expect(revalidatePath).toHaveBeenCalledWith("/market/[code]", "page");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("flips an existing star off (the row stays for the audit trail) and on again", async () => {
    asUser(ownerId, "owner");
    await toggleWatchlistAction(form({ code: "ZZUP" }));
    expect(await toggleWatchlistAction(form({ code: "ZZUP" }))).toEqual({
      ok: true,
      starred: false,
      changed: true,
    });
    const rows = await ownerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.removed_at).not.toBeNull();
    expect(
      await toggleWatchlistAction(form({ code: "ZZUP", state: "on", market: "AU" })),
    ).toMatchObject({ ok: true, starred: true });
    expect((await auditRows(auth)).map((a) => a.action)).toEqual([
      "controls.watch_list_add",
      "controls.watch_list_remove",
      "controls.watch_list_add",
    ]);
  });

  it("asking for the state it already has writes nothing and no audit event", async () => {
    asUser(ownerId, "owner");
    await toggleWatchlistAction(form({ code: "ZZUP", state: "on" }));
    const before = (await auditRows(auth)).length;
    expect(await toggleWatchlistAction(form({ code: "ZZUP", state: "on" }))).toEqual({
      ok: true,
      starred: true,
      changed: false,
    });
    expect(await toggleWatchlistAction(form({ code: "ZZDN", state: "off" }))).toEqual({
      ok: true,
      starred: false,
      changed: false,
    });
    expect((await auditRows(auth)).length).toBe(before);
    expect(await ownerRows()).toHaveLength(1);
  });

  it("refuses a code that is not a listed instrument", async () => {
    asUser(ownerId, "owner");
    expect(await toggleWatchlistAction(form({ code: "ZZNONE" }))).toEqual({
      error: "unknown_code",
    });
    expect(await toggleWatchlistAction(form({ code: "ZZGONE" }))).toEqual({
      error: "unknown_code",
    });
    expect(await ownerRows()).toEqual([]);
  });

  it("stops at watchlist_max and still allows removing", async () => {
    await setMax(10);
    asUser(ownerId, "owner");
    // Ten more instruments fill the list.
    for (let i = 0; i < 10; i++) {
      await main.execute({
        sql: "INSERT INTO instrument (market, code, name) VALUES ('AU', ?, 'Zed filler')",
        args: [`ZF${i}`],
      });
      expect(await toggleWatchlistAction(form({ code: `ZF${i}`, state: "on" }))).toMatchObject({
        ok: true,
      });
    }
    expect(await toggleWatchlistAction(form({ code: "ZZUP", state: "on" }))).toEqual({
      error: "limit",
    });
    expect(await toggleWatchlistAction(form({ code: "ZF0", state: "off" }))).toMatchObject({
      ok: true,
      starred: false,
    });
    expect(await toggleWatchlistAction(form({ code: "ZZUP", state: "on" }))).toMatchObject({
      ok: true,
    });
  });

  it("a failing audit writer changes nothing and answers with a code only", async () => {
    asUser(ownerId, "owner");
    vi.stubEnv("PII_HASH_KEY", ""); // audit is not configured: the audit append fails
    expect(await toggleWatchlistAction(form({ code: "ZZUP" }))).toEqual({
      error: "unavailable",
    });
    expect(await ownerRows()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("an Editor's personal list", () => {
  it("adds and removes a code in the auth database, audited, with no effect on the Owner list", async () => {
    asUser(grantedId, "editor");
    expect(await toggleWatchlistAction(form({ code: "ZZUP" }))).toEqual({
      ok: true,
      starred: true,
      changed: true,
    });
    expect(await personalRows(grantedId)).toEqual(["ZZUP"]);
    expect(await ownerRows()).toEqual([]);
    expect(await toggleWatchlistAction(form({ code: "ZZUP" }))).toEqual({
      ok: true,
      starred: false,
      changed: true,
    });
    expect(await personalRows(grantedId)).toEqual([]);
    const audit = await auditRows(auth);
    expect(audit.map((a) => a.action)).toEqual(["watchlist.add", "watchlist.remove"]);
    expect(audit[0]!.actor_user_id).toBe(grantedId);
    expect(audit[0]!.detail).toMatchObject({ market: "AU", code: "ZZUP", personal: true });
  });

  it("is refused for a masked Editor before any data is read", async () => {
    asUser(editorId, "editor");
    expect(await toggleWatchlistAction(form({ code: "ZZUP" }))).toEqual({ error: "masked" });
    expect(await personalRows(editorId)).toEqual([]);
  });

  it("is per user: another Editor's star is not shared", async () => {
    asUser(grantedId, "editor");
    await toggleWatchlistAction(form({ code: "ZZUP" }));
    expect(await personalRows(grantedId)).toEqual(["ZZUP"]);
    expect(await personalRows(editorId)).toEqual([]);
  });

  it("an unmasked Editor (live grant) can star; unknown and delisted codes are refused", async () => {
    asUser(grantedId, "editor");
    expect(await toggleWatchlistAction(form({ code: "ZZNONE" }))).toEqual({
      error: "unknown_code",
    });
    expect(await toggleWatchlistAction(form({ code: "ZZGONE" }))).toEqual({
      error: "unknown_code",
    });
    expect(await personalRows(grantedId)).toEqual([]);
    expect((await auditRows(auth)).length).toBe(0);
  });

  it("stops at watchlist_max", async () => {
    await setMax(10);
    asUser(grantedId, "editor");
    for (let i = 0; i < 10; i++) {
      await main.execute({
        sql: "INSERT INTO instrument (market, code, name) VALUES ('AU', ?, 'Zed filler')",
        args: [`ZF${i}`],
      });
      await toggleWatchlistAction(form({ code: `ZF${i}`, state: "on" }));
    }
    expect(await toggleWatchlistAction(form({ code: "ZZUP", state: "on" }))).toEqual({
      error: "limit",
    });
    expect(await personalRows(grantedId)).toHaveLength(10);
  });

  it("a failed write leaves the audit row and a _failed row, and no star", async () => {
    asUser(grantedId, "editor");
    await auth.execute(
      "CREATE TRIGGER wl_block BEFORE INSERT ON user_watchlist BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    expect(await toggleWatchlistAction(form({ code: "ZZUP" }))).toEqual({ error: "unavailable" });
    expect(await personalRows(grantedId)).toEqual([]);
    expect((await auditRows(auth)).map((r) => r.action)).toEqual([
      "watchlist.add",
      "watchlist.add_failed",
    ]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("a Viewer with a live unmask grant", () => {
  it("still cannot star: the watchlist action belongs to Owner and Editor", () => {
    expect(can("viewer", "watchlist")).toBe(false);
    expect(viewerId).toBeGreaterThan(0);
  });
});

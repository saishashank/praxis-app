// @vitest-environment node
// TST-122 for setArenaControlAction (UX-050; M7 T13; HIGH RISK). The Owner may pause / resume a strategy
// and switch a family off / on. Covered: the guard runs FIRST and a refusal changes nothing, input
// validation and the explicit confirmation, the audit event is written BEFORE the change (a failing
// writer leaves the audit row and a `_failed` row, and no state change), the data-only refusal, the
// error codes, the append-only effect batch 2b reads (killed is sticky), and revalidation.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlStates } from "@/lib/agents/controls";
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

import { setArenaControlAction } from "@/app/(app)/strategies/risk/actions";
import { setArenaControl } from "@/lib/learning/arenaControl";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;

const asUser = (id: number, role: string) =>
  requireUser.mockResolvedValue({ id, email: `${role}@example.test`, name: null, role });

const form = (o: Record<string, string | undefined>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) fd.set(k, v);
  return fd;
};
const PAUSE = { scope: "execution", key: "E01", state: "paused", confirm: "true" };

const controlRows = async () =>
  (await main.execute("SELECT * FROM arena_control ORDER BY id")).rows.map((r) => ({ ...r }));

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  await main.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  for (const [id, family, kind] of [
    ["E01", "F1", "E"],
    ["E02", "F2", "E"],
    ["C2-F1", "F1", "C2"],
  ] as const) {
    await main.execute({
      sql: `INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile)
            VALUES (?, 'AU', ?, ?, 'U', 'v1', 'P5')`,
      args: [id, kind, family],
    });
  }
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  asUser(ownerId, "owner");
});

describe("guard first", () => {
  it("asks for the admin (Owner) action before anything else, on the page path", async () => {
    await setArenaControlAction(form(PAUSE));
    expect(requireUser).toHaveBeenCalledWith("admin", "/strategies/risk");
  });

  it("a non-Owner is refused by the guard: nothing is written and the action writes no audit event", async () => {
    // The guard (not the action) records its own auth.forbidden event; here it is mocked to refuse.
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(setArenaControlAction(form(PAUSE))).rejects.toThrow(/403/);
    expect(await controlRows()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an anonymous visitor is redirected by the guard before any read", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(setArenaControlAction(form(PAUSE))).rejects.toThrow(/REDIRECT/);
    expect(await controlRows()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("the service refuses a non-Owner even if a caller skipped the guard", async () => {
    const user = { id: editorId, email: "e", name: null, role: "editor" } as const;
    const out = await setArenaControl(
      { mainDb: main, authDb: auth, env: process.env, meta: { ip: null, userAgent: null } },
      user as never,
      { scope: "execution", key: "E01", state: "paused", confirm: true },
    );
    expect(out.status).toBe(403);
    expect(await controlRows()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });
});

describe("the Owner pauses and resumes a strategy", () => {
  it("appends one row, audits it, and revalidates the pages", async () => {
    expect(await setArenaControlAction(form({ ...PAUSE, reason: "earnings week" }))).toEqual({
      ok: true,
    });
    const rows = await controlRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: "execution",
      scope_key: "E01",
      state: "paused",
      set_by: `u${ownerId}`,
    });
    expect(String(rows[0]!.reason)).toContain("earnings week");
    const audits = await auditRows(auth);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "arena.control_paused",
      actor_user_id: ownerId,
      target_type: "arena_control",
      target_id: "execution:E01",
      ip: "9.9.9.9",
    });
    expect(audits[0]!.detail).toMatchObject({
      scope: "execution",
      key: "E01",
      from: "enabled",
      to: "paused",
      reason: "earnings week",
    });
    // the control row names its audit event
    expect(String(rows[0]!.reason)).toContain(`audit:${String(audits[0]!.id)}`);
    expect(revalidatePath).toHaveBeenCalledWith("/strategies/risk");
    expect(revalidatePath).toHaveBeenCalledWith("/strategies");
  });

  it("pause then resume: the log is append-only and the latest row wins", async () => {
    await setArenaControlAction(form(PAUSE));
    await setArenaControlAction(form({ ...PAUSE, state: "enabled" }));
    const rows = await controlRows();
    expect(rows.map((r) => r.state)).toEqual(["paused", "enabled"]);
    const st = controlStates(
      rows.map((r) => ({
        scope: String(r.scope),
        scopeKey: String(r.scope_key),
        state: String(r.state),
      })),
    );
    expect(st.get("execution|E01")).toBe("enabled");
    expect((await auditRows(auth)).map((a) => a.action)).toEqual([
      "arena.control_paused",
      "arena.control_resume",
    ]);
  });

  it("the actor is the session user, never a field of the request", async () => {
    const fd = form(PAUSE);
    fd.set("set_by", "someone-else");
    fd.set("actor", "u999");
    await setArenaControlAction(fd);
    expect((await controlRows())[0]!.set_by).toBe(`u${ownerId}`);
  });
});

describe("the Owner switches a family off and on", () => {
  const KILL = { scope: "family", key: "F2", state: "killed", confirm: "true" };

  it("kill, then lift with an explicit enable (killed is sticky for pause)", async () => {
    expect(await setArenaControlAction(form(KILL))).toEqual({ ok: true });
    let rows = await controlRows();
    expect(rows[0]).toMatchObject({ scope: "family", scope_key: "F2", state: "killed" });
    expect((await auditRows(auth))[0]).toMatchObject({ action: "arena.control_killed" });
    // a later paused row does not lift a kill (D-094), and the action offers no family pause anyway
    expect(await setArenaControlAction(form({ ...KILL, state: "paused" }))).toEqual({
      error: "invalid",
    });
    expect(await setArenaControlAction(form({ ...KILL, state: "enabled" }))).toEqual({ ok: true });
    rows = await controlRows();
    expect(rows.map((r) => r.state)).toEqual(["killed", "enabled"]);
  });
});

describe("error codes", () => {
  const code = async (o: Record<string, string | undefined>) =>
    (await setArenaControlAction(form(o))) as { error?: string; ok?: true };
  const nothingChanged = async () => {
    expect(await controlRows()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  };

  it("invalid: missing or odd scope, key, state, combinations, long or control-character reason", async () => {
    for (const bad of [
      { ...PAUSE, scope: undefined },
      { ...PAUSE, scope: "market" },
      { ...PAUSE, key: undefined },
      { ...PAUSE, key: "E 01" },
      { ...PAUSE, key: "x".repeat(41) },
      { ...PAUSE, state: "killed" }, // an execution is paused, not killed
      { ...PAUSE, state: "off" },
      { ...PAUSE, scope: "family", key: "F1", state: "paused" },
      { ...PAUSE, reason: "x".repeat(201) },
      { ...PAUSE, reason: "bad\u0000reason" },
    ]) {
      expect(await code(bad)).toEqual({ error: "invalid" });
    }
    await nothingChanged();
  });

  it("confirmation_required: without confirm=true nothing happens", async () => {
    expect(await code({ ...PAUSE, confirm: undefined })).toEqual({
      error: "confirmation_required",
    });
    expect(await code({ ...PAUSE, confirm: "yes" })).toEqual({ error: "confirmation_required" });
    await nothingChanged();
  });

  it("not_found: unknown strategy or family, and controls (C2) cannot be paused here", async () => {
    expect(await code({ ...PAUSE, key: "E99" })).toEqual({ error: "not_found" });
    expect(await code({ ...PAUSE, key: "C2-F1" })).toEqual({ error: "not_found" });
    expect(await code({ scope: "family", key: "F9", state: "killed", confirm: "true" })).toEqual({
      error: "not_found",
    });
    await nothingChanged();
  });

  it("no_change: already in that state", async () => {
    expect(await code({ ...PAUSE, state: "enabled" })).toEqual({ error: "no_change" });
    await setArenaControlAction(form(PAUSE));
    expect(await code(PAUSE)).toEqual({ error: "no_change" });
    expect(await controlRows()).toHaveLength(1);
    expect(await auditRows(auth)).toHaveLength(1);
  });

  it("market_data_only: refused in data-only mode, before any audit event or state change", async () => {
    await main.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    expect(await code(PAUSE)).toEqual({ error: "market_data_only" });
    expect(await code({ scope: "family", key: "F1", state: "killed", confirm: "true" })).toEqual({
      error: "market_data_only",
    });
    await nothingChanged();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("unavailable: when the audit cannot be written, nothing is changed", async () => {
    vi.stubEnv("PII_HASH_KEY", ""); // the audit chain needs its key; without it the audit fails first
    expect(await code(PAUSE)).toEqual({ error: "unavailable" });
    await nothingChanged();
  });
});

describe("audit first", () => {
  it("the audit row exists before the state row; a failing writer leaves the audit and a _failed event", async () => {
    let auditSeenAtWrite: number | null = null;
    mem.main = new Proxy(main, {
      get(t, p, r) {
        if (p === "execute") {
          return async (...a: unknown[]) => {
            const q = a[0] as { sql?: string } | string;
            const sql = typeof q === "string" ? q : (q.sql ?? "");
            if (sql.includes("INSERT INTO arena_control")) {
              auditSeenAtWrite = (await auditRows(auth)).length; // what the audit log holds at write time
              throw new Error("disk full");
            }
            return (t.execute as (...x: unknown[]) => unknown)(...a);
          };
        }
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect(await setArenaControlAction(form(PAUSE))).toEqual({ error: "unavailable" });
    expect(auditSeenAtWrite).toBe(1);
    expect(await controlRows()).toEqual([]);
    const audits = await auditRows(auth);
    expect(audits.map((a) => a.action)).toEqual([
      "arena.control_paused",
      "arena.control_paused_failed",
    ]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

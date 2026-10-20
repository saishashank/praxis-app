// @vitest-environment node
// TST-122 for tickOpsTaskAction (UX-118, OPS-020; M7 T19b). The Owner ticks a dated Ops task. Covered:
// the guard runs FIRST and a refusal changes nothing, input validation, the audit event is written
// BEFORE the tick (a failing insert leaves the audit row and a `_failed` row, and no tick), the error
// codes, the append-only effect, no refusal in data-only mode (not a trading action), revalidation.
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

import { tickOpsTaskAction } from "@/app/(app)/ops/actions";
import { loadOps, tickOpsTask } from "@/lib/ops/service";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
  vi.useRealTimers();
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
// Monday 05 Oct 2026 12:00 Melbourne (AEDT): the weekly review of Saturday 03 Oct is overdue by 2 days.
const NOW = new Date("2026-10-05T01:00:00.000Z");
const WEEKLY = { task: "weekly_review", due: "2026-10-03" };

const ticks = async () =>
  (await main.execute("SELECT * FROM ops_task_done ORDER BY task_id, due_d")).rows.map((r) => ({
    ...r,
  }));

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  asUser(ownerId, "owner");
});

describe("guard first", () => {
  it("asks for the admin (Owner) action before anything else, on the page path", async () => {
    await tickOpsTaskAction(form(WEEKLY));
    expect(requireUser).toHaveBeenCalledWith("admin", "/ops");
  });

  it("a non-Owner is refused by the guard: nothing is written and the action writes no audit event", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(tickOpsTaskAction(form(WEEKLY))).rejects.toThrow(/403/);
    expect(await ticks()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an anonymous visitor is redirected by the guard before any read", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(tickOpsTaskAction(form(WEEKLY))).rejects.toThrow(/REDIRECT/);
    expect(await ticks()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("the service refuses a non-Owner even if a caller skipped the guard", async () => {
    const user = { id: editorId, email: "e", name: null, role: "editor" } as const;
    const out = await tickOpsTask(
      {
        mainDb: main,
        authDb: auth,
        env: process.env,
        meta: { ip: null, userAgent: null },
        now: () => NOW,
      },
      user as never,
      { taskId: WEEKLY.task, dueD: WEEKLY.due },
    );
    expect(out.status).toBe(403);
    expect(await ticks()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });
});

describe("the Owner ticks a task", () => {
  it("appends one row naming its audit event, audits it first, and revalidates /ops", async () => {
    expect(await tickOpsTaskAction(form(WEEKLY))).toEqual({ ok: true });
    const rows = await ticks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_id: "weekly_review",
      due_d: "2026-10-03",
      done_by: ownerId,
      done_at: NOW.toISOString(),
    });
    const audits = await auditRows(auth);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "ops.task_done",
      actor_user_id: ownerId,
      target_type: "ops_task",
      target_id: "weekly_review:2026-10-03",
      ip: "9.9.9.9",
    });
    expect(rows[0]!.audit_ref).toBe(`audit:${String(audits[0]!.id)}`);
    expect(revalidatePath).toHaveBeenCalledWith("/ops");
  });

  it("the page model then shows it done with the next date", async () => {
    await tickOpsTaskAction(form(WEEKLY));
    const page = await loadOps(main, NOW);
    expect(page.today).toBe("2026-10-05");
    expect(page.tasks.find((t) => t.id === "weekly_review")).toMatchObject({
      status: "done",
      nextD: "2026-10-10",
    });
  });

  it("works in data-only mode (it is not a trading action)", async () => {
    await main.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    expect(await tickOpsTaskAction(form(WEEKLY))).toEqual({ ok: true });
  });

  it("the actor is the session user, never a field of the request", async () => {
    const fd = form(WEEKLY);
    fd.set("done_by", "999");
    await tickOpsTaskAction(fd);
    expect((await ticks())[0]!.done_by).toBe(ownerId);
  });

  it("a token rotation is ticked on its expiry date once it is inside the warning window", async () => {
    await main.execute({
      sql: "INSERT INTO credential_expiry (name, expires_on, set_at, set_by) VALUES (?, ?, ?, ?)",
      args: ["turso_token", "2026-10-12", NOW.toISOString(), ownerId],
    });
    expect(
      await tickOpsTaskAction(form({ task: "rotate_turso_token", due: "2026-10-12" })),
    ).toEqual({
      ok: true,
    });
    expect((await ticks())[0]).toMatchObject({
      task_id: "rotate_turso_token",
      due_d: "2026-10-12",
    });
  });
});

describe("error codes", () => {
  const code = async (o: Record<string, string | undefined>) =>
    (await tickOpsTaskAction(form(o))) as { error?: string; ok?: true };
  const nothingChanged = async () => {
    expect(await ticks()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  };

  it("invalid: missing, odd or oversized task and due date", async () => {
    for (const bad of [
      { ...WEEKLY, task: undefined },
      { ...WEEKLY, task: "" },
      { ...WEEKLY, task: "Weekly Review" },
      { ...WEEKLY, task: "x".repeat(101) },
      { ...WEEKLY, due: undefined },
      { ...WEEKLY, due: "2026-13-40" },
      { ...WEEKLY, due: "03/10/2026" },
    ]) {
      expect(await code(bad)).toEqual({ error: "invalid" });
    }
    await nothingChanged();
  });

  it("unknown_task: not on the list", async () => {
    expect(await code({ task: "reformat_disk", due: "2026-10-03" })).toEqual({
      error: "unknown_task",
    });
    expect(await code({ task: "rotate_missing", due: "2026-10-03" })).toEqual({
      error: "unknown_task",
    });
    await nothingChanged();
  });

  it("not_due: a past, future or other date than the one on the list", async () => {
    for (const due of ["2026-09-26", "2026-10-10", "2026-10-05"])
      expect(await code({ task: "weekly_review", due })).toEqual({ error: "not_due" });
    // a one-off task before its date has no tickable date
    expect(await code({ task: "asic_cfd_review", due: "2027-05-24" })).toEqual({
      error: "not_due",
    });
    await nothingChanged();
  });

  it("already_done: a second tick of the same occurrence changes nothing", async () => {
    await tickOpsTaskAction(form(WEEKLY));
    expect(await code(WEEKLY)).toEqual({ error: "already_done" });
    expect(await ticks()).toHaveLength(1);
    expect(await auditRows(auth)).toHaveLength(1);
  });

  it("unavailable: when the audit cannot be written, nothing is ticked", async () => {
    vi.stubEnv("PII_HASH_KEY", "");
    expect(await code(WEEKLY)).toEqual({ error: "unavailable" });
    await nothingChanged();
  });
});

describe("audit first", () => {
  it("a failing insert leaves the audit row and a _failed event, and no tick", async () => {
    await main.execute(
      "CREATE TRIGGER ops_boom BEFORE INSERT ON ops_task_done BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(await tickOpsTaskAction(form(WEEKLY))).toEqual({ error: "unavailable" });
    const audits = await auditRows(auth);
    expect(audits.map((a) => a.action)).toEqual(["ops.task_done", "ops.task_done_failed"]);
    expect(audits[1]!.detail).toMatchObject({ taskId: "weekly_review", auditId: audits[0]!.id });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("the tick table is append-only: a stored tick cannot be changed or removed", async () => {
    await tickOpsTaskAction(form(WEEKLY));
    await expect(main.execute("UPDATE ops_task_done SET done_by = 2")).rejects.toThrow(
      /append-only/,
    );
    await expect(main.execute("DELETE FROM ops_task_done")).rejects.toThrow(/append-only/);
  });
});

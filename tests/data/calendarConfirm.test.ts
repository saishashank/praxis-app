// @vitest-environment node
// DAT-160, D-057 #11, D-047 (audit first), ROL-102a, AT-02: confirmCalendar service and
// confirmCalendarAction (System Health, Owner only).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { calendarYearSummary, confirmCalendar } from "@/lib/data/calendarAdmin";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbs = vi.hoisted(() => ({ main: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbs.main(), authDb: () => dbs.auth() }));

import { confirmCalendarAction } from "@/app/(app)/health/actions";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
const ENV = { PII_HASH_KEY: KEY } as Record<string, string | undefined>;
const NOW = new Date("2026-10-11T01:00:00.000Z");
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const unconfirmed = async (year: number) =>
  Number(
    (
      await main.execute({
        sql: "SELECT COUNT(*) n FROM trading_calendar WHERE d LIKE ? AND confirmed = 0",
        args: [`${year}-%`],
      })
    ).rows[0].n,
  );
const svc = (over: Record<string, unknown> = {}) =>
  confirmCalendar({
    mainDb: main,
    authDb: auth,
    env: ENV,
    actorId: ownerId,
    market: "AU",
    year: 2026,
    now: NOW,
    ...over,
  } as Parameters<typeof confirmCalendar>[0]);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.stubEnv("OWNER_EMAIL", "owner@example.test");
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await freshDb("main");
  auth = await freshDb("auth");
  dbs.main.mockReset().mockReturnValue(main);
  dbs.auth.mockReset().mockReturnValue(auth);
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
  requireUser.mockResolvedValue({
    id: ownerId,
    email: "owner@example.test",
    name: null,
    role: "owner",
  });
});

describe("confirmCalendar (service)", () => {
  it("confirms every unconfirmed AU row of the year in one go, with one audit event", async () => {
    expect(await svc()).toEqual({ ok: true, rows: 261 });
    expect(await unconfirmed(2026)).toBe(0);
    expect(await unconfirmed(2027)).toBe(261); // other years untouched
    const a = await auditRows(auth);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action: "calendar.confirm",
      actor_user_id: ownerId,
      target_type: "calendar",
      target_id: "AU",
    });
    expect(a[0].detail).toEqual({ market: "AU", year: 2026, rows: 261 });
    expect(await calendarYearSummary(main, "AU", 2026)).toMatchObject({
      unconfirmed: 0,
      tradingDays: 254,
    });
  });

  it("is idempotent: a second confirm changes nothing and adds no audit event", async () => {
    await svc();
    expect(await svc()).toEqual({ ok: true, rows: 0 });
    expect(await auditRows(auth)).toHaveLength(1);
  });

  it("only confirms the remaining rows when some were confirmed already", async () => {
    await main.execute("UPDATE trading_calendar SET confirmed = 1 WHERE d < '2026-07-01'");
    const left = await unconfirmed(2026);
    expect(await svc()).toEqual({ ok: true, rows: left });
    expect((await auditRows(auth))[0].detail).toMatchObject({ rows: left });
  });

  it("writes the audit event BEFORE the calendar change", async () => {
    let auditAtWrite = -1;
    const spy = new Proxy(main, {
      get(t, p, r) {
        if (p === "transaction") {
          return async (...args: unknown[]) => {
            auditAtWrite = (await auditRows(auth)).length;
            return (t.transaction as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect(await svc({ mainDb: spy })).toEqual({ ok: true, rows: 261 });
    expect(auditAtWrite).toBe(1);
  });

  it("if the audit cannot be written nothing is confirmed", async () => {
    await auth.execute("DROP TABLE audit_event");
    expect(await svc()).toEqual({ ok: false, error: "unavailable" });
    expect(await unconfirmed(2026)).toBe(261);
  });

  it("if the calendar write fails, a calendar.confirm_failed event follows and nothing changes", async () => {
    const broken = new Proxy(main, {
      get(t, p, r) {
        if (p === "transaction") return async () => Promise.reject(new Error("db down"));
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect(await svc({ mainDb: broken })).toEqual({ ok: false, error: "unavailable" });
    expect((await auditRows(auth)).map((r) => r.action)).toEqual([
      "calendar.confirm",
      "calendar.confirm_failed",
    ]);
    expect(await unconfirmed(2026)).toBe(261);
  });

  it("a failed execute inside the transaction rolls back and reports unavailable", async () => {
    await main.execute("DROP TRIGGER trading_calendar_guard_update");
    await main.execute(
      "CREATE TRIGGER boom BEFORE UPDATE ON trading_calendar BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    expect(await svc()).toEqual({ ok: false, error: "unavailable" });
    expect(await unconfirmed(2026)).toBe(261);
  });

  it("refuses a non-Owner actor, bad market, bad year and a year with no rows", async () => {
    expect(await svc({ actorId: editorId })).toEqual({ ok: false, error: "forbidden" });
    expect(await svc({ actorId: 9999 })).toEqual({ ok: false, error: "forbidden" });
    for (const market of ["IN", "au", 5, undefined]) {
      expect(await svc({ market })).toEqual({ ok: false, error: "invalid" });
    }
    for (const year of [1999, 2101, 2026.5, "2026", undefined, NaN]) {
      expect(await svc({ year })).toEqual({ ok: false, error: "invalid" });
    }
    expect(await svc({ year: 2031 })).toEqual({ ok: false, error: "not_found" });
    expect(await auditRows(auth)).toEqual([]);
    expect(await unconfirmed(2026)).toBe(261);
  });

  it("reports unavailable when the databases cannot be read", async () => {
    await auth.execute("DROP TABLE app_user");
    expect(await svc()).toEqual({ ok: false, error: "unavailable" });
    await auth.close();
    const m = await freshDb("main");
    const a = await freshDb("auth");
    const owner = await addUser(a, { email: "owner@example.test", role: "owner" });
    await m.execute("DROP TABLE trading_calendar");
    expect(await svc({ mainDb: m, authDb: a, actorId: owner })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("the table trigger still allows only confirmed 0 to 1", async () => {
    await expect(
      main.execute("UPDATE trading_calendar SET close_time = '12:00' WHERE d = '2026-02-02'"),
    ).rejects.toThrow(/only confirmed 0 to 1/);
    await svc();
    await expect(
      main.execute("UPDATE trading_calendar SET confirmed = 0 WHERE d = '2026-02-02'"),
    ).rejects.toThrow(/only confirmed 0 to 1/);
  });
});

describe("confirmCalendarAction", () => {
  it("requires admin on /health and stops when refused (editor/viewer)", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(confirmCalendarAction(form({ market: "AU", year: "2026" }))).rejects.toThrow(
      /403/,
    );
    expect(requireUser).toHaveBeenCalledWith("admin", "/health");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await unconfirmed(2026)).toBe(261);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("confirms, audits with the request meta and revalidates the page", async () => {
    expect(await confirmCalendarAction(form({ market: "AU", year: "2026" }))).toEqual({
      ok: true,
      rows: 261,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/health");
    expect(await unconfirmed(2026)).toBe(0);
    expect((await auditRows(auth))[0]).toMatchObject({
      action: "calendar.confirm",
      actor_user_id: ownerId,
      ip: "9.9.9.9",
      user_agent: "agent",
    });
  });

  it("second click is a harmless no-op", async () => {
    await confirmCalendarAction(form({ market: "AU", year: "2026" }));
    expect(await confirmCalendarAction(form({ market: "AU", year: "2026" }))).toEqual({
      ok: true,
      rows: 0,
    });
    expect(await auditRows(auth)).toHaveLength(1);
  });

  it("returns the code for invalid input without revalidating", async () => {
    expect(await confirmCalendarAction(form({ market: "AU", year: "20x6" }))).toEqual({
      error: "invalid",
    });
    expect(await confirmCalendarAction(form({ market: "XX", year: "2026" }))).toEqual({
      error: "invalid",
    });
    expect(await confirmCalendarAction(new FormData())).toEqual({ error: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a user the guard lets through but who is not the Owner in the auth DB is refused", async () => {
    requireUser.mockResolvedValue({
      id: editorId,
      email: "e@example.test",
      name: null,
      role: "owner",
    });
    expect(await confirmCalendarAction(form({ market: "AU", year: "2026" }))).toEqual({
      error: "forbidden",
    });
    expect(await unconfirmed(2026)).toBe(261);
  });

  it("an unexpected database error becomes unavailable", async () => {
    dbs.main.mockImplementation(() => {
      throw new Error("no db");
    });
    expect(await confirmCalendarAction(form({ market: "AU", year: "2026" }))).toEqual({
      error: "unavailable",
    });
  });
});

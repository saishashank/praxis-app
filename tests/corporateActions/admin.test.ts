// @vitest-environment node
// Owner decisions on queued corporate actions (DAT-221, UX-114, ROL-102a, D-047 audit first, AT-02):
// resolveCorporateAction service and the review server actions.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { resolveCorporateAction } from "@/lib/data/corporateActions/admin";
import { loadActions, runCorporateActions } from "@/lib/data/corporateActions/engine.mjs";
import { caDb, count, D0, D1, factors, io, nowOf, openFlags, putBar, rows } from "./helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbs = vi.hoisted(() => ({ main: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbs.main(), authDb: () => dbs.auth() }));

import {
  confirmCorporateActionAction,
  rejectCorporateActionAction,
} from "@/app/(app)/review/actions";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
const ENV = { PII_HASH_KEY: KEY } as Record<string, string | undefined>;
const NOW = new Date("2026-10-13T08:00:00.000Z");
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const svc = (over: Record<string, unknown> = {}) =>
  resolveCorporateAction({
    mainDb: main,
    authDb: auth,
    env: ENV,
    actorId: ownerId,
    actionId: 1,
    decision: "confirm",
    now: NOW,
    ...over,
  } as Parameters<typeof resolveCorporateAction>[0]);
const state = async (id = 1) =>
  (await loadActions(main, io(), "AU")).find((a) => a.id === id)?.state;
const proxyMain = (over: Record<string, unknown>) =>
  new Proxy(main, {
    get(t, p, r) {
      if (typeof p === "string" && p in over) return over[p];
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
  vi.stubEnv("OWNER_EMAIL", "owner@example.test");
  requireUser.mockReset();
  revalidatePath.mockReset();
  main = await caDb();
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
  // ZZA drops 50% on D1 with no announcement: a price-only candidate waits in the Owner queue.
  await putBar(main, "ZZA", D0, 10);
  await putBar(main, "ZZA", D1, 5);
  await runCorporateActions({ db: main, market: "AU", d: D1, io: io(), now: nowOf(D1) });
});

describe("resolveCorporateAction (service)", () => {
  it("confirm: audit event first, then the decision, the factor and the cleared block", async () => {
    expect(await openFlags(main, "DAT-222:unresolved_corporate_action")).toHaveLength(1);
    expect(await svc()).toEqual({ ok: true, settled: true });
    expect(await state()).toBe("confirmed");
    const a = await auditRows(auth);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action: "corporate_action.confirm",
      actor_user_id: ownerId,
      target_type: "corporate_action",
      target_id: "1",
    });
    expect(a[0].detail).toEqual({ code: "ZZA", type: "split", ex_date: D1 });
    expect(await factors(main)).toEqual([[1, 0.5]]);
    expect(await openFlags(main, "DAT-222:unresolved_corporate_action")).toEqual([]);
    const ev = await rows(
      main,
      "SELECT status, by, note FROM corporate_action_event ORDER BY id DESC LIMIT 1",
    );
    expect(ev[0]).toMatchObject({ status: "resolved", by: `owner:${ownerId}` });
    expect(JSON.parse(String(ev[0].note))).toEqual({ d: "2026-10-13", resolution: "confirmed" });
  });

  it("reject: no factor, the item closes", async () => {
    expect(await svc({ decision: "reject" })).toEqual({ ok: true, settled: true });
    expect(await state()).toBe("rejected");
    expect((await auditRows(auth))[0].action).toBe("corporate_action.reject");
    expect(await count(main, "adjustment_factor")).toBe(0);
  });

  it("writes the audit event BEFORE the decision", async () => {
    let auditAtWrite = -1;
    const spy = proxyMain({
      transaction: async (...args: unknown[]) => {
        auditAtWrite = (await auditRows(auth)).length;
        return (main.transaction as (...a: unknown[]) => unknown).apply(main, args);
      },
    });
    expect((await svc({ mainDb: spy })).ok).toBe(true);
    expect(auditAtWrite).toBe(1);
  });

  it("a second click finds nothing open: no write and no audit event", async () => {
    await svc();
    expect(await svc()).toEqual({ ok: false, error: "not_open" });
    expect(await svc({ decision: "reject" })).toEqual({ ok: false, error: "not_open" });
    expect(await auditRows(auth)).toHaveLength(1);
  });

  it("a blocked-only item can also be decided by the Owner", async () => {
    await main.execute({
      sql: "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (1, ?, 'queued', 'system', ?)",
      args: ["2026-10-13T09:00:00.000Z", JSON.stringify({ d: D1, queue: "blocked" })],
    });
    expect((await svc()).ok).toBe(true);
  });

  it("a pending item is not open for a decision", async () => {
    await main.execute({
      sql: "INSERT INTO corporate_action (id, market, code, type, ex_date, payload_json) VALUES (9, 'AU', 'ZZB', 'split', '2026-11-02', '{\"new\":2,\"old\":1}')",
    });
    await main.execute({
      sql: "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (9, ?, 'queued', 'system', ?)",
      args: [nowOf(D1), JSON.stringify({ d: D1, queue: "pending" })],
    });
    expect(await svc({ actionId: 9 })).toEqual({ ok: false, error: "not_open" });
    expect(await auditRows(auth)).toEqual([]);
  });

  it("if the audit cannot be written nothing is decided", async () => {
    await auth.execute("DROP TABLE audit_event");
    expect(await svc()).toEqual({ ok: false, error: "unavailable" });
    expect(await state()).toBe("owner");
  });

  it("if the decision write fails, a ..._failed event follows and nothing changes", async () => {
    const broken = proxyMain({ transaction: () => Promise.reject(new Error("db down")) });
    expect(await svc({ mainDb: broken })).toEqual({ ok: false, error: "unavailable" });
    expect((await auditRows(auth)).map((r) => r.action)).toEqual([
      "corporate_action.confirm",
      "corporate_action.confirm_failed",
    ]);
    expect(await state()).toBe("owner");
  });

  it("if someone else decided in between, the failure is recorded and reported", async () => {
    const racing = proxyMain({
      transaction: async (...args: unknown[]) => {
        await main.execute({
          sql: "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (1, ?, 'resolved', 'other', ?)",
          args: ["2026-10-13T08:00:00.500Z", JSON.stringify({ d: D1, resolution: "rejected" })],
        });
        return (main.transaction as (...a: unknown[]) => unknown).apply(main, args);
      },
    });
    expect(await svc({ mainDb: racing })).toEqual({ ok: false, error: "not_open" });
    const a = await auditRows(auth);
    expect(a.map((r) => r.action)).toEqual([
      "corporate_action.confirm",
      "corporate_action.confirm_failed",
    ]);
    expect(a[1].detail).toMatchObject({ reason: "not_open" });
    expect(await state()).toBe("rejected");
  });

  it("if settling fails after the decision, the decision stands and the next nightly run completes it", async () => {
    await main.execute(
      "CREATE TRIGGER boom BEFORE INSERT ON adjustment_factor BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    expect(await svc()).toEqual({ ok: true, settled: false });
    expect(await state()).toBe("confirmed");
    expect(await count(main, "adjustment_factor")).toBe(0);
    await main.execute("DROP TRIGGER boom");
    const r = await runCorporateActions({
      db: main,
      market: "AU",
      d: D1,
      io: io(),
      now: nowOf(D1),
    });
    expect(r.factors_written).toBe(1);
    expect(await factors(main)).toEqual([[1, 0.5]]);
  });

  it("refuses a non-Owner actor, a bad decision, a bad id and an unknown item", async () => {
    expect(await svc({ actorId: editorId })).toEqual({ ok: false, error: "forbidden" });
    expect(await svc({ actorId: 9999 })).toEqual({ ok: false, error: "forbidden" });
    for (const decision of ["reverse", "CONFIRM", undefined, 1]) {
      expect(await svc({ decision })).toEqual({ ok: false, error: "invalid" });
    }
    for (const actionId of ["1", 0, -1, 1.5, NaN, undefined, 2 ** 60]) {
      expect(await svc({ actionId })).toEqual({ ok: false, error: "invalid" });
    }
    expect(await svc({ actionId: 777 })).toEqual({ ok: false, error: "not_found" });
    expect(await auditRows(auth)).toEqual([]);
    expect(await state()).toBe("owner");
  });

  it("reports unavailable when a database cannot be read", async () => {
    await main.execute("DROP TRIGGER corporate_action_no_delete");
    await main.execute("DROP TABLE corporate_action");
    expect(await svc()).toEqual({ ok: false, error: "unavailable" });
    await auth.execute("DROP TABLE app_user");
    expect(await svc()).toEqual({ ok: false, error: "unavailable" });
  });

  it("confirming one reading while another is confirmed is refused and audited as a failure", async () => {
    await main.execute({
      sql: "INSERT INTO corporate_action (id, market, code, type, ex_date, payload_json) VALUES (2, 'AU', 'ZZA', 'split', ?, ?)",
      args: [D1, JSON.stringify({ new: 3, old: 1 })],
    });
    await main.execute({
      sql: "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (2, ?, 'auto_confirmed', 'system', ?)",
      args: ["2026-10-13T09:00:00.000Z", JSON.stringify({ d: D1 })],
    });
    expect(await svc()).toEqual({ ok: false, error: "conflicts_with_confirmed" });
    expect((await auditRows(auth)).map((r) => r.action)).toEqual([
      "corporate_action.confirm",
      "corporate_action.confirm_failed",
    ]);
  });
});

describe("review server actions", () => {
  it("require admin on /review and stop when refused (editor/viewer)", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(confirmCorporateActionAction(form({ id: "1" }))).rejects.toThrow(/403/);
    await expect(rejectCorporateActionAction(form({ id: "1" }))).rejects.toThrow(/403/);
    expect(requireUser).toHaveBeenCalledWith("admin", "/review");
    expect(await state()).toBe("owner");
    expect(await auditRows(auth)).toEqual([]);
  });

  it("confirm: decides, revalidates and records the signed-in Owner as the actor", async () => {
    expect(await confirmCorporateActionAction(form({ id: "1" }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/review");
    expect(await state()).toBe("confirmed");
    const a = await auditRows(auth);
    expect(a[0]).toMatchObject({ action: "corporate_action.confirm", actor_user_id: ownerId });
  });

  it("reject: decides and revalidates", async () => {
    expect(await rejectCorporateActionAction(form({ id: "1" }))).toEqual({ ok: true });
    expect(await state()).toBe("rejected");
    expect((await auditRows(auth))[0].action).toBe("corporate_action.reject");
  });

  it("returns the error code for a bad id or a closed item, without revalidating", async () => {
    for (const id of ["abc", "", "1 OR 1=1", "0"]) {
      expect(await confirmCorporateActionAction(form({ id }))).toEqual({ error: "invalid" });
    }
    expect(await confirmCorporateActionAction(new FormData())).toEqual({ error: "invalid" });
    expect(await confirmCorporateActionAction(form({ id: "99" }))).toEqual({ error: "not_found" });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await auditRows(auth)).toEqual([]);
  });

  it("maps an unexpected failure to unavailable", async () => {
    dbs.main.mockImplementation(() => {
      throw new Error("no db");
    });
    expect(await confirmCorporateActionAction(form({ id: "1" }))).toEqual({ error: "unavailable" });
  });
});

// @vitest-environment node
// M5 T2 Owner controls on System Health (docs/M5_design.md 4.12, 4.7, 3; D-096, D-097): the email
// switch and its one-off review test date, the Owner watch-list, credential expiry dates and the
// attention snooze. HIGH-RISK like src/lib/data/controls.ts: Owner only, audit first (D-047,
// D-066), refusals write nothing, a failed write follows with a `_failed` event.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { setConfig } from "@/lib/config/store";
import {
  addWatchListCode,
  loadEmailControlsView,
  removeWatchListCode,
  setCredentialExpiry,
  setEmailMode,
  setEmailReviewTestDate,
  snoozeAttention,
} from "@/lib/data/controls";
import { emailKindAllowed, readEmailSwitch, reviewCheckForced } from "@/lib/email/switch";
import { findAttentionItem, parseAttentionItems, type AttentionItem } from "@/lib/health/attention";
import { EMAIL_KINDS } from "@/lib/sentinel/schema";

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
  addWatchListCodeAction,
  removeWatchListCodeAction,
  setCredentialExpiryAction,
  setEmailModeAction,
  setEmailReviewTestDateAction,
  snoozeAttentionAction,
} from "@/app/(app)/health/emailActions";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
const ENV = { PII_HASH_KEY: KEY } as Record<string, string | undefined>;
// 2026-10-19 01:00 UTC is 12:00 on 2026-10-19 in Melbourne (AEDT).
const NOW = new Date("2026-10-19T01:00:00.000Z");
const TODAY = "2026-10-19";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const base = (over: Record<string, unknown> = {}) => ({
  mainDb: main,
  authDb: auth,
  env: ENV,
  actorId: ownerId,
  now: NOW,
  ...over,
});
const actions = async () => (await auditRows(auth)).map((r) => r.action);
const sw = async (key: string) => {
  const r = await main.execute({
    sql: "SELECT value_json FROM worker_state WHERE key = ?",
    args: [key],
  });
  return r.rows.length ? String(r.rows[0].value_json) : null;
};
const count = async (sql: string) => Number((await main.execute(sql)).rows[0].n);
const setMarket = (mode: string) =>
  main.execute({ sql: "UPDATE market SET mode = ? WHERE code = 'AU'", args: [mode] });

/** A main DB whose transaction() runs `before` first, then behaves normally. */
const withTxHook = (before: () => Promise<void>) =>
  new Proxy(main, {
    get(t, p, r) {
      if (p === "transaction") {
        return async (...args: unknown[]) => {
          await before();
          return (t.transaction as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
const brokenDb = new Proxy({} as Client, {
  get: () => () => Promise.reject(new Error("db down")),
});
const txFails = () =>
  new Proxy(main, {
    get(t, p, r) {
      if (p === "transaction") return async () => Promise.reject(new Error("db down"));
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("PII_HASH_KEY", KEY);
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
  await main.execute(
    "INSERT INTO instrument (market, code, name) VALUES ('AU', 'ZZAA', 'Synthetic A'), ('AU', 'ZZBB', 'Synthetic B')",
  );
});

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  component: "security",
  key: "d_turso_main_tokens",
  label: "Turso token expires soon",
  state: "attention",
  deadlineD: "2026-11-30",
  ...over,
});

describe("shared rules (every M5 control)", () => {
  const calls: Array<[string, (o?: Record<string, unknown>) => Promise<unknown>]> = [
    ["email mode", (o) => setEmailMode(base({ mode: "incidents", ...o }) as never)],
    ["review test date", (o) => setEmailReviewTestDate(base({ date: TODAY, ...o }) as never)],
    [
      "watch-list add",
      (o) => addWatchListCode(base({ market: "AU", code: "ZZAA", ...o }) as never),
    ],
    [
      "watch-list remove",
      (o) => removeWatchListCode(base({ market: "AU", code: "ZZAA", ...o }) as never),
    ],
    [
      "credential expiry",
      (o) =>
        setCredentialExpiry(
          base({ name: "d_turso_main_tokens", expiresOn: "2027-01-31", ...o }) as never,
        ),
    ],
    [
      "attention snooze",
      (o) =>
        snoozeAttention(
          base({
            component: "security",
            itemKey: "d_turso_main_tokens",
            days: 3,
            item: item(),
            ...o,
          }) as never,
        ),
    ],
  ];

  it.each(calls)(
    "%s: a non-Owner (editor) is refused with no audit and no change",
    async (_n, call) => {
      expect(await call({ actorId: editorId })).toEqual({ ok: false, error: "forbidden" });
      expect(await call({ actorId: 9999 })).toEqual({ ok: false, error: "forbidden" });
      expect(await actions()).toEqual([]);
      expect(await sw("email_mode")).toBeNull();
      expect(await count("SELECT COUNT(*) AS n FROM watch_list_owner")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM credential_expiry")).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM attention_snooze")).toBe(0);
    },
  );

  it.each(calls)("%s: a revoked Owner is refused", async (_n, call) => {
    await auth.execute({
      sql: "UPDATE app_user SET status = 'revoked' WHERE id = ?",
      args: [ownerId],
    });
    expect(await call()).toEqual({ ok: false, error: "forbidden" });
    expect(await actions()).toEqual([]);
  });

  it.each(calls)("%s: an unreadable auth database is 'unavailable'", async (_n, call) => {
    expect(await call({ authDb: brokenDb })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("email switch: defaults and the kind matrix", () => {
  it("nothing stored reads as off; an unknown or malformed value reads as off (fail closed)", async () => {
    expect(await readEmailSwitch(main, TODAY)).toEqual({ mode: "off", reviewTestDate: null });
    for (const raw of ['"FULL"', '"on"', "1", "{bad", '""']) {
      await main.execute({
        sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('email_mode', ?, 'x') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
        args: [raw],
      });
      expect((await readEmailSwitch(main, TODAY)).mode, raw).toBe("off");
    }
  });

  it("a test date is honoured only with incidents mode, only from a real date, and expires after that date", async () => {
    const put = (k: string, v: string) =>
      main.execute({
        sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
        args: [k, JSON.stringify(v)],
      });
    await put("email_review_test_date", "2026-10-20");
    await put("email_mode", "off");
    expect((await readEmailSwitch(main, TODAY)).reviewTestDate).toBeNull();
    await put("email_mode", "full");
    expect((await readEmailSwitch(main, TODAY)).reviewTestDate).toBeNull();
    await put("email_mode", "incidents");
    expect((await readEmailSwitch(main, TODAY)).reviewTestDate).toBe("2026-10-20");
    expect((await readEmailSwitch(main, "2026-10-20")).reviewTestDate).toBe("2026-10-20");
    expect((await readEmailSwitch(main, "2026-10-21")).reviewTestDate).toBeNull(); // expired
    await put("email_review_test_date", "2026-02-30");
    expect((await readEmailSwitch(main, TODAY)).reviewTestDate).toBeNull();
  });

  it("emailKindAllowed: off sends nothing, full sends all, incidents only incident-class mail", () => {
    const off = { mode: "off", reviewTestDate: null } as const;
    const full = { mode: "full", reviewTestDate: null } as const;
    const inc = { mode: "incidents", reviewTestDate: "2026-10-20" } as const;
    for (const kind of EMAIL_KINDS) {
      expect(emailKindAllowed(off, kind, { d: TODAY, watchdogFallback: true }), kind).toBe(false);
      expect(emailKindAllowed(full, kind, { d: TODAY }), kind).toBe(true);
    }
    for (const kind of ["incident_open", "incident_s1", "tokens", "unread7", "dbdown"] as const) {
      expect(emailKindAllowed(inc, kind, { d: TODAY }), kind).toBe(true);
    }
    for (const kind of ["p0", "p0_batch", "reminder", "brief", "test"] as const) {
      expect(emailKindAllowed(inc, kind, { d: "2026-10-20" }), kind).toBe(false);
    }
    // The review: only on the one-off date, or as the watchdog's fallback.
    expect(emailKindAllowed(inc, "review", { d: "2026-10-20" })).toBe(true);
    expect(emailKindAllowed(inc, "review", { d: TODAY })).toBe(false);
    expect(emailKindAllowed(inc, "review", { d: TODAY, watchdogFallback: true })).toBe(true);
    expect(
      emailKindAllowed({ mode: "incidents", reviewTestDate: null }, "review", { d: TODAY }),
    ).toBe(false);
    expect(reviewCheckForced(inc, "2026-10-20")).toBe(true);
    expect(reviewCheckForced(inc, TODAY)).toBe(false);
    expect(reviewCheckForced({ mode: "incidents", reviewTestDate: null }, TODAY)).toBe(false);
  });
});

describe("setEmailMode", () => {
  it("rejects anything that is not off, incidents or full", async () => {
    for (const mode of [undefined, "", "on", "FULL", 1, null, true]) {
      expect(await setEmailMode(base({ mode }) as never)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await actions()).toEqual([]);
  });

  it("off when never set changes nothing and writes no audit", async () => {
    expect(await setEmailMode(base({ mode: "off" }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await sw("email_mode")).toBeNull();
    expect(await actions()).toEqual([]);
  });

  it("incidents is written with an audit event, then idempotent", async () => {
    expect(await setEmailMode(base({ mode: "incidents" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("email_mode")).toBe('"incidents"');
    const a = (await auditRows(auth)).filter((r) => r.action === "controls.email_mode");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor_user_id: ownerId,
      target_type: "control",
      target_id: "email_mode",
    });
    expect(a[0].detail).toEqual({ from: "off", to: "incidents", clearsReviewTestDate: false });
    expect(await setEmailMode(base({ mode: "incidents" }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect((await actions()).filter((x) => x === "controls.email_mode")).toHaveLength(1);
  });

  it("full is refused while a market is data-only: no audit, no change", async () => {
    expect((await main.execute("SELECT mode FROM market WHERE code = 'AU'")).rows[0].mode).toBe(
      "data_only",
    );
    expect(await setEmailMode(base({ mode: "full" }) as never)).toEqual({
      ok: false,
      error: "data_only_market",
    });
    expect(await actions()).toEqual([]);
    expect(await sw("email_mode")).toBeNull();
    // From incidents too.
    await setEmailMode(base({ mode: "incidents" }) as never);
    expect(await setEmailMode(base({ mode: "full" }) as never)).toMatchObject({
      error: "data_only_market",
    });
    expect(await sw("email_mode")).toBe('"incidents"');
  });

  it("full is allowed once no market is data-only, and off is always allowed", async () => {
    await setMarket("off");
    expect(await setEmailMode(base({ mode: "full" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("email_mode")).toBe('"full"');
    await setMarket("data_only");
    expect(await setEmailMode(base({ mode: "off" }) as never)).toEqual({ ok: true, changed: true });
    expect(await sw("email_mode")).toBe('"off"');
  });

  it("the data-only rule is re-checked inside the transaction (a market switched back after the check)", async () => {
    await setMarket("off");
    const racing = withTxHook(async () => {
      await setMarket("data_only");
    });
    expect(await setEmailMode(base({ mode: "full", mainDb: racing }) as never)).toEqual({
      ok: false,
      error: "data_only_market",
    });
    expect(await sw("email_mode")).toBeNull();
    expect((await actions()).slice(-1)).toEqual(["controls.email_mode_failed"]);
  });

  it("leaving incidents clears the one-off review test date in the same change", async () => {
    await setEmailMode(base({ mode: "incidents" }) as never);
    await setEmailReviewTestDate(base({ date: "2026-10-20" }) as never);
    expect(await sw("email_review_test_date")).toBe('"2026-10-20"');
    expect(await setEmailMode(base({ mode: "off" }) as never)).toEqual({ ok: true, changed: true });
    expect(await sw("email_review_test_date")).toBeNull();
    const last = (await auditRows(auth)).filter((r) => r.action === "controls.email_mode").pop();
    expect(last?.detail).toEqual({ from: "incidents", to: "off", clearsReviewTestDate: true });
  });

  it("writes the audit event BEFORE the switch changes", async () => {
    let auditAtWrite = -1;
    const spy = withTxHook(async () => {
      auditAtWrite = (await actions()).filter((x) => x === "controls.email_mode").length;
    });
    expect(await setEmailMode(base({ mode: "incidents", mainDb: spy }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(auditAtWrite).toBe(1);
  });

  it("if the audit cannot be written nothing changes", async () => {
    await auth.execute("DROP TABLE audit_event");
    expect(await setEmailMode(base({ mode: "incidents" }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await sw("email_mode")).toBeNull();
  });

  it("if the write fails a _failed event follows and nothing changes", async () => {
    expect(await setEmailMode(base({ mode: "incidents", mainDb: txFails() }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect((await actions()).slice(-2)).toEqual([
      "controls.email_mode",
      "controls.email_mode_failed",
    ]);
    expect(await sw("email_mode")).toBeNull();
  });
});

describe("setEmailReviewTestDate", () => {
  const inIncidents = () => setEmailMode(base({ mode: "incidents" }) as never);

  it("needs the incidents mode: refused with off or full, no audit", async () => {
    expect(await setEmailReviewTestDate(base({ date: TODAY }) as never)).toEqual({
      ok: false,
      error: "email_mode_required",
    });
    await setMarket("off");
    await setEmailMode(base({ mode: "full" }) as never);
    expect(await setEmailReviewTestDate(base({ date: TODAY }) as never)).toMatchObject({
      error: "email_mode_required",
    });
    expect(await sw("email_review_test_date")).toBeNull();
    expect(await actions()).toEqual(["controls.email_mode"]);
  });

  it("accepts today up to 31 days ahead (Melbourne date) and nothing else", async () => {
    await inIncidents();
    for (const date of [
      "2026-10-18",
      "2026-11-20",
      "2026-02-30",
      "19/10/2026",
      "",
      20261019,
      undefined,
      {},
    ]) {
      expect(await setEmailReviewTestDate(base({ date }) as never), String(date)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await sw("email_review_test_date")).toBeNull();
    expect(await setEmailReviewTestDate(base({ date: "2026-11-19" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setEmailReviewTestDate(base({ date: TODAY }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("email_review_test_date")).toBe('"2026-10-19"');
  });

  it("uses the Melbourne date, not the UTC date", async () => {
    await inIncidents();
    // 2026-10-18 23:30 UTC is 10:30 on 2026-10-19 in Melbourne: the 18th is already yesterday.
    const lateUtc = new Date("2026-10-18T23:30:00.000Z");
    expect(
      await setEmailReviewTestDate(base({ date: "2026-10-18", now: lateUtc }) as never),
    ).toMatchObject({
      error: "invalid",
    });
    expect(
      await setEmailReviewTestDate(base({ date: "2026-10-19", now: lateUtc }) as never),
    ).toEqual({
      ok: true,
      changed: true,
    });
  });

  it("records the audit event, is idempotent, can be changed and cleared", async () => {
    await inIncidents();
    await setEmailReviewTestDate(base({ date: "2026-10-20" }) as never);
    const a = (await auditRows(auth)).filter((r) => r.action === "controls.email_review_test_date");
    expect(a[0].detail).toEqual({ from: null, to: "2026-10-20" });
    expect(await setEmailReviewTestDate(base({ date: "2026-10-20" }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    await setEmailReviewTestDate(base({ date: "2026-10-22" }) as never);
    expect(await sw("email_review_test_date")).toBe('"2026-10-22"');
    expect(await setEmailReviewTestDate(base({ date: null }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("email_review_test_date")).toBeNull();
    expect(await setEmailReviewTestDate(base({ date: null }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect((await actions()).filter((x) => x === "controls.email_review_test_date")).toHaveLength(
      3,
    );
  });

  it("the mode is re-checked inside the transaction", async () => {
    await inIncidents();
    const racing = withTxHook(async () => {
      await main.execute("DELETE FROM worker_state WHERE key = 'email_mode'");
    });
    expect(await setEmailReviewTestDate(base({ date: TODAY, mainDb: racing }) as never)).toEqual({
      ok: false,
      error: "email_mode_required",
    });
    expect(await sw("email_review_test_date")).toBeNull();
    expect((await actions()).slice(-1)).toEqual(["controls.email_review_test_date_failed"]);
  });

  it("writes the audit event BEFORE the date is stored", async () => {
    await inIncidents();
    let auditAtWrite = -1;
    const spy = withTxHook(async () => {
      auditAtWrite = (await actions()).filter(
        (x) => x === "controls.email_review_test_date",
      ).length;
    });
    await setEmailReviewTestDate(base({ date: TODAY, mainDb: spy }) as never);
    expect(auditAtWrite).toBe(1);
  });
});

describe("watch-list add and remove", () => {
  it("adds a listed code with the longest expiry by default (90 days) and records who and when", async () => {
    expect(await addWatchListCode(base({ market: "AU", code: "ZZAA" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    const r = (await main.execute("SELECT * FROM watch_list_owner")).rows[0];
    expect(r).toMatchObject({
      market: "AU",
      code: "ZZAA",
      added_by: ownerId,
      added_at: NOW.toISOString(),
      expires_d: "2027-01-17",
      removed_at: null,
    });
    const a = (await auditRows(auth)).filter((x) => x.action === "controls.watch_list_add");
    expect(a).toHaveLength(1);
    expect(a[0].detail).toEqual({ market: "AU", code: "ZZAA", days: 90, expires_d: "2027-01-17" });
  });

  it("validates market, code shape, days and that the code is a listed instrument", async () => {
    for (const o of [
      { market: "US", code: "ZZAA" },
      { market: undefined, code: "ZZAA" },
      { market: "AU", code: "zzaa" },
      { market: "AU", code: "Z" },
      { market: "AU", code: "TOOLONG1" },
      { market: "AU", code: "ZZ AA" },
      { market: "AU", code: 5 },
      { market: "AU", code: "ZZAA", days: 0 },
      { market: "AU", code: "ZZAA", days: 91 },
      { market: "AU", code: "ZZAA", days: 1.5 },
      { market: "AU", code: "ZZAA", days: "30" },
    ]) {
      expect(await addWatchListCode(base(o) as never), JSON.stringify(o)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await addWatchListCode(base({ market: "AU", code: "NOPE" }) as never)).toEqual({
      ok: false,
      error: "unknown_code",
    });
    await main.execute("UPDATE instrument SET delisted_on = '2026-01-01' WHERE code = 'ZZBB'");
    expect(await addWatchListCode(base({ market: "AU", code: "ZZBB" }) as never)).toMatchObject({
      error: "unknown_code",
    });
    expect(await actions()).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM watch_list_owner")).toBe(0);
  });

  it("an explicit shorter expiry is used; the owner_add_expiry_days key lowers the ceiling", async () => {
    expect(await addWatchListCode(base({ market: "AU", code: "ZZAA", days: 30 }) as never)).toEqual(
      {
        ok: true,
        changed: true,
      },
    );
    expect((await main.execute("SELECT expires_d FROM watch_list_owner")).rows[0].expires_d).toBe(
      "2026-11-18",
    );
    await setConfig(main, {
      key: "owner_add_expiry_days",
      value: 14,
      userId: ownerId,
      reason: "test",
      now: NOW.toISOString(),
    });
    // The 60 s config cache is process-wide; a fresh DB handle has no cache entry for it.
    const r = await addWatchListCode(base({ market: "AU", code: "ZZBB", days: 15 }) as never);
    expect(r).toEqual({ ok: false, error: "invalid" });
    expect(await addWatchListCode(base({ market: "AU", code: "ZZBB" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(
      (await main.execute("SELECT expires_d FROM watch_list_owner WHERE code = 'ZZBB'")).rows[0]
        .expires_d,
    ).toBe("2026-11-02");
  });

  it("a code already on the list changes nothing; an expired or removed one can be added again", async () => {
    await addWatchListCode(base({ market: "AU", code: "ZZAA", days: 5 }) as never);
    expect(await addWatchListCode(base({ market: "AU", code: "ZZAA", days: 9 }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await count("SELECT COUNT(*) AS n FROM watch_list_owner")).toBe(1);
    // After the expiry date has passed (a week later) it is addable again.
    const later = new Date("2026-10-26T01:00:00.000Z");
    expect(
      await addWatchListCode(base({ market: "AU", code: "ZZAA", days: 5, now: later }) as never),
    ).toEqual({
      ok: true,
      changed: true,
    });
    expect(await count("SELECT COUNT(*) AS n FROM watch_list_owner")).toBe(2);
    // Removed rows free the code too.
    await removeWatchListCode(base({ market: "AU", code: "ZZAA", now: later }) as never);
    expect(
      await addWatchListCode(
        base({
          market: "AU",
          code: "ZZAA",
          days: 5,
          now: new Date(later.getTime() + 60_000),
        }) as never,
      ),
    ).toEqual({
      ok: true,
      changed: true,
    });
  });

  it("the add is race-safe: a duplicate inserted after the check is caught inside the transaction", async () => {
    const racing = withTxHook(async () => {
      await main.execute({
        sql: "INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d) VALUES ('x','AU','ZZAA',1,?,'2026-11-01')",
        args: [NOW.toISOString()],
      });
    });
    expect(
      await addWatchListCode(base({ market: "AU", code: "ZZAA", mainDb: racing }) as never),
    ).toEqual({
      ok: false,
      error: "already_listed",
    });
    expect(await count("SELECT COUNT(*) AS n FROM watch_list_owner")).toBe(1);
    expect((await actions()).slice(-1)).toEqual(["controls.watch_list_add_failed"]);
  });

  it("remove sets removed_at once, keeps the row, audits, and is a no-op when nothing is on the list", async () => {
    expect(await removeWatchListCode(base({ market: "AU", code: "ZZAA" }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await actions()).toEqual([]);
    await addWatchListCode(base({ market: "AU", code: "ZZAA" }) as never);
    expect(await removeWatchListCode(base({ market: "AU", code: "ZZAA" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect((await main.execute("SELECT removed_at FROM watch_list_owner")).rows[0].removed_at).toBe(
      NOW.toISOString(),
    );
    expect(await removeWatchListCode(base({ market: "AU", code: "ZZAA" }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    const a = (await auditRows(auth)).filter((x) => x.action === "controls.watch_list_remove");
    expect(a).toHaveLength(1);
    expect(a[0].detail).toEqual({ market: "AU", code: "ZZAA", entries: 1 });
    for (const o of [
      { market: "US", code: "ZZAA" },
      { market: "AU", code: "zz" },
      { market: "AU", code: 1 },
    ]) {
      expect(await removeWatchListCode(base(o) as never)).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("writes the audit event BEFORE the row, and a failed write leaves a _failed event and no row", async () => {
    let auditAtWrite = -1;
    const spy = withTxHook(async () => {
      auditAtWrite = (await actions()).filter((x) => x === "controls.watch_list_add").length;
    });
    await addWatchListCode(base({ market: "AU", code: "ZZAA", mainDb: spy }) as never);
    expect(auditAtWrite).toBe(1);
    await main.execute("DELETE FROM worker_state WHERE 0");
    expect(
      await addWatchListCode(base({ market: "AU", code: "ZZBB", mainDb: txFails() }) as never),
    ).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect((await actions()).slice(-2)).toEqual([
      "controls.watch_list_add",
      "controls.watch_list_add_failed",
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM watch_list_owner WHERE code = 'ZZBB'")).toBe(0);
  });
});

describe("credential expiry dates", () => {
  const set = (o: Record<string, unknown> = {}) =>
    setCredentialExpiry(
      base({ name: "d_turso_main_tokens", expiresOn: "2027-01-31", ...o }) as never,
    );

  it("rejects an unknown name and a bad, past or too-distant date; nothing is written", async () => {
    for (const o of [
      { name: "RESEND_API_KEY" },
      { name: "" },
      { name: undefined },
      { expiresOn: "2026-10-18" },
      { expiresOn: "2032-12-31" },
      { expiresOn: "31/01/2027" },
      { expiresOn: "2027-02-30" },
      { expiresOn: undefined },
      { expiresOn: 20270131 },
    ]) {
      expect(await set(o), JSON.stringify(o)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await actions()).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM credential_expiry")).toBe(0);
  });

  it("accepts today and the far limit (1830 days)", async () => {
    expect(await set({ expiresOn: TODAY })).toEqual({ ok: true, changed: true });
    expect(await set({ expiresOn: "2031-10-23" })).toEqual({ ok: true, changed: true }); // today + 1830
    expect(await set({ expiresOn: "2031-10-24" })).toMatchObject({ error: "invalid" });
  });

  it("inserts, then updates, with a history row each and an audit event that holds names and dates only", async () => {
    expect(await set()).toEqual({ ok: true, changed: true });
    expect(await set()).toEqual({ ok: true, changed: false });
    expect(await set({ expiresOn: "2027-02-28" })).toEqual({ ok: true, changed: true });
    expect(await count("SELECT COUNT(*) AS n FROM credential_expiry")).toBe(1);
    expect(
      (
        await main.execute(
          "SELECT op, expires_on, set_by FROM credential_expiry_history ORDER BY id",
        )
      ).rows.map((r) => ({ ...r })),
    ).toEqual([
      { op: "insert", expires_on: "2027-01-31", set_by: ownerId },
      { op: "update", expires_on: "2027-02-28", set_by: ownerId },
    ]);
    const a = (await auditRows(auth)).filter((x) => x.action === "controls.credential_expiry");
    expect(a.map((x) => x.detail)).toEqual([
      { name: "d_turso_main_tokens", from: null, to: "2027-01-31" },
      { name: "d_turso_main_tokens", from: "2027-01-31", to: "2027-02-28" },
    ]);
    expect(a[0]).toMatchObject({ target_type: "credential", target_id: "d_turso_main_tokens" });
  });

  it("writes the audit event BEFORE the row; a failed write leaves a _failed event", async () => {
    let auditAtWrite = -1;
    const spy = withTxHook(async () => {
      auditAtWrite = (await actions()).filter((x) => x === "controls.credential_expiry").length;
    });
    await set({ mainDb: spy });
    expect(auditAtWrite).toBe(1);
    expect(await set({ expiresOn: "2027-03-31", mainDb: txFails() })).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect((await actions()).slice(-1)).toEqual(["controls.credential_expiry_failed"]);
    expect(
      (await main.execute("SELECT expires_on FROM credential_expiry")).rows[0].expires_on,
    ).toBe("2027-01-31");
  });
});

describe("attention snooze", () => {
  const snooze = (o: Record<string, unknown> = {}) =>
    snoozeAttention(
      base({
        component: "security",
        itemKey: "d_turso_main_tokens",
        days: 3,
        item: item(),
        ...o,
      }) as never,
    );

  it("snoozes from today for the days asked, with an audit event, and a covered snooze is a no-op", async () => {
    expect(await snooze()).toEqual({ ok: true, changed: true });
    const r = (await main.execute("SELECT * FROM attention_snooze")).rows[0];
    expect(r).toMatchObject({
      component: "security",
      item_key: "d_turso_main_tokens",
      from_d: TODAY,
      until_d: "2026-10-22",
      created_by: ownerId,
    });
    const a = (await auditRows(auth)).filter((x) => x.action === "controls.attention_snooze");
    expect(a).toHaveLength(1);
    expect(a[0].detail).toEqual({
      component: "security",
      item_key: "d_turso_main_tokens",
      days: 3,
      from_d: TODAY,
      until_d: "2026-10-22",
    });
    expect(await snooze({ days: 2 })).toEqual({ ok: true, changed: false });
    expect(await snooze({ days: 3 })).toEqual({ ok: true, changed: false });
    expect(await count("SELECT COUNT(*) AS n FROM attention_snooze")).toBe(1);
    // A longer snooze is a new row (the table is insert-only).
    expect(await snooze({ days: 5 })).toEqual({ ok: true, changed: true });
    expect(await count("SELECT COUNT(*) AS n FROM attention_snooze")).toBe(2);
  });

  it("the default maximum is 7 days (attention_snooze_max_days) and the key can lower it", async () => {
    expect(await snooze({ days: 7 })).toEqual({ ok: true, changed: true });
    expect(await snooze({ days: 8 })).toEqual({ ok: false, error: "invalid" });
    for (const days of [0, -1, 1.5, "3", null, undefined]) {
      expect(await snooze({ days }), String(days)).toEqual({ ok: false, error: "invalid" });
    }
    await setConfig(main, {
      key: "attention_snooze_max_days",
      value: 2,
      userId: ownerId,
      reason: "test",
      now: NOW.toISOString(),
    });
    expect(await snooze({ days: 3, itemKey: "d_turso_main_tokens" })).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("a red item (down) cannot be snoozed: refused with no audit and no row", async () => {
    expect(await snooze({ item: item({ state: "down" }) })).toEqual({
      ok: false,
      error: "snooze_red",
    });
    expect(await actions()).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM attention_snooze")).toBe(0);
  });

  it("an item within 2 days of its deadline (or past it) cannot be snoozed; 3 days away can", async () => {
    for (const deadlineD of ["2026-10-17", TODAY, "2026-10-20", "2026-10-21"]) {
      expect(await snooze({ item: item({ deadlineD }) }), deadlineD).toEqual({
        ok: false,
        error: "snooze_deadline",
      });
    }
    expect(await snooze({ item: item({ deadlineD: "2026-10-22" }) })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await snooze({ item: item({ deadlineD: null }), days: 6 })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await count("SELECT COUNT(*) AS n FROM attention_snooze")).toBe(2);
  });

  it("an unknown item, a mismatched item, a bad component or a bad key is refused", async () => {
    expect(await snooze({ item: null })).toEqual({ ok: false, error: "item_not_found" });
    expect(await snooze({ item: item({ key: "other" }) })).toEqual({ ok: false, error: "invalid" });
    expect(await snooze({ item: item({ component: "backups" }) })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await snooze({ component: "email" })).toEqual({ ok: false, error: "invalid" });
    expect(await snooze({ itemKey: "Has Space" })).toEqual({ ok: false, error: "invalid" });
    expect(await snooze({ itemKey: "" })).toEqual({ ok: false, error: "invalid" });
    expect(await actions()).toEqual([]);
  });

  it("writes the audit event BEFORE the row; a failed write leaves a _failed event and no row", async () => {
    let auditAtWrite = -1;
    const spy = withTxHook(async () => {
      auditAtWrite = (await actions()).filter((x) => x === "controls.attention_snooze").length;
    });
    await snooze({ mainDb: spy });
    expect(auditAtWrite).toBe(1);
    expect(await snooze({ days: 5, mainDb: txFails() })).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect((await actions()).slice(-1)).toEqual(["controls.attention_snooze_failed"]);
    expect(await count("SELECT COUNT(*) AS n FROM attention_snooze")).toBe(1);
  });
});

describe("attention items (the server's own view of an item)", () => {
  const snapshot = (components: unknown) =>
    main.execute({
      sql: "INSERT INTO health_snapshot (d, purpose, components_json) VALUES (?, 'reminder', ?)",
      args: [TODAY, JSON.stringify({ components })],
    });
  const good = [
    {
      id: "security",
      state: "attention",
      items: [
        {
          key: "d_turso_main_tokens",
          label: "Turso token",
          state: "attention",
          deadline_d: "2026-11-02",
        },
        { key: "bad key", state: "attention" },
        { key: "x", state: "healthy" },
        "junk",
      ],
    },
    { id: "nope", items: [{ key: "k", state: "down" }] },
    { id: "backups", items: [{ key: "last_backup", state: "down", deadline_d: "soon" }] },
  ];

  it("reads the items of the latest reminder snapshot and skips anything malformed", async () => {
    await snapshot(good);
    expect(parseAttentionItems("{bad")).toEqual([]);
    expect(parseAttentionItems({})).toEqual([]);
    expect(await findAttentionItem(main, "security", "d_turso_main_tokens")).toEqual({
      component: "security",
      key: "d_turso_main_tokens",
      label: "Turso token",
      state: "attention",
      deadlineD: "2026-11-02",
    });
    expect(await findAttentionItem(main, "backups", "last_backup")).toMatchObject({
      state: "down",
      deadlineD: null,
    });
    expect(await findAttentionItem(main, "security", "bad key")).toBeNull();
    expect(await findAttentionItem(main, "security", "missing")).toBeNull();
  });

  it("with no snapshot there is nothing to snooze", async () => {
    expect(await findAttentionItem(main, "security", "d_turso_main_tokens")).toBeNull();
  });
});

describe("the actions (Owner guard, form parsing, server-side item state)", () => {
  it("every action asks for the admin role first; a refusal throws and nothing is written", async () => {
    requireUser.mockRejectedValue(new Error("403"));
    for (const call of [
      () => setEmailModeAction(form({ mode: "incidents" })),
      () => setEmailReviewTestDateAction(form({ date: TODAY })),
      () => addWatchListCodeAction(form({ market: "AU", code: "ZZAA", days: "5" })),
      () => removeWatchListCodeAction(form({ market: "AU", code: "ZZAA" })),
      () =>
        setCredentialExpiryAction(form({ name: "d_turso_main_tokens", expires_on: "2027-01-31" })),
      () => snoozeAttentionAction(form({ component: "security", item_key: "x", days: "1" })),
    ]) {
      await expect(call()).rejects.toThrow("403");
    }
    expect(requireUser).toHaveBeenCalledTimes(6);
    for (const c of requireUser.mock.calls) expect(c.slice(0, 2)).toEqual(["admin", "/health"]);
    expect(await actions()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("the Owner's actions write, audit as the signed-in user and revalidate the page", async () => {
    expect(await setEmailModeAction(form({ mode: "incidents" }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setEmailReviewTestDateAction(form({ date: "" }))).toEqual({
      ok: true,
      changed: false,
    });
    expect(await addWatchListCodeAction(form({ market: "AU", code: "zzaa", days: "5" }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(await removeWatchListCodeAction(form({ market: "AU", code: "ZZAA" }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(
      await setCredentialExpiryAction(
        form({ name: "d_turso_main_tokens", expires_on: "2099-01-01" }),
      ),
    ).toMatchObject({ error: "invalid" });
    const rows = await auditRows(auth);
    expect(rows.every((r) => r.actor_user_id === ownerId)).toBe(true);
    expect(rows.map((r) => r.action)).toEqual([
      "controls.email_mode",
      "controls.watch_list_add",
      "controls.watch_list_remove",
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/health");
    expect(rows[1].ip).toBe("9.9.9.9");
  });

  it("form numbers must be whole digits; a missing field is invalid, not a crash", async () => {
    expect(await addWatchListCodeAction(form({ market: "AU", code: "ZZAA", days: "5.5" }))).toEqual(
      {
        error: "invalid",
      },
    );
    expect(await addWatchListCodeAction(form({ market: "AU", code: "ZZAA", days: "abc" }))).toEqual(
      {
        error: "invalid",
      },
    );
    expect(await addWatchListCodeAction(form({ market: "AU" }))).toEqual({ error: "invalid" });
    expect(await setEmailModeAction(form({}))).toEqual({ error: "invalid" });
  });

  it("the snooze takes the item's state from the server snapshot: a red item cannot be snoozed even if the form says attention", async () => {
    await main.execute({
      sql: "INSERT INTO health_snapshot (d, purpose, components_json) VALUES (?, 'reminder', ?)",
      args: [
        TODAY,
        JSON.stringify({
          components: [
            {
              id: "security",
              items: [
                { key: "red_one", state: "down" },
                { key: "amber_one", state: "attention", deadline_d: "2026-12-01" },
                { key: "soon_one", state: "attention", deadline_d: "2026-10-30" },
              ],
            },
          ],
        }),
      ],
    });
    const snz = (key: string, extra: Record<string, string> = {}) =>
      snoozeAttentionAction(form({ component: "security", item_key: key, days: "2", ...extra }));
    expect(await snz("red_one", { state: "attention" })).toEqual({ error: "snooze_red" });
    expect(await snz("not_listed")).toEqual({ error: "item_not_found" });
    expect(await snz("amber_one")).toEqual({ ok: true, changed: true });
    expect(await count("SELECT COUNT(*) AS n FROM attention_snooze")).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM attention_snooze WHERE item_key = 'red_one'"),
    ).toBe(0);
  });
});

describe("loadEmailControlsView", () => {
  it("shows the defaults for a fresh database", async () => {
    const v = await loadEmailControlsView(main, [], NOW);
    expect(v).toMatchObject({
      mode: "off",
      reviewTestDate: null,
      dataOnly: true,
      watchList: [],
      watchListMaxDays: 90,
      attention: [],
      attentionSnoozeMaxDays: 7,
    });
    expect(v.credentials).toHaveLength(17);
    expect(v.credentials.every((c) => c.expiresOn === null)).toBe(true);
  });

  it("lists active watch-list codes only, credential dates, the test date and snooze state", async () => {
    await setEmailMode(base({ mode: "incidents" }) as never);
    await setEmailReviewTestDate(base({ date: "2026-10-21" }) as never);
    await addWatchListCode(base({ market: "AU", code: "ZZAA", days: 5 }) as never);
    await addWatchListCode(base({ market: "AU", code: "ZZBB", days: 5 }) as never);
    await removeWatchListCode(base({ market: "AU", code: "ZZBB" }) as never);
    await setCredentialExpiry(
      base({ name: "h_resend_api_keys", expiresOn: "2027-05-01" }) as never,
    );
    await snoozeAttention(
      base({
        component: "security",
        itemKey: "d_turso_main_tokens",
        days: 3,
        item: item(),
      }) as never,
    );
    const v = await loadEmailControlsView(main, [item(), item({ key: "other" })], NOW);
    expect(v.mode).toBe("incidents");
    expect(v.reviewTestDate).toBe("2026-10-21");
    expect(v.watchList).toEqual([{ market: "AU", code: "ZZAA", expiresD: "2026-10-24" }]);
    expect(v.credentials.find((c) => c.name === "h_resend_api_keys")?.expiresOn).toBe("2027-05-01");
    expect(v.attention.map((a) => a.snoozedUntil)).toEqual(["2026-10-22", null]);
    // A week later the watch-list entry and the snooze have lapsed.
    const later = await loadEmailControlsView(main, [item()], new Date("2026-10-27T01:00:00.000Z"));
    expect(later.watchList).toEqual([]);
    expect(later.attention[0].snoozedUntil).toBeNull();
    expect(later.reviewTestDate).toBeNull();
  });
});

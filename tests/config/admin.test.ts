// @vitest-environment node
// UX-116, PLT-041, ROL-102a, SEC-013, ch.15 acceptance (Owner edit -> version + audit event)
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  editText,
  formatConfigValue,
  listConfig,
  listConfigHistory,
  parseConfigInput,
  updateConfig,
} from "@/lib/config/admin";
import { CONFIG_KEYS, CONFIG_META } from "@/lib/config/keys";
import { getConfigCached, invalidateConfigCache } from "@/lib/config/runtime";
import { setConfig } from "@/lib/config/store";
import { verifyAuditChain, auditKey } from "@/lib/db/audit";
import { addUser, auditRows, ENV, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const T = new Date("2026-10-10T07:00:00.000Z");
let main: Client;
let auth: Client;
let ownerId: number;

beforeEach(async () => {
  invalidateConfigCache();
  main = await freshDb("main");
  auth = await freshDb("auth");
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
});

const edit = (over: Record<string, unknown> = {}, db = { main, auth }) =>
  updateConfig({
    mainDb: db.main,
    authDb: db.auth,
    env: ENV,
    actorId: ownerId,
    key: "retention_logs_days",
    rawValue: "21",
    reason: "shorter retention",
    now: T,
    ...over,
  });

// A client whose statements fail when `when(sql)` is true (or whose transactions fail).
function breaking(
  db: Client,
  opts: { sql?: (s: string) => boolean; transaction?: boolean },
): Client {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute" && opts.sql) {
        return (stmt: string | { sql: string }) => {
          const s = typeof stmt === "string" ? stmt : stmt.sql;
          if (opts.sql!(s)) return Promise.reject(new Error("boom"));
          return target.execute(stmt as never);
        };
      }
      if (prop === "transaction" && opts.transaction) {
        return () => Promise.reject(new Error("boom"));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const versions = async () => (await main.execute("SELECT * FROM config_version ORDER BY id")).rows;

describe("updateConfig success", () => {
  it("writes a version with before/after and an audit event (ch.15 acceptance)", async () => {
    const r = await edit();
    expect(r).toMatchObject({ ok: true });
    const v = await versions();
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      key: "retention_logs_days",
      scope: "global",
      value_json: "21",
      previous_json: null,
      changed_by_user_id: ownerId,
      reason: "shorter retention",
    });
    const a = (await auditRows(auth)).filter((x) => x.action === "config.change");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor_user_id: ownerId,
      target_type: "config",
      target_id: "retention_logs_days",
    });
    expect(a[0].detail).toEqual({
      key: "retention_logs_days",
      scope: "global",
      before: 30,
      after: 21,
      reason: "shorter retention",
    });
    expect(await verifyAuditChain(auth, auditKey(KEY))).toBeNull();
  });

  it("second edit records the previous stored value", async () => {
    await edit();
    await edit({ rawValue: "10", reason: "again" });
    const v = await versions();
    expect(v[1]).toMatchObject({ value_json: "10", previous_json: "21" });
    const a = (await auditRows(auth)).filter((x) => x.action === "config.change");
    expect(a[1].detail).toMatchObject({ before: 21, after: 10 });
  });

  it("records the request meta on the audit row", async () => {
    await edit({ meta: { ip: "9.9.9.9", userAgent: "agent" } });
    const a = (await auditRows(auth)).find((x) => x.action === "config.change")!;
    expect(a).toMatchObject({ ip: "9.9.9.9", user_agent: "agent" });
  });

  it("uses the clock when none is given and accepts a market scope", async () => {
    const r = await edit({ now: undefined, scope: "AU" });
    expect(r.ok).toBe(true);
    expect((await versions())[0]).toMatchObject({ scope: "AU" });
  });

  it.each([
    [
      "backup_retention",
      '{"daily": 7, "weekly": 4, "monthly": 6}',
      { daily: 7, weekly: 4, monthly: 6 },
    ],
    ["token_warning_days", "21, 10, 3", [21, 10, 3]],
    ["token_warning_days", "[30, 5]", [30, 5]],
    ["storage_warn_gb", "2.25", 2.25],
    [
      "rate_limits",
      '{"signin_per_min_ip":5,"writes_per_min_user":30,"exports_per_hour_user":2}',
      {
        signin_per_min_ip: 5,
        writes_per_min_user: 30,
        exports_per_hour_user: 2,
      },
    ],
  ])("parses %s: %s", async (key, raw, expected) => {
    expect(await edit({ key, rawValue: raw })).toMatchObject({ ok: true });
    const rows = await listConfig(main);
    expect(rows.find((r) => r.key === key)!.value).toEqual(expected);
  });

  it("invalidates the runtime cache after an edit", async () => {
    const deps = { db: () => main };
    expect(await getConfigCached("retention_logs_days", "global", deps)).toBe(30);
    await edit();
    expect(await getConfigCached("retention_logs_days", "global", deps)).toBe(21);
  });
});

describe("updateConfig refusals", () => {
  const unchanged = async () => {
    expect(await versions()).toHaveLength(0);
    expect((await auditRows(auth)).filter((x) => String(x.action).startsWith("config."))).toEqual(
      [],
    );
  };

  it("unknown key", async () => {
    expect(await edit({ key: "nope" })).toEqual({ ok: false, error: "unknown" });
    expect(await edit({ key: undefined })).toEqual({ ok: false, error: "unknown" });
    expect(await edit({ key: "toString" })).toEqual({ ok: false, error: "unknown" });
    await unchanged();
  });

  it.each(["hmac_max_age_s", "pii_hash_after_revocation_days"])("fixed key %s", async (key) => {
    expect(await edit({ key, rawValue: "5" })).toMatchObject({ ok: false, error: "fixed" });
    await unchanged();
  });

  it("reason is required, trimmed, at most 200 characters", async () => {
    for (const reason of [undefined, "", "   ", 5, "x".repeat(201)]) {
      expect(await edit({ reason })).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(await edit({ reason: "x".repeat(200) })).toMatchObject({ ok: true });
  });

  it("invalid scope", async () => {
    for (const scope of ["", "au", "global2", 3, "A"]) {
      expect(await edit({ scope })).toMatchObject({ ok: false, error: "invalid" });
    }
    await unchanged();
  });

  it.each([
    ["retention_logs_days", "0"],
    ["retention_logs_days", "1.5"],
    ["retention_logs_days", "abc"],
    ["retention_logs_days", ""],
    ["retention_logs_days", "9".repeat(501)],
    ["retention_logs_days", undefined],
    ["session_lifetime_days", "15"],
    ["llm_daily_budget_total", "74999"],
    ["llm_daily_budget_total", "225001"],
    ["what_if_daily_limit_per_user", "21"],
    ["what_if_daily_limit_per_user", "-1"],
    ["storage_warn_gb", "0"],
    ["storage_warn_gb", "3.5"], // above the ceiling (3)
    ["storage_ceiling_gb", "2"], // below the warning (2.5)
    ["storage_ceiling_gb", "x"],
    ["turso_staging_share", "1.5"],
    ["token_warning_days", "7, 14"],
    ["token_warning_days", "7, x"],
    ["token_warning_days", "[]"],
    ["token_warning_days", "[1.5]"],
    ["token_warning_days", "{}"],
    ["backup_retention", '{"daily": 0, "weekly": 1, "monthly": 1}'],
    ["backup_retention", "[1]"],
    ["backup_retention", "not json"],
    ["quota_thresholds", '{"notice": 0.9, "alert": 0.8, "degrade": 0.95}'],
    ["rate_limits", '{"signin_per_min_ip": 1}'],
  ])("%s <- %s is invalid with a message", async (key, rawValue) => {
    const r = await edit({ key, rawValue });
    expect(r).toMatchObject({ ok: false, error: "invalid" });
    expect((r as { message?: string }).message).toMatch(/^Value /);
    await unchanged();
  });

  it("a non-Owner actor is forbidden (editor, viewer, revoked owner, missing)", async () => {
    const editor = await addUser(auth, { email: "e@example.test", role: "editor" });
    const viewer = await addUser(auth, { email: "v@example.test", role: "viewer" });
    const gone = await addUser(auth, { email: "g@example.test", role: "owner", status: "revoked" });
    for (const actorId of [editor, viewer, gone, 9999]) {
      expect(await edit({ actorId })).toEqual({ ok: false, error: "forbidden" });
    }
    await unchanged();
  });

  it("forbidden wins over a bad key", async () => {
    const editor = await addUser(auth, { email: "e@example.test", role: "editor" });
    expect(await edit({ actorId: editor, key: "nope" })).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("updateConfig failures (audit first)", () => {
  it("audit failure: unavailable, no config row, no audit row", async () => {
    const r = await edit({}, { main, auth: breaking(auth, { transaction: true }) });
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(await versions()).toHaveLength(0);
    expect((await auditRows(auth)).filter((x) => String(x.action).startsWith("config."))).toEqual(
      [],
    );
  });

  it("missing PII key: audit cannot be written, nothing changes", async () => {
    const r = await updateConfig({
      mainDb: main,
      authDb: auth,
      env: {},
      actorId: ownerId,
      key: "retention_logs_days",
      rawValue: "21",
      reason: "r",
    });
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(await versions()).toHaveLength(0);
  });

  it("config write failure: change_failed event follows config.change", async () => {
    const bad = breaking(main, { sql: (s) => s.includes("INSERT INTO config_version") });
    const r = await edit({}, { main: bad, auth });
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(await versions()).toHaveLength(0);
    const a = (await auditRows(auth)).filter((x) => String(x.action).startsWith("config."));
    expect(a.map((x) => x.action)).toEqual(["config.change", "config.change_failed"]);
    expect(a[1].detail).toEqual({ key: "retention_logs_days", scope: "global" });
    expect(await verifyAuditChain(auth, auditKey(KEY))).toBeNull();
  });

  it("config write failure and change_failed also failing still returns unavailable", async () => {
    const bad = breaking(main, { sql: (s) => s.includes("INSERT INTO config_version") });
    let n = 0;
    const flaky = new Proxy(auth, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (...a: unknown[]) =>
            ++n > 1
              ? Promise.reject(new Error("boom"))
              : (target.transaction as (...x: unknown[]) => unknown)(...a);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Client;
    expect(await edit({}, { main: bad, auth: flaky })).toEqual({ ok: false, error: "unavailable" });
    const a = (await auditRows(auth)).filter((x) => String(x.action).startsWith("config."));
    expect(a.map((x) => x.action)).toEqual(["config.change"]);
  });

  it("main DB unreadable during validation: unavailable, no audit", async () => {
    const bad = breaking(main, { sql: (s) => s.includes("FROM config_version") });
    expect(await edit({}, { main: bad, auth })).toEqual({ ok: false, error: "unavailable" });
    expect((await auditRows(auth)).filter((x) => String(x.action).startsWith("config."))).toEqual(
      [],
    );
  });

  it("auth DB unreadable for the actor check: unavailable", async () => {
    const bad = breaking(auth, { sql: (s) => s.includes("FROM app_user") });
    expect(await edit({}, { main, auth: bad })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("listConfig / listConfigHistory", () => {
  it("lists every registry key with defaults and metadata", async () => {
    const rows = await listConfig(main);
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(CONFIG_KEYS).sort());
    for (const r of rows) {
      expect(r.source).toBe("default");
      expect(r.lastChange).toBeNull();
      expect(r.value).toEqual(CONFIG_KEYS[r.key].default);
      expect(r.label.length).toBeGreaterThan(3);
      expect(r.bounds).toBe(CONFIG_META[r.key].bounds);
    }
    const hmac = rows.find((r) => r.key === "hmac_max_age_s")!;
    expect(hmac).toMatchObject({ editable: "fixed", ref: "SEC-017", unit: "s", default: 300 });
  });

  it("shows stored value, source and last change; own scope beats global", async () => {
    await setConfig(main, {
      key: "retention_logs_days",
      value: 20,
      userId: 1,
      now: "2026-10-01T00:00:00.000Z",
    });
    const second = await setConfig(main, {
      key: "retention_logs_days",
      value: 25,
      userId: 1,
      now: "2026-10-02T00:00:00.000Z",
    });
    await setConfig(main, {
      key: "retention_runs_days",
      value: 99,
      scope: "AU",
      userId: 1,
      now: T.toISOString(),
    });
    const rows = await listConfig(main);
    const logs = rows.find((r) => r.key === "retention_logs_days")!;
    expect(logs).toMatchObject({ value: 25, source: "stored" });
    expect(logs.lastChange).toEqual({
      at: "2026-10-02T00:00:00.000Z",
      versionId: second.versionId,
    });
    expect(rows.find((r) => r.key === "retention_runs_days")!.source).toBe("default");
    const au = await listConfig(main, "AU");
    expect(au.find((r) => r.key === "retention_runs_days")!.value).toBe(99);
    expect(au.find((r) => r.key === "retention_logs_days")!.value).toBe(25); // falls back to global
  });

  it("history is newest first with before -> after and reason", async () => {
    await edit();
    await edit({ rawValue: "10", reason: "again" });
    await edit({ key: "token_warning_days", rawValue: "9, 3", reason: "list" });
    const h = await listConfigHistory(main, 2);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({
      key: "token_warning_days",
      before: [14, 7, 2],
      after: [9, 3],
      reason: "list",
    });
    expect(h[1]).toMatchObject({ before: 21, after: 10, reason: "again" });
    const all = await listConfigHistory(main);
    expect(all[2]).toMatchObject({ before: 30, after: 21 }); // first edit: before = default
    expect(await listConfigHistory(main, Number.NaN)).toHaveLength(3);
  });

  it("history tolerates unknown keys and null reasons", async () => {
    await main.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('old_key','global','1',?)",
      args: [T.toISOString()],
    });
    const h = await listConfigHistory(main);
    expect(h[0]).toMatchObject({ key: "old_key", before: null, after: 1, reason: null });
  });
});

describe("parse and format helpers", () => {
  it("parseConfigInput rejects wrong types", () => {
    expect(parseConfigInput("int", 5)).toHaveProperty("error");
    expect(parseConfigInput("int", "1e3")).toHaveProperty("error");
    expect(parseConfigInput("number", "1.2.3")).toHaveProperty("error");
    expect(parseConfigInput("number", " 2.5 ")).toEqual({ value: 2.5 });
    expect(parseConfigInput("list", "14 7 2")).toEqual({ value: [14, 7, 2] });
    expect(parseConfigInput("object", "[1]")).toHaveProperty("error");
  });

  it("editText round-trips through parseConfigInput", () => {
    for (const k of Object.keys(CONFIG_KEYS) as Array<keyof typeof CONFIG_KEYS>) {
      const d = CONFIG_KEYS[k].default;
      expect(parseConfigInput(CONFIG_META[k].input, editText(d))).toEqual({ value: d });
    }
  });

  it("formatConfigValue", () => {
    expect(formatConfigValue(30, "days")).toBe("30 days");
    expect(formatConfigValue([14, 7, 2], "days")).toBe("14, 7, 2 days");
    expect(formatConfigValue(0.15, "fraction")).toBe("0.15");
    expect(formatConfigValue(6_000_000, "rows/month")).toBe("6,000,000 rows/month");
    expect(formatConfigValue({ daily: 14, weekly: 8 }, "copies")).toBe("daily: 14, weekly: 8");
    expect(formatConfigValue({ signin_per_min_ip: 10 }, "count")).toBe("signin per min ip: 10");
  });
});

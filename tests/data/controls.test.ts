// @vitest-environment node
// M2 T10 Owner data controls: BLD-024, DAT-120, DAT-123, O-23, O-26, D-047 (audit first), ROL-102a,
// AT-02, D-057 decision 3. Services in src/lib/data/controls.ts and the System Health actions.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { CONFIG_KEYS, validateMarketModes } from "@/lib/config/keys";
import { ConfigError, getConfig, setConfig } from "@/lib/config/store";
import {
  loadControlsView,
  parseOn,
  setAsxEnabled,
  setDispatchEnabled,
  setMarketMode,
  setSourceAccepted,
  SOURCE_CONTROLS,
} from "@/lib/data/controls";

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
  resetAsxTripAction,
  setAsxEnabledAction,
  setDispatchEnabledAction,
  setMarketModeAction,
  setSourceAcceptedAction,
} from "@/app/(app)/health/actions";

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
const reg = async (source: string) =>
  String(
    (
      await main.execute({
        sql: "SELECT status FROM source_register WHERE source = ?",
        args: [source],
      })
    ).rows[0].status,
  );
const srcMode = async (source: string) =>
  (
    await main.execute({
      sql: "SELECT mode, reason FROM source_status WHERE source = ?",
      args: [source],
    })
  ).rows[0];
const marketMode = async () =>
  String((await main.execute("SELECT mode FROM market WHERE code = 'AU'")).rows[0].mode);
const count = async (sql: string) => Number((await main.execute(sql)).rows[0].n);
const confirmCal = () =>
  main.execute("UPDATE trading_calendar SET confirmed = 1 WHERE d LIKE '2026-%' AND confirmed = 0");
const addOpenRow = () =>
  main.execute(
    "INSERT INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('AU', '2026-12-26', 'session', 0, 'test')",
  );
/** Everything dispatch ON needs: O-26 accepted and the AU calendar confirmed. */
const ready = async () => {
  await accept("yahoo_eod");
  await confirmCal();
};
const accept = (source: string) =>
  setSourceAccepted(base({ source, accept: true, acknowledged: true }) as never);

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
const brokenTx = new Proxy({} as Client, {
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
});

describe("shared rules (every control)", () => {
  const calls: Array<[string, (o?: Record<string, unknown>) => Promise<unknown>]> = [
    ["dispatch", (o) => setDispatchEnabled(base({ enabled: true, ...o }) as never)],
    ["asx", (o) => setAsxEnabled(base({ enabled: true, ...o }) as never)],
    [
      "source",
      (o) =>
        setSourceAccepted(
          base({ source: "yahoo_eod", accept: true, acknowledged: true, ...o }) as never,
        ),
    ],
    ["market", (o) => setMarketMode(base({ market: "AU", mode: "off", ...o }) as never)],
  ];

  it.each(calls)(
    "%s: a non-Owner (editor) is refused with no audit and no change",
    async (_n, call) => {
      expect(await call({ actorId: editorId })).toEqual({ ok: false, error: "forbidden" });
      expect(await call({ actorId: 9999 })).toEqual({ ok: false, error: "forbidden" });
      expect(await actions()).toEqual([]);
      expect(await sw("dispatch_enabled")).toBeNull();
      expect(await reg("yahoo_eod")).toBe("pending");
      expect(await marketMode()).toBe("data_only");
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
    expect(await call({ authDb: brokenTx })).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("a. dispatch switch", () => {
  it("rejects anything that is not a boolean", async () => {
    for (const enabled of [undefined, "1", 1, null]) {
      expect(await setDispatchEnabled(base({ enabled }) as never)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await actions()).toEqual([]);
  });

  it("is refused while the Yahoo risk (O-26) is not accepted: no audit, no change", async () => {
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toEqual({
      ok: false,
      error: "source_pending",
    });
    expect(await actions()).toEqual([]);
    expect(await sw("dispatch_enabled")).toBeNull();
  });

  it("is refused while the current year's AU calendar has unconfirmed rows, then allowed after confirm", async () => {
    await accept("yahoo_eod");
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toEqual({
      ok: false,
      error: "calendar_unconfirmed",
    });
    expect(await actions()).toEqual(["controls.source_accept"]);
    expect(await sw("dispatch_enabled")).toBeNull();
    // one open row is enough to refuse; other years do not matter
    await confirmCal();
    await addOpenRow();
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toMatchObject({
      error: "calendar_unconfirmed",
    });
    await confirmCal();
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toEqual({
      ok: true,
      changed: true,
    });
  });

  it("an empty calendar for the year also refuses; turning off never needs the calendar", async () => {
    await accept("yahoo_eod");
    await main.execute("DROP TRIGGER trading_calendar_guard_delete").catch(() => undefined);
    await main.execute("DROP TABLE trading_calendar");
    await main.execute(
      "CREATE TABLE trading_calendar (market TEXT, d TEXT, kind TEXT, close_time TEXT, confirmed INTEGER)",
    );
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toMatchObject({
      error: "calendar_unconfirmed",
    });
    expect(await setDispatchEnabled(base({ enabled: false }) as never)).toEqual({
      ok: true,
      changed: false,
    });
  });

  it("the calendar is re-checked inside the transaction (a row reopened after the first check)", async () => {
    await ready();
    const racing = withTxHook(async () => {
      await addOpenRow();
    });
    expect(await setDispatchEnabled(base({ enabled: true, mainDb: racing }) as never)).toEqual({
      ok: false,
      error: "calendar_unconfirmed",
    });
    expect(await sw("dispatch_enabled")).toBeNull();
    expect((await actions()).slice(-1)).toEqual(["controls.dispatch_enabled_failed"]);
  });

  it("turns on after O-26, writes the audit event, and is idempotent", async () => {
    await ready();
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("dispatch_enabled")).toBe('"1"');
    const a = (await auditRows(auth)).filter((r) => r.action === "controls.dispatch_enabled");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor_user_id: ownerId,
      target_type: "control",
      target_id: "dispatch_enabled",
    });
    expect(a[0].detail).toEqual({ from: false, to: true });
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect((await actions()).filter((x) => x === "controls.dispatch_enabled")).toHaveLength(1);
  });

  it("turns off at any time, even with O-26 not accepted; off when never set writes nothing", async () => {
    expect(await setDispatchEnabled(base({ enabled: false }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await sw("dispatch_enabled")).toBeNull();
    await main.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 'x')",
    );
    expect(await setDispatchEnabled(base({ enabled: false }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("dispatch_enabled")).toBe('"0"');
    expect(await actions()).toEqual(["controls.dispatch_enabled"]);
  });

  it("writes the audit event BEFORE the switch changes", async () => {
    await ready();
    let auditAtWrite = -1;
    const spy = withTxHook(async () => {
      auditAtWrite = (await actions()).filter((x) => x === "controls.dispatch_enabled").length;
    });
    expect(await setDispatchEnabled(base({ enabled: true, mainDb: spy }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(auditAtWrite).toBe(1);
  });

  it("if the audit cannot be written nothing changes", async () => {
    await ready();
    await auth.execute("DROP TABLE audit_event");
    expect(await setDispatchEnabled(base({ enabled: true }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await sw("dispatch_enabled")).toBeNull();
  });

  it("if the write fails a _failed event follows and nothing changes", async () => {
    await ready();
    expect(await setDispatchEnabled(base({ enabled: true, mainDb: txFails() }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect((await actions()).slice(-2)).toEqual([
      "controls.dispatch_enabled",
      "controls.dispatch_enabled_failed",
    ]);
    expect(await sw("dispatch_enabled")).toBeNull();
  });

  it("a source disabled between the check and the write is caught inside the transaction", async () => {
    await ready();
    const racing = withTxHook(async () => {
      await main.execute(
        "UPDATE source_register SET status = 'disabled' WHERE source = 'yahoo_eod'",
      );
    });
    expect(await setDispatchEnabled(base({ enabled: true, mainDb: racing }) as never)).toEqual({
      ok: false,
      error: "source_pending",
    });
    expect(await sw("dispatch_enabled")).toBeNull();
    expect((await actions()).slice(-1)).toEqual(["controls.dispatch_enabled_failed"]);
  });

  it("a main-database read failure is 'unavailable'", async () => {
    expect(await setDispatchEnabled(base({ enabled: true, mainDb: brokenTx }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await actions()).toEqual([]);
  });
});

describe("b. ASX contact switch", () => {
  it("is refused while O-23 is pending, disabled or unknown; nothing is written", async () => {
    const t = () => setAsxEnabled(base({ enabled: true }) as never);
    expect(await t()).toEqual({ ok: false, error: "source_pending" });
    await accept("asx_announcements");
    await setSourceAccepted(base({ source: "asx_announcements", accept: false }) as never);
    const before = await actions();
    expect(await t()).toEqual({ ok: false, error: "source_pending" });
    expect(await actions()).toEqual(before);
    expect(await sw("asx_enabled")).toBe('"0"'); // the disable already switched it off
    await main.execute("DELETE FROM worker_state WHERE key = 'asx_enabled'");
    await main.execute("DROP TRIGGER source_register_no_delete");
    await main.execute("DELETE FROM source_register WHERE source = 'asx_announcements'");
    expect(await t()).toEqual({ ok: false, error: "source_pending" });
  });

  it("turns on once O-23 is enabled, with an audit event; off is always allowed", async () => {
    await accept("asx_announcements");
    expect(await setAsxEnabled(base({ enabled: true }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("asx_enabled")).toBe('"1"');
    expect(parseOn(await sw("asx_enabled"))).toBe(true);
    const a = (await auditRows(auth)).filter((r) => r.action === "controls.asx_enabled");
    expect(a[0].detail).toEqual({ from: false, to: true });
    expect(await setAsxEnabled(base({ enabled: true }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await setAsxEnabled(base({ enabled: false }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await sw("asx_enabled")).toBe('"0"');
  });

  it("rejects non-booleans; failure path and race are audited", async () => {
    expect(await setAsxEnabled(base({ enabled: "yes" }) as never)).toEqual({
      ok: false,
      error: "invalid",
    });
    await accept("asx_announcements");
    expect(await setAsxEnabled(base({ enabled: true, mainDb: txFails() }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect((await actions()).slice(-1)).toEqual(["controls.asx_enabled_failed"]);
    const racing = withTxHook(async () => {
      await main.execute(
        "UPDATE source_register SET status = 'disabled' WHERE source = 'asx_announcements'",
      );
    });
    expect(await setAsxEnabled(base({ enabled: true, mainDb: racing }) as never)).toEqual({
      ok: false,
      error: "source_pending",
    });
    expect(await sw("asx_enabled")).toBeNull();
  });

  it("audit comes first and a failed audit changes nothing", async () => {
    await accept("asx_announcements");
    let seen = -1;
    const spy = withTxHook(async () => {
      seen = (await actions()).filter((x) => x === "controls.asx_enabled").length;
    });
    await setAsxEnabled(base({ enabled: true, mainDb: spy }) as never);
    expect(seen).toBe(1);
    await setAsxEnabled(base({ enabled: false }) as never);
    await auth.execute("DROP TABLE audit_event");
    expect(await setAsxEnabled(base({ enabled: true }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await sw("asx_enabled")).toBe('"0"');
  });
});

describe("c. source risk acceptance (O-23 / O-26)", () => {
  it("needs the box ticked, a boolean choice and a known source", async () => {
    for (const acknowledged of [undefined, false, "on", 1]) {
      expect(
        await setSourceAccepted(
          base({ source: "asx_announcements", accept: true, acknowledged }) as never,
        ),
      ).toEqual({ ok: false, error: "risk_not_acknowledged" });
    }
    for (const source of ["rba", "abs", "asic_short", "nope", undefined, 5]) {
      expect(
        await setSourceAccepted(base({ source, accept: true, acknowledged: true }) as never),
      ).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(
      await setSourceAccepted(
        base({ source: "yahoo_eod", accept: "1", acknowledged: true }) as never,
      ),
    ).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await actions()).toEqual([]);
    expect(await reg("asx_announcements")).toBe("pending");
  });

  it("accepting O-23 enables the register row, logs history, and records the exact risk text", async () => {
    const before = await count(
      "SELECT COUNT(*) n FROM source_register_history WHERE source = 'asx_announcements'",
    );
    expect(await accept("asx_announcements")).toEqual({ ok: true, changed: true });
    expect(await reg("asx_announcements")).toBe("enabled");
    expect(
      await count(
        "SELECT COUNT(*) n FROM source_register_history WHERE source = 'asx_announcements'",
      ),
    ).toBe(before + 1);
    const hist = await main.execute(
      "SELECT status, op FROM source_register_history WHERE source = 'asx_announcements' ORDER BY id DESC LIMIT 1",
    );
    expect(hist.rows[0]).toMatchObject({ status: "enabled", op: "update" });
    const a = (await auditRows(auth)).filter((r) => r.action === "controls.source_accept");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ target_type: "source", target_id: "asx_announcements" });
    expect(a[0].detail).toEqual({
      source: "asx_announcements",
      ref: "O-23",
      from: "pending",
      to: "enabled",
      riskText: SOURCE_CONTROLS.asx_announcements.riskText,
    });
    expect(SOURCE_CONTROLS.asx_announcements.riskText).toMatch(/private\s+personal use/);
    expect(SOURCE_CONTROLS.yahoo_eod.ref).toBe("O-26");
    // The accept does not turn any switch on.
    expect(await sw("asx_enabled")).toBeNull();
    expect(await sw("dispatch_enabled")).toBeNull();
  });

  it("is idempotent in both directions", async () => {
    await ready();
    expect(await accept("yahoo_eod")).toEqual({ ok: true, changed: false });
    expect(await setSourceAccepted(base({ source: "yahoo_eod", accept: false }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setSourceAccepted(base({ source: "yahoo_eod", accept: false }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await actions()).toEqual(["controls.source_accept", "controls.source_disable"]);
  });

  it("disabling ASX switches the kill switch and asx_enabled off in the same step", async () => {
    await accept("asx_announcements");
    await setAsxEnabled(base({ enabled: true }) as never);
    expect(
      await setSourceAccepted(base({ source: "asx_announcements", accept: false }) as never),
    ).toEqual({
      ok: true,
      changed: true,
    });
    expect(await reg("asx_announcements")).toBe("disabled");
    expect(await sw("asx_enabled")).toBe('"0"');
    expect(await srcMode("asx_announcements")).toMatchObject({
      mode: "off",
      reason: "owner_disabled",
    });
    const d = (await auditRows(auth)).filter((r) => r.action === "controls.source_disable");
    expect(d[0].detail).toEqual({
      source: "asx_announcements",
      ref: "O-23",
      from: "enabled",
      to: "disabled",
    });
  });

  it("disabling Yahoo does not touch the ASX switch; accepting again lifts an Owner-set off only", async () => {
    await ready();
    await setSourceAccepted(base({ source: "yahoo_eod", accept: false }) as never);
    expect(await sw("asx_enabled")).toBeNull();
    expect((await srcMode("yahoo_eod")).mode).toBe("off");
    await ready();
    expect(await srcMode("yahoo_eod")).toMatchObject({ mode: "on", reason: null });
  });

  it("a tripped source stays tripped when accepted, and becomes off when disabled", async () => {
    await main.execute(
      "UPDATE source_status SET mode = 'tripped', reason = 'blocked', tripped_by = 'asx_block_trip' WHERE source = 'asx_announcements'",
    );
    await accept("asx_announcements");
    expect((await srcMode("asx_announcements")).mode).toBe("tripped");
    await setSourceAccepted(base({ source: "asx_announcements", accept: false }) as never);
    expect((await srcMode("asx_announcements")).mode).toBe("off");
  });

  it("audit first; a failed audit or failed write changes nothing", async () => {
    let seen = -1;
    const spy = withTxHook(async () => {
      seen = (await actions()).length;
    });
    expect(
      await setSourceAccepted(
        base({ source: "yahoo_eod", accept: true, acknowledged: true, mainDb: spy }) as never,
      ),
    ).toEqual({ ok: true, changed: true });
    expect(seen).toBe(1);
    expect(
      await setSourceAccepted(
        base({
          source: "asx_announcements",
          accept: true,
          acknowledged: true,
          mainDb: txFails(),
        }) as never,
      ),
    ).toEqual({ ok: false, error: "unavailable" });
    expect(await reg("asx_announcements")).toBe("pending");
    expect((await actions()).slice(-1)).toEqual(["controls.source_accept_failed"]);
    await auth.execute("DROP TABLE audit_event");
    expect(await accept("asx_announcements")).toEqual({ ok: false, error: "unavailable" });
    expect(await reg("asx_announcements")).toBe("pending");
  });

  it("a missing register row is invalid; an unreadable database is unavailable", async () => {
    await main.execute("DROP TRIGGER source_register_no_delete");
    await main.execute("DELETE FROM source_register WHERE source = 'yahoo_eod'");
    expect(await accept("yahoo_eod")).toEqual({ ok: false, error: "invalid" });
    expect(
      await setSourceAccepted(
        base({ source: "asx_announcements", accept: false, mainDb: brokenTx }) as never,
      ),
    ).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("c2. the listed-companies source follows O-23 (D-067)", () => {
  it("accepting O-23 enables asx_listed_companies too; disabling O-23 disables it; Yahoo never touches it", async () => {
    expect(await reg("asx_listed_companies")).toBe("pending");
    await accept("yahoo_eod");
    expect(await reg("asx_listed_companies")).toBe("pending");
    await accept("asx_announcements");
    expect(await reg("asx_announcements")).toBe("enabled");
    expect(await reg("asx_listed_companies")).toBe("enabled");
    await setSourceAccepted(base({ source: "asx_announcements", accept: false }) as never);
    expect(await reg("asx_announcements")).toBe("disabled");
    expect(await reg("asx_listed_companies")).toBe("disabled");
    await accept("asx_announcements");
    expect(await reg("asx_listed_companies")).toBe("enabled");
    // Both changes are logged by the register's history trigger.
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM source_register_history WHERE source = 'asx_listed_companies'",
      ),
    ).toBe(5); // insert (0006), update (0018, O-23b), enabled, disabled, enabled
  });
});

describe("d. market mode (source of truth: market.mode; config value is the history)", () => {
  it("full in production is refused without a sign-off (M8 T11) with no audit; bad input is invalid", async () => {
    expect(await setMarketMode(base({ market: "AU", mode: "full" }) as never)).toEqual({
      ok: false,
      error: "signoff_required",
    });
    for (const [market, mode] of [
      ["US", "off"],
      ["IN", "data_only"],
      [undefined, "off"],
      ["AU", "on"],
      ["AU", undefined],
      ["AU", 1],
    ]) {
      expect(await setMarketMode(base({ market, mode }) as never)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await actions()).toEqual([]);
    expect(await marketMode()).toBe("data_only");
  });

  it("the default is data_only for AU in both places, so data_only is a no-op", async () => {
    expect(CONFIG_KEYS.market_mode.default).toEqual({ AU: "data_only" });
    expect(await marketMode()).toBe("data_only");
    expect(await setMarketMode(base({ market: "AU", mode: "data_only" }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await actions()).toEqual([]);
    expect(await count("SELECT COUNT(*) n FROM config_version WHERE key = 'market_mode'")).toBe(0);
  });

  it("off writes market.mode AND a config version in one go, then data_only restores both", async () => {
    expect(await setMarketMode(base({ market: "AU", mode: "off" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await marketMode()).toBe("off");
    expect(await getConfig(main, "market_mode")).toEqual({ AU: "off" });
    const v = (await main.execute("SELECT * FROM config_version WHERE key = 'market_mode'")).rows;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      scope: "global",
      previous_json: null,
      changed_by_user_id: ownerId,
    });
    expect(await setMarketMode(base({ market: "AU", mode: "off" }) as never)).toEqual({
      ok: true,
      changed: false,
    });
    expect(await setMarketMode(base({ market: "AU", mode: "data_only" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await marketMode()).toBe("data_only");
    expect(await getConfig(main, "market_mode")).toEqual({ AU: "data_only" });
    const last = (
      await main.execute(
        "SELECT previous_json FROM config_version WHERE key = 'market_mode' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];
    expect(JSON.parse(String(last.previous_json))).toEqual({ AU: "off" });
    const a = (await auditRows(auth)).filter((r) => r.action === "controls.market_mode");
    expect(a.map((r) => r.detail)).toEqual([
      { market: "AU", from: "data_only", to: "off" },
      { market: "AU", from: "off", to: "data_only" },
    ]);
  });

  it("repairs a column and config value that disagree", async () => {
    await main.execute("UPDATE market SET mode = 'off' WHERE code = 'AU'");
    const before = await loadControlsView(main, true);
    expect(before.markets[0]).toMatchObject({
      mode: "off",
      configMode: "data_only",
      inSync: false,
    });
    expect(await setMarketMode(base({ market: "AU", mode: "off" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    const after = await loadControlsView(main, true);
    expect(after.markets[0]).toMatchObject({ mode: "off", configMode: "off", inSync: true });
  });

  it("is atomic: if the config insert fails, market.mode is unchanged; audit is first", async () => {
    let seen = -1;
    const spy = withTxHook(async () => {
      seen = (await actions()).length;
    });
    await setMarketMode(base({ market: "AU", mode: "off", mainDb: spy }) as never);
    expect(seen).toBe(1);
    await main.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'");
    await main.execute(
      "CREATE TRIGGER block_cfg BEFORE INSERT ON config_version BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    expect(await setMarketMode(base({ market: "AU", mode: "off" }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await marketMode()).toBe("data_only");
    expect((await actions()).slice(-1)).toEqual(["controls.market_mode_failed"]);
  });

  it("a failed audit changes nothing; an unreadable market row is invalid", async () => {
    await auth.execute("DROP TABLE audit_event");
    expect(await setMarketMode(base({ market: "AU", mode: "off" }) as never)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await marketMode()).toBe("data_only");
    await main.execute("DROP TRIGGER market_no_delete");
    await main.execute("DELETE FROM market");
    expect(await setMarketMode(base({ market: "AU", mode: "off" }) as never)).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("the validator accepts full (the interlock is in the Owner action), refuses unknown markets and bad shapes; the generic editor cannot write it", async () => {
    expect(validateMarketModes({ AU: "data_only" })).toBeNull();
    expect(validateMarketModes({ AU: "off" })).toBeNull();
    expect(validateMarketModes({ AU: "full" })).toBeNull();
    expect(validateMarketModes({ AU: "on" })).toMatch(/off, data_only or full/);
    expect(validateMarketModes({ US: "off" })).toMatch(/unknown market/);
    expect(validateMarketModes({})).toMatch(/unknown market/);
    expect(validateMarketModes("data_only")).toMatch(/each market/);
    expect(validateMarketModes([])).toMatch(/each market/);
    expect(await CONFIG_KEYS.market_mode.validate({ AU: "full" })).toBeNull();
    await expect(
      setConfig(main, {
        key: "market_mode",
        value: { AU: "off" },
        userId: ownerId,
        now: NOW.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("a corrupt stored config value is read as empty and then repaired", async () => {
    await main.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('market_mode', 'global', 'not json', ?)",
      args: [NOW.toISOString()],
    });
    expect(await setMarketMode(base({ market: "AU", mode: "off" }) as never)).toEqual({
      ok: true,
      changed: true,
    });
    expect(await getConfig(main, "market_mode")).toEqual({ AU: "off" });
  });
});

describe("read model for System Health", () => {
  it("shows status for everyone and the trip reason to the Owner only", async () => {
    await main.execute(
      "UPDATE source_status SET mode = 'tripped', reason = 'blocked by asx', tripped_by = 'asx_block_trip' WHERE source = 'asx_announcements'",
    );
    const owner = await loadControlsView(main, true);
    const viewer = await loadControlsView(main, false);
    expect(owner).toMatchObject({
      dispatchEnabled: false,
      asxEnabled: false,
      asxTripped: true,
      asxTrippedReason: "blocked by asx",
      dataOnly: true,
      workerVars: { asxLive: "not known", asxUserAgent: "not known" },
      calendarConfirmed: false,
    });
    expect(owner.sources.map((s) => [s.source, s.ref, s.status])).toEqual([
      ["asx_announcements", "O-23", "pending"],
      ["yahoo_eod", "O-26", "pending"],
      ["yahoo_delayed", "O-26", "pending"],
    ]);
    expect("asxTrippedReason" in viewer).toBe(false);
    expect(viewer.asxTripped).toBe(true);
  });

  it("reads ASX_LIVE / ASX_USER_AGENT from the latest worker-selfcheck record (set / not set only)", async () => {
    const put = (at: string, results: unknown) =>
      main.execute({
        sql: "INSERT INTO run_record (job, concurrency_key, started_at, status, details_json) VALUES ('worker-selfcheck', ?, ?, 'success', ?)",
        args: [`k${at}`, at, typeof results === "string" ? results : JSON.stringify(results)],
      });
    await put("2026-10-10T00:00:00.000Z", [
      { name: "ASX_LIVE", ok: true, detail: "not set" },
      { name: "ASX_USER_AGENT", ok: true, detail: "not set" },
    ]);
    await put("2026-10-11T00:00:00.000Z", [
      { name: "ASX_LIVE", ok: true, detail: "set" },
      { name: "ASX_USER_AGENT", ok: true, detail: "weird value" },
      "junk",
    ]);
    expect((await loadControlsView(main, false)).workerVars).toEqual({
      asxLive: "set",
      asxUserAgent: "not known",
    });
    await put("2026-10-12T00:00:00.000Z", "not json");
    expect((await loadControlsView(main, false)).workerVars.asxLive).toBe("not known");
    await put("2026-10-13T00:00:00.000Z", { not: "a list" });
    expect((await loadControlsView(main, false)).workerVars.asxLive).toBe("not known");
  });

  it("calendarConfirmed follows the current Sydney year", async () => {
    expect((await loadControlsView(main, false, NOW)).calendarConfirmed).toBe(false);
    await confirmCal();
    expect((await loadControlsView(main, false, NOW)).calendarConfirmed).toBe(true);
    expect(
      (await loadControlsView(main, false, new Date("2028-03-01T00:00:00Z"))).calendarConfirmed,
    ).toBe(false);
  });

  it("dataOnly is false when the market is off or full; parseOn accepts the Worker's forms", async () => {
    await main.execute("UPDATE market SET mode = 'off'");
    expect((await loadControlsView(main, false)).dataOnly).toBe(false);
    await main.execute("UPDATE market SET mode = 'full'");
    expect((await loadControlsView(main, false)).dataOnly).toBe(false);
    for (const raw of ['"1"', "1", "true"]) expect(parseOn(raw)).toBe(true);
    for (const raw of ['"0"', "0", "false", "junk", undefined, null, '"yes"'])
      expect(parseOn(raw)).toBe(false);
  });
});

describe("System Health actions (Owner only)", () => {
  it("each action requires the admin guard on /health, decodes the form and revalidates", async () => {
    await ready();
    await accept("asx_announcements");
    expect(await setDispatchEnabledAction(form({ enabled: "1" }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(requireUser).toHaveBeenLastCalledWith("admin", "/health");
    expect(await setAsxEnabledAction(form({ enabled: "1" }))).toEqual({ ok: true, changed: true });
    expect(await setMarketModeAction(form({ market: "AU", mode: "off" }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setSourceAcceptedAction(form({ source: "yahoo_eod", accept: "0" }))).toEqual({
      ok: true,
      changed: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/health");
    expect(await sw("dispatch_enabled")).toBe('"1"');
    expect(await sw("asx_enabled")).toBe('"1"');
    expect(await marketMode()).toBe("off");
    expect(await reg("yahoo_eod")).toBe("disabled");
    const rows = await auditRows(auth);
    expect(rows.every((r) => r.actor_user_id === ownerId)).toBe(true);
  });

  it("form values that are missing or odd are refused by the service", async () => {
    expect(await setDispatchEnabledAction(form({}))).toEqual({ error: "invalid" });
    expect(await setAsxEnabledAction(form({ enabled: "yes" }))).toEqual({ error: "invalid" });
    expect(await setMarketModeAction(form({ market: "AU", mode: "full" }))).toEqual({
      error: "signoff_required",
    });
    expect(await setMarketModeAction(form({}))).toEqual({ error: "invalid" });
    expect(await setSourceAcceptedAction(form({ source: "yahoo_eod", accept: "1" }))).toEqual({
      error: "risk_not_acknowledged",
    });
    expect(await setSourceAcceptedAction(form({ accept: "1", acknowledged: "on" }))).toEqual({
      error: "invalid",
    });
    expect(
      await setSourceAcceptedAction(form({ source: "yahoo_eod", accept: "1", acknowledged: "on" })),
    ).toEqual({
      ok: true,
      changed: true,
    });
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("a guard refusal (non-Owner) stops the action before anything runs", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(setDispatchEnabledAction(form({ enabled: "0" }))).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
    await expect(setAsxEnabledAction(form({ enabled: "0" }))).rejects.toThrow();
    await expect(setMarketModeAction(form({ market: "AU", mode: "off" }))).rejects.toThrow();
    await expect(
      setSourceAcceptedAction(form({ source: "yahoo_eod", accept: "0" })),
    ).rejects.toThrow();
    await expect(resetAsxTripAction()).rejects.toThrow();
    expect(await actions()).toEqual([]);
  });

  it("an editor who got past the guard is still refused by the service", async () => {
    requireUser.mockResolvedValue({
      id: editorId,
      email: "editor@example.test",
      name: null,
      role: "editor",
    });
    expect(await setMarketModeAction(form({ market: "AU", mode: "off" }))).toEqual({
      error: "forbidden",
    });
    expect(await resetAsxTripAction()).toEqual({ error: "forbidden" });
    expect(await marketMode()).toBe("data_only");
  });

  it("a thrown error becomes a generic message", async () => {
    dbs.main.mockImplementation(() => {
      throw new Error("secret detail");
    });
    expect(await setDispatchEnabledAction(form({ enabled: "1" }))).toEqual({
      error: "unavailable",
    });
    expect(await resetAsxTripAction()).toEqual({ error: "unavailable" });
  });

  it("e. the ASX trip reset button resets once, audits, and is idempotent", async () => {
    expect(await resetAsxTripAction()).toEqual({ ok: true, changed: false }); // nothing tripped
    await main.execute(
      "UPDATE source_status SET mode = 'tripped', reason = 'blocked', tripped_by = 'asx_block_trip' WHERE source = 'asx_announcements'",
    );
    expect(await resetAsxTripAction()).toEqual({ ok: true, changed: true });
    expect((await srcMode("asx_announcements")).mode).toBe("on");
    expect(await actions()).toEqual(["asx.trip_reset"]);
    expect(await resetAsxTripAction()).toEqual({ ok: true, changed: false });
    expect(await actions()).toEqual(["asx.trip_reset"]);
    // Resetting never turns the switch on.
    expect(await sw("asx_enabled")).toBeNull();
  });
});

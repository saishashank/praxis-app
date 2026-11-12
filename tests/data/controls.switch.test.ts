// @vitest-environment node
// M20 S1 (AT-71, MKT-111, D-1100, D-1101; F: kill and rollback). The two-step switch-on writer and the rollback:
// refused while any checklist item is open (and the open items named), `off -> full` refused, `data_only -> full`
// refused before five green days and ten latency samples, the seed computed from the RBA close, `full -> off` writes
// only the switch, audit and mode rows and keeps `enabled = 1` until the kill, a rollback in progress blocks every
// switch, and a planted write for a disabled market is refused by the guard.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";
import { switchMarket } from "@/lib/data/marketSwitch";
import type { ChecklistDeps } from "@/lib/market/checklist";
import { invalidateProfiles } from "@/lib/market/profile";
import { isMarketEnabled } from "@/lib/market/profile";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
const ENV = { PII_HASH_KEY: KEY } as Record<string, string | undefined>;
const NOW = new Date("2026-11-20T02:00:00.000Z"); // Fri 20 Nov 2026, 13:00 Melbourne
const TODAY = "2026-11-20";

const AU_OK = async () => ({
  id: "au_mkt105" as const,
  ok: true,
  text: "AU meets MKT-105.",
  evidence: null,
});
/** Every checklist reader satisfied except the ones the profile and the market row decide. */
const DEPS: ChecklistDeps = {
  quota: async () => ({ fits: true, text: "fits" }),
  reportListed: () => true,
  sources: [{ id: "in_test", status: "enabled" }],
  au: AU_OK,
};
const base = (over: Record<string, unknown> = {}) => ({
  mainDb: main,
  authDb: auth,
  env: ENV,
  actorId: ownerId,
  now: NOW,
  checklistDeps: DEPS,
  ...over,
});
const go = (market: string, to: string, over: Record<string, unknown> = {}) =>
  switchMarket(base({ market, to, ...over }) as never);

async function ready(code: string) {
  await main.execute({
    sql: "UPDATE market_profile_field SET verify = 0 WHERE code = ?",
    args: [code],
  });
  await main.execute({
    sql: "UPDATE market_profile SET evidence_recorded_at = '2026-11-12T00:00:00.000Z' WHERE code = ?",
    args: [code],
  });
  invalidateProfiles();
}
const row = async (code: string) =>
  (await main.execute({ sql: "SELECT * FROM market WHERE code = ?", args: [code] })).rows[0]!;
const n = async (sql: string, args: (string | number)[] = []) =>
  Number((await main.execute({ sql, args })).rows[0]!.n);
const actions = async () => (await auditRows(auth)).map((r) => r.action);

/** Row count of every table, to prove what a step wrote and what it did not. */
async function counts(db: Client): Promise<Record<string, number>> {
  const t = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, number> = {};
  for (const r of t.rows) {
    const name = String(r.name);
    out[name] = Number((await db.execute(`SELECT COUNT(*) AS n FROM "${name}"`)).rows[0]!.n);
  }
  return out;
}
const diff = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(b)
      .filter(([k, v]) => a[k] !== v)
      .map(([k, v]) => [k, v - a[k]!]),
  );

async function toDataOnly(code: string) {
  await ready(code);
  const r = await go(code, "data_only", { reason: "start", now: EARLIER });
  expect(r).toMatchObject({ ok: true, changed: true });
}
async function green(code: string, days: string[]) {
  for (const d of days) {
    await main.execute({
      sql: "INSERT OR IGNORE INTO trading_calendar (market, d, kind, confirmed, source) VALUES (?, ?, 'session', 1, 't')",
      args: [code, d],
    });
    for (const t of ["U1", "U2", "U3"]) {
      await main.execute({
        sql: "INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES (?, ?, ?, 1, 1, 1.0, 1)",
        args: [code, d, t],
      });
    }
  }
}
async function latency(code: string, count: number) {
  for (let i = 1; i <= count; i++) {
    await main.execute({
      sql: "INSERT INTO bar_latency_sample (market, d, close_local, first_seen_at, latency_min, source) VALUES (?, ?, '15:30', 'x', 45, 'test')",
      args: [code, `2026-10-${String(i).padStart(2, "0")}`],
    });
  }
}
const fxRow = (series: string, d: string, micro: number) =>
  main.execute({
    sql: "INSERT INTO macro_series (source, series_id, d, value_micro, fetched_at) VALUES ('rba', ?, ?, ?, 'x')",
    args: [series, d, micro],
  });
// the five newest completed sessions before Fri 20 Nov (the market entered data_only on Tue 10 Nov)
const FIVE = ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];
const EARLIER = new Date("2026-11-10T02:00:00.000Z");

beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  invalidateProfiles();
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
});

describe("who and what (shared rules)", () => {
  it("a non-Owner or an unknown actor is refused with no audit and no change", async () => {
    const before = await counts(main);
    for (const actorId of [editorId, 9999]) {
      expect(await go("IN", "data_only", { actorId })).toEqual({ ok: false, error: "forbidden" });
    }
    expect(await actions()).toEqual([]);
    expect(await counts(main)).toEqual(before);
  });

  it.each([
    ["AU", "data_only"], // the home market is never switched
    ["ZZ", "data_only"],
    ["IN", "on"],
    [7, "data_only"],
    ["IN", undefined],
  ])("refuses an invalid request (%s -> %s)", async (market, to) => {
    expect(await go(market as string, to as string)).toEqual({ ok: false, error: "invalid" });
    expect(await actions()).toEqual([]);
  });

  it("refuses a reason that is not text or longer than 200 characters", async () => {
    expect(await go("IN", "data_only", { reason: 5 })).toMatchObject({ error: "invalid" });
    expect(await go("IN", "data_only", { reason: "x".repeat(201) })).toMatchObject({
      error: "invalid",
    });
  });
});

describe("the production seed never switches (BLD-050, AT-71 a)", () => {
  it.each(["IN", "US"])(
    "%s: off -> data_only is refused with the open items named; nothing is written",
    async (code) => {
      const before = await counts(main);
      const r = await switchMarket({
        ...base({ market: code, to: "data_only" }),
        checklistDeps: { ...DEPS, reportListed: () => false },
      } as never);
      expect(r).toMatchObject({ ok: false, error: "checklist_open" });
      const open = (r as { open: { id: string }[] }).open.map((i) => i.id);
      expect(open).toEqual(expect.arrayContaining(["profile_complete", "at_m_evidence"]));
      expect(await actions()).toEqual([]);
      expect(await counts(main)).toEqual(before);
      expect(String((await row(code)).mode)).toBe("off");
      expect(Number((await row(code)).enabled)).toBe(0);
    },
  );

  it("with the real readers (no seams) the first step cannot be complete on the seed", async () => {
    const r = await switchMarket(
      base({ market: "IN", to: "data_only", checklistDeps: undefined }) as never,
    );
    expect(r).toMatchObject({ ok: false, error: "checklist_open" });
    expect((r as { open: unknown[] }).open.length).toBeGreaterThanOrEqual(4);
  });

  it("each single open item blocks on its own, and names itself", async () => {
    await ready("IN");
    const cases: [string, ChecklistDeps][] = [
      ["at_m_evidence", { ...DEPS, reportListed: () => false }],
      ["licence_rows", { ...DEPS, sources: [{ id: "in_test", status: "pending" }] }],
      [
        "quota_projection",
        {
          ...DEPS,
          quota: async () => ({ fits: false, text: "Over the line: Turso rows read 21 %." }),
        },
      ],
      [
        "au_mkt105",
        {
          ...DEPS,
          au: async () => ({
            id: "au_mkt105",
            ok: false,
            text: "AU live 40 of 60 trading days.",
            evidence: null,
          }),
        },
      ],
    ];
    for (const [id, deps] of cases) {
      const r = await switchMarket(
        base({ market: "IN", to: "data_only", checklistDeps: deps }) as never,
      );
      expect(r, id).toMatchObject({ ok: false, error: "checklist_open" });
      expect((r as { open: { id: string }[] }).open.map((i) => i.id)).toEqual([id]);
    }
    expect(Number((await row("IN")).enabled)).toBe(0);
    expect(await actions()).toEqual([]);
  });
});

describe("off -> data_only", () => {
  it.each(["IN", "US"])(
    "%s: enables the market, writes its rows and calendar, one switch row, one audit event",
    async (code) => {
      await ready(code);
      const au = await row("AU");
      const before = await counts(main);
      const r = await go(code, "data_only", { reason: "India first" });
      expect(r).toEqual({ ok: true, changed: true, from: "off", to: "data_only" });
      const m = await row(code);
      expect(Number(m.enabled)).toBe(1);
      expect(String(m.mode)).toBe("data_only");
      expect(String(m.data_only_since)).toBe(TODAY);
      expect(m.rollback_at).toBeNull();
      expect(JSON.parse(String(m.slots_json))).toHaveProperty("b1");
      expect(await isMarketEnabled(main, code)).toBe(true);
      expect(
        String(
          (
            await main.execute({
              sql: "SELECT work_status FROM market_profile WHERE code = ?",
              args: [code],
            })
          ).rows[0]!.work_status,
        ),
      ).toBe("active");
      // the source register rows and one history row each are written on enable (D-1128), the calendar years too (D-1097)
      const prefix = `${code.toLowerCase()}_`;
      const sources = await n(
        "SELECT COUNT(*) AS n FROM source_register WHERE substr(source, 1, 3) = ?",
        [prefix],
      );
      expect(sources).toBeGreaterThanOrEqual(9);
      expect(
        await n(
          "SELECT COUNT(*) AS n FROM source_register_history WHERE substr(source, 1, 3) = ?",
          [prefix],
        ),
      ).toBe(sources);
      expect(
        await n("SELECT COUNT(*) AS n FROM source_status WHERE substr(source, 1, 3) = ?", [prefix]),
      ).toBe(sources);
      const cal = await n(
        "SELECT COUNT(*) AS n FROM trading_calendar WHERE market = ? AND confirmed = 0",
        [code],
      );
      expect(cal).toBeGreaterThan(300); // two years of provisional rows
      // exactly one switch row and one audit event; the market_mode value moved
      const sw = (
        await main.execute({ sql: "SELECT * FROM market_switch WHERE market = ?", args: [code] })
      ).rows;
      expect(sw).toHaveLength(1);
      expect(sw[0]).toMatchObject({
        from_mode: "off",
        to_mode: "data_only",
        enabled_after: 1,
        reason: "India first",
        actor: `user:${ownerId}`,
        at: NOW.toISOString(),
      });
      expect(
        JSON.parse(String(sw[0]!.checklist_json)).items.map((i: { id: string }) => i.id),
      ).toEqual([
        "profile_complete",
        "at_m_evidence",
        "licence_rows",
        "quota_projection",
        "au_mkt105",
      ]);
      expect(await actions()).toEqual(["market.switch"]);
      expect((await auditRows(auth))[0]!.detail).toEqual({
        market: code,
        from: "off",
        to: "data_only",
        reason: "India first",
      });
      const modes = JSON.parse(
        String(
          (
            await main.execute(
              "SELECT value_json FROM config_version WHERE key = 'market_mode' ORDER BY id DESC LIMIT 1",
            )
          ).rows[0]!.value_json,
        ),
      );
      expect(modes[code]).toBe("data_only");
      // AU is untouched, byte for byte
      expect(await row("AU")).toEqual(au);
      // nothing else grew: no arena, ledger or price row
      const d = diff(before, await counts(main));
      for (const t of [
        "fill",
        "trade",
        "cash_ledger",
        "nav_daily",
        "arena_order",
        "cohort",
        "price_bar",
      ])
        expect(d[t]).toBeUndefined();
    },
  );

  it("a second identical request changes nothing and writes nothing", async () => {
    await ready("IN");
    await go("IN", "data_only");
    const before = await counts(main);
    expect(await go("IN", "data_only")).toEqual({
      ok: true,
      changed: false,
      from: "data_only",
      to: "data_only",
    });
    expect(await counts(main)).toEqual(before);
    expect(await actions()).toEqual(["market.switch"]);
  });
});

describe("the two-step rule (AT-71 b)", () => {
  it("off -> full is refused two_step, even with every item ok", async () => {
    await ready("IN");
    expect(await go("IN", "full")).toEqual({ ok: false, error: "two_step" });
    expect(Number((await row("IN")).enabled)).toBe(0);
    expect(await actions()).toEqual([]);
  });

  it("full -> data_only is refused two_step", async () => {
    await toDataOnly("IN");
    await green("IN", FIVE);
    await latency("IN", 10);
    await fxRow("FXRINR", "2026-11-19", 55_750_000);
    expect(await go("IN", "full")).toMatchObject({ ok: true });
    expect(await go("IN", "data_only")).toEqual({ ok: false, error: "two_step" });
  });

  it("data_only -> full is refused before five green days, naming the item", async () => {
    await toDataOnly("IN");
    await latency("IN", 10);
    await fxRow("FXRINR", "2026-11-19", 55_750_000);
    await green("IN", FIVE.slice(1)); // the newest four of five: the fifth session has no verdict
    const r = await go("IN", "full");
    expect(r).toMatchObject({ ok: false, error: "checklist_open" });
    expect((r as { open: { id: string; text: string }[] }).open.map((i) => i.id)).toEqual([
      "five_green_days",
    ]);
    expect(String((await row("IN")).mode)).toBe("data_only");
  });

  it("data_only -> full is refused before ten latency samples", async () => {
    await toDataOnly("IN");
    await green("IN", FIVE);
    await fxRow("FXRINR", "2026-11-19", 55_750_000);
    await latency("IN", 9);
    const r = await go("IN", "full");
    expect((r as { open: { id: string }[] }).open.map((i) => i.id)).toEqual(["latency_measured"]);
  });

  it("data_only -> full is refused fx_missing without the RBA close (the seed cannot be computed)", async () => {
    await toDataOnly("IN");
    await green("IN", FIVE);
    await latency("IN", 10);
    expect(await go("IN", "full")).toEqual({ ok: false, error: "fx_missing" });
    expect(String((await row("IN")).mode)).toBe("data_only");
  });

  it("a stale close (older than five days before the activation day) is refused fx_missing, never converted", async () => {
    await toDataOnly("IN");
    await green("IN", FIVE);
    await latency("IN", 10);
    await fxRow("FXRINR", "2026-11-14", 55_750_000); // six days before Fri 20 Nov
    expect(await go("IN", "full")).toEqual({ ok: false, error: "fx_missing" });
    await fxRow("FXRINR", "2026-11-15", 55_750_000); // five days: the oldest accepted
    expect(await go("IN", "full")).toMatchObject({ ok: true });
  });

  // IN: A$600 x 55.75 = 33,450 -> /1,000 = 33.45 -> 33 -> Rs 33,000 = 33,000,000,000 micro (half-up to Rs 1,000)
  // US: A$600 x 0.6584 = 395.04 -> /10 = 39.504 -> 40 -> US$400 = 400,000,000 micro; at 0.6583 -> 394.98 -> US$390
  it.each([
    ["IN", "FXRINR", 55_750_000, "33000000000", "55.75"],
    ["US", "FXRUSD", 658_400, "400000000", "0.6584"],
    ["US", "FXRUSD", 658_300, "390000000", "0.6583"],
  ])(
    "%s: full is set, and the seed record is stored in the switch row (%s %i -> %s)",
    async (code, series, micro, seed, rate) => {
      await toDataOnly(code);
      await green(code, FIVE);
      await latency(code, 10);
      await fxRow(series, "2026-11-19", micro); // the newest close on or before the activation day
      await fxRow(series, "2026-11-21", micro * 2); // a later close is never read
      const r = await go(code, "full", { reason: "go" });
      expect(r).toEqual({ ok: true, changed: true, from: "data_only", to: "full" });
      expect(String((await row(code)).mode)).toBe("full");
      const sw = (
        await main.execute({
          sql: "SELECT checklist_json FROM market_switch WHERE market = ? AND to_mode = 'full'",
          args: [code],
        })
      ).rows[0]!;
      const rec = JSON.parse(String(sw.checklist_json));
      expect(rec.seed).toEqual({
        seed_micro: seed,
        fx_rate: rate,
        fx_date: "2026-11-19",
        fx_source: `rba:${series}`,
        activation_day: TODAY,
      });
      expect(rec.items.map((i: { id: string }) => i.id)).toContain("five_green_days");
      expect(await n("SELECT COUNT(*) AS n FROM cohort")).toBe(0); // books open the next trading day, not here
    },
  );
});

describe("the rollback full -> off (AT-71 c; F)", () => {
  async function full(code: string) {
    await toDataOnly(code);
    await green(code, FIVE);
    await latency(code, 10);
    await fxRow(
      code === "IN" ? "FXRINR" : "FXRUSD",
      "2026-11-19",
      code === "IN" ? 55_750_000 : 658_400,
    );
    expect(await go(code, "full")).toMatchObject({ ok: true });
  }

  it("needs a reason", async () => {
    await full("IN");
    expect(await go("IN", "off")).toEqual({ ok: false, error: "reason_required" });
    expect(await go("IN", "off", { reason: "   " })).toEqual({
      ok: false,
      error: "reason_required",
    });
    expect(String((await row("IN")).mode)).toBe("full");
  });

  it("sets mode off and rollback_at, KEEPS enabled = 1, and writes only the switch, mode and audit rows", async () => {
    await full("IN");
    // some forever rows exist: they must all stay
    await main.execute(
      "INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version) VALUES ('IN', 'nse', 'a1', 'results', 2, 1, 'v1')",
    );
    const au = await row("AU");
    const before = await counts(main);
    const audits = (await actions()).length;
    const r = await go("IN", "off", { reason: "data feed unreliable" });
    expect(r).toEqual({ ok: true, changed: true, from: "full", to: "off" });
    const m = await row("IN");
    expect(String(m.mode)).toBe("off");
    expect(Number(m.enabled)).toBe(1); // until the kill has run
    expect(String(m.rollback_at)).toBe(NOW.toISOString());
    expect(diff(before, await counts(main))).toEqual({ market_switch: 1, config_version: 1 });
    expect((await actions()).length).toBe(audits + 1);
    const last = (await auditRows(auth)).at(-1)!;
    expect(last.action).toBe("market.switch");
    expect(last.detail).toEqual({
      market: "IN",
      from: "full",
      to: "off",
      reason: "data feed unreliable",
    });
    const sw = (
      await main.execute("SELECT * FROM market_switch WHERE market = 'IN' ORDER BY id DESC LIMIT 1")
    ).rows[0]!;
    expect(sw).toMatchObject({
      from_mode: "full",
      to_mode: "off",
      enabled_after: 1,
      reason: "data feed unreliable",
    });
    expect(await n("SELECT COUNT(*) AS n FROM announcement_category WHERE market = 'IN'")).toBe(1); // forever rows stay
    expect(await row("AU")).toEqual(au);
    // the market_mode config value follows
    const modes = JSON.parse(
      String(
        (
          await main.execute(
            "SELECT value_json FROM config_version WHERE key = 'market_mode' ORDER BY id DESC LIMIT 1",
          )
        ).rows[0]!.value_json,
      ),
    );
    expect(modes.IN).toBe("off");
  });

  it("while the rollback waits for its kill, every switch is refused rollback_pending", async () => {
    await full("IN");
    await go("IN", "off", { reason: "r" });
    for (const to of ["data_only", "full", "off"]) {
      expect(await go("IN", to, { reason: "again" })).toEqual({
        ok: false,
        error: "rollback_pending",
      });
    }
    expect(Number((await row("IN")).enabled)).toBe(1);
  });

  it("the writes of a market in rollback are still accepted (the kill needs them), those of a disabled market are not", async () => {
    await full("IN");
    await go("IN", "off", { reason: "r" });
    await main.execute(
      "INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version) VALUES ('IN', 'nse', 'k1', 'results', 2, 1, 'v1')",
    );
    await main.execute("UPDATE market SET enabled = 0, rollback_at = NULL WHERE code = 'IN'"); // what the kill does last
    await expect(
      main.execute(
        "INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version) VALUES ('IN', 'nse', 'k2', 'results', 2, 1, 'v1')",
      ),
    ).rejects.toThrow(/MarketNotEnabled/);
  });
});

describe("data_only -> off (no books, no kill)", () => {
  it("disables the market at once, keeps every row, writes one switch row", async () => {
    await toDataOnly("US");
    const before = await counts(main);
    const r = await go("US", "off", { reason: "not ready" });
    expect(r).toEqual({ ok: true, changed: true, from: "data_only", to: "off" });
    const m = await row("US");
    expect(Number(m.enabled)).toBe(0);
    expect(String(m.mode)).toBe("off");
    expect(m.rollback_at).toBeNull();
    expect(diff(before, await counts(main))).toEqual({ market_switch: 1, config_version: 1 });
    expect(await isMarketEnabled(main, "US")).toBe(false);
    const sw = (
      await main.execute("SELECT * FROM market_switch WHERE market = 'US' ORDER BY id DESC LIMIT 1")
    ).rows[0]!;
    expect(sw).toMatchObject({ from_mode: "data_only", to_mode: "off", enabled_after: 0 });
    // a planted write for the disabled market is refused (AT-71: the guard)
    await expect(
      main.execute(
        "INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version) VALUES ('US', 'sec', 'x', 'results', 2, 1, 'v1')",
      ),
    ).rejects.toThrow(/MarketNotEnabled/);
    // and the market can be switched on again: its source and calendar rows already exist, nothing is duplicated
    const sources = await n(
      "SELECT COUNT(*) AS n FROM source_register WHERE substr(source, 1, 3) = 'us_'",
    );
    await ready("US");
    expect(await go("US", "data_only")).toMatchObject({ ok: true });
    expect(
      await n("SELECT COUNT(*) AS n FROM source_register WHERE substr(source, 1, 3) = 'us_'"),
    ).toBe(sources);
  });
});

describe("atomicity (D-047)", () => {
  it("an audit failure changes nothing", async () => {
    await ready("IN");
    const broken = {
      execute: () => Promise.reject(new Error("auth down")),
      transaction: () => Promise.reject(new Error("x")),
    } as unknown as Client;
    // ownerCheck uses authDb too: a down auth database reads as unavailable, before any write
    const before = await counts(main);
    expect(await go("IN", "data_only", { authDb: broken })).toMatchObject({
      ok: false,
      error: "unavailable",
    });
    expect(await counts(main)).toEqual(before);
  });

  it("a transaction that fails rolls back every statement and appends a _failed audit event", async () => {
    await ready("IN");
    const real = main;
    const failing = new Proxy(real, {
      get(t, p, r) {
        if (p === "transaction") {
          return async () => {
            const tx = await t.transaction("write");
            return new Proxy(tx, {
              get(tt, pp, rr) {
                if (pp === "batch") return () => Promise.reject(new Error("boom")); // the source rows
                const v = Reflect.get(tt, pp, rr);
                return typeof v === "function" ? v.bind(tt) : v;
              },
            });
          };
        }
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    const before = await counts(main);
    expect(await go("IN", "data_only", { mainDb: failing })).toMatchObject({
      ok: false,
      error: "unavailable",
    });
    expect(await counts(main)).toEqual(before);
    expect(Number((await row("IN")).enabled)).toBe(0);
    expect(await actions()).toEqual(["market.switch", "market.switch_failed"]);
  });

  it("a race (the row changed after the checks) refuses inside the transaction and writes nothing", async () => {
    await ready("IN");
    const racing = new Proxy(main, {
      get(t, p, r) {
        if (p === "transaction") {
          return async (...a: unknown[]) => {
            await allowMarket(t, "IN");
            await t.execute("UPDATE market SET mode = 'data_only' WHERE code = 'IN'");
            return (t.transaction as (...x: unknown[]) => unknown).apply(t, a);
          };
        }
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    const r = await go("IN", "data_only", { mainDb: racing });
    expect(r).toEqual({ ok: false, error: "two_step" });
    expect(await n("SELECT COUNT(*) AS n FROM market_switch")).toBe(0);
  });
});

// @vitest-environment node
// M17 WP3 (AT-60 a c; D-397, D-442): the quote-poll tick on a migrated test DB with ZZ fixtures and an
// injected fetch. Refused source writes nothing; arming is step 1 and idempotent; one hit per pick per
// session over duplicate ticks; clears carry their reason; stale quotes decide nothing; the signed
// route refuses unsigned and wrong-purpose calls. No network.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs signer without types (the Actions-side twin)
import { sign } from "../../scripts/smoke/sign.mjs";
import { armableOrders } from "@/lib/alerts/pick/armable";
import {
  createPickAlertsHandler,
  runPickAlertPoll,
  type PollRunDeps,
} from "@/lib/alerts/pick/poll";
import type { MailableTransition, PickAlertMailer } from "@/lib/alerts/pick/types";
import { syntheticChart } from "@/lib/data/quotes/fixture";
import type { NonceStore } from "@/lib/security/replay";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const SESSION = "2026-11-04"; // Wed, AEDT (UTC+11)
const T1045 = new Date("2026-11-03T23:45:00.000Z");
const T1050 = new Date("2026-11-03T23:50:00.000Z");
const SHA = "a".repeat(64);

let db: Client;
let calls: string[];
let prices: Map<string, { price: number; volume: number | null; ageMin: number; status?: number }>;
let clock: Date;

const fetchStub: PollRunDeps["fetch"] = async (url) => {
  calls.push(url);
  const code = /chart\/([A-Z0-9]+)\.AX/.exec(url)![1];
  const s = prices.get(code);
  if (!s) return { ok: false, status: 404, json: async () => ({}) };
  if (s.status) return { ok: false, status: s.status, json: async () => ({}) };
  return {
    ok: true,
    status: 200,
    json: async () =>
      syntheticChart({
        price: s.price,
        prevClose: 10,
        volume: s.volume,
        timeS: (clock.getTime() - s.ageMin * 60_000) / 1000,
        symbol: `${code}.AX`,
      }),
  };
};

let mailed: MailableTransition[][];
const mailer: PickAlertMailer = {
  notify: async (_c, t) => {
    mailed.push([...t]);
  },
  digest: async () => {},
};

const deps = (now: Date, users: string[] = ["1"]): PollRunDeps => ({
  db,
  now: () => now,
  fetch: fetchStub,
  sleep: async () => {},
  recipients: async () => users,
  mailer,
});

async function accept(): Promise<void> {
  await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_delayed'");
  await db.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 't')",
  );
}

async function seedPick(code: string, rank: number, d = "2026-11-03"): Promise<void> {
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, size_micro,
            risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES ('AU', ?, 'P1', ?, ?, 'F1', 'U1', 'F1.v1', ?, 'UNVALIDATED', 10000000, 10000000, '2026-11-12',
            9000000, 11000000, 50, 1000000000, 100000000, '[]', '[]', ?, ?)`,
    args: [d, rank, code, `sig-${code}`, SHA, `${d}T07:00:00.000Z`],
  });
}

async function buy(rank: number): Promise<void> {
  const keys = ["'AU'", "'2026-11-03'", "'P1'", String(rank), "'pick'"].join(", ");
  await db.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          SELECT market, d, profile, rank, 'pick', code, pick_sha, 'waiting', d FROM pick
          WHERE market = 'AU' AND d = '2026-11-03' AND profile = 'P1' AND rank = ${rank}`,
    args: [],
  });
  await db.execute(
    `UPDATE pick_outcome SET state = 'bought', entry_d = '2026-11-04', entry_micro = 10000000, updated_d = '2026-11-04'
     WHERE (market, d, profile, rank, kind) = (${keys})`,
  );
}

const rows = async (sql: string) => (await db.execute(sql)).rows;
const scalar = async (sql: string): Promise<number> => Number((await rows(sql))[0].n);
const states = async (code: string): Promise<string[]> =>
  (
    await rows(`SELECT state, clear_reason FROM pick_alert WHERE code = '${code}' ORDER BY seq`)
  ).map((r) => `${String(r.state)}${r.clear_reason === null ? "" : ":" + String(r.clear_reason)}`);

beforeEach(async () => {
  db = await freshDb("main");
  calls = [];
  mailed = [];
  clock = T1045;
  prices = new Map();
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  await accept();
  await seedPick("ZZ01", 1);
  await seedPick("ZZ02", 2);
  await seedPick("ZZ03", 3);
  prices.set("ZZ01", { price: 10.0, volume: 5000, ageMin: 20 }); // at the limit: hit
  prices.set("ZZ02", { price: 8.5, volume: 5000, ageMin: 20 }); // under the stop: below_stop
  prices.set("ZZ03", { price: 10.1, volume: 5000, ageMin: 20 }); // between limit and cap: stays armed
});

describe("refusal and gates", () => {
  it("a pending source is a skip: no request, nothing armed, nothing written", async () => {
    await db.execute(
      "UPDATE source_register SET status = 'pending' WHERE source = 'yahoo_delayed'",
    );
    expect(await runPickAlertPoll(deps(T1045))).toEqual({
      status: "skipped",
      reason: "source_not_accepted",
    });
    expect(calls).toEqual([]);
    expect(await scalar("SELECT COUNT(*) AS n FROM pick_alert")).toBe(0);
    expect(await scalar("SELECT COUNT(*) AS n FROM quote_run")).toBe(0);
  });

  it("outside the window and on a weekend: skipped", async () => {
    expect(await runPickAlertPoll(deps(new Date("2026-11-03T22:55:00.000Z")))).toMatchObject({
      reason: "before_window",
    });
    expect(await runPickAlertPoll(deps(new Date("2026-11-04T05:05:00.000Z")))).toMatchObject({
      reason: "after_close",
    });
    expect(await runPickAlertPoll(deps(new Date("2026-11-07T00:00:00.000Z")))).toMatchObject({
      reason: "non_trading_day",
    });
    expect(calls).toEqual([]);
  });

  it("the cool-down after a paused run skips the next ticks (arming still happens, no request)", async () => {
    prices.set("ZZ01", { price: 10, volume: 5000, ageMin: 20, status: 429 });
    const first = await runPickAlertPoll(deps(T1045));
    expect(first).toMatchObject({ status: "ok", paused: "rate_limited" });
    const n = calls.length;
    expect(await runPickAlertPoll(deps(T1050))).toMatchObject({ reason: "cooldown" });
    expect(calls.length).toBe(n);
  });
});

describe("arming (step 1, idempotent)", () => {
  it("arms every listed pick for every recipient on the first tick, once", async () => {
    const r = await runPickAlertPoll(deps(T1045, ["1", "2"]));
    expect(r).toMatchObject({ status: "ok", armed: 6, sessionD: SESSION });
    expect(
      await scalar("SELECT COUNT(*) AS n FROM pick_alert WHERE seq = 1 AND state = 'armed'"),
    ).toBe(6);
    const again = await runPickAlertPoll(deps(T1050, ["1", "2"]));
    expect(again).toMatchObject({ status: "ok", armed: 0 });
    expect(await scalar("SELECT COUNT(*) AS n FROM pick_alert WHERE seq = 1")).toBe(6);
  });

  it("armableOrders: limit = buy_max_micro, stop = stop_micro; a withdrawn or filled pick is not armable", async () => {
    const before = await armableOrders(db, "AU", "2026-11-05");
    expect(before.map((o) => o.code)).toEqual(["ZZ01", "ZZ02", "ZZ03"]);
    expect(before[0]).toMatchObject({ limitMicro: 10_000_000n, stopMicro: 9_000_000n });
    await db.execute({
      sql: "INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at) VALUES ('AU','2026-11-03','P1',2,'2026-11-04',0,'below_stop','t')",
      args: [],
    });
    await buy(3);
    expect((await armableOrders(db, "AU", "2026-11-05")).map((o) => o.code)).toEqual(["ZZ01"]);
    expect((await armableOrders(db, "AU", SESSION)).map((o) => o.code)).toEqual(["ZZ01", "ZZ02"]);
  });
});

describe("transitions and mail", () => {
  it("hit and below_stop on the first tick; one row per transition; mail hook gets both", async () => {
    await runPickAlertPoll(deps(T1045));
    expect(await states("ZZ01")).toEqual(["armed", "hit"]);
    expect(await states("ZZ02")).toEqual(["armed", "cleared:below_stop"]);
    expect(await states("ZZ03")).toEqual(["armed"]);
    expect(
      mailed
        .flat()
        .map((t) => `${t.code}:${t.state}`)
        .sort(),
    ).toEqual(["ZZ01:hit", "ZZ02:cleared"]);
  });

  it("duplicate ticks and a repeated slot give no second hit, no second mail", async () => {
    await runPickAlertPoll(deps(T1045));
    expect(await runPickAlertPoll(deps(T1045))).toEqual({
      status: "skipped",
      reason: "already_done",
      armed: 0,
    });
    await runPickAlertPoll(deps(T1050));
    expect(await states("ZZ01")).toEqual(["armed", "hit"]);
    expect(mailed).toHaveLength(1);
  });

  it("a later rise in the same session does not re-arm; a fall under the stop after a hit is silent", async () => {
    await runPickAlertPoll(deps(T1045));
    clock = T1050;
    prices.set("ZZ01", { price: 12, volume: 6000, ageMin: 20 });
    await runPickAlertPoll(deps(T1050));
    prices.set("ZZ01", { price: 5, volume: 6000, ageMin: 20 });
    await runPickAlertPoll(deps(new Date("2026-11-03T23:55:00.000Z")));
    expect(await states("ZZ01")).toEqual(["armed", "hit"]);
  });

  it("a stale quote and a quote without volume decide nothing", async () => {
    prices.set("ZZ01", { price: 10, volume: 5000, ageMin: 90 });
    prices.set("ZZ02", { price: 8, volume: null, ageMin: 20 });
    await runPickAlertPoll(deps(T1045));
    expect(await states("ZZ01")).toEqual(["armed"]);
    expect(await states("ZZ02")).toEqual(["armed"]);
    expect(mailed).toEqual([]);
  });

  it("filled by the book, a new list and a muted user clear without any mail", async () => {
    await runPickAlertPoll(deps(T1045));
    await buy(3);
    await seedPick("ZZ09", 1, "2026-11-04"); // a new 18:10 list replaces the old one
    mailed = [];
    await runPickAlertPoll(deps(new Date("2026-11-04T23:45:00.000Z"))); // next session 10:45
    expect(await states("ZZ03")).toEqual(["armed", "cleared:filled"]);
    expect(mailed.flat().filter((t) => t.state === "cleared")).toEqual([]);
  });

  it("left_list at the first tick after a new list; muted when the user turns alerts off", async () => {
    await runPickAlertPoll(deps(T1045));
    await seedPick("ZZ09", 1, "2026-11-04");
    await runPickAlertPoll(deps(new Date("2026-11-04T23:45:00.000Z")));
    expect(await states("ZZ03")).toEqual(["armed", "cleared:left_list"]);
    expect(await states("ZZ09")).toEqual(["armed"]);
    await runPickAlertPoll(deps(new Date("2026-11-05T23:45:00.000Z"), []));
    expect(await states("ZZ09")).toEqual(["armed", "cleared:muted"]);
  });

  it("expires after pick_alert_max_sessions", async () => {
    await runPickAlertPoll(deps(T1045));
    for (const iso of [
      "2026-11-04T23:45:00.000Z",
      "2026-11-05T23:45:00.000Z",
      "2026-11-06T23:45:00.000Z",
      "2026-11-08T23:45:00.000Z",
    ]) {
      await runPickAlertPoll(deps(new Date(iso)));
    }
    expect(await states("ZZ03")).toEqual(["armed", "cleared:expired"]);
  });

  it("pick_alert is append-only", async () => {
    await runPickAlertPoll(deps(T1045));
    await expect(db.execute("UPDATE pick_alert SET code = 'X'")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM pick_alert")).rejects.toThrow(/append-only/);
  });
});

describe("books are never touched (ARN-111)", () => {
  it("a tick writes no order, fill, ledger or lesson row", async () => {
    await runPickAlertPoll(deps(T1045));
    for (const t of ["arena_order", "fill", "cash_ledger", "trade", "lesson", "cortex_decision"]) {
      expect(await scalar(`SELECT COUNT(*) AS n FROM ${t}`), t).toBe(0);
    }
  });
});

describe("POST /api/internal/pick-alerts", () => {
  const SECRET = "7".repeat(64);
  const NOW_S = T1045.getTime() / 1000;
  let n = 0;
  const store = (): NonceStore => {
    const seen = new Set<string>();
    return {
      claim: async (x) => {
        if (seen.has(x)) return false;
        seen.add(x);
        return true;
      },
    };
  };
  const handler = () =>
    createPickAlertsHandler({
      env: { WORKER_HMAC_SECRET: SECRET, PRAXIS_ENV: "staging" },
      store: store(),
      nowSec: () => NOW_S,
      today: () => SESSION,
      db: () => db,
      fetch: fetchStub,
      sleep: async () => {},
      recipients: async () => ["1"],
      mailer,
    });
  const req = (b: object, signed = true) => {
    const raw = JSON.stringify(b);
    n += 1;
    return new Request("https://praxis-host.vercel.app/api/internal/pick-alerts", {
      method: "POST",
      body: raw,
      headers: signed
        ? (sign(SECRET, raw, NOW_S, n.toString(16).padStart(32, "0")) as Record<string, string>)
        : {},
    });
  };
  const body = (over: Record<string, unknown> = {}) => ({
    purpose: "pick-alerts",
    env: "staging",
    d: SESSION,
    slot: "quote-poll",
    ...over,
  });

  it("refuses unsigned and wrong-purpose requests", async () => {
    const h = handler();
    expect((await h(req(body(), false))).status).toBe(401);
    expect((await h(req(body({ purpose: "intraday-scan" })))).status).toBe(400);
  });

  it("a signed call runs the tick; the same slot again is already_done", async () => {
    const h = handler();
    const r = await h(req(body()));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", armed: 3, hits: 1, cleared: 1 });
    const r2 = await h(req(body()));
    expect(await r2.json()).toEqual({ status: "already_done", reason: "already_done" });
  });

  it("a signed call with the source not accepted is a 200 skip and writes nothing", async () => {
    await db.execute(
      "UPDATE source_register SET status = 'pending' WHERE source = 'yahoo_delayed'",
    );
    const r = await handler()(req(body()));
    expect(await r.json()).toEqual({ status: "skipped", reason: "source_not_accepted" });
    expect(await scalar("SELECT COUNT(*) AS n FROM pick_alert")).toBe(0);
  });
});

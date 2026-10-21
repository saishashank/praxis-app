// @vitest-environment node
// M5 T8 pre-open re-check (ARN-020a, AT-18 part B, DAT-127; docs/M5_design.md 4.5; D-103).
// Cancellation reasons and their order, exits and sleeve orders untouched, a missing or failed
// re-check -> P1 alert and `not_rechecked` fills, the ASX-off proxy, idempotent reruns, the
// data-only no-op, replay parity with the live path, and the DST-safe 09:55 evidence bound.
// Synthetic ZZ data on a real migrated libSQL file (the closeBooks harness).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import {
  markNotRechecked,
  PREOPEN_AT,
  preopenDecision,
  runPreopen,
  type PreopenEvidence,
  type PreopenOrder,
} from "@/lib/arena/preopen";
import { replaySessions } from "@/lib/arena/replay";
import { defaultAgentParams } from "@/lib/agents/params";
import { itemFromAnnouncement } from "@/lib/agents/breakerEval";
import { localToUtc } from "@/lib/data/calendar";
import { cleanupTempDbs } from "../db/helpers";
import {
  CODES,
  dumpTables,
  makeStrategy,
  MARKET,
  NOW,
  paramOverridesFor,
  setMode,
  setupReplay,
  type FullSetup,
} from "./replayHarness";

afterEach(cleanupTempDbs);

const BASE = { startD: "2030-01-07", sessions: 30, seed: 3 };
const TZ = "Australia/Sydney";
const at = (d: string, hm: string): string => localToUtc(d, hm, TZ).toISOString();
const cell = async (db: Client, sql: string, args: unknown[] = []) =>
  (await db.execute({ sql, args: args as never })).rows;
const one = async (db: Client, sql: string, args: unknown[] = []) => (await cell(db, sql, args))[0];

type Setup = FullSetup & { prior: string; d: string; cohort: string };

async function prep(): Promise<Setup> {
  const s = await setupReplay({ ...BASE, keep: ["E01"] });
  await setMode(s.db, "full");
  return {
    ...s,
    prior: s.ds.dates[1],
    d: s.ds.dates[2],
    cohort: s.cohortIds.find((id) => id.startsWith("E01@")) as string,
  };
}

async function order(
  s: Setup,
  o: {
    id: string;
    code?: string;
    kind?: "entry" | "exit_cs" | "sleeve_open";
    tier?: "U1" | "U2";
    card?: string | null;
  },
): Promise<void> {
  const kind = o.kind ?? "entry";
  await s.db.execute({
    sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier, card_id)
          VALUES (?, ?, ?, ?, ?, ?, 30, 500000, ?, ?)`,
    args: [
      o.id,
      s.cohort,
      s.prior,
      o.code ?? "ZZA",
      kind === "entry" || kind === "sleeve_open" ? "buy" : "sell",
      kind,
      o.tier ?? "U1",
      o.card ?? null,
    ],
  });
}

async function card(s: Setup, id: string, code: string, breakers: unknown[]): Promise<void> {
  const decidedAt = at(s.prior, "18:10");
  await s.db.execute({
    sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score,
            rules_json, evidence_json, classes, group_key, partial, schema_version, agent_version,
            inputs_ref, decided_at)
          VALUES (?, 'AU', ?, 'F1', 'rv1', 'F1', ?, 'RISK-ON', '0.9', '[]', '{}', NULL, NULL, 0, 1, 'a1', 'r1', ?)`,
    args: [`sig-${id}`, s.prior, code, decidedAt],
  });
  await s.db.execute({
    sql: `INSERT INTO decision_card (id, signal_id, execution_id, cohort_id, taken, not_taken_reason,
            order_id, card_json, card_sha, schema_version, decided_at)
          VALUES (?, ?, 'E01', NULL, 0, 'rank', NULL, ?, ?, 1, ?)`,
    args: [
      id,
      `sig-${id}`,
      JSON.stringify({ d: s.prior, thesis_breakers: breakers }),
      "a".repeat(64),
      decidedAt,
    ],
  });
}

async function announce(
  s: Setup,
  a: {
    id: string;
    code?: string;
    type?: string | null;
    title: string;
    publishedAt: string;
    priceSensitive?: boolean;
  },
): Promise<void> {
  await s.db.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
          VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, NULL, 'asx_announcements')`,
    args: [
      a.code ?? "ZZA",
      a.id,
      a.publishedAt,
      a.publishedAt,
      a.type ?? null,
      a.priceSensitive === true ? 1 : 0,
      a.title,
    ],
  });
}

const fresh = (s: Setup): string => at(s.d, "09:30"); // after the decision, before 09:55
const state = async (s: Setup, id: string) =>
  one(s.db, "SELECT status, reject_reason FROM arena_order WHERE id = ?", [id]);
const result = async (s: Setup, id: string) =>
  one(s.db, "SELECT outcome, reason, card_id FROM preopen_result WHERE order_id = ?", [id]);
const pre = (s: Setup, attempt: 1 | 2 = 1, db: Client = s.db) =>
  runPreopen(db, { market: MARKET, d: s.d, attempt, now: NOW });

describe("cancellation reasons (ARN-020a)", () => {
  it("a clean order passes, stays pending and later fills without a not_rechecked flag", async () => {
    const s = await prep();
    await order(s, { id: "O1" });
    const r = await pre(s);
    expect(r).toMatchObject({ status: "ok", attempt: 1, checked: 1, cancelled: 0 });
    expect(await state(s, "O1")).toMatchObject({ status: "pending" });
    expect(await result(s, "O1")).toMatchObject({ outcome: "pass", reason: null });
    await closeBooksDay(s.db, { market: MARKET, d: s.d, replay: true, now: NOW });
    expect((await state(s, "O1"))?.status).toBe("filled");
    expect((await result(s, "O1"))?.outcome).toBe("pass");
    expect(await cell(s.db, "SELECT 1 FROM alert")).toHaveLength(0);
  });

  it("a halt since the decision cancels with preopen:halt; an item the decision already knew does not", async () => {
    const s = await prep();
    await order(s, { id: "O1", code: "ZZA" });
    await order(s, { id: "O2", code: "ZZB" });
    await announce(s, {
      id: "h1",
      code: "ZZA",
      type: "Trading Halt",
      title: "Trading halt",
      publishedAt: fresh(s),
    });
    await announce(s, {
      id: "h2",
      code: "ZZB",
      type: "Trading Halt",
      title: "Trading halt",
      publishedAt: at(s.prior, "10:00"), // before the 18:10 cut-off: known to the decision
    });
    const r = await pre(s);
    expect(r).toMatchObject({ status: "ok", checked: 2, cancelled: 1, reasons: { halt: 1 } });
    expect(await state(s, "O1")).toMatchObject({
      status: "cancelled",
      reject_reason: "preopen:halt",
    });
    expect(await result(s, "O1")).toMatchObject({ outcome: "cancel", reason: "halt" });
    expect((await state(s, "O2"))?.status).toBe("pending");
    expect((await result(s, "O2"))?.outcome).toBe("pass");
    // an item published after 09:55 is not evidence yet
    expect((await one(s.db, "SELECT cancelled FROM preopen_run"))?.cancelled).toBe(1n);
  });

  it("ARN-011 filters apply to U2/U3 only; U1 passes the same items", async () => {
    const s = await prep();
    await order(s, { id: "Q2", code: "ZZA", tier: "U2" });
    await order(s, { id: "P2", code: "ZZB", tier: "U2" });
    await order(s, { id: "Q1", code: "ZZC", tier: "U1" });
    await announce(s, {
      id: "q",
      code: "ZZA",
      type: "Price Query",
      title: "Price query",
      publishedAt: fresh(s),
    });
    await announce(s, {
      id: "p",
      code: "ZZB",
      title: "Placement to institutions",
      publishedAt: fresh(s),
    });
    await announce(s, {
      id: "q1",
      code: "ZZC",
      type: "Price Query",
      title: "Price query",
      publishedAt: fresh(s),
    });
    await pre(s);
    expect(await result(s, "Q2")).toMatchObject({ outcome: "cancel", reason: "filter:asx_query" });
    expect(await result(s, "P2")).toMatchObject({ outcome: "cancel", reason: "filter:placement" });
    expect(await result(s, "Q1")).toMatchObject({ outcome: "pass" });
    expect((await state(s, "Q2"))?.reject_reason).toBe("preopen:filter:asx_query");
  });

  it("a quality flag raised after the decision blocks the entry (filter:quality)", async () => {
    const s = await prep();
    await order(s, { id: "O1", code: "ZZA" });
    await order(s, { id: "O2", code: "ZZB" });
    await s.db.execute({
      sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at, blocks_entries)
            VALUES ('AU', 'ZZA', ?, 'DQ-1', 'high', ?, 1)`,
      args: [s.prior, at(s.prior, "19:40")],
    });
    await pre(s);
    expect(await result(s, "O1")).toMatchObject({ outcome: "cancel", reason: "filter:quality" });
    expect((await result(s, "O2"))?.outcome).toBe("pass");
  });

  it("a red event breaker of the card cancels with tb:<id>, logs a preopen row and a P2 alert", async () => {
    const s = await prep();
    await card(s, "K1", "ZZA", [{ id: "TB-NEG", check: "negative_price_sensitive_event" }]);
    await order(s, { id: "O1", code: "ZZA", card: "K1" });
    await announce(s, {
      id: "n1",
      code: "ZZA",
      title: "Convertible notes issued",
      publishedAt: fresh(s),
      priceSensitive: true,
    });
    await pre(s);
    expect(await result(s, "O1")).toMatchObject({
      outcome: "cancel",
      reason: "tb:TB-NEG",
      card_id: "K1",
    });
    expect(
      await one(s.db, "SELECT status, phase, subject_kind FROM thesis_breaker_eval"),
    ).toMatchObject({
      status: "red",
      phase: "preopen",
      subject_kind: "order",
    });
    expect(
      await one(s.db, "SELECT tier, kind FROM alert WHERE alert_key = ?", [`tb:O1:TB-NEG:${s.d}`]),
    ).toMatchObject({ tier: "P2", kind: "thesis_breaker" });
  });

  it("the first failing check wins: halt before quality before filters before breakers", () => {
    const params = defaultAgentParams();
    const o: PreopenOrder = {
      id: "O",
      code: "ZZA",
      tier: "U2",
      cardId: null,
      breakers: [],
    };
    const mk = (type: string, title: string) =>
      itemFromAnnouncement({ ref: `s|${title}`, type, title, priceSensitive: true });
    const ev = (over: Partial<PreopenEvidence>): PreopenEvidence => ({
      items: [],
      qualityBlocked: false,
      asxOn: true,
      lastSession: { hasBar: true, volume: 10 },
      ...over,
    });
    const all = ev({
      items: [mk("Price Query", "q"), mk("Trading Halt", "h"), mk("", "Placement")],
      qualityBlocked: true,
      asxOn: false,
      lastSession: { hasBar: false, volume: null },
    });
    expect(preopenDecision(o, all, params, "2030-01-09").reason).toBe("halt");
    expect(
      preopenDecision(
        o,
        { ...all, items: all.items.slice(0, 1).concat(all.items.slice(2)) },
        params,
        "d",
      ).reason,
    ).toBe("possible_halt_feed_off");
    expect(
      preopenDecision(o, { ...all, asxOn: true, items: all.items.slice(0, 1) }, params, "d").reason,
    ).toBe("filter:quality");
    expect(preopenDecision(o, ev({ items: [mk("Price Query", "q")] }), params, "d").reason).toBe(
      "filter:asx_query",
    );
    expect(preopenDecision(o, ev({}), params, "d")).toMatchObject({
      outcome: "pass",
      reason: null,
    });
  });
});

describe("exits and other orders are untouched", () => {
  it("a pending exit_cs and sleeve_open stay pending with no result row, whatever the news", async () => {
    const s = await prep();
    await order(s, { id: "X1", code: "ZZA", kind: "exit_cs" });
    await order(s, { id: "S1", code: "ZZB", kind: "sleeve_open" });
    await order(s, { id: "O1", code: "ZZC" });
    for (const code of ["ZZA", "ZZB", "ZZC"]) {
      await announce(s, {
        id: `h-${code}`,
        code,
        type: "Trading Halt",
        title: "Trading halt",
        publishedAt: fresh(s),
      });
    }
    const r = await pre(s);
    expect(r).toMatchObject({ status: "ok", checked: 1, cancelled: 1 });
    expect((await state(s, "X1"))?.status).toBe("pending");
    expect((await state(s, "S1"))?.status).toBe("pending");
    expect(await result(s, "X1")).toBeUndefined();
    expect(await result(s, "S1")).toBeUndefined();
    expect((await state(s, "O1"))?.status).toBe("cancelled");
  });
});

describe("a failed or missing re-check (P1 and not_rechecked)", () => {
  it("no run by the fill: the entry fills flagged not_rechecked, the run is not_run and one P1 is raised", async () => {
    const s = await prep();
    await order(s, { id: "O1" });
    await closeBooksDay(s.db, { market: MARKET, d: s.d, replay: true, now: NOW });
    expect((await state(s, "O1"))?.status).toBe("filled");
    expect(await result(s, "O1")).toMatchObject({ outcome: "not_rechecked", reason: null });
    expect(await one(s.db, "SELECT status, attempt FROM preopen_run")).toMatchObject({
      status: "not_run",
      attempt: 1n,
    });
    const alerts = await cell(s.db, "SELECT alert_key, tier, kind FROM alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alert_key: `preopen:AU:${s.d}`,
      tier: "P1",
      kind: "preopen_failure",
    });
    // a second mark writes nothing new
    expect(
      await markNotRechecked(s.db, {
        market: MARKET,
        d: s.d,
        orderId: "O1",
        cardId: null,
        at: NOW(),
      }),
    ).toBe(false);
  });

  it("two failed attempts leave status error (attempt 2), raise the P1 and the fill is not_rechecked", async () => {
    const s = await prep();
    await order(s, { id: "O1" });
    const broken = new Proxy(s.db, {
      get(t, p) {
        if (p === "execute") {
          return (q: { sql?: string } | string) => {
            if (String(typeof q === "string" ? q : q.sql).includes("FROM announcement")) {
              throw new Error("boom");
            }
            return t.execute(q as never);
          };
        }
        const v = Reflect.get(t, p) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as Client;
    expect(await pre(s, 1, broken)).toEqual({ status: "error", attempt: 1 });
    expect(await one(s.db, "SELECT status, attempt FROM preopen_run")).toMatchObject({
      status: "error",
      attempt: 1n,
    });
    expect(await cell(s.db, "SELECT 1 FROM alert")).toHaveLength(0); // retry still pending
    expect(await pre(s, 2, broken)).toEqual({ status: "error", attempt: 2 });
    expect(await one(s.db, "SELECT status, attempt FROM preopen_run")).toMatchObject({
      status: "error",
      attempt: 2n,
    });
    expect(
      await one(s.db, "SELECT tier, kind FROM alert WHERE alert_key = ?", [`preopen:AU:${s.d}`]),
    ).toMatchObject({
      tier: "P1",
      kind: "preopen_failure",
    });
    // final: a third call changes nothing
    expect(await pre(s, 2)).toMatchObject({ status: "final" });
    await closeBooksDay(s.db, { market: MARKET, d: s.d, replay: true, now: NOW });
    expect((await result(s, "O1"))?.outcome).toBe("not_rechecked");
    expect(await cell(s.db, "SELECT 1 FROM alert")).toHaveLength(1);
  });

  it("attempt 1 fails, the 09:58 retry succeeds: run ok on attempt 2, orders re-checked, no P1", async () => {
    const s = await prep();
    await order(s, { id: "O1" });
    await s.db.execute({
      sql: `INSERT INTO preopen_run (market, d, attempt, started_at, finished_at, status) VALUES ('AU', ?, 1, ?, ?, 'error')`,
      args: [s.d, NOW(), NOW()],
    });
    expect(await pre(s, 2)).toMatchObject({ status: "ok", attempt: 2, checked: 1 });
    expect(await one(s.db, "SELECT status, attempt FROM preopen_run")).toMatchObject({
      status: "ok",
      attempt: 2n,
    });
    expect((await result(s, "O1"))?.outcome).toBe("pass");
    expect(await cell(s.db, "SELECT 1 FROM alert")).toHaveLength(0);
  });
});

/** Test fixtures only: the stored-bar immutability triggers are dropped on this throw-away database. */
async function openBars(db: Client): Promise<void> {
  await db.execute("DROP TRIGGER price_bar_no_update");
  await db.execute("DROP TRIGGER price_bar_prune_only");
}

describe("DAT-127 proxy with the ASX feed off", () => {
  it("zero volume or no bar in the last session cancels (possible_halt_feed_off) with a P1 proxy alert", async () => {
    const s = await prep();
    await openBars(s.db);
    await order(s, { id: "O1", code: "ZZA" });
    await order(s, { id: "O2", code: "ZZB" });
    await order(s, { id: "O3", code: "ZZC" });
    await s.db.execute({
      sql: "UPDATE price_bar SET volume = 0 WHERE market = 'AU' AND code = 'ZZA' AND d = ?",
      args: [s.prior],
    });
    await s.db.execute({
      sql: "DELETE FROM price_bar WHERE market = 'AU' AND code = 'ZZB' AND d = ?",
      args: [s.prior],
    });
    await pre(s);
    expect(await result(s, "O1")).toMatchObject({
      outcome: "cancel",
      reason: "possible_halt_feed_off",
    });
    expect(await result(s, "O2")).toMatchObject({
      outcome: "cancel",
      reason: "possible_halt_feed_off",
    });
    expect((await result(s, "O3"))?.outcome).toBe("pass");
    expect(
      await one(s.db, "SELECT tier, kind FROM alert WHERE alert_key = ?", [`proxy:AU:ZZA:${s.d}`]),
    ).toMatchObject({ tier: "P1", kind: "halt_proxy" });
  });

  it("with the feed ON the proxy does not run (halts come from announcements)", async () => {
    const s = await prep();
    await openBars(s.db);
    await order(s, { id: "O1", code: "ZZA" });
    await s.db.execute({
      sql: "UPDATE price_bar SET volume = 0 WHERE market = 'AU' AND code = 'ZZA' AND d = ?",
      args: [s.prior],
    });
    await s.db.execute({
      sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('asx_enabled', '\"1\"', 'x')",
    });
    await pre(s);
    expect((await result(s, "O1"))?.outcome).toBe("pass");
    expect(await cell(s.db, "SELECT 1 FROM alert")).toHaveLength(0);
  });
});

describe("guards and idempotency", () => {
  it("data-only market, off market and a non-trading day: skipped, nothing written", async () => {
    const s = await prep();
    await order(s, { id: "O1" });
    await announce(s, {
      id: "h",
      type: "Trading Halt",
      title: "Trading halt",
      publishedAt: fresh(s),
    });
    const before = await dumpTables(s.db);
    await setMode(s.db, "data_only");
    expect(await pre(s)).toEqual({ status: "skipped", reason: "data_only_guard" });
    await setMode(s.db, "off");
    expect(await pre(s)).toEqual({ status: "skipped", reason: "market_off" });
    await setMode(s.db, "full");
    expect(await runPreopen(s.db, { market: MARKET, d: "2030-01-12", now: NOW })).toEqual({
      status: "skipped",
      reason: "non_trading_day",
    });
    expect(await cell(s.db, "SELECT 1 FROM preopen_run")).toHaveLength(0);
    expect(await cell(s.db, "SELECT 1 FROM preopen_result")).toHaveLength(0);
    expect((await state(s, "O1"))?.status).toBe("pending");
    expect(await dumpTables(s.db)).toEqual(before);
  });

  it("a rerun is a no-op; a crash between orders is resumed without duplicates", async () => {
    const s = await prep();
    await order(s, { id: "O1", code: "ZZA" });
    await order(s, { id: "O2", code: "ZZB" });
    await announce(s, {
      id: "h",
      code: "ZZA",
      type: "Trading Halt",
      title: "Trading halt",
      publishedAt: fresh(s),
    });
    // O1 was already handled by a crashed first call (result row exists, no run row)
    await s.db.batch(
      [
        {
          sql: "UPDATE arena_order SET status = 'cancelled', reject_reason = 'preopen:halt' WHERE id = 'O1'",
          args: [],
        },
        {
          sql: "INSERT INTO preopen_result (order_id, market, d, outcome, reason, card_id) VALUES ('O1','AU',?,'cancel','halt',NULL)",
          args: [s.d],
        },
      ],
      "write",
    );
    const first = await pre(s);
    expect(first).toMatchObject({ status: "ok", checked: 2, cancelled: 1 });
    const dump = await dumpTables(s.db);
    const results = await cell(s.db, "SELECT * FROM preopen_result ORDER BY order_id");
    expect(await pre(s)).toMatchObject({ status: "already_done", checked: 2, cancelled: 1 });
    expect(await cell(s.db, "SELECT * FROM preopen_result ORDER BY order_id")).toEqual(results);
    expect(await dumpTables(s.db)).toEqual(dump);
    expect(await cell(s.db, "SELECT 1 FROM preopen_run")).toHaveLength(1);
  });
});

describe("replay parity (ARN-020a, design 4.5)", () => {
  it("replaySessions with the re-check gives the same orders and results as the live sequence", async () => {
    const make = async (): Promise<FullSetup> => {
      const s = await setupReplay({
        startD: "2030-01-07",
        sessions: 40,
        seed: 5,
        keep: ["E01", "E02"],
      });
      // a halt on one code at every 3rd session, 09:30 local: some pending orders get cancelled
      let i = 0;
      for (const d of s.ds.dates.slice(2, 40)) {
        i += 1;
        if (i % 3 !== 0) continue;
        await s.db.execute({
          sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
                VALUES ('AU', ?, ?, ?, ?, 'Trading Halt', 1, 'Trading halt', NULL, 'asx_announcements')`,
          args: [CODES[i % CODES.length], `h${i}`, at(d, "09:30"), at(d, "09:30")],
        });
      }
      return s;
    };
    const a = await make();
    const resultsA = await replaySessions(a.db, {
      market: MARKET,
      from: a.ds.dates[0],
      to: a.ds.dates[39],
      now: NOW,
      afterClose: makeStrategy(a.db, a.ds),
      restartParams: paramOverridesFor,
      preopen: true,
    });
    expect(new Set(resultsA.map((r) => r.status))).toEqual(new Set(["success"]));

    const b = await make();
    await setMode(b.db, "full"); // the live path: market full, no replay flag on the re-check
    const hook = makeStrategy(b.db, b.ds);
    for (const d of b.ds.dates.slice(0, 40).filter((x) => x >= b.ds.dates[0])) {
      const pr = await runPreopen(b.db, { market: MARKET, d, now: NOW });
      expect(["ok", "skipped"]).toContain(pr.status);
      const r = await closeBooksDay(b.db, {
        market: MARKET,
        d,
        replay: true,
        now: NOW,
        restartParams: paramOverridesFor,
      });
      if (r.status === "failed") throw new Error("close failed");
      await hook(d, r);
    }
    const dumpOf = async (db: Client) => ({
      results: await cell(db, "SELECT * FROM preopen_result ORDER BY order_id"),
      runs: await cell(
        db,
        "SELECT market, d, attempt, status, checked, cancelled FROM preopen_run ORDER BY d",
      ),
      orders: await cell(db, "SELECT id, status, reject_reason FROM arena_order ORDER BY id"),
      fills: await dumpTables(db),
    });
    const da = await dumpOf(a.db);
    const db_ = await dumpOf(b.db);
    expect(da.results.filter((r) => r.outcome === "cancel").length).toBeGreaterThan(0);
    expect(da.results.every((r) => r.outcome !== "not_rechecked")).toBe(true);
    expect(db_).toEqual(da);
  }, 120_000);
});

describe("DST: the 09:55 evidence bound", () => {
  it("is 09:55 Sydney local on both sides of both changes", () => {
    expect(PREOPEN_AT).toBe("09:55");
    expect(at("2026-10-02", PREOPEN_AT)).toBe("2026-10-01T23:55:00.000Z"); // AEST +10
    expect(at("2026-10-05", PREOPEN_AT)).toBe("2026-10-04T22:55:00.000Z"); // AEDT +11
    expect(at("2027-04-02", PREOPEN_AT)).toBe("2027-04-01T22:55:00.000Z"); // AEDT +11
    expect(at("2027-04-06", PREOPEN_AT)).toBe("2027-04-05T23:55:00.000Z"); // AEST +10
  });

  it("an item published between 09:55 and the open is not evidence; one just before is", async () => {
    const s = await prep();
    await order(s, { id: "O1", code: "ZZA" });
    await order(s, { id: "O2", code: "ZZB" });
    await announce(s, {
      id: "late",
      code: "ZZA",
      type: "Trading Halt",
      title: "Trading halt",
      publishedAt: at(s.d, "09:56"),
    });
    await announce(s, {
      id: "in",
      code: "ZZB",
      type: "Trading Halt",
      title: "Trading halt",
      publishedAt: at(s.d, "09:54"),
    });
    await pre(s);
    expect((await result(s, "O1"))?.outcome).toBe("pass");
    expect(await result(s, "O2")).toMatchObject({ outcome: "cancel", reason: "halt" });
  });
});

// @vitest-environment node
// M5 T7 (AGT-111, D-094, D-096 #39, D-097; D-102 draft): thesis-breakers in batch 2b and the Sentinel's
// intraday path, on the golden world (real migrations, 2a + 2b end to end). A held ZZUP (F1) gets a
// price-sensitive trading halt on session 302: the night turns TB-NEG and TB-HALT red, queues an
// `exit_cs` with rule `TB-NEG` for the next open, even for a paused or killed cohort; the intraday
// path logs and alerts but never touches an order, and `seq` keeps two evaluations of one day.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signalsDay } from "@/lib/agents/batch2b";
import type { BreakerAlert } from "@/lib/agents/breakerEval";
import { evaluateSubject, loadBreakerSubjects, writeEvaluation } from "@/lib/agents/breakerNightly";
import { ASX_SOURCE } from "@/lib/data/asxToken";
import { evaluateIntraday } from "@/lib/sentinel/breakers";
import { ingestFeed } from "@/lib/sentinel/ingest";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  dump,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden } from "./batch2bScenario";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });

const params = testParams();
const d = (i: number): string => DATES[i]!;
const KEEP = ["E01", "E07"];
type Ctl = readonly [scope: string, key: string, state: string];
type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

async function announce(db: Client, annId: string, publishedAt: string, title: string) {
  await db.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
          VALUES (?, 'ZZUP', ?, ?, ?, 'Trading Halt', 1, ?, NULL, ?)`,
    args: [MARKET, annId, publishedAt, publishedAt, title, ASX_SOURCE],
  });
}

type World = { db: Client; alerts: BreakerAlert[] };

/** Nights 295..301 (E01 holds ZZUP from 301), then the controls, then nights 302..to. */
async function world(
  o: { halt?: boolean; controls?: readonly Ctl[]; to?: number } = {},
): Promise<World> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  if (o.halt === true) await announce(db, "HALT-1", `${d(302)}T03:00:00.000Z`, "Trading Halt");
  await startCohortsAt(db, 295, KEEP);
  const alerts: BreakerAlert[] = [];
  const sink = {
    record: async (a: BreakerAlert) => {
      alerts.push(a);
    },
  };
  await runNights(db, params, 295, 301, undefined, { breakerSink: sink });
  for (const [scope, key, state] of o.controls ?? []) {
    await db.execute({
      sql: `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason)
            VALUES (?, ?, ?, '2031-01-01T00:00:00.000Z', 'owner', 'test')`,
      args: [scope, key, state],
    });
  }
  await runNights(db, params, 302, o.to ?? 304, undefined, { breakerSink: sink });
  return { db, alerts };
}

const zzupExit = (db: Client): Promise<Row[]> =>
  rows(
    db,
    `SELECT id, decided_d, fill_d, status, kind, card_id, stop_spec FROM arena_order
     WHERE code = 'ZZUP' AND kind = 'exit_cs' ORDER BY id`,
  );

let green: World;
let red: World;
afterAll(cleanupTempDbs);
beforeAll(async () => {
  green = await world();
  red = await world({ halt: true });
});

describe("nightly evaluation (batch 2b)", () => {
  it("logs every breaker of every held position every night; quiet nights stay green and queue nothing", async () => {
    const evals = await rows(
      green.db,
      `SELECT subject_id, breaker_id, d, phase, seq, subject_kind, status, rule_version
       FROM thesis_breaker_eval ORDER BY d, subject_id, breaker_id`,
    );
    expect(evals.length).toBeGreaterThan(0);
    expect(evals.every((e) => e.phase === "nightly" && Number(e.seq) === 1)).toBe(true);
    expect(evals.every((e) => e.status === "green" && e.rule_version === "tb-v1")).toBe(true);
    const zzup = evals.filter((e) => String(e.subject_id).includes("ZZUP"));
    // F1 card: NEG, HALT, RAISE, REGIME, SMA on each night the position is held (301..304)
    expect(new Set(zzup.map((e) => e.breaker_id))).toEqual(
      new Set(["TB-NEG", "TB-HALT", "TB-RAISE", "TB-REGIME", "TB-SMA"]),
    );
    expect(new Set(zzup.map((e) => e.d))).toEqual(new Set([d(301), d(302), d(303), d(304)]));
    expect(await zzupExit(green.db)).toEqual([]);
    const tb = await rows(green.db, "SELECT id FROM arena_order WHERE stop_spec LIKE '%TB-%'");
    expect(tb).toEqual([]);
    expect(green.alerts).toEqual([]);
  });

  it("amber stays as stored: the SMA breaker's value and thresholds are logged", async () => {
    const [sma] = await rows(
      green.db,
      `SELECT value_text, trigger_text, amber_text FROM thesis_breaker_eval
       WHERE breaker_id = 'TB-SMA' AND subject_id LIKE '%ZZUP' AND d = ?`,
      [d(302)],
    );
    expect(String(sma!.trigger_text)).toMatch(/^close_vs_sma < \d+$/);
    expect(Number(sma!.amber_text)).toBeGreaterThan(0);
  });

  it("a red breaker on a held position queues an exit_cs for the next open, rule TB-<id>", async () => {
    const evals = await rows(
      red.db,
      `SELECT breaker_id, status, trigger_ref FROM thesis_breaker_eval
       WHERE subject_id LIKE '%ZZUP' AND d = ? ORDER BY breaker_id`,
      [d(302)],
    );
    expect(evals.map((e) => `${e.breaker_id}:${e.status}`)).toEqual([
      "TB-HALT:red",
      "TB-NEG:red",
      "TB-RAISE:green",
      "TB-REGIME:green",
      "TB-SMA:green",
    ]);
    expect(evals.find((e) => e.breaker_id === "TB-HALT")!.trigger_ref).toBe(`${ASX_SOURCE}|HALT-1`);
    const exits = await zzupExit(red.db);
    expect(exits).toHaveLength(1);
    const x = exits[0]!;
    expect(x.decided_d).toBe(d(302));
    expect(x.fill_d).toBe(d(303)); // the next open
    expect(x.status).toBe("filled");
    expect(x.card_id).toMatch(/^card:/);
    expect(JSON.parse(String(x.stop_spec)).exit_rule).toBe("TB-NEG"); // first red in card order
    const [trade] = await rows(red.db, "SELECT exit_type FROM trade WHERE code = 'ZZUP'");
    expect(trade!.exit_type).toBe("CS");
    // the run counted it
    const [run] = await rows(
      red.db,
      "SELECT details_json FROM run_record WHERE concurrency_key = ?",
      [`arena-2b:${MARKET}:${d(302)}`],
    );
    const details = JSON.parse(String(run!.details_json)) as Record<string, number>;
    expect(details.breakerRed).toBe(1);
    expect(details.breakerExits).toBe(1);
    expect(details.breakerEvals).toBeGreaterThan(0);
  });

  it("emits the alert through the sink with its effect; the default recorder writes the alert row", async () => {
    const reds = red.alerts.filter((a) => a.d === d(302));
    expect(reds.map((a) => a.breakerId).sort()).toEqual(["TB-HALT", "TB-NEG"]);
    for (const a of reds) {
      expect(a).toMatchObject({
        phase: "nightly",
        subjectKind: "trade",
        executionId: "E01",
        effect: "exit_queued",
        status: "red",
        code: "ZZUP",
      });
      expect(a.key).toBe(`tb:${a.subjectId}:${a.breakerId}:${d(302)}`);
    }
    // default recorder: re-run the same alerts into the alert table
    const { createAlertRowSink } = await import("@/lib/agents/breakerEval");
    const sink = createAlertRowSink(red.db);
    for (const a of reds) await sink.record(a);
    for (const a of reds) await sink.record(a); // idempotent on the key
    const stored = await rows(
      red.db,
      "SELECT * FROM alert WHERE kind = 'thesis_breaker' ORDER BY alert_key",
    );
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      tier: "P0",
      code: "ZZUP",
      execution_id: "E01",
      market: MARKET,
    });
    expect(JSON.parse(String(stored[0]!.facts_json))).toMatchObject({
      effect: "exit_queued",
      phase: "nightly",
      status: "red",
    });
  });

  it("is deterministic: the same world gives the same rows", async () => {
    const again = await world({ halt: true });
    const q = `SELECT * FROM thesis_breaker_eval ORDER BY 1, 2, 3, 4, 5`;
    expect(await dump(again.db, q)).toBe(await dump(red.db, q));
    expect(await dump(again.db, "SELECT * FROM arena_order ORDER BY id")).toBe(
      await dump(red.db, "SELECT * FROM arena_order ORDER BY id"),
    );
  });

  it("is idempotent: a finished night is not run again; re-writing a night's rows adds none", async () => {
    const again = await signalsDay(red.db, {
      withLeverage: true, // D-191: the full engine, sleeve included

      market: MARKET,
      d: d(302),
      replay: true,
      now: () => NOW(),
      params,
    });
    expect(again.status).toBe("already_done");
    const before = await rows(green.db, "SELECT COUNT(*) AS n FROM thesis_breaker_eval");
    const subjects = await loadBreakerSubjects(green.db, d(302));
    expect(subjects.length).toBeGreaterThan(0);
    // evaluate the open position again from the stored inputs and write: nothing new
    const s = subjects.find((x) => x.code === "ZZUP")!;
    const { loadDayInputs } = await import("@/lib/agents/candidates");
    const { loadCalendar } = await import("@/lib/arena/closeBooks");
    const calendar = await loadCalendar(green.db, MARKET);
    const day = await loadDayInputs(green.db, {
      market: MARKET,
      d: d(302),
      calendar,
      hours: { tz: "Australia/Melbourne", open_time: "10:00", close_time: "16:00" },
      params,
      replay: true,
      heldCodes: ["ZZUP"],
      actions: [],
    });
    const ev = await evaluateSubject(
      { db: green.db, market: MARKET, d: d(302), calendar, params, day },
      s,
    );
    expect(await writeEvaluation(green.db, s, MARKET, d(302), "nightly", 1, ev)).toBe(0);
    const after = await rows(green.db, "SELECT COUNT(*) AS n FROM thesis_breaker_eval");
    expect(after).toEqual(before);
  });
});

describe("exits are never blocked by pause, kill or quality (D-094)", () => {
  it("a paused execution still exits on a red breaker", async () => {
    const w = await world({ halt: true, controls: [["execution", "E01", "paused"]] });
    const exits = await zzupExit(w.db);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ decided_d: d(302), fill_d: d(303), status: "filled" });
  });

  it("a killed family still exits on a red breaker", async () => {
    const w = await world({ halt: true, controls: [["family", "F1", "killed"]] });
    const exits = await zzupExit(w.db);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ decided_d: d(302), fill_d: d(303), status: "filled" });
  });
});

describe("intraday event breakers (Sentinel)", () => {
  it("logs and alerts, never changes an order; seq keeps two evaluations of one day", async () => {
    const w = await world({ to: 302 }); // ZZUP still held, no breaker red
    const ordersBefore = await dump(w.db, "SELECT * FROM arena_order ORDER BY id");
    const feed = (id: string, time: string): string =>
      JSON.stringify({
        data: [
          {
            id,
            code: "ZZUP",
            time,
            type: "Trading Halt",
            price_sensitive: true,
            title: "Trading Halt",
            url: "https://example.test/x.pdf",
          },
        ],
      });
    const alerts: BreakerAlert[] = [];
    const sink = {
      record: async (a: BreakerAlert) => {
        alerts.push(a);
      },
    };
    const today = d(303);
    const first = await ingestFeed({
      db: w.db,
      feed: feed("INTRA-1", `${today}T01:00:00Z`),
      sha: "1".repeat(64),
      now: `${today}T01:05:00.000Z`,
      today,
      market: MARKET,
      breakerSink: sink,
    });
    expect(first).toMatchObject({ ok: true, new: 1, assessed: 1 });
    const second = await ingestFeed({
      db: w.db,
      feed: feed("INTRA-2", `${today}T02:00:00Z`),
      sha: "2".repeat(64),
      now: `${today}T02:05:00.000Z`,
      today,
      market: MARKET,
      breakerSink: sink,
    });
    expect(second).toMatchObject({ ok: true, new: 1, assessed: 1 });

    const evals = await rows(
      w.db,
      `SELECT breaker_id, seq, status, value_text, trigger_ref FROM thesis_breaker_eval
       WHERE phase = 'intraday' ORDER BY breaker_id, seq`,
    );
    // F1: NEG, HALT, RAISE are event breakers (REGIME and SMA are nightly only), two announcements
    expect(evals.map((e) => `${e.breaker_id}#${e.seq}:${e.status}`)).toEqual([
      "TB-HALT#1:red",
      "TB-HALT#2:red",
      "TB-NEG#1:red",
      "TB-NEG#2:red",
      "TB-RAISE#1:green",
      "TB-RAISE#2:green",
    ]);
    expect(String(evals[0]!.value_text).startsWith(`${ASX_SOURCE}|`)).toBe(true);
    expect(evals[0]!.trigger_ref).not.toBeNull();
    expect(alerts.map((a) => `${a.breakerId}:${a.effect}:${a.phase}`).sort()).toEqual([
      "TB-HALT:none:intraday",
      "TB-HALT:none:intraday",
      "TB-NEG:none:intraday",
      "TB-NEG:none:intraday",
    ]);
    // the default recorder keys one alert per breaker and day: a second hit the same day is a duplicate
    expect(await dump(w.db, "SELECT * FROM arena_order ORDER BY id")).toBe(ordersBefore);
    expect(await rows(w.db, "SELECT id FROM arena_order WHERE stop_spec LIKE '%TB-%'")).toEqual([]);
  });

  it("a repeated evaluation of the same announcement writes nothing and alerts once", async () => {
    const w = await world({ to: 302 });
    const today = d(303);
    const input = {
      db: w.db,
      market: MARKET,
      today,
      now: `${today}T01:05:00.000Z`,
      params,
      announcements: [
        {
          annId: "INTRA-9",
          code: "ZZUP",
          type: "Trading Halt",
          title: "Trading Halt",
          priceSensitive: true,
          publishedAt: `${today}T01:00:00.000Z`,
        },
      ],
    };
    const a = await evaluateIntraday(input);
    const b = await evaluateIntraday(input);
    expect(a).toMatchObject({ evaluated: 1, rows: 3, red: 2 });
    expect(b).toMatchObject({ rows: 0, red: 0 });
    // default sink wrote the alert rows, once each
    const stored = await rows(
      w.db,
      "SELECT effect FROM (SELECT json_extract(facts_json, '$.effect') AS effect FROM alert WHERE kind = 'thesis_breaker')",
    );
    expect(stored).toEqual([{ effect: "none" }, { effect: "none" }]);
  });

  it("an announcement published before the card's decision was known to it: skipped", async () => {
    const w = await world({ to: 302 });
    const r = await evaluateIntraday({
      db: w.db,
      market: MARKET,
      today: d(303),
      now: `${d(303)}T01:05:00.000Z`,
      params,
      announcements: [
        {
          annId: "OLD-1",
          code: "ZZUP",
          type: "Trading Halt",
          title: "Trading Halt",
          priceSensitive: true,
          publishedAt: `${d(299)}T01:00:00.000Z`,
        },
      ],
    });
    expect(r).toEqual({ evaluated: 0, rows: 0, red: 0 });
  });
});

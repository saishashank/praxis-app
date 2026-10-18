// @vitest-environment node
// Batch 3 golden nights (M4 T15; docs/M4_design.md 4.1, 4.10, 4.11; ARN-070/071, ARN-093, ARN-101,
// VAL-102). The synthetic scenario of the batch 2b tests runs end to end through 2a, 2b and 3 against
// a local file with the real migrations. The forward ledger is compared with an independent replay
// of the same days built from the full day inputs (the T11 functions), batch 3 is run twice for
// determinism, and the data-only guard, the 2b precondition, idempotency and the report-only
// invariant re-check are checked.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  REVIEW_JOB,
  recheckInvariants,
  reviewDay,
  reviewKey,
  type ReviewResult,
} from "@/lib/agents/batch3";
import { loadDayInputs } from "@/lib/agents/candidates";
import {
  LiveWorld,
  decodeJson,
  encodeJson,
  poolFromDay,
  syncForwardLedger,
} from "@/lib/agents/forwardLedger";
import { ARENA_MASTER_SEED, loadCalendar } from "@/lib/arena/closeBooks";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { sessionsBetween } from "@/lib/data/calendar";
import { replayLedger } from "@/lib/replay/ledger";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden } from "./batch2bScenario";

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const LAST = 320;
const d = (i: number): string => DATES[i]!;
const HOURS = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const count = async (db: Client, table: string): Promise<bigint> =>
  (await rows(db, `SELECT COUNT(*) AS n FROM ${table}`))[0]!.n as bigint;

async function world(): Promise<{ db: Client; reviews: Map<string, ReviewResult> }> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, 295, KEEP);
  const reviews = new Map<string, ReviewResult>();
  await runNights(db, params, 295, LAST, async (day) => {
    reviews.set(
      day,
      await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params }),
    );
  });
  return { db, reviews };
}

/** Everything batch 3 wrote, as text. */
async function dump(db: Client): Promise<string> {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM ledger_row ORDER BY id",
    "SELECT * FROM ledger_control ORDER BY row_id, idx",
    "SELECT run_id, scope, metric, d, value_json FROM replay_stat ORDER BY run_id, scope, metric",
    "SELECT * FROM killswitch_look ORDER BY lineage_id, rule_version, criterion, look_k",
  ]) {
    parts.push(
      JSON.stringify(
        (await rows(db, sql)).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])),
        ),
      ),
    );
  }
  return parts.join("\n");
}

let db: Client;
let reviews: Map<string, ReviewResult>;
let second: Client;
let late: Client;
beforeAll(async () => {
  ({ db, reviews } = await world());
  ({ db: second } = await world());
  // batch 3 missed every night but the last: it catches the candidates of the window up
  late = await freshReplayDb();
  await buildGolden(late);
  await setMode(late, "full");
  await startCohortsAt(late, 295, KEEP);
  await runNights(late, params, 295, LAST, async (day) => {
    if (day === d(LAST)) {
      await reviewDay(late, { market: MARKET, d: day, replay: true, now: NOW, params });
    }
  });
});
afterAll(cleanupTempDbs);

describe("the nights", () => {
  it("batch 3 ran once a night after 2b, keyed arena-3:AU:<d>, and every run succeeded", async () => {
    expect(reviews.size).toBe(LAST - 295 + 1);
    for (const [, r] of reviews) expect(r.status).toBe("success");
    const runs = await rows(
      db,
      "SELECT concurrency_key, status, job FROM run_record WHERE job = ?",
      [REVIEW_JOB],
    );
    expect(runs).toHaveLength(LAST - 295 + 1);
    expect(runs.map((r) => String(r.concurrency_key))).toContain(reviewKey(MARKET, d(300)));
    expect(new Set(runs.map((r) => String(r.status)))).toEqual(new Set(["success"]));
  });

  it("the forward ledger holds the rows of the signals, opened at the next open and closed once", async () => {
    const lr = await rows(
      db,
      `SELECT lr.id, lr.entry_d, lr.exit_d, lr.exit_tag, lr.forward, s.d AS decided FROM ledger_row lr
       JOIN signal s ON s.id = lr.signal_id ORDER BY lr.id`,
    );
    expect(lr.map((r) => String(r.id))).toEqual([
      `lr:AU:F1:F1.v1:F1:ZZUP:${d(301)}`,
      `lr:AU:F4:F4.v1:F4:ZZD1:${d(301)}`,
      `lr:AU:F4:F4.v1:F4:ZZD2:${d(301)}`,
      `lr:AU:F4:F4.v1:F4:ZZD3:${d(303)}`,
      `lr:AU:F4:F4.v1:F4:ZZUP:${d(312)}`,
    ]);
    for (const r of lr) {
      expect(r.forward).toBe(1n);
      expect(String(r.entry_d) > String(r.decided)).toBe(true);
    }
  });

  it("controls of a row appear once every control path has ended; unfinished draws are deferred", async () => {
    const ctl = await rows(
      db,
      "SELECT row_id, COUNT(*) AS n FROM ledger_control GROUP BY row_id ORDER BY row_id",
    );
    expect(ctl.length).toBeGreaterThan(0);
    for (const c of ctl) expect(Number(c.n)).toBeLessThanOrEqual(params.stats.c2ControlsPerRow);
    const last = [...reviews.values()].pop()!;
    expect(last.stats.ledger!.controlsDeferred).toBeGreaterThan(0); // the F1 row's controls are still running
  });

  it("forward ledger rows and controls equal a replay of the same days from the full day inputs", async () => {
    const calendar = await loadCalendar(db, MARKET);
    const first = String((await rows(db, "SELECT MIN(d) AS d FROM signal"))[0]!.d);
    const sessions = sessionsBetween(first, d(LAST), calendar);
    const actions = await loadConfirmedActions(db, MARKET, d(LAST));
    const w = new LiveWorld({
      db,
      market: MARKET,
      d: d(LAST),
      sessions,
      params,
      actions,
      replay: true,
      hours: HOURS,
    });
    const codes = new Set<string>();
    for (const day of sessions) {
      const inputs = await loadDayInputs(db, {
        market: MARKET,
        d: day,
        calendar,
        hours: HOURS,
        params,
        replay: true,
        heldCodes: [],
        actions: await loadConfirmedActions(db, MARKET, day),
      });
      w.setInputs(day, inputs.inputs);
      w.setUniverse(day, poolFromDay(inputs));
      for (const c of inputs.inputs.codes) codes.add(c.code);
    }
    await w.load([...codes]);
    const oracle = replayLedger(w, {
      params,
      from: first,
      to: d(LAST),
      masterSeed: ARENA_MASTER_SEED,
    });
    const stored = new Map(
      (await rows(db, "SELECT * FROM ledger_row ORDER BY id")).map((r) => [String(r.id), r]),
    );
    expect(oracle.entries.length).toBe(stored.size);
    expect(stored.size).toBe(5);
    const control = new Map<string, Row[]>();
    for (const c of await rows(db, "SELECT * FROM ledger_control ORDER BY row_id, idx")) {
      control.set(String(c.row_id), [...(control.get(String(c.row_id)) ?? []), c]);
    }
    const marked = new Set(
      (await rows(db, "SELECT scope FROM replay_stat WHERE metric = 'controls_none'")).map((r) =>
        String(r.scope),
      ),
    );
    let closed = 0;
    let withControls = 0;
    for (const e of oracle.entries) {
      const s = stored.get(e.row.id)!;
      expect(s, e.row.id).toBeDefined();
      for (const k of [
        "signal_id",
        "group_key",
        "entry_d",
        "qty",
        "fill_in_micro",
        "brok_in_micro",
        "stress_in_micro",
        "timed",
      ] as const) {
        expect(String(s[k]), `${e.row.id} ${k}`).toBe(String(e.row[k]));
      }
      expect(String(s.exit_d)).toBe(String(e.row.exit_d));
      if (e.row.exit_d === null) continue;
      closed += 1;
      for (const k of [
        "exit_tag",
        "fill_out_micro",
        "brok_out_micro",
        "stress_out_micro",
        "qty_out",
        "dividend_micro",
        "gross_num",
        "gross_den",
      ] as const) {
        expect(String(s[k]), `${e.row.id} ${k}`).toBe(String(e.row[k]));
      }
      const own = control.get(e.row.id) ?? [];
      if (own.length > 0) {
        withControls += 1;
        expect(e.controls!.forcedIdx).toEqual([]);
        expect(own).toHaveLength(e.controls!.controls.length);
        e.controls!.controls.forEach((c, i) => {
          for (const k of [
            "idx",
            "code",
            "entry_d",
            "exit_d",
            "net_num",
            "net_den",
            "stress_num",
            "stress_den",
          ] as const) {
            expect(String(own[i]![k]), `${e.row.id} control ${i} ${k}`).toBe(String(c[k]));
          }
        });
      } else if (marked.has(`ctl:${e.row.id}`)) {
        expect(e.controls!.controls).toEqual([]);
      } else {
        expect(e.controls!.forcedIdx.length).toBeGreaterThan(0); // deferred, not wrong
      }
    }
    expect(closed).toBe(5);
    expect(withControls).toBeGreaterThan(0);
  });
});

describe("scorecards, evidence timeline and K", () => {
  it("writes the cohort figures (CIF, effective N, ranking) and the forward trade scorecards", async () => {
    const key = reviewKey(MARKET, d(LAST));
    const stat = await rows(
      db,
      "SELECT scope, metric, value_json FROM replay_stat WHERE run_id = ? ORDER BY scope, metric",
      [key],
    );
    const metrics = new Set(stat.map((r) => String(r.metric)));
    for (const m of [
      "cif",
      "effective_n",
      "ranking",
      "recheck",
      "scorecard",
      "evidence_timeline",
    ]) {
      expect(metrics.has(m), m).toBe(true);
    }
    const f4 = stat.find((r) => r.scope === "fwd:AU:F4|F4.v1|F4" && r.metric === "scorecard")!;
    const card = JSON.parse(String(f4.value_json)) as {
      insufficient: boolean;
      message: string;
      n: number;
    };
    expect(card.insufficient).toBe(true);
    expect(card.message).toBe(`Not enough history yet (n = ${card.n})`);
    const eff = JSON.parse(
      String(stat.find((r) => r.scope === "E01" && r.metric === "effective_n")!.value_json),
    ) as { cohorts: number };
    expect(eff.cohorts).toBe(1);
  });

  it("VAL-102 timeline data per (lineage, rule version): counts, rate, expected dates", async () => {
    const t = await rows(
      db,
      "SELECT scope, value_json FROM replay_stat WHERE run_id = ? AND metric = 'evidence_timeline' ORDER BY scope",
      [reviewKey(MARKET, d(LAST))],
    );
    expect(t.map((r) => String(r.scope))).toEqual(["AU:F1|F1.v1", "AU:F4|F4.v1"]);
    const f4 = JSON.parse(String(t[1]!.value_json)) as Record<string, unknown>;
    expect(f4.forwardRows).toBe(4);
    expect(f4.closedRows).toBe(4);
    expect(f4.rowsTarget).toBe(params.stats.minTrades);
    expect(typeof f4.rowsPerSession).toBe("number");
    expect(String(f4.expectedRowsD) > d(LAST)).toBe(true);
    expect(f4.minMonthsD).toBe("2031-08-27"); // first entry 2031-02-27 + forward_min_months (6)
    expect(f4.currentLabel).toBeNull();
    expect(f4.reachableLabel).toBe("UNVALIDATED");
  });

  it("no kill-switch look is due (4 forward trades), K stays at its default, nothing is recommended", async () => {
    expect(await count(db, "killswitch_look")).toBe(0n);
    expect(await count(db, "arena_control")).toBe(0n);
    const last = [...reviews.values()].pop()!;
    expect(last.stats.killLooksPerYear).toBe(params.killswitch.maxLooksPerYear);
  });
});

describe("determinism and idempotency", () => {
  it("two independent runs of the whole scenario write identical batch 3 data", async () => {
    expect(await dump(db)).toBe(await dump(second));
  });

  it("re-running a finished session is a no-op, and a second sync writes nothing", async () => {
    const before = await dump(db);
    const again = await reviewDay(db, {
      market: MARKET,
      d: d(LAST),
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("already_done");
    const calendar = await loadCalendar(db, MARKET);
    const sync = await syncForwardLedger(db, {
      market: MARKET,
      d: d(LAST),
      calendar,
      hours: HOURS,
      params,
      replay: true,
      masterSeed: ARENA_MASTER_SEED,
    });
    expect(sync).toMatchObject({ opened: 0, closed: 0, candidatesRebuilt: 0, controlRows: 0 });
    expect(await dump(db)).toBe(before);
  });

  it("a truncated window rewrites the same rows (warm-up half replayed, not written)", async () => {
    const before = await dump(second);
    const calendar = await loadCalendar(second, MARKET);
    const sync = await syncForwardLedger(second, {
      market: MARKET,
      d: d(LAST),
      calendar,
      hours: HOURS,
      params,
      replay: true,
      masterSeed: ARENA_MASTER_SEED,
      reach: 9,
    });
    expect(sync.windowSessions).toBe(19);
    expect(sync).toMatchObject({ opened: 0, closed: 0, controlRows: 0 });
    expect(sync.unchanged).toBeGreaterThan(0);
    expect(await dump(second)).toBe(before);
  });

  it("a batch 3 that missed the earlier nights catches up to the same rows and controls", async () => {
    const ledgerOnly = async (c: Client): Promise<string> =>
      JSON.stringify(
        await Promise.all(
          [
            "SELECT * FROM ledger_row ORDER BY id",
            "SELECT * FROM ledger_control ORDER BY row_id, idx",
          ].map(async (q) =>
            (await rows(c, q)).map((r) =>
              Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])),
            ),
          ),
        ),
      );
    expect(await ledgerOnly(late)).toBe(await ledgerOnly(db));
    const lastRun = await rows(late, "SELECT status FROM run_record WHERE job = ?", [REVIEW_JOB]);
    expect(lastRun).toEqual([{ status: "success" }]);
  });

  it("the bigint JSON codec round-trips candidates exactly", async () => {
    const stored = await rows(
      db,
      "SELECT value_json FROM replay_stat WHERE metric = 'candidates' ORDER BY scope",
    );
    expect(stored.length).toBeGreaterThan(0);
    for (const r of stored) {
      const text = String(r.value_json);
      expect(encodeJson(decodeJson(text))).toBe(text);
    }
  });
});

describe("guards", () => {
  it("data_only production: a skipped run record and no row in any batch 3 table", async () => {
    const fresh = await freshReplayDb();
    const before = [
      await count(fresh, "ledger_row"),
      await count(fresh, "replay_stat"),
      await count(fresh, "killswitch_look"),
    ];
    const r = await reviewDay(fresh, { market: MARKET, d: d(300), now: NOW, params });
    expect(r).toMatchObject({ status: "skipped", reason: "data_only_guard" });
    expect([
      await count(fresh, "ledger_row"),
      await count(fresh, "replay_stat"),
      await count(fresh, "killswitch_look"),
    ]).toEqual(before);
    const runs = await rows(fresh, "SELECT job, status FROM run_record");
    expect(runs).toEqual([{ job: REVIEW_JOB, status: "skipped" }]);
  });

  it("needs 2b success and a trading day, and the market must exist and be on", async () => {
    const fresh = await freshReplayDb();
    await buildGolden(fresh);
    await setMode(fresh, "full");
    expect(await reviewDay(fresh, { market: MARKET, d: d(300), now: NOW, params })).toMatchObject({
      status: "skipped",
      reason: "no_2b_success",
    });
    expect(
      await reviewDay(fresh, { market: MARKET, d: "2031-03-01", now: NOW, params }),
    ).toMatchObject({ status: "skipped", reason: "non_trading_day" });
    expect(await reviewDay(fresh, { market: "ZZ", d: d(300), now: NOW, params })).toMatchObject({
      status: "skipped",
      reason: "market_missing",
    });
    await setMode(fresh, "off");
    expect(await reviewDay(fresh, { market: MARKET, d: d(300), now: NOW, params })).toMatchObject({
      status: "skipped",
      reason: "market_off",
    });
    expect(await count(fresh, "replay_stat")).toBe(0n);
  });
});

describe("ARN-101 re-check is report only", () => {
  it("a broken book is reported, the run is degraded, and no book row changes", async () => {
    await runNights(db, params, LAST + 1, LAST + 1);
    const day = d(LAST + 1);
    const cohort = String(
      (
        await rows(db, "SELECT cohort_id FROM nav_daily WHERE d = ? ORDER BY cohort_id LIMIT 1", [
          day,
        ])
      )[0]!.cohort_id,
    );
    // a half posting: one leg of a transaction with no counter leg (double entry broken)
    await db.execute({
      sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id)
            VALUES (?, ?, 'broken:1', 'cash_settled', 5000000, 'seed', NULL, NULL)`,
      args: [cohort, day],
    });
    const tables = [
      "cash_ledger",
      "nav_daily",
      "nav_daily_pos",
      "fill",
      "trade",
      "arena_order",
      "cohort",
      "cohort_event",
      "sleeve_trade",
    ];
    const before = await Promise.all(tables.map((t) => count(db, t)));
    const calendar = await loadCalendar(db, MARKET);
    const direct = await recheckInvariants(db, day, calendar);
    expect(direct.violations).toBeGreaterThan(0);
    expect(direct.cohortsWithViolations).toContain(cohort);
    const r = await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params });
    expect(r.status).toBe("degraded");
    expect(r.reason).toBe("invariant_violations");
    expect(r.stats.invariantViolations).toBeGreaterThan(0);
    const log = await rows(
      db,
      "SELECT level, source FROM app_log WHERE source = ? AND level IN ('warn','error')",
      [REVIEW_JOB],
    );
    expect(log.length).toBeGreaterThan(0);
    const stat = await rows(
      db,
      "SELECT value_json FROM replay_stat WHERE run_id = ? AND metric = 'recheck'",
      [reviewKey(MARKET, day)],
    );
    expect((JSON.parse(String(stat[0]!.value_json)) as { violations: number }).violations).toBe(
      r.stats.invariantViolations,
    );
    const after = await Promise.all(tables.map((t) => count(db, t)));
    expect(after).toEqual(before);
  });
});

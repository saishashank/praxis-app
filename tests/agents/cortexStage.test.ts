// @vitest-environment node
// The Cortex nightly stage inside batch 2b / 2a / pre-open / batch 3 (M15 P2; D-265, D-266, D-280,
// D-281, D-288, D-289, D-307). Synthetic ZZ nights through the REAL migrations, batch 2a and 2b end
// to end (the batch 2b golden world): a shadow-only night writes night, feature, decision and abstain
// rows and no Cortex order; an `allowed` F1 family writes signal + card + order with `limit_micro`;
// a night with no map abstains `map_missing`; v1 rows are byte-identical with the stage on or off; a
// trade-through fills at the limit written as `level`; would-have scoring is idempotent.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { entryOrderId, signalsDay, type SignalsResult } from "@/lib/agents/batch2b";
import { reviewDay } from "@/lib/agents/batch3";
import { cardIdOf } from "@/lib/agents/cards";
import { replaySessions } from "@/lib/arena/replay";
import {
  cortexOrderId,
  cortexRuleVersion,
  cortexSignalId,
  MATCHED_CELL_KIND,
  scoreOutcomes,
  type StageResult,
} from "@/lib/cortex/stage";
import {
  insertFamilyStatus,
  insertMap,
  insertPassport,
  logCell,
  setCellResult,
} from "@/lib/cortex/store";
import { VOL_BUCKETS } from "@/lib/cortex/night";
import { cellKey, TOP3_BAND_KEY } from "@/lib/stats/cells";
import { cleanupTempDbs } from "../db/helpers";
import { cellStat, CLUSTERS, HASH, NIGHT_ANGLES } from "../cortex/night/zzNight";
import {
  DATES,
  MARKET,
  NOW,
  dump,
  freshReplayDb,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { MASTER_SEED } from "../arena/replayHarness";
import { buildNight } from "./batch2bHarness";
import { D, goldenCodes } from "./batch2bScenario";

vi.setConfig({ testTimeout: 240000, hookTimeout: 240000 });

const KEEP = ["E01", "E07"]; // F1 and F4 unleveraged books
const params = testParams();
// one A$600 book holds one code at ~49 % of its value: the CTX-026 caps would block every entry, and
// the three synthetic angles disagree more than the default allows; both are loosened for the live arm
const loose = testParams({
  max_code_nav_share: 1,
  max_industry_nav_share: 1,
  cortex_disagreement_max: 1,
});
// the allowed-family test keeps the CTX-026 caps (D-347: they span all 12 A$600 books); only the
// synthetic angles' disagreement is loosened
const disagree = testParams({ cortex_disagreement_max: 1 });
const ALL_BOOKS = Array.from({ length: 12 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`);
const d = (i: number): string => DATES[i]!;

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

/** Passports, a map and generous cells for F1 and F4; F1's status as given (F4 stays shadow). */
async function seedCortex(
  db: Client,
  f1: "shadow" | "allowed",
  sinceD = "2030-01-02",
): Promise<void> {
  for (const a of NIGHT_ANGLES) {
    await insertPassport(db, {
      market: MARKET,
      angleId: a.id,
      version: 1,
      domain: a.domain,
      cluster: a.cluster as never,
      orientation: a.orientation,
      kind: "score",
      inputs: ["bar_au"],
      historyFields: {},
      status: "active",
      horizonSessions: a.horizonSessions,
      evidence: {},
      measured: null,
      frozenAt: "2030-01-01T00:00:00.000Z",
    });
  }
  for (const family of ["F1", "F4"] as const) {
    await insertMap(db, {
      market: MARKET,
      family,
      ruleVersion: `${family}.zz.1`,
      fittedAt: "2030-01-01T00:00:00.000Z",
      params: {
        a: 1.2,
        b: 0.1,
        s_mean: 0,
        s_sd: 0.5,
        K: 3,
        clusters: [...CLUSTERS],
        top3_min_s: -1,
        family_mean_net: 0.01,
        gain: 0.1,
        loss: 0.06,
        tiers: ["U1"],
      } as never,
      activeSetHash: HASH,
      nEff: 250,
      pool: "zz",
      fitSplit: "development",
    });
    for (const v of VOL_BUCKETS) {
      const key = cellKey(family, TOP3_BAND_KEY, v, "U1");
      const cellId = `cell:${key}`;
      await logCell(db, {
        cellId,
        market: MARKET,
        family,
        angleId: null,
        kind: MATCHED_CELL_KIND,
        spec: { key },
        loggedAt: "2030-01-01T00:00:00.000Z",
        split: "development",
        lineageId: null,
      });
      await setCellResult(db, cellId, "2030-01-02T00:00:00.000Z", cellStat(key));
    }
  }
  // the DAT-234 list is loaded (an unrelated code): without it gate 8a fails closed (D-338)
  await db.execute({
    sql: `INSERT INTO index_change (market, code, index_name, kind, announced_d, effective_d, source, loaded_at)
          VALUES (?, 'ZZX', 'ASX200', 'add', '2029-12-01', '2029-12-15', 'manual', '2029-12-02T00:00:00Z')`,
    args: [MARKET],
  });
  await insertFamilyStatus(db, {
    market: MARKET,
    family: "F1",
    sinceD,
    status: f1,
    evidence: {},
    statementId: null,
    setBy: "import",
  });
}

type Run = { signals: Map<string, SignalsResult>; stages: Map<string, StageResult> };

/** 2a then 2b per session as the nightly pair runs, with the pre-open re-check before each 2a. */
async function runNights(
  db: Client,
  from: number,
  to: number,
  cortex: { enabled?: boolean; angles?: typeof NIGHT_ANGLES; timeoutMs?: number } = {},
  nightParams = params,
  /** Index of the first session whose batch 2b runs in live mode (replay: false, fixed now). */
  liveFrom = Number.POSITIVE_INFINITY,
  withPreopen = true,
): Promise<Run> {
  const signals = new Map<string, SignalsResult>();
  const stages = new Map<string, StageResult>();
  await replaySessions(db, {
    market: MARKET,
    from: d(from),
    to: d(to),
    now: NOW,
    masterSeed: MASTER_SEED,
    preopen: withPreopen,
    afterClose: async (day) => {
      signals.set(
        day,
        await signalsDay(db, {
          withLeverage: true,
          market: MARKET,
          d: day,
          replay: DATES.indexOf(day) < liveFrom,
          now: NOW,
          masterSeed: MASTER_SEED,
          params: nightParams,
          cortex: { ...cortex, onStage: (r) => stages.set(day, r) },
        }),
      );
    },
  });
  return { signals, stages };
}

const V1_TABLES = [
  "SELECT * FROM signal ORDER BY id",
  "SELECT * FROM decision_card ORDER BY id",
  "SELECT * FROM arena_order ORDER BY id",
  "SELECT * FROM fill ORDER BY id",
  "SELECT * FROM trade ORDER BY id",
  "SELECT * FROM nav_daily ORDER BY cohort_id, d",
  "SELECT * FROM cash_ledger ORDER BY 1, 2, 3, 4",
  "SELECT * FROM stop_level ORDER BY trade_id, d, rule",
  "SELECT * FROM card_note ORDER BY 1",
  "SELECT * FROM preopen_result ORDER BY order_id",
  "SELECT * FROM thesis_breaker_eval ORDER BY 1, 2, 3, 4, 5",
  "SELECT * FROM run_record ORDER BY id",
];

afterAll(cleanupTempDbs);

describe("shadow-only nights (D-280): the Cortex writes its tables and no order", () => {
  let on: Client;
  let off: Client;
  let run: Run;

  beforeAll(async () => {
    for (const enabled of [true, false]) {
      const db = await freshReplayDb();
      await buildNight(db, { codes: goldenCodes() });
      await setMode(db, "full");
      await startCohortsAt(db, 296, KEEP);
      await seedCortex(db, "shadow");
      if (enabled) {
        on = db;
        // the last night runs in live mode (replay: false, fixed now) on both databases
        run = await runNights(db, 297, 303, { angles: NIGHT_ANGLES }, loose, 303);
      } else {
        off = db;
        await runNights(db, 297, 303, { enabled: false }, loose, 303);
      }
    }
  });

  it("writes the night, manifest, one feature row per code, shadow decisions and abstains", async () => {
    const night = await rows(on, "SELECT * FROM cortex_night WHERE d = ?", [d(D)]);
    expect(night).toHaveLength(1);
    expect(night[0]).toMatchObject({ status: "ran", reason: null });
    const manifest = await rows(on, "SELECT 1 FROM input_manifest WHERE manifest_id = ?", [
      String(night[0]!.manifest_id),
    ]);
    expect(manifest).toHaveLength(1);
    const feats = await rows(on, "SELECT COUNT(*) AS n FROM cortex_feature_daily WHERE d = ?", [
      d(D),
    ]);
    expect(Number(feats[0]!.n)).toBe(Number(night[0]!.feature_rows));
    expect(Number(night[0]!.feature_rows)).toBeGreaterThan(30);
    const dec = await rows(
      on,
      "SELECT arm, COUNT(*) AS n FROM cortex_decision WHERE d = ? GROUP BY arm",
      [d(D)],
    );
    expect(dec.map((r) => String(r.arm))).toContain("shadow");
    // the live arm of a shadow family is only ever a blocked row (G03), never a decision
    expect(
      await rows(
        on,
        "SELECT 1 FROM cortex_decision WHERE arm = 'live' AND first_fail_gate IS NULL",
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        on,
        "SELECT 1 FROM cortex_decision WHERE d = ? AND arm = 'shadow' AND first_fail_gate IS NULL",
        [d(D)],
      ),
    ).not.toHaveLength(0);
    const stage = run.stages.get(d(D))!;
    expect(stage.out.status).toBe("ran");
    expect(stage.allowed.size).toBe(0);
  });

  it("writes no Cortex signal, card or order while every family is shadow", async () => {
    expect(await rows(on, "SELECT 1 FROM signal WHERE variant = 'cortex'")).toHaveLength(0);
    expect(await rows(on, "SELECT 1 FROM arena_order WHERE limit_micro IS NOT NULL")).toHaveLength(
      0,
    );
  });

  it("leaves every v1 row byte-identical with the stage on or off", async () => {
    for (const sql of V1_TABLES) {
      const a = await dump(on, sql);
      const b = await dump(off, sql);
      expect(a.length).toBeGreaterThan(2);
      expect(a).toBe(b);
    }
    // the stage-off database holds no Cortex night at all
    expect(await rows(off, "SELECT 1 FROM cortex_night")).toHaveLength(0);
  });

  it("a decision whose fill session has no bar is cancelled (no_fill_bar), not left open", async () => {
    const night = await rows(on, "SELECT manifest_id FROM cortex_night WHERE d = ?", [d(D)]);
    await on.execute({
      sql: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, limit_micro, stop_micro, qty,
              gate_trace_json, manifest_id) VALUES (?, ?, 'E01@x', 'ZZNOBAR', 'shadow', 'F1', 1000000, 900000, 10, '[]', ?)`,
      args: [MARKET, d(D), String(night[0]!.manifest_id)],
    });
    // D-354: a code with no bar on D+1 but a bar on D+2 is no trade either
    await on.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES (?, 'ZZGAP', ?, 1, 1.1, 0.9, 1, 1000000, 'synthetic', ?, ?)`,
      args: [MARKET, d(D + 2), `${d(D + 2)}T06:30:00.000Z`, `${d(D + 2)}T07:00:00.000Z`],
    });
    await on.execute({
      sql: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, limit_micro, stop_micro, qty,
              gate_trace_json, manifest_id) VALUES (?, ?, 'E01@x', 'ZZGAP', 'shadow', 'F1', 1000000, 900000, 10, '[]', ?)`,
      args: [MARKET, d(D), String(night[0]!.manifest_id)],
    });
    // and an unsized blocked row is cancelled by the set-based insert
    await on.execute({
      sql: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, gate_trace_json, first_fail_gate, manifest_id)
            VALUES (?, ?, 'E01@x', 'ZZUNSIZED', 'live', 'F1', '[]', 'G04_economic', ?)`,
      args: [MARKET, d(D), String(night[0]!.manifest_id)],
    });
    await scoreOutcomes(on, { market: MARKET, d: d(303), params, now: NOW });
    const out = await rows(
      on,
      "SELECT code, fill_status, exit_rule FROM cortex_outcome WHERE code IN ('ZZNOBAR', 'ZZGAP', 'ZZUNSIZED') ORDER BY code",
    );
    expect(out).toEqual([
      { code: "ZZGAP", fill_status: "cancelled", exit_rule: "no_fill_bar" },
      { code: "ZZNOBAR", fill_status: "cancelled", exit_rule: "no_fill_bar" },
      { code: "ZZUNSIZED", fill_status: "cancelled", exit_rule: null },
    ]);
  });

  it("scores would-have outcomes in batch 3, once (idempotent)", async () => {
    const first = await scoreOutcomes(on, { market: MARKET, d: d(303), params, now: NOW });
    expect(first.scored + first.unscorable).toBeGreaterThanOrEqual(0);
    const n1 = await rows(on, "SELECT COUNT(*) AS n FROM cortex_outcome");
    expect(Number(n1[0]!.n)).toBeGreaterThan(0);
    const again = await scoreOutcomes(on, { market: MARKET, d: d(303), params, now: NOW });
    const n2 = await rows(on, "SELECT COUNT(*) AS n FROM cortex_outcome");
    expect(n2[0]!.n).toBe(n1[0]!.n);
    expect(again.scored + again.unscorable).toBe(0);
    // batch 3 itself runs the same scoring without changing its status
    const review = await reviewDay(on, {
      market: MARKET,
      d: d(303),
      replay: true,
      now: NOW,
      masterSeed: MASTER_SEED,
      params,
    });
    expect(["success", "degraded"]).toContain(review.status);
  });
});

describe("an allowed F1 family trades the Cortex live arm (D-266)", () => {
  let db: Client;
  let run: Run;
  const book = async (): Promise<string> =>
    String((await rows(db, "SELECT id FROM cohort WHERE id LIKE 'E01%'"))[0]!.id);
  /** The first night on which the allowed F1 book had a live decision, and that decision. */
  const first = (): {
    day: string;
    stage: StageResult;
    pick: StageResult["out"]["decisions"][number];
  } => {
    for (const [day, stage] of [...run.stages.entries()].sort()) {
      const pick = stage.out.decisions.find((x) => x.family === "F1" && x.bookId.startsWith("E01"));
      if (pick !== undefined) return { day, stage, pick };
    }
    throw new Error("no live F1 decision on any night");
  };

  beforeAll(async () => {
    db = await freshReplayDb();
    // a market-wide 12 % gap-up at every open from session 297: above any limit, the low inside it
    const codes = goldenCodes().map((c) => ({
      ...c,
      open: (i: number, prev: bigint) => (i >= 297 ? (prev * 112n) / 100n : prev),
    }));
    await buildNight(db, { codes });
    await setMode(db, "full");
    await startCohortsAt(db, 296, ALL_BOOKS);
    await seedCortex(db, "allowed");
    run = await runNights(db, 297, 303, { angles: NIGHT_ANGLES }, disagree);
  });

  it("writes signal, card and a limit order for the live decision, and links the decision row", async () => {
    const { day, stage, pick } = first();
    // D-352: the reads are bounded to the universe plus held codes; the counts of this night
    expect(stage.readCounts.bars).toBeLessThanOrEqual(stage.readCounts.codes! * 420);
    expect(stage.readCounts.codes).toBe(37); // the universe on D plus held codes, not the whole table
    expect([...stage.allowed]).toEqual(["F1"]);
    const id = await book();
    const rv = cortexRuleVersion("F1", "F1.zz.1");
    const signalId = cortexSignalId(MARKET, day, "F1", rv, pick.code);
    const sig = await rows(db, "SELECT variant, family, rule_version FROM signal WHERE id = ?", [
      signalId,
    ]);
    expect(sig).toEqual([{ variant: "cortex", family: "F1", rule_version: rv }]);
    const orderId = entryOrderId(id, day, pick.code);
    expect(orderId).toBe(cortexOrderId(id, day, pick.code));
    const order = await rows(
      db,
      "SELECT limit_micro, qty, signal_id, card_id, stop_spec FROM arena_order WHERE id = ?",
      [orderId],
    );
    expect(order).toHaveLength(1);
    expect(BigInt(order[0]!.limit_micro as bigint)).toBe(pick.limitMicro);
    expect(BigInt(order[0]!.qty as bigint)).toBe(pick.qty);
    expect(String(order[0]!.signal_id)).toBe(signalId);
    expect(String(order[0]!.card_id)).toBe(cardIdOf(signalId, `E01`));
    const card = await rows(db, "SELECT taken, order_id FROM decision_card WHERE id = ?", [
      String(order[0]!.card_id),
    ]);
    expect(card).toEqual([{ taken: 1n, order_id: orderId }]);
    const dec = await rows(
      db,
      "SELECT signal_id, order_id, card_id, limit_micro FROM cortex_decision WHERE d = ? AND arm = 'live' AND code = ? AND book_id = ?",
      [day, pick.code, id],
    );
    expect(dec).toHaveLength(1);
    expect(String(dec[0]!.order_id)).toBe(orderId);
    expect(String(dec[0]!.signal_id)).toBe(signalId);
    // F4 stays shadow: its book (E07) has no Cortex order
    expect(
      await rows(
        db,
        "SELECT 1 FROM arena_order WHERE limit_micro IS NOT NULL AND cohort_id LIKE 'E07%'",
      ),
    ).toHaveLength(0);
  });

  it("fills the trade-through at the limit, written as `level` (D-307), after the 09:55 open list", async () => {
    const { day, pick } = first();
    const id = await book();
    const orderId = cortexOrderId(id, day, pick.code);
    const pre = await rows(db, "SELECT outcome FROM preopen_result WHERE order_id = ?", [orderId]);
    expect(pre).toEqual([{ outcome: "pass" }]);
    const ord = await rows(db, "SELECT status, reject_reason FROM arena_order WHERE id = ?", [
      orderId,
    ]);
    expect(ord).toEqual([{ status: "filled", reject_reason: null }]);
    const fill = await rows(
      db,
      "SELECT rule, fill_price_micro, slip_micro, bar_o_micro, bar_l_micro FROM fill WHERE order_id = ?",
      [orderId],
    );
    expect(fill).toHaveLength(1);
    expect(fill[0]!.rule).toBe("level");
    expect(BigInt(fill[0]!.fill_price_micro as bigint)).toBe(pick.limitMicro);
    expect(BigInt(fill[0]!.bar_o_micro as bigint)).toBeGreaterThan(pick.limitMicro);
    expect(BigInt(fill[0]!.bar_l_micro as bigint)).toBeLessThanOrEqual(pick.limitMicro);
    expect(BigInt(fill[0]!.slip_micro as bigint)).toBe(0n);
  });
});

describe("a night with no map (D-281)", () => {
  it("abstains every cash-holding book `map_missing` and writes shadow rows only", async () => {
    const db = await freshReplayDb();
    await buildNight(db, { codes: goldenCodes() });
    await setMode(db, "full");
    await startCohortsAt(db, 298, KEEP);
    const run = await runNights(db, 299, 301);
    const night = await rows(db, "SELECT status, reason FROM cortex_night WHERE d = ?", [d(D)]);
    expect(night).toEqual([{ status: "abstain_all", reason: "map_missing" }]);
    const abstain = await rows(db, "SELECT book_id, gate_id FROM cortex_abstain WHERE d = ?", [
      d(D),
    ]);
    expect(abstain.length).toBeGreaterThan(0);
    expect(run.stages.get(d(D))!.out.decisions).toHaveLength(0);
    expect(
      await rows(db, "SELECT 1 FROM cortex_decision WHERE first_fail_gate IS NULL"),
    ).toHaveLength(0);
    const gates = await rows(
      db,
      "SELECT DISTINCT first_fail_gate FROM cortex_decision WHERE d = ? ORDER BY 1",
      [d(D)],
    );
    expect(gates.map((g) => String(g.first_fail_gate))).toEqual([
      "G03_family_status",
      "G04_economic",
    ]);
    expect(await rows(db, "SELECT 1 FROM arena_order WHERE limit_micro IS NOT NULL")).toHaveLength(
      0,
    );
  });
});

describe("quota-degrade (D-289)", () => {
  it("measures its own elapsed minutes against cortex_stage_minutes", async () => {
    const db = await freshReplayDb();
    await buildNight(db, { codes: goldenCodes() });
    await setMode(db, "full");
    await startCohortsAt(db, 298, KEEP);
    await seedCortex(db, "shadow");
    // a wall clock that reads 30 minutes after the first reading: the stage exceeds the 20-minute default
    // five readings per stage: start, after the reads, before and after runNight, runtime
    let n = 0;
    const nowMs = (): number => {
      const k = n % 5;
      const base = Math.floor(n / 5) * 100 * 60_000;
      n += 1;
      return base + (k === 0 ? 0 : 30 * 60_000);
    };
    const signals = new Map<string, SignalsResult>();
    const stages = new Map<string, StageResult>();
    await replaySessions(db, {
      market: MARKET,
      from: d(299),
      to: d(300),
      now: NOW,
      masterSeed: MASTER_SEED,
      afterClose: async (day) => {
        signals.set(
          day,
          await signalsDay(db, {
            withLeverage: true,
            market: MARKET,
            d: day,
            replay: true,
            now: NOW,
            masterSeed: MASTER_SEED,
            params,
            cortex: { angles: NIGHT_ANGLES, nowMs, onStage: (r) => stages.set(day, r) },
          }),
        );
      },
    });
    const night = await rows(db, "SELECT status, reason FROM cortex_night WHERE d = ?", [d(D)]);
    expect(night).toEqual([{ status: "abstain_all", reason: "quota" }]);
    expect(stages.get(d(D))!.out.decisions).toHaveLength(0);
  });
});

describe("a paused family cancels its Cortex order at 09:55 and v1 keeps its pre-open rows (D-351)", () => {
  it("writes filter:open_O01_kill for the Cortex order and a pass row for the v1 orders", async () => {
    const db = await freshReplayDb();
    await buildNight(db, { codes: goldenCodes() });
    await setMode(db, "full");
    await startCohortsAt(db, 298, ALL_BOOKS);
    // allowed from the decision night 300 on: E01 gets a Cortex order, E07 (F4, shadow) a v1 order
    await seedCortex(db, "allowed", d(D));
    await runNights(db, 299, D, { angles: NIGHT_ANGLES }, disagree);
    const cortexOrders = await rows(
      db,
      "SELECT id FROM arena_order WHERE limit_micro IS NOT NULL AND status = 'pending'",
    );
    const v1Orders = await rows(
      db,
      "SELECT id FROM arena_order WHERE limit_micro IS NULL AND kind = 'entry' AND status = 'pending' AND decided_d = ?",
      [d(D)],
    );
    expect(cortexOrders.length).toBeGreaterThan(0); // E01 and its leverage twin E02
    expect(v1Orders.length).toBeGreaterThan(0);
    await db.execute({
      sql: "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason) VALUES ('family', 'F1', 'paused', ?, 'owner', 'test')",
      args: [NOW()],
    });
    await replaySessions(db, {
      market: MARKET,
      from: d(D + 1),
      to: d(D + 1),
      now: NOW,
      masterSeed: MASTER_SEED,
      preopen: true,
    });
    const run = await rows(db, "SELECT status FROM preopen_run WHERE d = ?", [d(D + 1)]);
    expect(run).toEqual([{ status: "ok" }]);
    for (const c of cortexOrders) {
      const cx = await rows(db, "SELECT outcome, reason FROM preopen_result WHERE order_id = ?", [
        String(c.id),
      ]);
      expect(cx).toEqual([{ outcome: "cancel", reason: "filter:open_O01_kill" }]);
      const ord = await rows(db, "SELECT status, reject_reason FROM arena_order WHERE id = ?", [
        String(c.id),
      ]);
      expect(ord).toEqual([{ status: "cancelled", reject_reason: "preopen:filter:open_O01_kill" }]);
    }
    for (const o of v1Orders) {
      const r = await rows(db, "SELECT outcome FROM preopen_result WHERE order_id = ?", [
        String(o.id),
      ]);
      expect(r).toEqual([{ outcome: "pass" }]);
    }
  });
});

describe("the stage is time-boxed (D-353) and a failure holds cash (D-356)", () => {
  it("an overrun logs a warning, the allowed family opens nothing and v1 families trade", async () => {
    const db = await freshReplayDb();
    await buildNight(db, { codes: goldenCodes() });
    await setMode(db, "full");
    await startCohortsAt(db, 298, ALL_BOOKS);
    await seedCortex(db, "allowed", d(D));
    await runNights(db, 299, D, { angles: NIGHT_ANGLES, timeoutMs: 1 }, disagree);
    const warn = await rows(
      db,
      "SELECT message FROM app_log WHERE level = 'warn' AND message LIKE 'cortex stage failed%'",
    );
    expect(warn.length).toBeGreaterThan(0);
    expect(await rows(db, "SELECT 1 FROM arena_order WHERE limit_micro IS NOT NULL")).toHaveLength(
      0,
    );
    expect(await rows(db, "SELECT 1 FROM signal WHERE variant = 'cortex'")).toHaveLength(0);
    expect(
      (await rows(db, "SELECT 1 FROM arena_order WHERE kind = 'entry' AND decided_d = ?", [d(D)]))
        .length,
    ).toBeGreaterThan(0);
  });
});

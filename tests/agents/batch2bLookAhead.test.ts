// @vitest-environment node
// Look-ahead, determinism, the quality gate at creation and the F3 gap cap (M4 T8; TST-109,
// ARN-102, DAT-210, spec 7.4 F3). Synthetic nights through the real batch 2a + 2b.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializePlan } from "@/lib/agents/orderPlan";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  addAction,
  dump,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden, D } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
afterEach(cleanupTempDbs);

const params = testParams();
const d = (i: number): string => DATES[i]!;
type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

const KEEP = ["E01", "E07", "C2-F1", "C2-F4"];
const TABLES = [
  "signal",
  "arena_order",
  "stop_level",
  "c2_selection",
  "regime_daily",
  "event",
  "insider_flow_score",
  "trade",
  "fill",
];

async function decisionNight(build: (db: Client) => Promise<void>, to: number): Promise<string[]> {
  const db = await freshReplayDb();
  await build(db);
  await setMode(db, "full");
  await startCohortsAt(db, 295, KEEP);
  const run = await runNights(db, params, 295, to);
  for (const [, r] of run.signals) expect(r.status).toBe("success");
  return Promise.all(TABLES.map((t) => dump(db, `SELECT * FROM ${t} ORDER BY 1, 2, 3`)));
}

describe("look-ahead and determinism (TST-109, ARN-102)", () => {
  it("poisoned rows after D (bars, index, a split, late rows) change no signal, order, stop or control", async () => {
    const clean = await decisionNight((db) => buildGolden(db, { through: D }), D);
    const poisoned = await decisionNight(async (db) => {
      await buildGolden(db, { poisonAfter: D });
      // a split with an ex-date after D+1 must not adjust any history used for D
      await addAction(db, "ZZUP", "split", D + 5, { new: 2, old: 1 });
      // an announcement published after the cut-off of D, and short-interest published after it
      await db.execute({
        sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
              VALUES (?, 'ZZ05', 'POISON-1', ?, ?, NULL, 1, 'Upgrades earnings guidance', NULL, 'synthetic')`,
        args: [MARKET, `${d(D)}T09:00:00.000Z`, `${d(D)}T09:01:00.000Z`],
      });
      await db.execute({
        sql: `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
              VALUES (?, 'ZZ05', ?, 90000, ?, ?, 0, 'synthetic')`,
        args: [MARKET, d(D - 1), `${d(D)}T09:00:00.000Z`, `${d(D)}T09:01:00.000Z`],
      });
    }, D);
    expect(poisoned).toEqual(clean);
    expect(clean[0]).not.toBe("[]"); // the comparison is not vacuous: signals exist
    expect(clean[3]).not.toBe("[]"); // and so are the controls drawn
  });

  it("the same night built twice gives byte-identical rows, controls included (C2 determinism)", async () => {
    const a = await decisionNight((db) => buildGolden(db), D + 4);
    const b = await decisionNight((db) => buildGolden(db), D + 4);
    expect(b).toEqual(a);
  });
});

describe("the quality gate at order creation (DAT-210)", () => {
  it("a failed U1 gate rejects the top-ranked entry once (reason gate) and nothing fills", async () => {
    const db = await freshReplayDb();
    await buildGolden(db, { gateFail: [D] });
    await setMode(db, "full");
    const ids = await startCohortsAt(db, 295, ["E07"]);
    await runNights(db, params, 295, D + 1);
    const orders = await rows(
      db,
      "SELECT code, kind, qty, status, reject_reason FROM arena_order WHERE cohort_id = ? AND decided_d = ?",
      [ids[0]!, d(D)],
    );
    expect(orders).toEqual([
      { code: "ZZD1", kind: "entry", qty: 0n, status: "rejected", reject_reason: "gate" },
    ]);
    expect(await rows(db, "SELECT 1 FROM fill")).toEqual([]);
    // the signals are still recorded: the gate blocks the order, not the finding
    expect((await rows(db, "SELECT 1 FROM signal WHERE d = ?", [d(D)])).length).toBe(3);
    // no matched entry, so no control is drawn
    expect(await rows(db, "SELECT 1 FROM c2_selection")).toEqual([]);
  });

  it("a blocked code is rejected and the next candidate takes its place", async () => {
    const db = await freshReplayDb();
    await buildGolden(db);
    await setMode(db, "full");
    const ids = await startCohortsAt(db, 295, ["E07"]);
    await db.execute({
      sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at, blocks_entries)
            VALUES (?, 'ZZD1', ?, 'synthetic', 'high', ?, 1)`,
      args: [MARKET, d(D), `${d(D)}T07:00:00.000Z`],
    });
    await runNights(db, params, 295, D);
    const orders = await rows(
      db,
      "SELECT code, status, reject_reason FROM arena_order WHERE cohort_id = ? AND decided_d = ? ORDER BY code",
      [ids[0]!, d(D)],
    );
    expect(orders).toEqual([
      { code: "ZZD1", status: "rejected", reject_reason: "gate" },
      { code: "ZZD2", status: "pending", reject_reason: null },
    ]);
  });
});

describe("the F3 gap cap and the order plan at the fill (spec 7.4, ARN-021)", () => {
  it("an entry is cancelled `gap` when the open reaches the cap; below it, it fills with the plan stop", async () => {
    const db = await freshReplayDb();
    await buildGolden(db);
    await setMode(db, "full");
    const [cohortId] = await startCohortsAt(db, 295, ["E07"]);
    await runNights(db, params, 295, 299);
    const close = async (code: string): Promise<bigint> => {
      const r = await rows(db, "SELECT c FROM price_bar WHERE code = ? AND d = ?", [code, d(299)]);
      return BigInt(Math.round(Number(r[0]!.c) * 1e6));
    };
    const plan = (level: bigint): string =>
      serializePlan({
        family: "F3",
        variant: "F3",
        ruleVersion: "F3.v1",
        caThrough: d(299),
        caApplied: [],
        plan: {
          initialStops: [
            {
              id: "initial",
              via: null,
              spec: { atr_micro: null, k: null, cap: null, level_micro: level },
            },
          ],
          trails: [],
          cs: [],
        },
        rel: [],
      });
    const c5 = await close("ZZ05");
    const c6 = await close("ZZ06");
    const insert = (code: string, maxOpen: bigint, level: bigint): Promise<unknown> =>
      db.execute({
        sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, tier, max_open_micro, stop_spec)
              VALUES (?, ?, ?, ?, 'buy', 'entry', 100, 'U1', ?, ?)`,
        args: [`EN:${cohortId}:${d(299)}:${code}`, cohortId!, d(299), code, maxOpen, plan(level)],
      });
    await insert("ZZ05", c5, c5 - 50_000n); // the open (= the previous close) is AT the cap: cancelled
    await insert("ZZ06", c6 + 1n, c6 - 50_000n); // one micro below the cap: fills
    await runNights(db, params, 300, 300);
    const out = await rows(
      db,
      "SELECT code, status, reject_reason FROM arena_order WHERE cohort_id = ? AND decided_d = ? AND code IN ('ZZ05', 'ZZ06') ORDER BY code",
      [cohortId!, d(299)],
    );
    expect(out).toEqual([
      { code: "ZZ05", status: "cancelled", reject_reason: "gap" },
      { code: "ZZ06", status: "filled", reject_reason: null },
    ]);
    const [trade] = await rows(db, "SELECT stop_micro FROM trade WHERE code = 'ZZ06'");
    expect(BigInt(trade!.stop_micro as bigint)).toBe(c6 - 50_000n); // the event-day-low style level
  });
});

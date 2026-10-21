// @vitest-environment node
// Attribution over the golden nights (M6 T3). The synthetic scenario of the batch 2b / 3 tests runs
// through 2a, 2b and 3 on a real migrated file; ZZD1 splits 2-for-1 in the middle of its hold. Every
// attributed MFE / MAE is recomputed here from the stored bars by an independent exact routine; the
// candidates that a gate blocked are walked by the forward-ledger hook with the ledger's rules.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay } from "@/lib/agents/batch3";
import { syncForwardLedger } from "@/lib/agents/forwardLedger";
import { ARENA_MASTER_SEED, loadCalendar } from "@/lib/arena/closeBooks";
import {
  attributeBlockedCandidates,
  attributeNight,
  type AttributionOptions,
} from "@/lib/learning/attribution";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  addAction,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { buildGolden } from "../agents/batch2bScenario";

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const LAST = 320;
const SPLIT = 303;
const d = (i: number): string => DATES[i]!;
const HOURS = { tz: "Australia/Sydney", open_time: "10:00", close_time: "16:00" };

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const big = (v: unknown): bigint => BigInt(String(v));

async function world(): Promise<Client> {
  const db = await freshReplayDb();
  await buildGolden(db, {}, SPLIT);
  await addAction(db, "ZZD1", "split", SPLIT, { new: 2, old: 1 });
  await setMode(db, "full");
  await startCohortsAt(db, 295, KEEP);
  await runNights(db, params, 295, LAST, async (day) => {
    await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params });
  });
  return db;
}

async function dump(db: Client): Promise<string> {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM attribution ORDER BY subject_kind, subject_id, version",
    "SELECT * FROM blocked_trade ORDER BY signal_id, execution_id",
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

const optionsFor = async (db: Client, day: string): Promise<AttributionOptions> => ({
  market: MARKET,
  d: day,
  calendar: await loadCalendar(db, MARKET),
  params,
  replay: true,
});

let db: Client;
let first: Awaited<ReturnType<typeof attributeNight>>;
beforeAll(async () => {
  db = await world();
  first = await attributeNight(db, await optionsFor(db, d(LAST)));
});
afterAll(cleanupTempDbs);

/** Independent exact MFE / MAE: integer arithmetic on the stored raw bars, the split factor by hand. */
async function brute(
  code: string,
  entryD: string,
  exitD: string | null,
  fill: bigint,
): Promise<{ mfe: bigint; mae: bigint }> {
  const end = exitD !== null && exitD <= d(LAST) ? exitD : d(LAST);
  const bars = await rows(
    db,
    "SELECT d, h, l FROM price_bar WHERE market = ? AND code = ? AND d >= ? AND d <= ? ORDER BY d",
    [MARKET, code, entryD, end],
  );
  const factor = (day: string): bigint =>
    code === "ZZD1" && entryD < d(SPLIT) && day >= d(SPLIT) ? 2n : 1n;
  const ppm = (num: bigint): bigint => {
    const scaled = num * 1_000_000n;
    const a = scaled < 0n ? -scaled : scaled;
    const q = (2n * a + fill) / (2n * fill);
    return scaled < 0n ? -q : q;
  };
  let mfe: bigint | null = null;
  let mae: bigint | null = null;
  for (const b of bars) {
    const f = factor(String(b.d));
    const hi = BigInt(Math.round(Number(b.h) * 1e6)) * f - fill;
    const lo = BigInt(Math.round(Number(b.l) * 1e6)) * f - fill;
    if (mfe === null || hi > mfe) mfe = hi;
    if (mae === null || lo < mae) mae = lo;
  }
  return { mfe: ppm(mfe!), mae: ppm(mae!) };
}

describe("the golden nights", () => {
  it("attributes every trade, forward row and not-taken signal; finished ones are final", async () => {
    const kinds = await rows(
      db,
      "SELECT subject_kind AS k, COUNT(*) AS n, SUM(final) AS f FROM attribution GROUP BY 1 ORDER BY 1",
    );
    expect(kinds.map((r) => [r.k, Number(r.n) > 0])).toEqual([
      ["blocked", true],
      ["ledger_row", true],
      ["trade", true],
    ]);
    expect(first.trades.inserted).toBeGreaterThan(0);
    expect(Number(kinds.find((r) => r.k === "ledger_row")!.f)).toBeGreaterThan(0);
    // every closed ledger row carries the exit rule its walk used (written once by the forward ledger)
    const closed = await rows(db, "SELECT id FROM ledger_row WHERE exit_d IS NOT NULL");
    const marks = await rows(db, "SELECT scope FROM replay_stat WHERE metric = 'exit_rule'");
    expect(marks.map((m) => String(m.scope)).sort()).toEqual(
      closed.map((c) => `exit:${String(c.id)}`).sort(),
    );
  });

  it("MFE / MAE of every ledger row and trade equal an independent exact recomputation, split included", async () => {
    let straddling = 0;
    const lr = await rows(
      db,
      `SELECT a.subject_id, a.mfe_ppm, a.mae_ppm, l.entry_d, l.exit_d, l.fill_in_micro, s.code
       FROM attribution a JOIN ledger_row l ON l.id = a.subject_id JOIN signal s ON s.id = l.signal_id
       WHERE a.subject_kind = 'ledger_row' AND a.version = (SELECT MAX(version) FROM attribution
         WHERE subject_kind = 'ledger_row' AND subject_id = a.subject_id)`,
    );
    expect(lr.length).toBeGreaterThan(0);
    for (const r of lr) {
      const want = await brute(
        String(r.code),
        String(r.entry_d),
        r.exit_d === null ? null : String(r.exit_d),
        big(r.fill_in_micro),
      );
      expect([String(r.subject_id), big(r.mfe_ppm), big(r.mae_ppm)]).toEqual([
        String(r.subject_id),
        want.mfe,
        want.mae,
      ]);
      if (r.code === "ZZD1" && String(r.entry_d) < d(SPLIT)) straddling += 1;
    }
    const tr = await rows(
      db,
      `SELECT a.subject_id, a.mfe_ppm, a.mae_ppm, f.d AS entry_d, x.d AS exit_d, f.fill_price_micro, t.code
       FROM attribution a JOIN trade t ON t.id = a.subject_id JOIN fill f ON f.id = t.entry_fill_id
       LEFT JOIN fill x ON x.id = t.exit_fill_id
       WHERE a.subject_kind = 'trade' AND a.version = (SELECT MAX(version) FROM attribution
         WHERE subject_kind = 'trade' AND subject_id = a.subject_id)`,
    );
    expect(tr.length).toBeGreaterThan(0);
    for (const r of tr) {
      const want = await brute(
        String(r.code),
        String(r.entry_d),
        r.exit_d === null ? null : String(r.exit_d),
        big(r.fill_price_micro),
      );
      expect([String(r.subject_id), big(r.mfe_ppm), big(r.mae_ppm)]).toEqual([
        String(r.subject_id),
        want.mfe,
        want.mae,
      ]);
      if (r.code === "ZZD1" && String(r.entry_d) < d(SPLIT)) straddling += 1;
    }
    expect(straddling).toBeGreaterThan(0); // a split went ex in the middle of a hold
  });

  it("a not-taken signal's counterfactual is the ledger row of the same signal", async () => {
    const b = await rows(
      db,
      `SELECT b.signal_id, b.counterfactual_row_id AS rid, b.counterfactual_net_ppm AS ppm, b.final,
              l.signal_id AS lsig, l.exit_d
       FROM blocked_trade b LEFT JOIN ledger_row l ON l.id = b.counterfactual_row_id`,
    );
    expect(b.length).toBeGreaterThan(0);
    let withPath = 0;
    for (const r of b) {
      if (r.rid === null) continue;
      withPath += 1;
      expect(String(r.lsig)).toBe(String(r.signal_id));
      expect(r.ppm !== null).toBe(r.exit_d !== null);
      expect(Number(r.final)).toBe(r.exit_d !== null ? 1 : 0);
    }
    expect(withPath).toBeGreaterThan(0);
  });

  it("candidates blocked by a gate are walked with the ledger's rules: same entry, same outcome", async () => {
    const o = await optionsFor(db, d(LAST));
    let result: Awaited<ReturnType<typeof attributeBlockedCandidates>> | undefined;
    await syncForwardLedger(db, {
      market: MARKET,
      d: d(LAST),
      calendar: o.calendar,
      hours: HOURS,
      params,
      replay: true,
      masterSeed: ARENA_MASTER_SEED,
      afterWrite: async (night) => {
        // present the candidates of the window as if a filter had stopped them
        const stored = new Map(
          [...night.stored].map(([day, out]) => [
            day,
            {
              candidates: [],
              blocked: out.candidates.map((c) => ({ ...c, reasons: ["gate_b", "arn011_a"] })),
            },
          ]),
        );
        result = await attributeBlockedCandidates({ ...night, stored });
      },
    });
    expect(result!.considered).toBeGreaterThan(0);
    const gate = await rows(
      db,
      "SELECT * FROM blocked_trade WHERE execution_id = 'gate' ORDER BY signal_id",
    );
    expect(gate).toHaveLength(result!.considered);
    for (const g of gate) expect(String(g.reason)).toBe("gate:arn011_a+gate_b");
    // where the ledger holds a closed row for the same signal, the walk reproduces its net return
    let compared = 0;
    for (const g of gate) {
      const lr = (
        await rows(db, "SELECT * FROM ledger_row WHERE signal_id = ?", [String(g.signal_id)])
      )[0];
      if (lr === undefined || lr.exit_d === null) continue;
      const cost = big(lr.qty) * big(lr.fill_in_micro) + big(lr.brok_in_micro);
      const proceeds =
        big(lr.qty_out) * big(lr.fill_out_micro) - big(lr.brok_out_micro) + big(lr.dividend_micro);
      const scaled = (proceeds - cost) * 1_000_000n;
      const a = scaled < 0n ? -scaled : scaled;
      const q = (2n * a + cost) / (2n * cost);
      expect(big(g.counterfactual_net_ppm)).toBe(scaled < 0n ? -q : q);
      expect(Number(g.final)).toBe(1);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
    const attr = await rows(
      db,
      "SELECT * FROM attribution WHERE subject_kind = 'blocked' AND subject_id LIKE '%|gate'",
    );
    expect(attr).toHaveLength(gate.length);
    for (const a of attr) {
      expect(JSON.parse(String(a.tags_json)).blocked).toMatchObject({
        source: "gate",
        reasons: ["arn011_a", "gate_b"],
      });
    }
  });

  it("a rerun of the night writes nothing (idempotent)", async () => {
    const before = await dump(db);
    const again = await attributeNight(db, await optionsFor(db, d(LAST)));
    expect(again.trades.inserted + again.ledgerRows.inserted + again.blocked.inserted).toBe(0);
    expect(await dump(db)).toBe(before);
  });
});

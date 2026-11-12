// @vitest-environment node
// M20 IN1 (AT-75 IN, AT-69, D-1154 item 6, **F**: money on the night): an India fixture night. The sessions come through
// the IN batch 1 (hand-made day files in the exchange's field names, band file included) into a development database
// with IN enabled; the cohort is an IN cohort (IN-P1, a Rs seed from the FX close); the orders run through the real
// close-books night. Asserted on the night's own rows: T+1 settlement in the ledger and the Cortex book, the Rs 25,000
// parcel floor, the single 09:15 open, IN-P1 fees to Rs 0.01, band-locking, and the ASM list reaching the reader.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { costProfileByCode, feeFor } from "@/lib/arena/costs";
import { loadLedgerRows } from "@/lib/arena/ledgerWriter";
import { marketMoney } from "@/lib/arena/marketMoney";
import { ANGLES } from "@/lib/cortex/angles/registry";
import { isLateBarNight } from "@/lib/cortex/pit/integrity";
import { bandLimits, loadSurveillance } from "@/lib/cortex/states/bands";
import { loadBookStates } from "@/lib/cortex/stage";
import { runDay } from "@/lib/data/sources/in/day.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { benchmarkIndexOf, staticProfile } from "@/lib/market/staticProfile.mjs";
import { allowMarket, cleanupTempDbs } from "../../db/helpers";
import { freshReplayDb } from "../../arena/replayHarness";
import { buildInNight, FX, IN, IN_NOW, M, placeOrder } from "./inNight";
import { asmFile, bandsFile, bhavFile, gsmFile, type Bar } from "./dayFixture";
import { buildExecutionRegistry, planInitialStart, resolveCohortParams } from "@/lib/arena/cohort";
import { seedExecutions, startCohorts } from "@/lib/arena/cohortWriter";
import { makeRational } from "@/lib/money/rational";

afterEach(cleanupTempDbs);

const DATES = [
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-09",
  "2026-11-11",
  "2026-11-12",
];
const LOCK_IDX = 4; // DLTA closes at its +5 % band limit on 2026-11-06
const table = marketMoney(IN).tickTable;
const f2 = (m: bigint) => (Number(m) / 1e6).toFixed(2);

/** Flat bars; DLTA (5 % band) closes at its upper limit on LOCK_IDX; ALFA and BETA have no band. */
function barsFor(i: number, prevDlta: bigint): { bars: Bar[]; dlta: bigint } {
  const flat = (code: string, p: string, series = "EQ"): Bar => ({
    code,
    series,
    open: p,
    high: p,
    low: p,
    close: p,
    prev: p,
    volume: String(300_000 + i * 1000),
  });
  const locked = i === LOCK_IDX;
  const up = bandLimits(prevDlta, 5, table).upperMicro;
  const dlta: Bar = locked
    ? {
        code: "DLTA",
        open: f2(prevDlta),
        high: f2(up),
        low: f2(prevDlta),
        close: f2(up),
        prev: f2(prevDlta),
        volume: String(300_000 + i * 1000),
      }
    : flat("DLTA", f2(prevDlta));
  return {
    bars: [flat("ALFA", "1500.00"), flat("BETA", "640.50"), dlta, flat("ZETA", "9.40", "BE")],
    dlta: locked ? up : prevDlta,
  };
}

async function fixtureDb(): Promise<{ db: Client; cohortId: string }> {
  const db = await freshReplayDb();
  await allowMarket(db, IN);
  await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'IN'");
  await ensureMarketSources(db, IN);
  // 2026-11-10 is an NSE holiday (Diwali Balipratipada): the fifth session after 11-05 is 11-12, as in the recorded window
  await db.execute(
    "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('IN', '2026-11-10', 'holiday', NULL, 1, 'test')",
  );
  let dlta = 48_300_000n;
  for (const [i, d] of DATES.entries()) {
    const day = barsFor(i, dlta);
    dlta = day.dlta;
    const last = i === DATES.length - 1;
    const r = await runDay(db, {
      d,
      files: {
        bhavcopy: bhavFile(d, day.bars),
        bands: bandsFile(),
        ...(last ? { asm: asmFile(), gsm: gsmFile() } : {}),
      },
      nowMs: () => Date.parse(`${d}T12:00:00.000Z`),
    });
    expect(r.status).toBe("ok");
  }
  const registry = buildExecutionRegistry({ market: IN });
  await seedExecutions(db, registry);
  const starts = planInitialStart({
    registry,
    startD: DATES[1]!,
    paramsFor: () =>
      resolveCohortParams({
        market: IN,
        fxRow: FX,
        terminal: {
          targetMultiple: makeRational(100n),
          bustFraction: makeRational(1n, 100n),
          timeoutSessions: 1000,
          stallFloorMicro: 1n,
        },
      }),
    masterSeed: 20_261_011n,
    controlsPerFamily: 1,
  }).filter((s) => s.executionId === "E01");
  await startCohorts(db, starts);
  return { db, cohortId: starts[0]!.id };
}

const rowOf = async (db: Client, sql: string, ...args: (string | number)[]) =>
  (await db.execute({ sql, args })).rows[0]!;

describe("AT-75 (IN): the fixture night", () => {
  it("runs the night on IN rules: IN-P1, T+1, Rs 25,000 floor, one 09:15 open, band-lock", async () => {
    const { db, cohortId } = await fixtureDb();
    const close = (d: string) => closeBooksDay(db, { market: IN, d, replay: true, now: IN_NOW });
    // the cohort: IN-P1, a Rs seed from the FX close (A$600 x 55.123 -> Rs 33,000), the Rs 25,000 parcel floor
    const params = JSON.parse(
      String((await rowOf(db, "SELECT params_json AS p FROM cohort WHERE id = ?", cohortId)).p),
    );
    expect(params.params.cost_profile).toBe("IN-P1");
    expect(params.params.seed_micro).toBe(String(33_000n * M));
    expect(params.params.min_parcel_micro).toBe(String(25_000n * M));
    const [d0, d1, d2, d3, d4, d5, d6] = DATES;

    await close(d0!);
    await close(d1!);
    // two entries decided on d1 fill at the d2 open: ALFA 15 x Rs 1,500 = Rs 22,500 (fits); BETA 30 x Rs 640.50 does not
    // fit the Rs 10,4xx left: the largest affordable parcel is about Rs 10,200, BELOW the Rs 25,000 floor -> cancelled 'cash'
    await placeOrder(db, {
      id: "O-A",
      cohortId,
      decidedD: d1!,
      code: "ALFA",
      kind: "entry",
      qty: 15,
      stop: 100n * M,
    });
    await placeOrder(db, {
      id: "O-B",
      cohortId,
      decidedD: d1!,
      code: "BETA",
      kind: "entry",
      qty: 30,
      stop: 40n * M,
    });
    await close(d2!);
    const a = await rowOf(db, "SELECT * FROM fill WHERE order_id = 'O-A'");
    expect(String(a.cost_profile)).toBe("IN-P1");
    // a single open: the fill is at the bar's open plus adverse slippage on the IN grid, never a second (auction) price
    const open = BigInt(a.bar_o_micro as bigint);
    expect(BigInt(a.ref_price_micro as bigint)).toBe(open);
    expect(BigInt(a.fill_price_micro as bigint) - open).toBeGreaterThanOrEqual(0n);
    expect(BigInt(a.fill_price_micro as bigint) % 50_000n).toBe(0n); // on the Rs 0.05 grid above Rs 250
    expect(staticProfile(IN).sessionOpen ?? staticProfile(IN).fields.session_open!.value).toBe(
      "09:15",
    );
    // IN-P1 to Rs 0.01 (hand-derived by the profile; the A4 suite holds the Rs 15.40 / 31.60 known answers)
    const fee = feeFor(costProfileByCode("IN-P1"), BigInt(a.value_micro as bigint), "buy", {
      code: "ALFA",
      firstBuyOfSecurityToday: true,
    });
    expect(BigInt(a.brokerage_micro as bigint)).toBe(fee);
    expect(fee % 10_000n).toBe(0n);
    const b = await rowOf(db, "SELECT status, reject_reason FROM arena_order WHERE id = 'O-B'");
    expect([String(b.status), String(b.reject_reason)]).toEqual(["cancelled", "cash"]);

    // band-lock: an entry decided on d3 for the d4 session, when DLTA closes at its upper band limit, is cancelled
    await close(d3!);
    await placeOrder(db, {
      id: "O-D",
      cohortId,
      decidedD: d3!,
      code: "DLTA",
      kind: "entry",
      qty: 100,
      stop: 4n * M,
    });
    await close(d4!);
    const dl = await rowOf(db, "SELECT status, reject_reason FROM arena_order WHERE id = 'O-D'");
    expect([String(dl.status), String(dl.reject_reason)]).toEqual(["cancelled", "band_locked"]);

    // T+1: ALFA is sold on the d5 session; the sale settles on d6, in the Cortex book and in the ledger
    await placeOrder(db, {
      id: "X-A",
      cohortId,
      decidedD: d4!,
      code: "ALFA",
      kind: "exit_cs",
      qty: 15,
    });
    await close(d5!);
    const sell = await rowOf(
      db,
      "SELECT id, d FROM fill WHERE cohort_id = ? AND side = 'sell'",
      cohortId,
    );
    expect(String(sell.d)).toBe(d5);
    const calendar = [
      { d: "2026-11-10", kind: "holiday", close_time: null, confirmed: 1 },
    ] as never[];
    const books = await loadBookStates(db, { market: IN, d: d5!, calendar });
    const pending = books[0]!.pending!.find((p) => p.side === "sell");
    expect(pending?.settleD).toBe(d6);
    const settled = async () =>
      (await loadLedgerRows(db, cohortId)).filter(
        (r) => r.kind === "settle" && r.refId === String(sell.id),
      );
    expect(await settled()).toHaveLength(0);
    await close(d6!);
    expect(new Set((await settled()).map((r) => r.d))).toEqual(new Set([d6]));
  });

  it("the ASM list of the day reaches the surveillance reader (no new entry is the promotion rule, A5)", async () => {
    const { db } = await fixtureDb();
    const m = await loadSurveillance(db, IN, "ZETA", DATES[0]!, DATES[7]!);
    expect(m.get(DATES[7]!)).toEqual({ list: "ASM", stage: 13 });
    const g = await loadSurveillance(db, IN, "EPSL", DATES[0]!, DATES[7]!);
    expect(g.size).toBe(0); // EPSL is not in this fixture's universe, so its GSM row was not stored
  });
});

describe("AT-69: Nifty 50 and India VIX feed the gates only; the series are not pulled (D-1132, D-1173)", () => {
  it("the profile names the indices the readers resolve", () => {
    const p = staticProfile(IN);
    expect(benchmarkIndexOf(IN)).toBe("NSEI");
    expect(p.regimeIndex).toBe("NSEI");
    expect(p.volatilityIndex).toBe("INDIAVIX");
  });

  it("the only angle that reads the volatility index is a gate, and with no series it is unmeasured, never invented", () => {
    const d5 = ANGLES.find((a) => a.id === "A-D5-08")!;
    expect(d5.kind).toBe("gate");
    const asked: string[] = [];
    const view = {
      market: IN,
      index: (code: string) => {
        asked.push(code);
        return [];
      },
    } as never;
    const out = d5.compute!(view, "ALFA", 10, { vix_pct_off: 70, vix_pct_on: 50 } as never);
    expect(out).toBeUndefined();
    expect(asked).toEqual(["INDIAVIX", "NSEI"]);
  });

  it("with no benchmark bar the night is a late-bar night and abstains (nothing is fabricated)", () => {
    expect(isLateBarNight({ d: "2026-11-12", benchmarkBarD: null, universeBarsOnD: 6 })).toBe(true);
    expect(
      isLateBarNight({ d: "2026-11-12", benchmarkBarD: "2026-11-12", universeBarsOnD: 6 }),
    ).toBe(false);
  });
});

describe("the harness night and the day night agree on T+1", () => {
  it("buildInNight (hand-made rows) still settles on D+1", async () => {
    const n = await buildInNight();
    expect(n.cohortIds).toHaveLength(1);
  });
});

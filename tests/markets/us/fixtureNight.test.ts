// @vitest-environment node
// M20 US1 (AT-75 US, AT-70, D-1154 item 5, D-1182; AT-M3/AT-M5 US): the US fixture night, on the synthetic data set
// (fictional codes, source synthetic_fixture, see scripts/ingest/us/synthetic.mjs; no real price exists, D-1132).
//   1. the five nights land complete (the batch-1 day);
//   2. SEC and FINRA fees are charged on the night's SELLS (quantity threaded, the dated US-P1 of the session), a buy
//      pays nothing;
//   3. the SIC two-digit group reaches the NAV cap: the Cortex stage loads `industry` through the `sic_2digit`
//      reader and the G11 gate counts two codes of one group together;
//   4. the Cortex night's rule sets resolve for the US profile (halt model, category map, classification).
// NOT proven here, and waiting on IN1 (see the `it.todo`s): the settlement lag threading (the US settles T+1, the
// stage, replay and batch-2b sites still default to the home lag until IN1 closes D-1154 item 1) and the tick grid.
import { afterEach, describe, expect, it } from "vitest";
import {
  allMarketCostProfileCodes,
  cohortCostProfile,
  costProfilesOfMarket,
  feeFor,
} from "@/lib/arena/costs";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { buildExecutionRegistry, planInitialStart, resolveCohortParams } from "@/lib/arena/cohort";
import { seedExecutions, startCohorts } from "@/lib/arena/cohortWriter";
import { loadLedgerRows } from "@/lib/arena/ledgerWriter";
import { marketMoney } from "@/lib/arena/marketMoney";
import { stallFloorMicro } from "@/lib/arena/sizing";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { profileOnDate } from "@/lib/arena/costAsOf";
import { fillIntradayStop } from "@/lib/arena/fills";
import { defaultAgentParams } from "@/lib/agents/params";
import { loadBookStates, loadStageRows } from "@/lib/cortex/stage";
import {
  categoryMapReader,
  classificationReader,
  haltReader,
  sicTwoDigit,
} from "@/lib/cortex/profileReaders";
import { gatePortfolio, groupOf } from "@/lib/cortex/gates/portfolio";
import { makeRational } from "@/lib/money/rational";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { allowMarket, cleanupTempDbs } from "../../db/helpers";
import { freshReplayDb } from "../../arena/replayHarness";
import { ensureCalendarYears } from "@/lib/data/calendarEnable.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { DAYS, FIXTURES, MARKET, runNight, sessionFiles, usDevDb } from "./usDev";

afterEach(cleanupTempDbs);

const USD = (n: bigint) => n * 1_000_000n;
const profile = staticProfile(MARKET);

/** The same five nights in a bigint-mode database (the close-books night reads 64-bit micro columns). */
async function bigintFiveNights() {
  const db = await freshReplayDb();
  await allowMarket(db, MARKET);
  await db.execute({ sql: "UPDATE market SET mode = 'data_only' WHERE code = ?", args: [MARKET] });
  await ensureMarketSources(db, MARKET);
  await ensureCalendarYears(db, MARKET, [2026]);
  for (const c of FIXTURES.companies) {
    await db.execute({
      sql: "INSERT INTO instrument (market, code, name, listed_on) VALUES (?, ?, ?, '2020-01-02')",
      args: [MARKET, c.code, c.name],
    });
  }
  for (const d of DAYS) {
    const { barsText, feeds } = sessionFiles(d);
    expect((await runNight(db, d, { barsText, feeds })).exit).toBe(0);
  }
  return db;
}

async function fiveNights() {
  const db = await usDevDb();
  for (const d of DAYS) {
    const { barsText, feeds } = sessionFiles(d);
    const r = await runNight(db, d, { barsText, feeds });
    expect(r.exit).toBe(0);
  }
  return db;
}

describe("the US fixture night", () => {
  it("SEC and TAF fees on the night's sells: the dated US-P1 of the session, the quantity of the fill; a buy pays nothing", async () => {
    const db = await fiveNights();
    const d = DAYS[4]!;
    const bar = (
      await db.execute({
        sql: "SELECT o, h, l, c FROM price_bar WHERE market = 'US' AND code = 'ZZA' AND d = ?",
        args: [d],
      })
    ).rows[0]!;
    const m = (x: unknown) => BigInt(Math.round(Number(x) * 1e6));
    const env = {
      bar: { openMicro: m(bar.o), highMicro: m(bar.h), lowMicro: m(bar.l), closeMicro: m(bar.c) },
      advMicro: USD(50_000_000n),
      profile: profileOnDate(costProfilesOfMarket(MARKET)["US-P1"]!, d), // the 2026-04-04 schedule: SEC 0.00206 %, TAF 0.000195
    };
    // a stop-out sell inside the day's range: the fill's fee is the engine's answer for ITS value and quantity
    const stop = fillIntradayStop(env, 200n, m(bar.l) + 1n);
    expect(stop).not.toBeNull();
    const sec = (stop!.valueMicro * 206n) / 10_000_000n; // 0.00206 % of the value, micro (exact before the cent rounding)
    const roundCent = (x: bigint) => ((x + 5_000n) / 10_000n) * 10_000n;
    const taf = roundCent(200n * 195n); // 200 shares x 0.000195, micro, min 0.01
    const expected = roundCent(sec) + (taf < 10_000n ? 10_000n : taf);
    expect(stop!.brokerageMicro).toBe(expected);
    expect(stop!.brokerageMicro).toBe(
      feeFor(env.profile, stop!.valueMicro, "sell", { quantity: 200n }),
    );
    // the same value as a BUY costs nothing
    expect(feeFor(env.profile, stop!.valueMicro, "buy", { quantity: 200n })).toBe(0n);
  });

  it("the SIC group reaches the Cortex stage: instrument.industry holds the two digits, the reader groups by them", async () => {
    const db = await fiveNights();
    const reader = classificationReader(profile);
    expect(reader.scheme).toBe("sic_2digit");
    const rows = await db.execute(
      "SELECT code, industry FROM instrument WHERE market = 'US' ORDER BY code",
    );
    expect(rows.rows.map((r) => groupOf(reader, { industry: r.industry as string }))).toEqual([
      "73",
      "60",
      "53",
      "28",
    ]);
    const cal = (
      await db.execute(
        "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = 'US'",
      )
    ).rows.map((r) => ({
      d: String(r.d),
      kind: String(r.kind) as "session" | "holiday" | "early_close",
      closeTime: r.close_time === null ? null : String(r.close_time),
      confirmed: Number(r.confirmed),
    }));
    const stage = await loadStageRows(db, {
      market: MARKET,
      d: DAYS[4]!,
      params: defaultAgentParams(),
      calendar: cal as never,
      liveIngestBound: false,
      heldCodes: ["ZZA", "ZZB"],
    });
    const ind = (code: string) => stage.industry.get(code)?.[0]?.industry;
    expect([ind("ZZA"), ind("ZZB"), ind("ZZC"), ind("ZZD")]).toEqual(["73", "60", "53", "28"]);
  });

  it("the NAV cap counts two codes of one SIC group together (G11, per-industry)", () => {
    const reader = classificationReader(profile);
    const g = (sic: string) => groupOf(reader, { sic });
    expect([g("7372"), g("7389"), g("6022")]).toEqual(["73", "73", "60"]);
    const caps = {
      maxBooksSameCode: 3,
      maxCodeNavShare: makeRational(1n, 1n),
      maxIndustryNavShare: makeRational(30n, 100n),
    };
    const base = { bookId: "b1", arenaNavMicro: USD(1_000n), caps };
    // 200 held in group 73 (ZZA) and 150 more proposed in group 73 (another software code): 350 / 1,000 = 35 % > 30 %
    const held = [{ bookId: "b2", code: "ZZA", industry: g("7372"), exposureMicro: USD(200n) }];
    const sameGroup = gatePortfolio({
      ...base,
      code: "ZZX",
      industry: g("7389"),
      orderValueMicro: USD(150n),
      exposures: held,
    });
    expect(sameGroup.pass).toBe(false);
    // the same 150 in another group (60, banks) passes
    const other = gatePortfolio({
      ...base,
      code: "ZZB",
      industry: g("6022"),
      orderValueMicro: USD(150n),
      exposures: held,
    });
    expect(other.pass).toBe(true);
    expect(sicTwoDigit("7372")).toBe("73");
  });

  it("the US profile resolves its Cortex rule sets (halt model, category map, classification), none by a market literal", () => {
    expect(haltReader(profile)).toBe("us_luld");
    expect(categoryMapReader(profile)?.version).toBe("us-categories-v1");
    expect(classificationReader(profile).scheme).toBe("sic_2digit");
  });

  it("the LULD pause of the fixture is on file and does not make a halted session (it resolved inside the session)", async () => {
    const db = await fiveNights();
    const h = await db.execute(
      "SELECT code, kind, halted_at, resumed_at FROM trading_halt WHERE market = 'US' AND code = 'ZZC'",
    );
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.kind).toBe("luld");
  });

  // ---- the lag, tick and cohort sites IN1 threaded (D-1154 items 1-4, D-1170) ----
  it("the guard test: a US sale on D settles on D+1 in the ledger and in BookState.pending", async () => {
    const db = await bigintFiveNights();
    const registry = buildExecutionRegistry({ market: MARKET });
    await seedExecutions(db, registry);
    const starts = planInitialStart({
      registry,
      startD: DAYS[1]!,
      paramsFor: () =>
        resolveCohortParams({
          market: MARKET,
          fxRow: { rate: "0.65", date: "2026-11-01", source: "FXRUSD" },
          terminal: {
            targetMultiple: makeRational(100n),
            bustFraction: makeRational(1n, 100n),
            timeoutSessions: 1000,
            stallFloorMicro: 1n,
          },
        }),
      masterSeed: 20_261_011n,
      controlsPerFamily: 1,
    }).filter((x) => x.executionId === "E01");
    await startCohorts(db, starts);
    const cohortId = starts[0]!.id;
    const close = (d: string) =>
      closeBooksDay(db, { market: MARKET, d, replay: true, now: () => "2031-01-01T00:00:00.000Z" });
    const order = (id: string, decidedD: string, kind: string, qty: number) =>
      db.execute({
        sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
              VALUES (?, ?, ?, 'ZZA', ?, ?, ?, ?, 'U1')`,
        args: [
          id,
          cohortId,
          decidedD,
          kind === "entry" ? "buy" : "sell",
          kind,
          qty,
          kind === "entry" ? 2_000_000 : null,
        ],
      });
    const [d0, d1, d2, d3, d4] = DAYS;
    await close(d0!);
    await close(d1!);
    await order("O1", d1!, "entry", 5);
    await close(d2!);
    await order("X1", d2!, "exit_cs", 5);
    await close(d3!);
    const sell = (
      await db.execute({
        sql: "SELECT id, d FROM fill WHERE cohort_id = ? AND side = 'sell'",
        args: [cohortId],
      })
    ).rows[0]!;
    expect(String(sell.d)).toBe(d3);
    const books = await loadBookStates(db, { market: MARKET, d: d3!, calendar: [] });
    expect(books[0]!.pending!.find((x) => x.side === "sell")?.settleD).toBe(d4);
    await close(d4!);
    const posted = (await loadLedgerRows(db, cohortId)).filter(
      (r) => r.kind === "settle" && r.refId === String(sell.id),
    );
    expect(new Set(posted.map((r) => r.d))).toEqual(new Set([d4]));
  });

  it("the US tick grid reaches the minimum price, the replay sensitivity and the stall floor", () => {
    const money = marketMoney(MARKET);
    expect(money.tickTable[0]!.tickMicro).toBe(100n); // $0.0001
    expect(money.lagSessions).toBe(1);
    // a stop at $0.0002: the D-184 floor of a sell is the market's lowest tick, not the home market's
    const f = fillIntradayStop(
      {
        bar: { openMicro: 300n, highMicro: 300n, lowMicro: 150n, closeMicro: 200n },
        advMicro: 0n,
        profile: costProfilesOfMarket(MARKET)["US-P1"]!,
        tickTable: money.tickTable,
        buckets: money.buckets,
      },
      10n,
      200n,
    )!;
    expect(f.fillPriceMicro).toBeGreaterThanOrEqual(100n);
    expect(f.fillPriceMicro % 100n).toBe(0n);
    const floor = stallFloorMicro({
      profile: costProfilesOfMarket(MARKET)["US-P1"]!,
      parcelMicro: money.parcelMicro,
      marketProfile: profile,
      tickTable: money.tickTable,
      refPriceMicro: 500_000n, // $0.50: one tick is 2 bps, so max(10 bps, a tick) stays the 10 bps floor
    });
    expect(floor).toBeGreaterThan(money.parcelMicro);
  });

  it("the US cohort uses the US table, the FX seed and US-P1 is an accepted profile code", async () => {
    const p = resolveCohortParams({
      market: MARKET,
      fxRow: { rate: "0.65", date: "2026-11-01", source: "FXRUSD" },
    });
    expect(p.costProfile).toBe("US-P1");
    expect(p.seedMicro).toBe(USD(390n)); // A$600 x 0.65, to US$10
    expect(p.minParcelMicro).toBe(marketMoney(MARKET).parcelMicro);
    expect(cohortCostProfile(p).code).toBe("US-P1");
    expect(allMarketCostProfileCodes()).toContain("US-P1");
    expect(await CONFIG_KEYS.cost_profile_default!.validate!("US-P1")).toBeNull();
  });
});

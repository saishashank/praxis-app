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
import { feeFor, costProfilesOfMarket } from "@/lib/arena/costs";
import { profileOnDate } from "@/lib/arena/costAsOf";
import { fillIntradayStop } from "@/lib/arena/fills";
import { defaultAgentParams } from "@/lib/agents/params";
import { runBatch1 } from "@/lib/data/pipeline/batch1-core.mjs";
import { loadStageRows } from "@/lib/cortex/stage";
import {
  categoryMapReader,
  classificationReader,
  haltReader,
  sicTwoDigit,
} from "@/lib/cortex/profileReaders";
import { gatePortfolio, groupOf } from "@/lib/cortex/gates/portfolio";
import { makeRational } from "@/lib/money/rational";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { cleanupTempDbs } from "../../db/helpers";
import { DAYS, MARKET, nightMs, sessionFiles, usDevDb } from "./usDev";

afterEach(cleanupTempDbs);

const USD = (n: bigint) => n * 1_000_000n;
const profile = staticProfile(MARKET);

async function fiveNights() {
  const db = await usDevDb();
  for (const d of DAYS) {
    const { barsText, feeds } = sessionFiles(d);
    const r = await runBatch1(db, { nowMs: () => nightMs(d), market: MARKET, barsText, feeds });
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

  // ---- waiting on IN1 (D-1154 item 1: the lag and tick sites IN1 alone threads) ----
  it.todo(
    "[waits on IN1] the guard test: a US fixture night asserts settleD = D+1 in the ledger and in BookState.pending (stage.ts:651, cohortReplay.ts:805, batch2b.ts:622 pass profile.settlementDays)",
  );
  it.todo(
    "[waits on IN1] the US tick grid ($0.0001 below $1) reaches FillEnv, the minimum price (fills.ts:232), the replay sensitivity and the stall floor",
  );
  it.todo(
    "[waits on IN1] the US cohort uses costProfilesOfMarket and seedForMarket (arena/cohort.ts) and the profile codes of keys.ts:2133 and streamCost.ts:44 accept US-P1",
  );
});

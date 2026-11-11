// @vitest-environment node
// OPS-111 (2), D-977: the router records the provider's returned token counts per call, and the budget
// reservation is the estimate raised to the trailing measured mean of that role (the estimate is the
// floor). No network.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { requestReservation, reservationWithMeasured } from "@/lib/llm/router";
import {
  DbStore,
  isMeasuredCall,
  MEASURED_WINDOW_DAYS,
  MemoryStore,
  meanTokensPerCall,
  measuredWindowStart,
  type CallRow,
} from "@/lib/llm/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { fixture, fixtureFor, makeRouter, mockProvider, request } from "./helpers";

afterEach(cleanupTempDbs);

const row = (over: Partial<CallRow>): CallRow => ({
  id: Math.random().toString(36).slice(2),
  role: "R2",
  provider: "mock",
  modelId: "mock-1",
  fallbackDepth: "0",
  tokensIn: 400,
  tokensOut: 100,
  cached: 0,
  outcome: "ok",
  injectionFiltered: 0,
  market: "AU",
  d: "2026-03-05",
  ...over,
});

describe("reservationWithMeasured (pure)", () => {
  it("the estimate is the floor; a larger measured need (two calls) raises it", () => {
    expect(reservationWithMeasured(1000, null)).toBe(1000);
    expect(reservationWithMeasured(1000, 0)).toBe(1000);
    expect(reservationWithMeasured(1000, Number.NaN)).toBe(1000);
    expect(reservationWithMeasured(1000, 300)).toBe(1000); // 600 < 1000: never lowered
    expect(reservationWithMeasured(1000, 800)).toBe(1600);
    expect(reservationWithMeasured(1000, 500.2)).toBe(1001);
  });
});

describe("the trailing measured mean", () => {
  it("counts only answered provider calls of the role, market and window", () => {
    expect(MEASURED_WINDOW_DAYS).toBe(7);
    expect(measuredWindowStart("2026-03-05")).toBe("2026-02-27");
    const rows = [
      row({}), // 500
      row({ tokensIn: 900, tokensOut: 100 }), // 1000
      row({ d: "2026-02-26" }), // outside the window
      row({ d: "2026-03-06" }), // after the day
      row({ cached: 1 }),
      row({ outcome: "rules-only" }),
      row({ provider: "none", tokensIn: 0, tokensOut: 0, outcome: "critic_unavailable" }),
      row({ role: "R6" }),
      row({ market: "XX" }),
    ];
    expect(rows.filter(isMeasuredCall)).toHaveLength(7 - 1); // the later day still reads as a measured call
    expect(meanTokensPerCall(rows, "R2", "AU", "2026-03-05")).toBe(750);
    expect(meanTokensPerCall([], "R2", "AU", "2026-03-05")).toBeNull();
  });

  it("MemoryStore and DbStore agree on the same rows", async () => {
    const rows = [row({}), row({ tokensIn: 900, tokensOut: 100 }), row({ d: "2026-02-20" })];
    const mem = new MemoryStore();
    const db = await freshDb("main");
    const dbs = new DbStore(db);
    for (const r of rows) {
      await mem.recordCall(r);
      await dbs.recordCall(r);
    }
    expect(await mem.measuredMean("R2", "AU", "2026-03-05")).toBe(750);
    expect(await dbs.measuredMean("R2", "AU", "2026-03-05")).toBe(750);
    expect(await dbs.measuredMean("R3", "AU", "2026-03-05")).toBeNull();
  });
});

describe("the router", () => {
  it("records the provider's returned counts, and a measured need above the estimate stops the call", async () => {
    const req = request();
    const p = mockProvider(fixtureFor(req, { note: "ok" }));
    const params = defaultAgentParams().llm;
    // First call: the estimate fits and the provider's own counts (120 in, 30 out) are recorded.
    const first = makeRouter("mock", [p]);
    const r1 = await first.router.route(req);
    expect(r1.outcome).toBe("ok");
    expect(first.store.rows[0]).toMatchObject({ tokensIn: 120, tokensOut: 30, outcome: "ok" });

    // A role whose recent calls cost far more than the estimate: the reservation follows the measurement.
    const est = requestReservation(req, req.untrusted);
    const share = params.marketShare.AU;
    const cap = Number((BigInt(params.roleDailyTokens.R2) * share.num) / share.den);
    expect(est).toBeLessThan(cap); // the estimate alone fits
    const big = Math.ceil(cap / 2) + 1; // two such calls (first + repair) exceed the cap
    const store = new MemoryStore();
    await store.recordCall(row({ tokensIn: big, tokensOut: 0, d: "2026-03-04", market: "AU" }));
    const second = makeRouter("mock", [p], store);
    const r2 = await second.router.route(request({ d: "2026-03-05" }));
    expect(r2.budgetExhausted).toBe(true);
    expect(r2.source).toBe("rules-only");
    // Without the measurement the same request goes through.
    const third = makeRouter("mock", [p], new MemoryStore());
    expect((await third.router.route(request({ d: "2026-03-05" }))).budgetExhausted).toBe(false);
    void fixture;
  });
});

// @vitest-environment node
// TST-104 style property tests for the ledger invariants (ARN-101, ARN-102; AT-12, AT-13): random
// synthetic fill sequences, both settlement modes, calendar with random holidays, dividends.
// Every run must keep every invariant, recompute exactly, match an independent cash-flow oracle
// and replay byte for byte. 1,000 simulated days must not drift by one micro.
import { describe, expect, it } from "vitest";
import { checkCohortBooks, replayIdentical } from "@/lib/arena/invariants";
import { balancesFromRows, availableCash, pendingSettlements } from "@/lib/arena/ledger";
import { buildNavSeries, serializeNavDays } from "@/lib/arena/nav";
import { simulate, type Sim } from "./ledgerHarness";

const MODES = ["matched", "conservative"] as const;

function verify(sim: Sim) {
  const violations = checkCohortBooks(sim.books, {
    mode: sim.mode,
    calendar: sim.calendar,
    dates: sim.dates,
    stored: sim.days,
    seedMicro: sim.seedMicro,
  });
  expect(violations).toEqual([]);
  for (const day of sim.days) {
    // NAV identity against an independent oracle (cash flows + positions at close), exactly
    expect(day.row.navMicro).toBe(sim.oracleNav.get(day.row.d));
    expect(day.row.liqNavMicro <= day.row.navMicro).toBe(true);
    expect(day.row.cashSettledMicro >= 0n).toBe(true);
  }
}

describe("random fill sequences keep every invariant", () => {
  for (const mode of MODES) {
    it(`${mode}: 30 seeds x 120 sessions`, () => {
      let fills = 0;
      let sells = 0;
      let held = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const sim = simulate({ seed, days: 120, mode });
        verify(sim);
        fills += sim.fills.length;
        sells += sim.fills.filter((f) => f.side === "sell").length;
        held += sim.days.filter((x) => x.row.openPositions > 0n).length;
      }
      // the generator really trades (guards against a vacuous pass)
      expect(fills).toBeGreaterThan(500);
      expect(sells).toBeGreaterThan(100);
      expect(held).toBeGreaterThan(1000);
    });
  }

  it("a larger seed still never goes negative on conservative cash", () => {
    const sim = simulate({ seed: 77, days: 150, mode: "conservative", seedMicro: 5_000_000_000n });
    verify(sim);
    expect(sim.fills.length).toBeGreaterThan(20);
  });
});

describe("no drift over 1,000 days", () => {
  for (const mode of MODES) {
    it(`${mode}: recompute equals stored for all 1,000 days, NAV equals the oracle`, () => {
      const sim = simulate({ seed: 2024, days: 1000, mode });
      expect(sim.dates).toHaveLength(1000);
      const recomputed = buildNavSeries(sim.books, sim.dates);
      expect(serializeNavDays(recomputed)).toBe(serializeNavDays(sim.days));
      for (const day of recomputed) expect(day.row.navMicro).toBe(sim.oracleNav.get(day.row.d));
      verify(sim);
    });
  }
});

describe("replay twice gives identical rows (ARN-102, NFR-022, AT-13)", () => {
  for (const mode of MODES) {
    it(`${mode}: same inputs, same bytes`, () => {
      const a = simulate({ seed: 5, days: 200, mode });
      const b = simulate({ seed: 5, days: 200, mode });
      expect(replayIdentical(a, b)).toBe(true);
      expect(serializeNavDays(a.days)).toBe(serializeNavDays(b.days));
      const other = simulate({ seed: 6, days: 200, mode });
      expect(replayIdentical(a, other)).toBe(false);
    });
  }
});

describe("matched and conservative on the same scripted sequence", () => {
  it("books are identical; only the cash available before settlement differs", () => {
    const sim = simulate({ seed: 9, days: 80, mode: "matched" });
    // re-evaluate availability under both modes at every date from the SAME ledger
    let strictlyLess = 0;
    for (const d of sim.dates) {
      const balances = balancesFromRows(sim.rows, d);
      const settled = new Set(
        sim.rows.filter((r) => r.kind === "settle" && r.d <= d).map((r) => r.refId ?? ""),
      );
      const pending = pendingSettlements(
        sim.fills.filter((f) => f.d <= d),
        settled,
        sim.calendar,
      );
      const matched = availableCash({ mode: "matched", balances, pending, sessionD: d });
      const conservative = availableCash({ mode: "conservative", balances, pending, sessionD: d });
      expect(conservative <= matched).toBe(true); // proceeds can only arrive later
      if (conservative < matched) strictlyLess += 1;
      // once nothing is pending the two coincide
      if (pending.length === 0) expect(conservative).toBe(matched);
    }
    expect(strictlyLess).toBeGreaterThan(0);
  });

  it("matched mode buys with unsettled proceeds, conservative never does", () => {
    // Over many seeds matched cohorts reach a state where settled cash alone could not have paid.
    let matchedLeans = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = simulate({ seed, days: 100, mode: "matched" });
      const c = simulate({ seed, days: 100, mode: "conservative" });
      for (const day of c.days) {
        expect(day.row.cashSettledMicro - day.row.payMicro >= 0n).toBe(true);
      }
      for (const day of m.days) {
        if (day.row.cashSettledMicro - day.row.payMicro < 0n) matchedLeans += 1;
      }
    }
    expect(matchedLeans).toBeGreaterThan(0);
  });
});

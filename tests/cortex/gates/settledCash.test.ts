// @vitest-environment node
// G12 settled cash, parcel and stall (M15 C3c; CTX-027; AT-56 fixture 10 "Monday sale, Tuesday buy →
// refused (settled-cash gate)"; ARN-071 stall predicate).
import { describe, expect, it } from "vitest";
import type { SettlementItem } from "@/lib/arena/ledger";
import type { CalendarRow } from "@/lib/data/calendar";
import {
  MIN_MARKETABLE_PARCEL_MICRO,
  PARCEL_LABEL,
  PARTICIPATION_LABEL,
  SETTLED_CASH_LABEL,
  STALL_SESSIONS,
  deployableCash,
  gateSettledCash,
  settlementDate,
  stallCheck,
  unsettledProceeds,
} from "@/lib/cortex/gates";
import { makeRational } from "@/lib/money/rational";

const M = 1_000_000n;
const sessions = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]; // Mon..Fri
const calendar: CalendarRow[] = sessions.map((d) => ({
  d,
  kind: "session",
  close_time: null,
  confirmed: 1,
}));

describe("deployableCash (CTX-027, T+2)", () => {
  // Monday sale of A$2,000 net: settles Wednesday the 4th
  const mondaySale: SettlementItem = {
    fillId: "f-sell-1",
    side: "sell",
    tradeD: "2026-03-02",
    settleD: settlementDate("2026-03-02", calendar),
    netMicro: 2_000n * M,
  };
  const cash = { settledCashMicro: 300n * M, pending: [mondaySale] };

  it("AT-56 fixture 10: a Monday sale cannot fund a Tuesday buy; it can fund a Wednesday buy", () => {
    expect(mondaySale.settleD).toBe("2026-03-04");
    // the Monday-night decision fills on Tuesday the 3rd: only the A$300 settled cash is deployable
    expect(deployableCash(cash, "2026-03-03")).toBe(300n * M);
    expect(unsettledProceeds(cash, "2026-03-03")).toBe(2_000n * M);
    const tuesday = gateSettledCash({
      deployableMicro: deployableCash(cash, "2026-03-03"),
      entryFeeMicro: 3n * M,
      halfSize: false,
    });
    expect(tuesday).toEqual({
      pass: false,
      gateId: "G12_settled_cash",
      label: SETTLED_CASH_LABEL,
      value: `deployable_net:${297n * M} < ${MIN_MARKETABLE_PARCEL_MICRO}`,
    });
    // the Tuesday-night decision fills on Wednesday: the proceeds are deployable
    expect(deployableCash(cash, "2026-03-04")).toBe(2_300n * M);
    expect(unsettledProceeds(cash, "2026-03-04")).toBe(0n);
    expect(
      gateSettledCash({
        deployableMicro: deployableCash(cash, "2026-03-04"),
        entryFeeMicro: 3n * M,
        halfSize: false,
      }),
    ).toEqual({
      pass: true,
      value: `deployable_net:${2_297n * M}`,
    });
  });

  it("buy payables are deducted in full; the result is never negative", () => {
    const payable: SettlementItem = {
      fillId: "f-buy-1",
      side: "buy",
      tradeD: "2026-03-02",
      settleD: "2026-03-04",
      netMicro: 1_000n * M,
    };
    expect(deployableCash({ settledCashMicro: 1_500n * M, pending: [payable] }, "2026-03-03")).toBe(
      500n * M,
    );
    expect(deployableCash({ settledCashMicro: 500n * M, pending: [payable] }, "2026-03-03")).toBe(
      0n,
    );
  });
});

describe("G12_settled_cash", () => {
  it("one parcel net of the fee passes; one micro short fails", () => {
    expect(
      gateSettledCash({ deployableMicro: 503n * M, entryFeeMicro: 3n * M, halfSize: false }).pass,
    ).toBe(true);
    expect(
      gateSettledCash({ deployableMicro: 503n * M - 1n, entryFeeMicro: 3n * M, halfSize: false }),
    ).toMatchObject({
      pass: false,
      gateId: "G12_settled_cash",
      label: SETTLED_CASH_LABEL,
    });
  });
  it("F4 at half size in SHOCK needs two parcels (FAM-009)", () => {
    expect(
      gateSettledCash({ deployableMicro: 900n * M, entryFeeMicro: 0n, halfSize: true }),
    ).toMatchObject({
      pass: false,
      value: `deployable_net:${900n * M} < ${2n * MIN_MARKETABLE_PARCEL_MICRO}:half_size`,
    });
    expect(
      gateSettledCash({ deployableMicro: 1_000n * M, entryFeeMicro: 0n, halfSize: true }).pass,
    ).toBe(true);
  });
  it("D-337: the label follows the sizing reason (cash, parcel / whole share, participation)", () => {
    const ok = { deployableMicro: 5_000n * M, entryFeeMicro: 3n * M, halfSize: false };
    expect(
      gateSettledCash({ ...ok, sizing: { accepted: false, reasons: ["cash"] } }),
    ).toMatchObject({ label: SETTLED_CASH_LABEL });
    expect(
      gateSettledCash({ ...ok, sizing: { accepted: false, reasons: ["parcel"] } }),
    ).toMatchObject({ label: PARCEL_LABEL });
    expect(
      gateSettledCash({ ...ok, sizing: { accepted: false, reasons: ["whole_share"] } }),
    ).toMatchObject({ label: PARCEL_LABEL });
    expect(
      gateSettledCash({ ...ok, sizing: { accepted: false, reasons: ["participation"] } }),
    ).toMatchObject({ label: PARTICIPATION_LABEL });
  });

  it("a sizing rejection fails the gate with the engine's reasons", () => {
    expect(
      gateSettledCash({
        deployableMicro: 5_000n * M,
        entryFeeMicro: 3n * M,
        halfSize: false,
        sizing: { accepted: false, reasons: ["participation"] },
      }),
    ).toEqual({
      pass: false,
      gateId: "G12_settled_cash",
      label: PARTICIPATION_LABEL,
      value: "sizing:participation",
    });
    expect(
      gateSettledCash({
        deployableMicro: 5_000n * M,
        entryFeeMicro: 3n * M,
        halfSize: false,
        sizing: { accepted: true, reasons: [] },
      }).pass,
    ).toBe(true);
  });
});

describe("stallCheck (ARN-071 through CTX-027)", () => {
  const maxLoss = makeRational(18n, 100n);
  it("no position and under one parcel for five consecutive sessions → stalled; unsettled proceeds keep it alive", () => {
    let run = 0;
    let stalled = false;
    for (let i = 0; i < STALL_SESSIONS; i += 1) {
      const r = stallCheck(
        {
          hasOpenPosition: false,
          deployableMicro: 400n * M,
          unsettledProceedsMicro: 0n,
          runSessions: run,
        },
        maxLoss,
      );
      run = r.runSessions;
      stalled = r.stalled;
    }
    expect(run).toBe(5);
    expect(stalled).toBe(true);
    const alive = stallCheck(
      {
        hasOpenPosition: false,
        deployableMicro: 400n * M,
        unsettledProceedsMicro: 200n * M,
        runSessions: 4,
      },
      maxLoss,
    );
    expect(alive).toMatchObject({ belowFloor: false, runSessions: 0, stalled: false });
    expect(
      stallCheck(
        { hasOpenPosition: true, deployableMicro: 0n, unsettledProceedsMicro: 0n, runSessions: 4 },
        maxLoss,
      ).stalled,
    ).toBe(false);
  });
  it("near the floor (within one capped loss) raises the Owner item before entry", () => {
    // 500 / 0.82 = 609.76: A$600 is near the floor, A$700 is not
    expect(
      stallCheck(
        {
          hasOpenPosition: false,
          deployableMicro: 600n * M,
          unsettledProceedsMicro: 0n,
          runSessions: 0,
        },
        maxLoss,
      ).nearFloor,
    ).toBe(true);
    expect(
      stallCheck(
        {
          hasOpenPosition: false,
          deployableMicro: 700n * M,
          unsettledProceedsMicro: 0n,
          runSessions: 0,
        },
        maxLoss,
      ).nearFloor,
    ).toBe(false);
  });
});

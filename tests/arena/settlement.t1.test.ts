// @vitest-environment node
// M20 A4 (D-1113, AT-69 funding clause): T+1 settlement for IN and US, T+2 for AU, from the profile's
// `settlement_days`; the settled-cash funding gate on a three-session calendar. Hand-worked.
import { describe, expect, it } from "vitest";
import {
  pendingSettlements,
  settlementDate,
  settlementItem,
  type LedgerFill,
} from "@/lib/arena/ledger";
import type { CalendarRow } from "@/lib/data/calendar";
import { deployableCash } from "@/lib/cortex/gates/settledCash";
import { staticProfile } from "@/lib/market/staticProfile.mjs";

const M = 1_000_000n;
// Mon 2026-03-02, Tue 03-03, Wed 03-04 are sessions; Thu 03-05 is a holiday; Fri 03-06 a session
const cal: CalendarRow[] = [
  { d: "2026-03-05", kind: "holiday", close_time: null, confirmed: 1 } as CalendarRow,
];
const sell: LedgerFill = {
  id: "S1",
  d: "2026-03-02",
  code: "ZZA",
  side: "sell",
  qty: 10n,
  valueMicro: 1_000n * M,
  brokerageMicro: 0n,
};

describe("the lag is the profile's settlement_days", () => {
  it("AU 2, IN 1, US 1", () => {
    expect(staticProfile("AU").settlementDays).toBe(2);
    expect(staticProfile("IN").settlementDays).toBe(1);
    expect(staticProfile("US").settlementDays).toBe(1);
  });

  it("T+1 skips weekends and holidays; the default stays T+2", () => {
    const lag = staticProfile("IN").settlementDays!;
    expect(settlementDate("2026-03-02", cal, lag)).toBe("2026-03-03"); // Mon -> Tue
    expect(settlementDate("2026-03-04", cal, lag)).toBe("2026-03-06"); // Wed -> Fri (Thu holiday)
    expect(settlementDate("2026-03-06", cal, lag)).toBe("2026-03-09"); // Fri -> Mon
    expect(settlementDate("2026-03-02", cal)).toBe("2026-03-04"); // default T+2: Mon -> Wed
    expect(settlementItem(sell, cal, lag).settleD).toBe("2026-03-03");
  });

  it("pendingSettlements takes the lag", () => {
    const t1 = pendingSettlements([sell], new Set(), cal, 1);
    const t2 = pendingSettlements([sell], new Set(), cal);
    expect(t1.map((p) => p.settleD)).toEqual(["2026-03-03"]);
    expect(t2.map((p) => p.settleD)).toEqual(["2026-03-04"]);
  });
});

describe("IN funding clause (AT-69): sell on D, buy on D+1 funded, buy on D not funded", () => {
  const lag = 1;
  const pending = pendingSettlements([sell], new Set(), cal, lag);
  const cash = { settledCashMicro: 0n, pending };

  it("a buy that fills on D cannot use the sale proceeds", () => {
    expect(deployableCash(cash, "2026-03-02")).toBe(0n);
  });

  it("a buy that fills on D+1 can", () => {
    expect(deployableCash(cash, "2026-03-03")).toBe(1_000n * M);
  });

  it("under T+2 the same buy on D+1 is still not funded (AU unchanged)", () => {
    const au = { settledCashMicro: 0n, pending: pendingSettlements([sell], new Set(), cal, 2) };
    expect(deployableCash(au, "2026-03-03")).toBe(0n);
    expect(deployableCash(au, "2026-03-04")).toBe(1_000n * M);
  });
});

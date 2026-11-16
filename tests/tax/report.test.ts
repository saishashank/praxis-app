// @vitest-environment node
// M21 B3 (ARN-122, D-1222, D-1223; AT-78): the report on the hand-built fixture book (tests/tax/fixtureBook.ts).
// Real migrations on a local file. Figures are micro units, worked out by hand in the comments.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { specificLots } from "@/lib/tax/lots";
import { taxReport } from "@/lib/tax/report";
import { PAPER_WORDS, type BookTrade, type TaxReport } from "@/lib/tax/types";
import { seedBook } from "./fixtureBook";

afterAll(cleanupTempDbs);

let db: Client;
let fy2026: TaxReport;
let fy2025: TaxReport;

beforeAll(async () => {
  db = await freshDb("main");
  await seedBook(db);
  fy2026 = await taxReport(db, { market: "AU", fy: 2026, source: "book" });
  fy2025 = await taxReport(db, { market: "AU", fy: 2025, source: "book" });
}, 60_000);

const rows = (r: TaxReport, exec: string, method: "specific" | "fifo") =>
  r.executions
    .find((e) => e.id === exec)!
    [method].disposals.map((d) => [
      d.code,
      d.sellD,
      d.qty,
      d.costMicro,
      d.proceedsMicro,
      d.gainMicro,
      d.over12Months,
    ]);

describe("the fixture book, FY 2026 (1 Jul 2025 to 30 Jun 2026)", () => {
  it("states the year and carries the fixed words", () => {
    expect(fy2026.words).toBe(PAPER_WORDS);
    expect(fy2026.fyLabel).toBe("1 Jul 2025 to 30 Jun 2026");
    expect(fy2026.executions.map((e) => e.id)).toEqual(["E01", "E02"]);
    expect(fy2026.truncated).toBe(false);
  });

  it("specific lot: one lot per trade, fees on both legs", () => {
    // T1: cost 1000 + 10 = 1_010_000_000, proceeds 1400 - 14 = 1_386_000_000, gain 376_000_000, bought 2025-08-01 (<= 12m)
    // T2: cost 606_000_000, proceeds 750_000_000 - 7_500_000 = 742_500_000, gain 136_500_000
    // T3: cost 50_000_000 (split changes shares, not cost), proceeds 60_000_000, gain 10_000_000
    // T5: bought 2024-01-03, sold 2025-07-01 (year 2026): 5_000_000 -> 10_000_000, gain 5_000_000, over 12 months
    // T6: sold ON the anniversary: 12 months or less. T7: one day later: over 12 months. Each gain 500_000
    // T4 sold 2025-06-30 is in FY 2025. T10 is open, T8 legacy: neither is a sale.
    expect(rows(fy2026, "E01", "specific")).toEqual(
      [
        ["ZZAA", "2025-10-01", 50n, 606_000_000n, 742_500_000n, 136_500_000n, false],
        ["ZZSP", "2025-09-15", 20n, 50_000_000n, 60_000_000n, 10_000_000n, false],
        ["ZZAA", "2025-11-03", 100n, 1_010_000_000n, 1_386_000_000n, 376_000_000n, false],
        ["ZZFY", "2025-07-01", 5n, 5_000_000n, 10_000_000n, 5_000_000n, true],
        ["ZZH1", "2025-12-10", 1n, 1_000_000n, 1_500_000n, 500_000n, false],
        ["ZZH2", "2025-12-11", 1n, 1_000_000n, 1_500_000n, 500_000n, true],
      ].sort((a, b) => ((a[1] as string) < (b[1] as string) ? -1 : 1)),
    );
    // totals: cost 1_010 + 606 + 50 + 5 + 1 + 1 = 1_673_000_000; proceeds 1_386 + 742.5 + 60 + 10 + 1.5 + 1.5 = 2_201_500_000
    const t = fy2026.executions[0]!.specific.totals;
    expect([t.costMicro, t.proceedsMicro, t.gainMicro]).toEqual([
      1_673_000_000n,
      2_201_500_000n,
      528_500_000n,
    ]);
    expect([t.gainsMicro, t.lossesMicro]).toEqual([528_500_000n, 0n]);
    // over 12 months: T5 5_000_000 + T7 500_000 = 5_500_000; the rest 523_000_000
    expect([t.gainOver12Micro, t.gain12OrLessMicro]).toEqual([5_500_000n, 523_000_000n]);
  });

  it("FIFO: the later lot sold first uses the older shares, so the rows differ from specific lot", () => {
    // ZZAA: the 50-share sale on 2025-10-01 takes 50 of the 100 bought on 08-01: cost 505_000_000, proceeds 742_500_000,
    //   gain 237_500_000. The 100-share sale on 11-03 takes the other 50 (cost 505_000_000) and the 50 bought 09-01
    //   (cost 606_000_000); value 1_400_000_000 and fee 14_000_000 split in halves: proceeds 693_000_000 each,
    //   gains 188_000_000 and 87_000_000.
    const fifo = rows(fy2026, "E01", "fifo");
    expect(fifo.filter((r) => r[0] === "ZZAA")).toEqual([
      ["ZZAA", "2025-10-01", 50n, 505_000_000n, 742_500_000n, 237_500_000n, false],
      ["ZZAA", "2025-11-03", 50n, 505_000_000n, 693_000_000n, 188_000_000n, false],
      ["ZZAA", "2025-11-03", 50n, 606_000_000n, 693_000_000n, 87_000_000n, false],
    ]);
    expect(fifo.find((r) => r[0] === "ZZSP")).toEqual([
      "ZZSP",
      "2025-09-15",
      20n,
      50_000_000n,
      60_000_000n,
      10_000_000n,
      false,
    ]);
    // the whole book closes all its lots, so the totals agree with specific lot
    const t = fy2026.executions[0]!.fifo.totals;
    expect([t.costMicro, t.proceedsMicro, t.gainMicro]).toEqual([
      1_673_000_000n,
      2_201_500_000n,
      528_500_000n,
    ]);
    expect(fifo.filter((r) => r[0] === "ZZAA")).not.toEqual(
      rows(fy2026, "E01", "specific").filter((r) => r[0] === "ZZAA"),
    );
  });

  it("the second strategy and the market total", () => {
    // E02: ZZE2 20_000_000 -> 30_000_000, gain 10_000_000; and the cash takeover of ZZTK (below): 10_000_000 -> 12_000_000.
    // Market: cost 1_693 + 10 = 1_703_000_000, proceeds 2_231.5 + 12 = 2_243_500_000, gain 538.5 + 2 = 540_500_000
    const e02 = [
      ["ZZE2", "2025-09-05", 10n, 20_000_000n, 30_000_000n, 10_000_000n, false],
      ["ZZTK", "2025-10-15", 1n, 10_000_000n, 12_000_000n, 2_000_000n, false],
    ];
    expect(rows(fy2026, "E02", "fifo")).toEqual(e02);
    expect(rows(fy2026, "E02", "specific")).toEqual(e02);
    for (const m of [fy2026.total.specific, fy2026.total.fifo]) {
      expect([m.costMicro, m.proceedsMicro, m.gainMicro]).toEqual([
        1_703_000_000n,
        2_243_500_000n,
        540_500_000n,
      ]);
    }
  });

  it("a cash takeover at 12.00 on a 10.00 lot is a gain of 2.00 in both columns, not a write-off", () => {
    expect(fy2026.writtenOff).toEqual([]);
  });

  it("a legacy close is listed without a gain; an open trade is not listed", () => {
    expect(fy2026.closedWithoutPrice).toEqual([
      {
        executionId: "E01",
        code: "ZZLG",
        buyD: "2025-08-01",
        closedD: "2025-12-20", // the cohort's terminal date, not the buy date
        costMicro: 4_000_000n,
      },
    ]);
    expect(
      rows(fy2026, "E01", "fifo")
        .map((r) => r.join(","))
        .join(";"),
    ).not.toContain("ZZOP");
    expect(
      rows(fy2026, "E01", "fifo")
        .map((r) => r.join(","))
        .join(";"),
    ).not.toContain("ZZLG");
  });

  it("dividends: the franking the action recorded, 'not recorded' otherwise; a reversed payment nets out", () => {
    // paid in FY 2026: 5_000_000 (franked 100%, credit 2_142_857), 1_500_000 (no franking recorded),
    // 800_000 and its reversal -800_000. Total 6_500_000. The 2025-06-20 payment is FY 2025.
    expect(
      fy2026.dividends.map((x) => [
        x.code,
        x.d,
        x.amountMicro,
        x.frankingPct,
        x.frankingCreditMicro,
      ]),
    ).toEqual(
      [
        ["ZZSP", "2025-11-20", 1_500_000n, null, null],
        ["ZZAA", "2025-12-15", 5_000_000n, "100", 2_142_857n],
        ["ZZSP", "2026-01-10", 800_000n, null, null],
        ["ZZSP", "2026-01-12", -800_000n, null, null],
      ].sort((a, b) => ((a[1] as string) < (b[1] as string) ? -1 : 1)),
    );
    expect(fy2026.dividendTotalMicro).toBe(6_500_000n);
  });
});

describe("the year boundary", () => {
  it("a sale on 30 June is in the year that ends that day; 1 July is in the next", () => {
    // FY 2025 (1 Jul 2024 to 30 Jun 2025): only T4 (sold 2025-06-30): cost 5_000_000, proceeds 10_000_000, bought 2024-01-02: over 12m
    expect(rows(fy2025, "E01", "specific")).toEqual([
      ["ZZFY", "2025-06-30", 5n, 5_000_000n, 10_000_000n, 5_000_000n, true],
    ]);
    expect(rows(fy2025, "E01", "fifo")).toEqual([
      ["ZZFY", "2025-06-30", 5n, 5_000_000n, 10_000_000n, 5_000_000n, true],
    ]);
    expect(fy2025.dividends.map((x) => [x.code, x.amountMicro, x.frankingPct])).toEqual([
      ["ZZAA", 3_000_000n, "0"],
    ]);
    expect(fy2025.executions.map((e) => e.id)).toEqual(["E01"]);
  });
  it("a year with no sales is empty, not an error", async () => {
    const r = await taxReport(db, { market: "AU", fy: 2030, source: "book" });
    expect(r.executions).toEqual([]);
    expect(r.total.fifo.gainMicro).toBe(0n);
  });
});

describe("specificLots on its own", () => {
  const f = (
    id: string,
    d: string,
    side: "buy" | "sell",
    qty: bigint,
    value: bigint,
    fee: bigint,
  ) => ({ id, d, code: "ZZ", side, qty, valueMicro: value, feeMicro: fee });
  it("cost and proceeds carry the brokerage of their own leg", () => {
    const t: BookTrade = {
      tradeId: "t",
      cohortId: "c",
      executionId: "E",
      code: "ZZ",
      entry: f("b", "2025-01-01", "buy", 2n, 2_000_000n, 30n),
      exit: f("s", "2025-02-01", "sell", 2n, 1_900_000n, 40n),
      legacy: false,
    };
    const r = specificLots([t]);
    // cost 2_000_030, proceeds 1_899_960, loss 100_070
    expect(r.disposals[0]).toMatchObject({
      costMicro: 2_000_030n,
      proceedsMicro: 1_899_960n,
      gainMicro: -100_070n,
    });
  });
});

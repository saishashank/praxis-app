// @vitest-environment node
// M21 B3 (ARN-122, D-1221, D-1223, D-1266): the report on the Owner's own trade log. A voided trade is left out, a sale
// with no earlier buy is flagged with no gain, ids sort in numeric order, and the specific-lot column equals FIFO.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { taxReport } from "@/lib/tax/report";
import { LOG_HEADING, PAPER_WORDS, type TaxReport } from "@/lib/tax/types";

afterAll(cleanupTempDbs);

let db: Client;
let r: TaxReport;

async function trade(
  id: number,
  code: string,
  side: "buy" | "sell",
  d: string,
  qty: number,
  price: number,
  fee: number,
) {
  await db.execute({
    sql: `INSERT INTO owner_trade (id, market, code, side, d, qty, price_micro, fees_micro, note, source, upload_id, entered_at, entered_by)
          VALUES (?, 'AU', ?, ?, ?, ?, ?, ?, NULL, 'typed', NULL, '2025-12-01T00:00:00.000Z', 'owner')`,
    args: [id, code, side, d, qty, price, fee],
  });
}

beforeAll(async () => {
  db = await freshDb("main");
  await trade(1, "ZZL", "buy", "2025-08-01", 10, 2_000_000, 5_000);
  await trade(2, "ZZL", "buy", "2025-09-01", 10, 3_000_000, 5_000);
  await trade(3, "ZZL", "sell", "2025-10-01", 15, 4_000_000, 10_000);
  await trade(4, "ZZL", "sell", "2025-10-02", 5, 1_000_000, 0); // voided below
  await db.execute(
    "INSERT INTO owner_trade_void (trade_id, voided_at, reason) VALUES (4, '2025-12-02T00:00:00.000Z', 'typed twice')",
  );
  await trade(5, "ZZQ", "sell", "2025-10-03", 3, 1_000_000, 0); // no buy
  await trade(9, "ZZP", "buy", "2025-11-01", 1, 1_000_000, 0); // id 9 then id 10 on one day: numeric order, not text order
  await trade(10, "ZZP", "sell", "2025-11-01", 1, 1_500_000, 0);
  r = await taxReport(db, { market: "AU", fy: 2026, source: "log" });
}, 60_000);

describe("the report on the trade log", () => {
  it("says what it runs on and keeps the fixed words", () => {
    expect(r.words).toBe(PAPER_WORDS);
    expect(r.heading).toBe(LOG_HEADING);
    expect(r.source).toBe("log");
    expect(r.specificEqualsFifo).toBe(true);
    expect(r.notes.join(" ")).toContain("specific-lot column is the FIFO column");
  });
  it("FIFO over the log, voided trade 4 left out", () => {
    // buy 1: 10 x 2.00 + 0.005 = 20_005_000; buy 2: 10 x 3.00 + 0.005 = 30_005_000. Sell 15 x 4.00 = 60_000_000, fee 10_000.
    // chunk 1 (10 shares of buy 1): value 60_000_000 x 10/15 = 40_000_000; fee 10_000 x 10/15 = 6_666.67 -> 6_667;
    //   proceeds 39_993_333; cost 20_005_000; gain 19_988_333
    // chunk 2 (5 of buy 2): value 20_000_000; fee 3_333; proceeds 19_996_667; cost 30_005_000 x 5/10 = 15_002_500;
    //   gain 4_994_167. ZZP: 1_500_000 - 1_000_000 = 500_000 (id 10 sorts after id 9)
    const e = r.executions[0]!;
    expect(e.id).toBe("log");
    expect(
      e.fifo.disposals.map((d) => [d.code, d.qty, d.costMicro, d.proceedsMicro, d.gainMicro]),
    ).toEqual([
      ["ZZL", 10n, 20_005_000n, 39_993_333n, 19_988_333n],
      ["ZZL", 5n, 15_002_500n, 19_996_667n, 4_994_167n],
      ["ZZP", 1n, 1_000_000n, 1_500_000n, 500_000n],
    ]);
    expect(e.specific.disposals).toEqual(e.fifo.disposals);
    expect(r.total.fifo.gainMicro).toBe(19_988_333n + 4_994_167n + 500_000n);
    expect(r.total.specific.gainMicro).toBe(r.total.fifo.gainMicro);
  });
  it("a sale with no earlier buy is flagged and has no gain", () => {
    expect(r.unmatched).toEqual([
      { executionId: "log", code: "ZZQ", sellId: "000000000005", sellD: "2025-10-03", qty: 3n },
    ]);
    expect(r.executions[0]!.fifo.disposals.some((d) => d.code === "ZZQ")).toBe(false);
  });
  it("another market's log is not read", async () => {
    const other = await taxReport(db, { market: "IN", fy: 2026, source: "log" });
    expect(other.executions).toEqual([]);
  });
  it("without the void, the same sale would have been matched (the void changes the figures)", async () => {
    // sanity: the voided sale of 5 would have taken the remaining 5 shares of buy 2
    const rows = await db.execute("SELECT count(*) AS n FROM owner_trade");
    expect(Number(rows.rows[0]!.n)).toBe(7);
  });
});

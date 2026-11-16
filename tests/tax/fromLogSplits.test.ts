// @vitest-environment node
// M21 B3 review fix (D-1268): the trade log is read with the market's public split, consolidation and bonus-issue ratios,
// so a log that buys 100 and sells 200 after a 1:2 split is matched, and one that buys 100 and sells 50 after a 1:2
// consolidation is matched, with the right gain. A same-day buy and sale is reported, buys first.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { taxReport } from "@/lib/tax/report";
import type { TaxReport } from "@/lib/tax/types";

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
) {
  await db.execute({
    sql: `INSERT INTO owner_trade (id, market, code, side, d, qty, price_micro, fees_micro, note, source, upload_id, entered_at, entered_by)
          VALUES (?, 'AU', ?, ?, ?, ?, ?, 0, NULL, 'typed', NULL, '2025-12-01T00:00:00.000Z', 'owner')`,
    args: [id, code, side, d, qty, price],
  });
}

async function action(code: string, type: string, exDate: string, payload: object, status: string) {
  const a = await db.execute({
    sql: "INSERT INTO corporate_action (market, code, type, ex_date, payload_json) VALUES ('AU', ?, ?, ?, ?)",
    args: [code, type, exDate, JSON.stringify(payload)],
  });
  await db.execute({
    sql: "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (?, '2026-10-01T00:00:00.000Z', ?, 'test', '{}')",
    args: [a.lastInsertRowid ?? 0n, status],
  });
}

beforeAll(async () => {
  db = await freshDb("main");
  // ZZS: 1:2 split on 2025-09-01. Buy 100 at 1.00, sell 200 at 0.75 -> cost 100_000_000, proceeds 150_000_000, gain 50_000_000
  await action("ZZS", "split", "2025-09-01", { new: 2, old: 1 }, "auto_confirmed");
  await trade(1, "ZZS", "buy", "2025-08-01", 100, 1_000_000);
  await trade(2, "ZZS", "sell", "2025-10-01", 200, 750_000);
  // ZZC: 1:2 consolidation on 2025-09-01. Buy 100 at 1.00, sell 50 at 3.00 -> cost 100_000_000, proceeds 150_000_000, gain 50_000_000
  await action("ZZC", "consolidation", "2025-09-01", { new: 1, old: 2 }, "auto_confirmed");
  await trade(3, "ZZC", "buy", "2025-08-01", 100, 1_000_000);
  await trade(4, "ZZC", "sell", "2025-10-01", 50, 3_000_000);
  // ZZU: a queued (unconfirmed) split is not applied: the 200-share sale has only 100 shares behind it
  await action("ZZU", "split", "2025-09-01", { new: 2, old: 1 }, "queued");
  await trade(5, "ZZU", "buy", "2025-08-01", 100, 1_000_000);
  await trade(6, "ZZU", "sell", "2025-10-01", 200, 750_000);
  // same-day: the sale has the lower id but the buy is taken first
  await trade(7, "ZZD", "sell", "2025-11-03", 1, 2_000_000);
  await trade(8, "ZZD", "buy", "2025-11-03", 1, 1_000_000);
  r = await taxReport(db, { market: "AU", fy: 2026, source: "log" });
}, 60_000);

const gains = (code: string) =>
  r.executions[0]!.fifo.disposals.filter((d) => d.code === code).map((d) => [
    d.qty,
    d.costMicro,
    d.proceedsMicro,
    d.gainMicro,
  ]);

describe("the trade log with the market's splits", () => {
  it("1:2 split: buy 100, sell 200 is one matched sale", () => {
    expect(gains("ZZS")).toEqual([[200n, 100_000_000n, 150_000_000n, 50_000_000n]]);
    expect(r.unmatched.some((u) => u.code === "ZZS")).toBe(false);
  });
  it("1:2 consolidation: buy 100, sell 50 is one matched sale", () => {
    expect(gains("ZZC")).toEqual([[50n, 100_000_000n, 150_000_000n, 50_000_000n]]);
    expect(r.unmatched.some((u) => u.code === "ZZC")).toBe(false);
  });
  it("an unconfirmed action is not applied: the shortfall is flagged, not silently matched", () => {
    expect(gains("ZZU")).toEqual([[100n, 100_000_000n, 75_000_000n, -25_000_000n]]);
    expect(r.unmatched.filter((u) => u.code === "ZZU").map((u) => u.qty)).toEqual([100n]);
  });
  it("a same-day buy and sale is matched buys first, and the report says so", () => {
    expect(gains("ZZD")).toEqual([[1n, 1_000_000n, 2_000_000n, 1_000_000n]]);
    expect(r.notes.join(" ")).toContain("buys are taken first");
    expect(r.notes.join(" ")).toContain("ZZD 2025-11-03");
  });
  it("states the rounding and applies the market's corporate actions", () => {
    expect(r.notes).toContain("Amounts are rounded to the cent; totals use the exact figures.");
    expect(r.notes.join(" ")).toContain("applied to the log's share counts");
  });
});

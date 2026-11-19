// @vitest-environment node
// M21 B2 (ARN-121, D-1221, D-1275 to D-1277; F: money maths): the Owner's trade log. Parsing of a typed trade and of a CSV
// (a bad row is refused with its line number), the append-only store (store, void, a second void, a market that is not
// enabled, nothing is ever updated or deleted), the matching pick, slippage, FIFO round trips and the monthly table on
// hand-computed figures. Synthetic ZZ data only.
//
// The world: one Balanced pick ZZUP of Mon 2026-10-19, paper-bought on 2026-10-20 at 10.00, closed on 2026-10-23 at 10.50
// with a net of 50,000 ppm (5 %). Trades: buy 100 at 10.10 on Wed 2026-10-21 (fee 5.00); sell 100 at 10.40 on Mon 2026-10-26
// (fee 5.00).
//   buy slippage  = (10.10 - 10.00) / 10.00 = +1.00 %  (10,000 ppm)
//   sell slippage = (10.40 - 10.50) / 10.50 = -0.9524 % (-9,524 ppm, half away from zero) -> "-0.95 %"
//   real net      = 100 x 10.40 - 5.00 - (100 x 10.10 + 5.00) = 1,035.00 - 1,015.00 = 20.00
//   paper net     = 50,000 ppm x cost 1,015.00 = 50.75
//   October mean slippage = (10,000 - 9,524) / 2 = 238 ppm -> "+0.02 %"
import type { Client } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import type { CalendarRow } from "@/lib/data/calendar";
import {
  compareLog,
  matchingPick,
  pctFromPpm,
  slippagePpm,
  type LogTrade,
  type PaperPick,
} from "@/lib/ownerTools/tradeLog/match";
import {
  parseReason,
  parseTradeRow,
  parseTradesCsv,
  parseTypedTrade,
  TRADES_MAX_ROWS,
  type RowContext,
} from "@/lib/ownerTools/tradeLog/parse";
import {
  appendTrades,
  loadTradeLog,
  newUploadId,
  voidTrade,
} from "@/lib/ownerTools/tradeLog/store";

afterAll(cleanupTempDbs);

const ctx: RowContext = { markets: ["AU"], today: "2026-11-01" };
const HEAD = "market,code,side,date,quantity,price,fees,note";
const NOW = new Date("2026-11-01T01:00:00.000Z");
const SHA = "b".repeat(64);

describe("parsing a typed trade", () => {
  const ok = {
    market: " au ",
    code: " zzup ",
    side: "Buy",
    date: "2026-10-21",
    qty: "1,000",
    price: "10.10",
    fees: "",
    note: "  first lot  ",
  };
  it("normalises market, code, side, quantity and money, and keeps a trimmed note", () => {
    expect(parseTradeRow(ok, ctx)).toEqual({
      market: "AU",
      code: "ZZUP",
      side: "buy",
      d: "2026-10-21",
      qty: 1000,
      priceMicro: 10_100_000n,
      feesMicro: 0n,
      note: "first lot",
    });
  });
  it.each([
    ["a market that is not enabled", { market: "IN" }],
    ["a bad code", { code: "zz up" }],
    ["a side that is not buy or sell", { side: "hold" }],
    ["a date that does not exist", { date: "2026-02-30" }],
    ["a date in the future", { date: "2026-11-02" }],
    ["a date long ago", { date: "1999-12-31" }],
    ["a zero quantity", { qty: "0" }],
    ["a fractional quantity", { qty: "1.5" }],
    ["a zero price", { price: "0" }],
    ["a price with seven decimals", { price: "1.1234567" }],
    ["a negative fee", { fees: "-1" }],
    ["a note over 200 characters", { note: "x".repeat(201) }],
    ["a note with a control character", { note: "a\u0007b" }],
  ])("refuses %s", (_name, patch) => {
    expect(parseTradeRow({ ...ok, ...patch }, ctx)).toBeNull();
  });
  it("the typed form answers a fixed refusal with no line", () => {
    expect(parseTypedTrade({ ...ok, qty: "x" }, ctx)).toEqual({ ok: false, error: "bad_row" });
    expect(parseTypedTrade(ok, ctx)).toMatchObject({ ok: true });
  });
  it("a void reason is 1 to 200 plain characters", () => {
    expect(parseReason("  typo  ")).toBe("typo");
    expect(parseReason("")).toBeNull();
    expect(parseReason("x".repeat(201))).toBeNull();
    expect(parseReason(5)).toBeNull();
  });
});

describe("parsing a CSV", () => {
  it("reads the eight columns, skips blank rows and a BOM", () => {
    const r = parseTradesCsv(
      `﻿${HEAD}\nAU,ZZUP,buy,2026-10-21,100,10.10,5,\n\nAU,ZZUP,sell,2026-10-26,100,10.40,5,"took the aim, sold"\n`,
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows).toHaveLength(2);
      expect(r.rows[1]!.note).toBe("took the aim, sold");
      expect(r.rows[1]!.side).toBe("sell");
    }
  });
  it("refuses a bad row with its 1-based line number and never its text", () => {
    const r = parseTradesCsv(
      `${HEAD}\nAU,ZZUP,buy,2026-10-21,100,10.10,5,\nAU,ZZUP,buy,2026-10-22,abc,10.10,5,`,
      ctx,
    );
    expect(r).toEqual({ ok: false, error: "bad_row", line: 3 });
  });
  it("refuses a wrong header, an empty file, too many rows and too large a file", () => {
    expect(parseTradesCsv("code,qty\nZZUP,1", ctx)).toEqual({ ok: false, error: "bad_header" });
    expect(parseTradesCsv(HEAD, ctx)).toEqual({ ok: false, error: "empty" });
    expect(parseTradesCsv("", ctx)).toEqual({ ok: false, error: "empty" });
    expect(parseTradesCsv(undefined, ctx)).toEqual({ ok: false, error: "empty" });
    const many = Array.from(
      { length: TRADES_MAX_ROWS + 1 },
      () => "AU,ZZUP,buy,2026-10-21,1,1,0,",
    ).join("\n");
    expect(parseTradesCsv(`${HEAD}\n${many}`, ctx)).toEqual({ ok: false, error: "too_many_rows" });
    expect(parseTradesCsv("x".repeat(70_000), ctx)).toEqual({ ok: false, error: "too_large" });
  });
  it("a row with a missing column is a bad row", () => {
    expect(parseTradesCsv(`${HEAD}\nAU,ZZUP,buy,2026-10-21,100,10.10`, ctx)).toEqual({
      ok: false,
      error: "bad_row",
      line: 2,
    });
  });
});

describe("slippage and the percentage text (integer maths)", () => {
  it("(price - paper) / paper in ppm, rounded half away from zero", () => {
    expect(slippagePpm(10_100_000n, 10_000_000n)).toBe(10_000n);
    expect(slippagePpm(10_400_000n, 10_500_000n)).toBe(-9_524n);
    expect(slippagePpm(1n, 2n)).toBe(-500_000n);
    expect(slippagePpm(5n, null)).toBeNull();
  });
  it("the text has two decimals and a sign", () => {
    expect(pctFromPpm(10_000n)).toBe("+1.00 %");
    expect(pctFromPpm(-9_524n)).toBe("-0.95 %");
    expect(pctFromPpm(0n)).toBe("0.00 %");
    expect(pctFromPpm(238n)).toBe("+0.02 %");
    expect(pctFromPpm(-1_234_500n)).toBe("-123.45 %");
  });
});

const pick = (over: Partial<PaperPick> = {}): PaperPick => ({
  d: "2026-10-19",
  profile: "balanced",
  rank: 1,
  code: "ZZUP",
  state: "closed",
  entryD: "2026-10-20",
  entryMicro: 10_000_000n,
  exitD: "2026-10-23",
  exitMicro: 10_500_000n,
  netPpm: 50_000n,
  ...over,
});

describe("the matching pick", () => {
  const holiday = (d: string): CalendarRow => ({
    d,
    kind: "holiday",
    close_time: null,
    confirmed: 1,
  });
  it("needs the same code, a pick date before the trade date and the trade inside the window", () => {
    const p = pick();
    expect(matchingPick({ code: "ZZUP", d: "2026-10-21" }, [p], 3, [])).toBe(p);
    expect(matchingPick({ code: "ZZUP", d: "2026-10-19" }, [p], 3, [])).toBeNull(); // the same day is not before
    expect(matchingPick({ code: "ZZOTHER", d: "2026-10-21" }, [p], 3, [])).toBeNull();
    // Tue, Wed, Thu are 3 sessions after Monday: inside 3; Friday is the 4th: outside
    expect(matchingPick({ code: "ZZUP", d: "2026-10-22" }, [p], 3, [])).toBe(p);
    expect(matchingPick({ code: "ZZUP", d: "2026-10-23" }, [p], 3, [])).toBeNull();
    expect(matchingPick({ code: "ZZUP", d: "2026-10-21" }, [p], 1, [])).toBeNull();
  });
  it("a holiday is not a session", () => {
    const p = pick();
    const cal = [holiday("2026-10-20")];
    expect(matchingPick({ code: "ZZUP", d: "2026-10-23" }, [p], 3, cal)).toBe(p); // Wed, Thu, Fri
    expect(matchingPick({ code: "ZZUP", d: "2026-10-23" }, [p], 2, cal)).toBeNull();
  });
  it("takes the newest pick, then the lowest rank, then the profile name", () => {
    const old = pick({ d: "2026-10-16" });
    const a = pick({ d: "2026-10-19", rank: 2, profile: "balanced" });
    const b = pick({ d: "2026-10-19", rank: 1, profile: "steady" });
    const c = pick({ d: "2026-10-19", rank: 1, profile: "aggressive" });
    expect(matchingPick({ code: "ZZUP", d: "2026-10-20" }, [old, a, b, c], 3, [])).toBe(c);
    expect(matchingPick({ code: "ZZUP", d: "2026-10-20" }, [old, a], 3, [])).toBe(a);
    expect(matchingPick({ code: "ZZUP", d: "2026-10-20" }, [old], 3, [])).toBe(old);
  });
  it("a pick far back is skipped without walking the calendar", () => {
    expect(
      matchingPick({ code: "ZZUP", d: "2026-10-21" }, [pick({ d: "2020-01-06" })], 10, []),
    ).toBeNull();
  });
});

let nextId = 1;
const trade = (over: Partial<LogTrade>): LogTrade => ({
  id: nextId++,
  market: "AU",
  code: "ZZUP",
  side: "buy",
  d: "2026-10-21",
  qty: 100n,
  priceMicro: 10_100_000n,
  feesMicro: 5_000_000n,
  note: null,
  source: "typed",
  voidReason: null,
  ...over,
});

describe("compareLog: slippage, round trips and the monthly table on hand-computed figures", () => {
  beforeEach(() => {
    nextId = 1;
  });
  const buy = () => trade({});
  const sell = () => trade({ side: "sell", d: "2026-10-26", priceMicro: 10_400_000n });

  it("the buy is +1.00 % against the paper fill of 10.00", () => {
    const v = compareLog([buy()], [pick()], 3, []);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]!.paper).toMatchObject({
      kind: "ok",
      paperMicro: 10_000_000n,
      paperD: "2026-10-20",
    });
    expect(v.rows[0]!.slippagePpm).toBe(10_000n);
  });

  it("the sell is compared with the paper exit; real net 20.00 against paper net 50.75 on the same cost", () => {
    const v = compareLog([buy(), sell()], [pick()], 3, []);
    const s = v.rows.find((r) => r.trade.side === "sell")!;
    expect(s.paper).toMatchObject({ kind: "ok", paperMicro: 10_500_000n });
    expect(s.slippagePpm).toBe(-9_524n);
    expect(s.costMicro).toBe(1_015_000_000n);
    expect(s.realNetMicro).toBe(20_000_000n);
    expect(s.paperNetMicro).toBe(50_750_000n);
    expect(s.unmatchedQty).toBe(0n);
  });

  it("the October row: two compared, mean +0.02 %, one round trip", () => {
    const v = compareLog([buy(), sell()], [pick()], 3, []);
    expect(v.months).toEqual([
      {
        month: "2026-10",
        compared: 2,
        meanSlippagePpm: 238n,
        roundTrips: 1,
        realNetMicro: 20_000_000n,
        paperNetMicro: 50_750_000n,
      },
    ]);
  });

  it("months are newest first", () => {
    const later = trade({ d: "2026-11-02", code: "ZZLATE" });
    const v = compareLog([later, buy()], [pick()], 3, []);
    expect(v.months.map((m) => m.month)).toEqual(["2026-11", "2026-10"]);
    expect(v.months[0]).toMatchObject({ compared: 0, meanSlippagePpm: null, roundTrips: 0 });
  });

  it("a voided trade is left out of everything", () => {
    const v = compareLog([buy(), trade({ voidReason: "typo" }), sell()], [pick()], 3, []);
    expect(v.rows).toHaveLength(2);
    expect(v.months[0]!.compared).toBe(2);
  });

  it("a pick that never filled on paper is 'not bought'; a trade outside every window has no paper side", () => {
    const missed = pick({
      state: "missed",
      entryD: null,
      entryMicro: null,
      exitD: null,
      exitMicro: null,
      netPpm: null,
    });
    const a = compareLog([buy()], [missed], 3, []);
    expect(a.rows[0]!.paper.kind).toBe("not_bought");
    expect(a.rows[0]!.slippagePpm).toBeNull();
    const b = compareLog([trade({ d: "2026-12-01" })], [pick()], 3, []);
    expect(b.rows[0]!.paper.kind).toBe("none");
  });

  it("a sell whose paper pick is still open has no paper exit and no paper net", () => {
    const open = pick({ state: "bought", exitD: null, exitMicro: null, netPpm: null });
    const v = compareLog([buy(), sell()], [open], 3, []);
    const s = v.rows.find((r) => r.trade.side === "sell")!;
    expect(s.paper.kind).toBe("no_exit");
    expect(s.realNetMicro).toBe(20_000_000n);
    expect(s.paperNetMicro).toBeNull();
    expect(v.months[0]!.roundTrips).toBe(0);
  });

  it("a sale with no earlier buy is flagged with no cost and no gain", () => {
    const v = compareLog([trade({ side: "sell", d: "2026-10-26", qty: 40n })], [pick()], 3, []);
    expect(v.rows[0]!.unmatchedQty).toBe(40n);
    expect(v.rows[0]!.realNetMicro).toBeNull();
  });

  it("FIFO: a sale closes the oldest lot first and is compared with that lot's pick", () => {
    const oldBuy = trade({ d: "2026-10-21", qty: 60n, priceMicro: 10_000_000n, feesMicro: 0n });
    const newBuy = trade({ d: "2026-10-22", qty: 60n, priceMicro: 11_000_000n, feesMicro: 0n });
    const out = trade({
      side: "sell",
      d: "2026-10-26",
      qty: 80n,
      priceMicro: 12_000_000n,
      feesMicro: 0n,
    });
    const v = compareLog([out, newBuy, oldBuy], [pick()], 3, []);
    const s = v.rows.find((r) => r.trade.side === "sell")!;
    // 60 from the first lot (cost 600.00) and 20 from the second (cost 220.00): 820.00; proceeds 960.00; gain 140.00
    expect(s.costMicro).toBe(820_000_000n);
    expect(s.realNetMicro).toBe(140_000_000n);
    // paper: 50,000 ppm of 820.00 = 41.00
    expect(s.paperNetMicro).toBe(41_000_000n);
  });

  it("two buys on the same day and a sale are matched buys first (the log has no order within a day)", () => {
    const b1 = trade({ d: "2026-10-21", qty: 10n, priceMicro: 10_000_000n, feesMicro: 0n });
    const s1 = trade({
      side: "sell",
      d: "2026-10-21",
      qty: 10n,
      priceMicro: 10_000_000n,
      feesMicro: 0n,
    });
    const v = compareLog([s1, b1], [], 3, []);
    expect(v.rows.find((r) => r.trade.side === "sell")!.unmatchedQty).toBe(0n);
  });
});

async function insertPick(
  db: Client,
  over: { code: string; d: string; state: "waiting" | "bought" | "closed" | "missed" },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
            typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
            pick_sha, created_at)
          VALUES ('AU', ?, 'balanced', 1, ?, 'F1', 'U1', 'F1.v1', 's1', 'UNVALIDATED', 10000000, 10050000,
            '2026-11-30', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, '[]', '[]', ?, ?)`,
    args: [over.d, over.code, SHA, `${over.d}T07:00:00.000Z`],
  });
  await db.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES ('AU', ?, 'balanced', 1, 'pick', ?, ?, 'waiting', ?)`,
    args: [over.d, over.code, SHA, over.d],
  });
  if (over.state === "missed") {
    await db.execute({
      sql: "UPDATE pick_outcome SET state = 'missed' WHERE code = ? AND d = ?",
      args: [over.code, over.d],
    });
  }
  if (over.state === "bought" || over.state === "closed") {
    await db.execute({
      sql: "UPDATE pick_outcome SET state = 'bought', entry_d = '2026-10-20', entry_micro = 10000000 WHERE code = ? AND d = ?",
      args: [over.code, over.d],
    });
  }
  if (over.state === "closed") {
    await db.execute({
      sql: `UPDATE pick_outcome SET state = 'closed', exit_d = '2026-10-23', exit_micro = 10500000, exit_reason = 'aim',
              net_micro = 50000, net_ppm = 50000 WHERE code = ? AND d = ?`,
      args: [over.code, over.d],
    });
  }
}

const row = (over: Record<string, unknown> = {}) => ({
  market: "AU",
  code: "ZZUP",
  side: "buy" as const,
  d: "2026-10-21",
  qty: 100,
  priceMicro: 10_100_000n,
  feesMicro: 5_000_000n,
  note: null,
  ...over,
});

describe("the append-only store on a migrated database", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
  });
  const count = async (t: string) =>
    Number((await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);

  it("stores typed rows with no upload id and CSV rows with one (one batch)", async () => {
    expect(await appendTrades(db, [row()], "typed", "user:1", NOW, null)).toEqual({
      ok: true,
      uploadId: null,
    });
    const up = newUploadId(NOW, "abcd1234");
    expect(
      await appendTrades(db, [row(), row({ side: "sell" })], "csv", "user:1", NOW, up),
    ).toEqual({
      ok: true,
      uploadId: up,
    });
    expect(await count("owner_trade")).toBe(3);
    const r = (
      await db.execute("SELECT source, upload_id, entered_by FROM owner_trade ORDER BY id")
    ).rows;
    expect(r.map((x) => [x.source, x.upload_id])).toEqual([
      ["typed", null],
      ["csv", up],
      ["csv", up],
    ]);
    expect(String(r[0]!.entered_by)).toBe("user:1");
  });

  it("refuses a source and an upload id that do not agree, and an empty list, writing nothing", async () => {
    expect((await appendTrades(db, [row()], "csv", "u", NOW, null)).ok).toBe(false);
    expect((await appendTrades(db, [row()], "typed", "u", NOW, "x")).ok).toBe(false);
    expect((await appendTrades(db, [], "typed", "u", NOW, null)).ok).toBe(false);
    expect(await count("owner_trade")).toBe(0);
  });

  it("a market that is not enabled is refused and a mixed import is all or nothing", async () => {
    const r = await appendTrades(db, [row(), row({ market: "IN" })], "csv", "u", NOW, "up1");
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(await count("owner_trade")).toBe(0);
  });

  it("nothing is ever updated or deleted", async () => {
    await appendTrades(db, [row()], "typed", "u", NOW, null);
    await expect(db.execute("UPDATE owner_trade SET qty = 5")).rejects.toThrow();
    await expect(db.execute("DELETE FROM owner_trade")).rejects.toThrow();
    await voidTrade(db, 1, "typo", NOW);
    await expect(db.execute("UPDATE owner_trade_void SET reason = 'x'")).rejects.toThrow();
    await expect(db.execute("DELETE FROM owner_trade_void")).rejects.toThrow();
  });

  it("a void is a new row; a second void and an unknown trade are refused", async () => {
    await appendTrades(db, [row()], "typed", "u", NOW, null);
    expect(await voidTrade(db, 1, "typed the wrong price", NOW)).toEqual({ ok: true });
    expect(await count("owner_trade")).toBe(1);
    expect(await count("owner_trade_void")).toBe(1);
    expect(await voidTrade(db, 1, "again", NOW)).toEqual({ ok: false, error: "already" });
    expect(await voidTrade(db, 99, "nothing", NOW)).toEqual({ ok: false, error: "not_found" });
    expect(await count("owner_trade_void")).toBe(1);
  });

  it("loadTradeLog: the pick, the slippage, the round trip and the monthly row from stored rows", async () => {
    await insertPick(db, { code: "ZZUP", d: "2026-10-19", state: "closed" });
    await appendTrades(
      db,
      [
        row(),
        row({ side: "sell", d: "2026-10-26", priceMicro: 10_400_000n }),
        row({ d: "2026-10-22", note: "typo" }),
      ],
      "csv",
      "u",
      NOW,
      "up1",
    );
    await voidTrade(db, 3, "typed twice", NOW);
    const m = await loadTradeLog(db, "AU");
    expect(m.maxSessions).toBe(3);
    expect(m.truncated).toBe(false);
    expect(m.liveCount).toBe(2);
    expect(m.listed.map((t) => [t.id, t.voidReason])).toEqual([
      [3, "typed twice"],
      [2, null],
      [1, null],
    ]);
    expect(m.view.rows.map((r) => r.slippagePpm)).toEqual([10_000n, -9_524n]);
    expect(m.view.months).toEqual([
      {
        month: "2026-10",
        compared: 2,
        meanSlippagePpm: 238n,
        roundTrips: 1,
        realNetMicro: 20_000_000n,
        paperNetMicro: 50_750_000n,
      },
    ]);
  });

  it("an empty log gives an empty view without reading the pick tables for nothing", async () => {
    const m = await loadTradeLog(db, "AU");
    expect(m.view).toEqual({ rows: [], months: [] });
    expect(m.listed).toEqual([]);
  });

  it("the trades of another market are never read", async () => {
    await appendTrades(db, [row()], "typed", "u", NOW, null);
    const m = await loadTradeLog(db, "ZZ");
    expect(m.liveCount).toBe(0);
  });
});

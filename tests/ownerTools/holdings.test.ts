// @vitest-environment node
// M21 B1 (UXN-316, D-1220, AT-78): holdings are append-only uploads of code, quantity and average cost. The CSV header and
// limits, the refusal of a bad row with its row number (never its text), a save as ONE new upload, the newest upload being
// the current set, and the screenshot control being a stub.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOLDINGS_MAX_CHARS,
  HOLDINGS_MAX_ROWS,
  loadCurrentHoldings,
  newUploadId,
  parseHoldingRow,
  parseHoldingsCsv,
  parseManualRows,
  saveHoldings,
  type HoldingRow,
} from "@/lib/ownerTools/holdings";
import { OCR_NOT_AVAILABLE_TEXT, OcrNotAvailable } from "@/lib/ownerTools/ocr";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const csv = (...lines: string[]) => ["code,quantity,average_cost", ...lines].join("\n");

describe("parseHoldingRow", () => {
  it("reads a code, whole shares and a decimal cost exactly", () => {
    expect(parseHoldingRow(" zza ", "1,250", "12.5")).toEqual({
      code: "ZZA",
      qty: 1250,
      avgCostMicro: 12_500_000n,
    });
    expect(parseHoldingRow("ZZB", "3", "0.000001")?.avgCostMicro).toBe(1n);
    expect(parseHoldingRow("BRK.B", "1", "400")?.code).toBe("BRK.B");
  });

  it("refuses a fractional or zero share count, a zero or malformed cost, a bad code", () => {
    for (const [c, q, a] of [
      ["ZZA", "1.5", "1"],
      ["ZZA", "0", "1"],
      ["ZZA", "-1", "1"],
      ["ZZA", "1", "0"],
      ["ZZA", "1", "0.0000001"],
      ["ZZA", "1", "abc"],
      ["ZZA", "1", "1e3"],
      ["zz a", "1", "1"],
      ["", "1", "1"],
      ["ZZA", "9999999999999", "1"],
    ] as const) {
      expect(parseHoldingRow(c, q, a), `${c} ${q} ${a}`).toBeNull();
    }
  });
});

describe("parseHoldingsCsv", () => {
  it("accepts the header and rows, a BOM, quoted fields and blank lines", () => {
    const r = parseHoldingsCsv('﻿Code,Quantity,Average_Cost\r\n\r\nzza,100,"1.50"\r\nZZB,5,20\r\n');
    expect(r).toEqual({
      ok: true,
      rows: [
        { code: "ZZA", qty: 100, avgCostMicro: 1_500_000n },
        { code: "ZZB", qty: 5, avgCostMicro: 20_000_000n },
      ],
    });
  });

  it("refuses a wrong or missing header", () => {
    expect(parseHoldingsCsv("ZZA,1,1")).toEqual({ ok: false, error: "bad_header" });
    expect(parseHoldingsCsv("code,qty,cost\nZZA,1,1")).toEqual({ ok: false, error: "bad_header" });
    expect(parseHoldingsCsv("code,quantity\nZZA,1")).toEqual({ ok: false, error: "bad_header" });
  });

  it("refuses a bad row with its row number, never its text", () => {
    const r = parseHoldingsCsv(csv("ZZA,1,1", "ZZB,x,1", "ZZC,1,1"));
    expect(r).toEqual({ ok: false, error: "bad_row", line: 3 });
    expect(JSON.stringify(r)).not.toContain("ZZB");
    expect(parseHoldingsCsv(csv("ZZA,1"))).toEqual({ ok: false, error: "bad_row", line: 2 });
  });

  it("refuses a company that appears twice", () => {
    expect(parseHoldingsCsv(csv("ZZA,1,1", "zza,2,2"))).toEqual({
      ok: false,
      error: "duplicate",
      line: 3,
    });
  });

  it("enforces 200 rows and 64 KB, and refuses an empty file", () => {
    const many = (n: number) =>
      csv(...Array.from({ length: n }, (_, i) => `Z${String(i).padStart(4, "0")},1,1`));
    expect(HOLDINGS_MAX_ROWS).toBe(200);
    expect(parseHoldingsCsv(many(200))).toMatchObject({ ok: true });
    expect(parseHoldingsCsv(many(201))).toEqual({ ok: false, error: "too_many_rows" });
    expect(HOLDINGS_MAX_CHARS).toBe(65_536);
    expect(parseHoldingsCsv(csv("ZZA,1,1") + "\n#".repeat(HOLDINGS_MAX_CHARS))).toEqual({
      ok: false,
      error: "too_large",
    });
    expect(parseHoldingsCsv("")).toEqual({ ok: false, error: "empty" });
    expect(parseHoldingsCsv(csv())).toEqual({ ok: false, error: "empty" });
    expect(parseHoldingsCsv(42)).toEqual({ ok: false, error: "empty" });
  });
});

describe("parseManualRows", () => {
  it("skips an all-empty row, parses the rest, and numbers a bad row", () => {
    expect(
      parseManualRows([
        { code: "ZZA", qty: "10", cost: "2" },
        { code: "", qty: "", cost: "" },
        { code: "ZZB", qty: "5", cost: "3.25" },
      ]),
    ).toMatchObject({ ok: true, rows: [{ code: "ZZA" }, { code: "ZZB" }] });
    expect(
      parseManualRows([
        { code: "ZZA", qty: "10", cost: "2" },
        { code: "ZZB", qty: "", cost: "3" },
      ]),
    ).toEqual({ ok: false, error: "bad_row", line: 2 });
    expect(parseManualRows([{ code: "", qty: "", cost: "" }])).toEqual({
      ok: false,
      error: "empty",
    });
  });
});

describe("saving and reading uploads", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
  });
  const A: HoldingRow[] = [
    { code: "ZZA", qty: 100, avgCostMicro: 1_500_000n },
    { code: "ZZB", qty: 5, avgCostMicro: 20_000_000n },
  ];

  it("upload ids sort by time", () => {
    const a = newUploadId(new Date("2030-01-01T00:00:00.000Z"), "aaaaaaaa");
    const b = newUploadId(new Date("2030-01-01T00:00:00.001Z"), "00000000");
    expect(a < b).toBe(true);
  });

  it("nothing saved: no current set", async () => {
    expect(await loadCurrentHoldings(db, "AU")).toBeNull();
  });

  it("a save is one new upload; the newest upload is the current set; the older ones are kept", async () => {
    const t1 = new Date("2030-01-01T00:00:00.000Z");
    const t2 = new Date("2030-01-02T00:00:00.000Z");
    expect(await saveHoldings(db, "AU", A, t1, "11111111")).toMatchObject({ ok: true });
    const first = await loadCurrentHoldings(db, "AU");
    expect(first?.rows).toEqual(A);
    expect(first?.uploadedAt).toBe(t1.toISOString());
    expect(await saveHoldings(db, "AU", [A[0]!], t2, "22222222")).toMatchObject({ ok: true });
    const second = await loadCurrentHoldings(db, "AU");
    expect(second?.rows).toEqual([A[0]]);
    // append-only: three rows in all, the first upload still there
    const all = await db.execute("SELECT COUNT(*) AS n FROM owner_holding");
    expect(Number(all.rows[0]!.n)).toBe(3);
    await expect(db.execute("UPDATE owner_holding SET qty = 1")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM owner_holding")).rejects.toThrow(/append-only/);
  });

  it("a market that is not enabled cannot be saved to (the 0038 guard), and nothing is half-written", async () => {
    const r = await saveHoldings(db, "ZZ", A, new Date("2030-01-01T00:00:00.000Z"), "33333333");
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(Number((await db.execute("SELECT COUNT(*) AS n FROM owner_holding")).rows[0]!.n)).toBe(
      0,
    );
  });

  it("refuses an empty set or more than 200 rows", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    expect(await saveHoldings(db, "AU", [], now, "44444444")).toEqual({
      ok: false,
      error: "unavailable",
    });
    const big = Array.from({ length: 201 }, (_, i) => ({
      code: `Z${i}`,
      qty: 1,
      avgCostMicro: 1n,
    }));
    expect(await saveHoldings(db, "AU", big, now, "55555555")).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("OcrNotAvailable (D-944)", () => {
  it("reads nothing and says so", async () => {
    expect(await OcrNotAvailable()).toEqual({ ok: false, error: "not_available" });
    expect(OCR_NOT_AVAILABLE_TEXT).toBe(
      "Not available yet: screenshots are not read in this version",
    );
  });
});

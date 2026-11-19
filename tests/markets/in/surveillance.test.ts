// @vitest-environment node
// M20 IN1 (DAT-243 g, D-1109 trigger 3): the ASM and GSM lists. The stage is the number in the parentheses of the
// exchange's `survCode`; a code on both lists keeps one row per list; a row with no symbol is dropped.
import { describe, expect, it } from "vitest";
import { parseAsm, parseGsm, surveillanceRows } from "@/lib/data/sources/in/surveillance.mjs";
import { asmFile, gsmFile } from "./dayFixture";

describe("surveillance lists", () => {
  it("ASM long-term and short-term, GSM, with the exchange's stage code", () => {
    const asm = parseAsm({
      longterm: {
        data: [
          { symbol: "AAA", survCode: "LTASM - I (13)" },
          { symbol: "AAA", survCode: "LTASM - II (14)" },
        ],
      },
      shortterm: {
        data: [
          { symbol: "BBB", survCode: "ASM-ST I (3)" },
          { symbol: " ", survCode: "x" },
          { symbol: "CCC" },
        ],
      },
    });
    expect(asm).toEqual([
      { code: "AAA", stage: 13 },
      { code: "BBB", stage: 3 },
      { code: "CCC", stage: null },
    ]);
    expect(parseGsm([{ symbol: "AAA", survCode: "GSM - VI (6)" }])).toEqual([
      { code: "AAA", stage: 6 },
    ]);
  });

  it("a malformed document is an empty list, not an error", () => {
    expect(parseAsm(null)).toEqual([]);
    expect(parseGsm({ not: "an array" })).toEqual([]);
  });

  it("a code on both lists gets one row per list", () => {
    const rows = surveillanceRows(
      { asm: parseAsm(JSON.parse(asmFile())), gsm: parseGsm(JSON.parse(gsmFile())) },
      { market: "IN", d: "2026-11-12" },
    );
    expect(rows).toEqual([
      ["IN", "ZETA", "2026-11-12", "ASM", 13, "in_nse_asm_gsm"],
      ["IN", "EPSL", "2026-11-12", "GSM", 6, "in_nse_asm_gsm"],
    ]);
  });
});

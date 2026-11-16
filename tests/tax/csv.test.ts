// @vitest-environment node
// M21 B3 (ARN-122, D-1222): the CSV export. Formula guard, escaping, exact decimals, the fixed words on the first line.
import { describe, expect, it } from "vitest";
import { makeRational } from "@/lib/money/rational";
import { CSV_HEADER, csvCell, guardCell, microText, reportCsv } from "@/lib/tax/csv";
import { buildReport } from "@/lib/tax/report";
import { PAPER_WORDS, type TaxFill } from "@/lib/tax/types";
import { parseCsv, unguard } from "./csvParse";

describe("formula guard", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", '=HYPERLINK("http://x")'])(
    "prefixes %j",
    (raw) => {
      expect(guardCell(raw)).toBe(`'${raw}`);
    },
  );
  it.each(["", "abc", "1.5", "A=B", "'=already", "ZZAA", " =x"])("leaves %j alone", (raw) => {
    expect(guardCell(raw)).toBe(raw);
  });
  it("a negative amount is guarded too (every cell, D-1222) and parses back", () => {
    expect(csvCell(microText(-100_070n))).toBe("'-0.100070");
    expect(unguard("'-0.100070")).toBe("-0.100070");
  });
});

describe("escaping", () => {
  it("quotes cells with a comma, quote or line break, doubling the quotes", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell("plain")).toBe("plain");
  });
  it("the guard is applied before the quoting", () => {
    expect(csvCell("=SUM(1,2)")).toBe('"\'=SUM(1,2)"');
  });
});

describe("microText", () => {
  it("exact decimals, six places, signed", () => {
    expect(microText(0n)).toBe("0.000000");
    expect(microText(1_010_000_000n)).toBe("1010.000000");
    expect(microText(5n)).toBe("0.000005");
    expect(microText(-12_500_000n)).toBe("-12.500000");
  });
});

const fill = (
  id: string,
  d: string,
  side: "buy" | "sell",
  qty: bigint,
  value: bigint,
  code: string,
): TaxFill => ({ id, d, code, side, qty, valueMicro: value, feeMicro: 0n });

describe("the file", () => {
  // a planted code that starts with "=" and holds a comma and a quote, bought 1 for 2_000_000 and sold for 1_000_000 (a loss)
  const evil = '=cmd|"x",1';
  const report = buildReport({
    market: "AU",
    fy: 2026,
    source: "log",
    trades: [],
    splitsByCohort: new Map(),
    logStreams: [
      {
        executionId: "log",
        fills: [
          fill("1", "2025-08-01", "buy", 1n, 2_000_000n, evil),
          fill("2", "2025-09-01", "sell", 1n, 1_000_000n, evil),
        ],
        splits: [{ code: evil, exD: "2025-08-15", ratio: makeRational(1n, 1n) }],
      },
    ],
    dividends: [],
    truncated: false,
  });
  const text = reportCsv(report);
  const rows = parseCsv(text);

  it("starts with the fixed words and says what the figures are based on", () => {
    expect(rows[0]).toEqual([PAPER_WORDS]);
    expect(rows[1]![0]).toBe("Your own trade log (typed by you), not the paper books");
    expect(rows[3]).toEqual([...CSV_HEADER]);
  });
  it("no cell of a data row starts with a formula character unguarded", () => {
    for (const r of rows) {
      for (const c of r) expect(/^[=+\-@\t\r]/.test(c), c).toBe(false);
    }
  });
  it("the planted code round-trips through the guard and the quoting", () => {
    const gain = rows.filter((r) => r[0] === "gain");
    expect(gain.length).toBe(2); // specific lot and FIFO
    for (const r of gain) expect(unguard(r[3]!)).toBe(evil);
  });
  it("amounts round-trip exactly, a loss included: cost 2.000000, proceeds 1.000000, gain -1.000000", () => {
    const g = rows.find((r) => r[0] === "gain" && r[2] === "fifo")!;
    expect([unguard(g[7]!), unguard(g[8]!), unguard(g[9]!)]).toEqual([
      "2.000000",
      "1.000000",
      "-1.000000",
    ]);
    expect(g[10]).toBe("12 months or less");
    const total = rows.find((r) => r[0] === "total" && r[2] === "fifo")!;
    expect(unguard(total[9]!)).toBe("-1.000000");
  });
});

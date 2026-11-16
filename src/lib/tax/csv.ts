// CSV export of the tax report (M21 B3; ARN-122, D-1222). The first line is the fixed words. Amounts are exact decimal
// text of the micro integer (six places), never a float. Formula guard: a cell whose first character is =, +, -, @,
// a tab or a carriage return is prefixed with a single quote, so a spreadsheet reads it as text (the usual rule, applied
// to EVERY cell, so a negative amount is also prefixed). Cells with a comma, quote or line break are quoted, quotes doubled.
import { financialYearLabel } from "@/lib/market/seed/taxYear.mjs";
import type { Disposal, TaxReport } from "./types";

const GUARDED = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function guardCell(raw: string): string {
  return raw.length > 0 && GUARDED.has(raw[0]!) ? `'${raw}` : raw;
}

export function csvCell(raw: string): string {
  const g = guardCell(raw);
  return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
}

/** Micro units as exact decimal text with six places: -12500000 -> "-12.500000". */
export function microText(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs - (abs % 1_000_000n)) / 1_000_000n;
  const frac = abs % 1_000_000n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(6, "0")}`;
}

export const CSV_HEADER = [
  "section",
  "execution",
  "method",
  "code",
  "bought",
  "sold",
  "shares",
  "cost",
  "proceeds",
  "gain",
  "holding",
  "note",
] as const;

const row = (cells: readonly string[]): string => cells.map(csvCell).join(",");
const holding = (d: Disposal): string => (d.over12Months ? "over 12 months" : "12 months or less");

export function reportCsv(r: TaxReport): string {
  const lines: string[] = [];
  lines.push(row([r.words]));
  lines.push(row([r.heading]));
  lines.push(row(["market", r.market, "financial year", financialYearLabel(r.market, r.fy)]));
  lines.push(row(CSV_HEADER));
  for (const e of r.executions) {
    const methods: [string, readonly Disposal[]][] = [
      ["specific lot", e.specific.disposals],
      ["fifo", e.fifo.disposals],
    ];
    for (const [method, list] of methods) {
      for (const d of list) {
        lines.push(
          row([
            "gain",
            e.id,
            method,
            d.code,
            d.buyD,
            d.sellD,
            d.qty.toString(),
            microText(d.costMicro),
            microText(d.proceedsMicro),
            microText(d.gainMicro),
            holding(d),
            "",
          ]),
        );
      }
    }
  }
  for (const [method, t] of [
    ["specific lot", r.total.specific],
    ["fifo", r.total.fifo],
  ] as const) {
    lines.push(
      row([
        "total",
        "all",
        method,
        "",
        "",
        "",
        "",
        microText(t.costMicro),
        microText(t.proceedsMicro),
        microText(t.gainMicro),
        "",
        "",
      ]),
    );
  }
  for (const c of r.closedWithoutPrice) {
    lines.push(
      row([
        "closed without a sale price",
        c.executionId,
        "",
        c.code,
        c.buyD,
        "",
        "",
        microText(c.costMicro),
        "",
        "",
        "",
        "no gain computed",
      ]),
    );
  }
  for (const u of r.unmatched) {
    lines.push(
      row([
        "sale with no earlier buy",
        u.executionId,
        "",
        u.code,
        "",
        u.sellD,
        u.qty.toString(),
        "",
        "",
        "",
        "",
        "no gain computed",
      ]),
    );
  }
  for (const w of r.writtenOff) {
    lines.push(
      row([
        "shares removed by a corporate action",
        w.executionId,
        "",
        w.code,
        "",
        w.exD,
        "",
        microText(w.costMicro),
        "",
        "",
        "",
        "no gain computed",
      ]),
    );
  }
  for (const x of r.dividends) {
    const franking =
      x.frankingPct === null && x.frankingCreditMicro === null
        ? "franking not recorded"
        : `franking ${x.frankingPct ?? "not recorded"}%, credit ${x.frankingCreditMicro === null ? "not recorded" : microText(x.frankingCreditMicro)}`;
    lines.push(
      row([
        "dividend",
        x.executionId,
        "",
        x.code,
        "",
        x.d,
        "",
        "",
        microText(x.amountMicro),
        "",
        "",
        franking,
      ]),
    );
  }
  if (r.truncated)
    lines.push(
      row([
        "note",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "incomplete: the read stopped at its page limit",
      ]),
    );
  return lines.join("\r\n") + "\r\n";
}

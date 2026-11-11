// Branch coverage for the display formatters: missing values, signs, odd inputs.
import { describe, expect, it } from "vitest";
import { currencyFormatOf } from "@/lib/market/profileCore.mjs";
import {
  currencyFormatFor,
  displayName,
  formatCents,
  formatCount,
  formatDate,
  formatDay,
  formatInstant,
  formatMicro,
  formatPercent,
  formatPpm,
  gainLossGlyph,
  gainLossWord,
  isoWeek,
  plural,
  truncate,
} from "@/lib/view/format";

const AUD = currencyFormatOf("AUD");
const INR = currencyFormatOf("INR");
const USD = currencyFormatOf("USD");

const NOW = new Date("2026-11-10T00:00:00Z");

describe("one CurrencyFormat per market (UXN-313, D-1002)", () => {
  it("prints the symbol and the grouping of each currency", () => {
    expect(formatMicro("1234567890000", AUD)).toBe("A$1,234,567.89");
    expect(formatMicro("1234567890000", USD)).toBe("US$1,234,567.89");
    expect(formatMicro("1234567890000", INR)).toBe("₹12,34,567.89"); // lakh grouping
    expect(formatMicro("100000000000", INR)).toBe("₹1,00,000.00");
    expect(formatMicro("10000000000000", INR)).toBe("₹1,00,00,000.00"); // crore
    expect(formatMicro("999000000", INR)).toBe("₹999.00");
    expect(formatCents(-12345678, INR, { sign: "always" })).toBe("-₹1,23,456.78");
    expect(formatCents(12345678, USD)).toBe("US$123,456.78");
  });

  it("an unregistered currency code prints as its code and never throws", () => {
    expect(formatCents(150, currencyFormatFor("JPY"))).toBe("JPY 1.50");
    expect(currencyFormatFor("AUD")).toBe(AUD);
  });
});

describe("money", () => {
  it("shows a missing or non-finite cents value as n/a, and signs by style", () => {
    expect(formatCents(null, AUD)).toBe("n/a");
    expect(formatCents(Number.NaN, AUD)).toBe("n/a");
    expect(formatCents(123456, AUD)).toBe("A$1,234.56");
    expect(formatCents(-5, AUD, { sign: "always" })).toBe("-A$0.05");
    expect(formatCents(5, USD, { sign: "always" })).toBe("+US$0.05");
    expect(formatCents(0, AUD, { sign: "always" })).toBe("A$0.00");
    expect(formatCents(-0.2, AUD)).toBe("A$0.00");
  });
  it("reads micro as number, string or bigint and rejects unsafe or malformed input", () => {
    expect(formatMicro(undefined, AUD)).toBe("n/a");
    expect(formatMicro(null, AUD)).toBe("n/a");
    expect(formatMicro(1.5, AUD)).toBe("n/a");
    expect(formatMicro(Number.MAX_SAFE_INTEGER * 2, AUD)).toBe("n/a");
    expect(formatMicro("12.5", AUD)).toBe("n/a");
    expect(formatMicro("1234567890000", AUD)).toBe("A$1,234,567.89");
    expect(formatMicro(12_345_000n, AUD)).toBe("A$12.35");
    expect(formatMicro(-12_345_000n, AUD, { sign: "always" })).toBe("-A$12.35");
    expect(formatMicro(10_000_000, AUD, { sign: "always" })).toBe("+A$10.00");
    expect(formatMicro(4_000, AUD)).toBe("A$0.00");
  });
});

describe("percent, ppm and counts", () => {
  it("handles missing values, zero after rounding and the sign styles", () => {
    expect(formatPercent(undefined)).toBe("n/a");
    expect(formatPercent(12.3456)).toBe("12.35%");
    expect(formatPercent(0.001, { sign: "always" })).toBe("0.00%");
    expect(formatPercent(-3, { digits: 0 })).toBe("-3%");
    expect(formatPercent(3, { digits: 1, sign: "always" })).toBe("+3.0%");
    expect(formatPpm(null)).toBe("n/a");
    expect(formatPpm(12_500)).toBe("1.25%");
    expect(formatCount(undefined)).toBe("n/a");
    expect(formatCount(-1234.4)).toBe("-1,234");
    expect(formatCount(-0.3)).toBe("0");
  });
  it("gives a glyph and a word for gain, loss, flat and unknown", () => {
    expect(gainLossGlyph(5)).toBe("▲");
    expect(gainLossGlyph(-5)).toBe("▼");
    expect(gainLossGlyph(0)).toBe("–");
    expect(gainLossGlyph(null)).toBe("–");
    expect(gainLossWord(5)).toBe("gain");
    expect(gainLossWord(-5)).toBe("loss");
    expect(gainLossWord(0)).toBe("no change");
    expect(gainLossWord(undefined)).toBe("not available");
  });
});

describe("dates", () => {
  it("formats a calendar date and rejects what is not one", () => {
    expect(formatDate("2026-10-19")).toBe("Mon 19 Oct 2026");
    expect(formatDate("2026-02-31")).toBe("n/a");
    expect(formatDate("19/10/2026")).toBe("n/a");
    expect(formatDate(null)).toBe("n/a");
  });
  it("computes ISO weeks across a year boundary", () => {
    expect(isoWeek("2026-10-19")).toBe("2026-W43");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2026-10-18")).toBe("2026-W42"); // a Sunday
    expect(isoWeek("nope")).toBeNull();
  });
  it("shows the year only when it is not the current one", () => {
    expect(formatDay("2026-11-09", NOW)).toBe("Mon 9 Nov");
    expect(formatDay("2025-11-09", NOW)).toBe("Sun 9 Nov 2025");
    expect(formatDay("2026-11-09T05:00:00Z", NOW)).toBe("Mon 9 Nov");
    expect(formatDay(null, NOW)).toBe("n/a");
    expect(formatDay("garbage", NOW)).toBe("n/a");
  });
  it("shows an instant in Melbourne time without the raw ISO text", () => {
    const s = formatInstant("2026-11-09T09:30:00Z", NOW);
    expect(s).toBe("Mon 9 Nov, 20:30");
    expect(formatInstant("2025-07-01T00:00:00Z", NOW)).toBe("Tue 1 Jul 2025, 10:00");
    expect(formatInstant("not a date", NOW)).toBe("n/a");
    expect(formatInstant(undefined, NOW)).toBe("n/a");
  });
});

describe("text helpers", () => {
  it("truncates with an ellipsis and never splits an emoji", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefgh", 4)).toBe("abc…");
    expect(truncate("😀😀😀😀", 3)).toBe("😀😀…");
    expect(truncate("abc", 0)).toBe("…");
  });
  it("picks the singular only for one", () => {
    expect(plural(1, "pick")).toBe("pick");
    expect(plural(0, "pick")).toBe("picks");
    expect(plural(2, "company", "companies")).toBe("companies");
  });
  it("tidies an all-capitals company name and leaves a mixed-case one alone", () => {
    expect(displayName(null)).toBe("n/a");
    expect(displayName("   ")).toBe("n/a");
    expect(displayName("Already Mixed LTD")).toBe("Already Mixed LTD");
    expect(displayName("SERVICE STREAM LIMITED")).toBe("Service Stream Limited");
    expect(displayName("BHP GROUP LTD")).toBe("BHP Group Ltd");
    expect(displayName("ACME PTY LTD.")).toBe("Acme Pty Ltd.");
    expect(displayName("SCX.AI NL")).toBe("SCX.AI NL");
    expect(displayName("G8 EDUCATION")).toBe("G8 Education");
    expect(displayName("BANK OF THE WEST")).toBe("Bank of the West");
    expect(displayName("O'BRIEN-SMITH HOLDINGS")).toBe("O'Brien-Smith Holdings");
    expect(displayName("SMITH & CO")).toBe("Smith & Co");
  });
});

// @vitest-environment node
// Format, terms, staleness and honesty helpers of the view-model foundation (M7 T2). Missing, zero,
// negative and very large values are covered on purpose (TST-128).
import { describe, expect, it } from "vitest";
import {
  formatCents,
  formatCount,
  formatDate,
  formatMicro,
  formatPercent,
  formatPpm,
  gainLossGlyph,
  gainLossWord,
  isoWeek,
  MISSING,
  plural,
  truncate,
} from "@/lib/view/format";
import {
  alertTierLabel,
  breakerLabel,
  moneyTypeLabel,
  regimeLabel,
  strategyDisplayName,
  termFor,
  TERMS,
  validationLabel,
} from "@/lib/view/terms";
import { dateStaleness, daysBetween, staleness } from "@/lib/view/staleness";
import {
  AI_SUMMARY_NOTICE,
  DELAYED_PRICE_LABEL,
  hasForbiddenClaim,
  NOT_ADVICE_FOOTER,
  SCENARIO_CAPTION,
  sampleCheck,
} from "@/lib/view/honesty";
import { STRATEGY_NAMES_DEFAULT } from "@/lib/config/keys";
import { LABELS } from "@/lib/agents/schema";

describe("format", () => {
  it("cents: grouping, sign, zero, missing", () => {
    expect(formatCents(123456)).toBe("A$1,234.56");
    expect(formatCents(-5)).toBe("-A$0.05");
    expect(formatCents(0)).toBe("A$0.00");
    expect(formatCents(0, { sign: "always" })).toBe("A$0.00");
    expect(formatCents(1, { sign: "always" })).toBe("+A$0.01");
    expect(formatCents(-100000000, { sign: "always" })).toBe("-A$1,000,000.00");
    expect(formatCents(null)).toBe(MISSING);
    expect(formatCents(undefined)).toBe(MISSING);
    expect(formatCents(Number.NaN)).toBe(MISSING);
    expect(formatCents(Infinity)).toBe(MISSING);
    expect(formatCents(150, { currency: "USD " })).toBe("USD 1.50");
  });
  it("micro-AUD: strings, bigint, rounding half away from zero, bad input", () => {
    expect(formatMicro("1500000")).toBe("A$1.50");
    expect(formatMicro("150000000")).toBe("A$150.00");
    expect(formatMicro(1_234_567_890n)).toBe("A$1,234.57");
    expect(formatMicro("5000")).toBe("A$0.01");
    expect(formatMicro("4999")).toBe("A$0.00");
    expect(formatMicro("-5000")).toBe("-A$0.01");
    expect(formatMicro("-4999")).toBe("A$0.00");
    expect(formatMicro("0", { sign: "always" })).toBe("A$0.00");
    expect(formatMicro(2_500_000)).toBe("A$2.50");
    expect(formatMicro(null)).toBe(MISSING);
    expect(formatMicro("1.5")).toBe(MISSING);
    expect(formatMicro("abc")).toBe(MISSING);
    expect(formatMicro(1.5)).toBe(MISSING);
    expect(formatMicro("9".repeat(31))).toBe(MISSING);
    expect(formatMicro("123456789012345678901234567890")).toMatch(/^A\$[\d,]+\.\d\d$/);
  });
  it("percent and ppm", () => {
    expect(formatPercent(12.3456)).toBe("12.35%");
    expect(formatPercent(-0.004)).toBe("0.00%");
    expect(formatPercent(0.5, { sign: "always", digits: 1 })).toBe("+0.5%");
    expect(formatPercent(null)).toBe(MISSING);
    expect(formatPpm(12_500)).toBe("1.25%");
    expect(formatPpm(-126_000)).toBe("-12.60%");
    expect(formatPpm(0)).toBe("0.00%");
    expect(formatPpm(null)).toBe(MISSING);
  });
  it("counts, glyphs and words", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(-1200)).toBe("-1,200");
    expect(formatCount(null)).toBe(MISSING);
    expect(gainLossGlyph(1)).toBe("▲");
    expect(gainLossGlyph(-1)).toBe("▼");
    expect(gainLossGlyph(0)).toBe("–");
    expect(gainLossGlyph(null)).toBe("–");
    expect(gainLossWord(1)).toBe("gain");
    expect(gainLossWord(-1)).toBe("loss");
    expect(gainLossWord(0)).toBe("no change");
    expect(gainLossWord(undefined)).toBe("not available");
  });
  it("dates and ISO weeks", () => {
    expect(formatDate("2026-10-19")).toBe("Mon 19 Oct 2026");
    expect(formatDate("2026-02-30")).toBe(MISSING);
    expect(formatDate("")).toBe(MISSING);
    expect(formatDate(null)).toBe(MISSING);
    expect(isoWeek("2026-10-19")).toBe("2026-W43");
    expect(isoWeek("2026-10-25")).toBe("2026-W43");
    expect(isoWeek("2026-10-26")).toBe("2026-W44");
    expect(isoWeek("2021-01-03")).toBe("2020-W53");
    expect(isoWeek("2024-12-30")).toBe("2025-W01");
    expect(isoWeek("2026-13-01")).toBeNull();
  });
  it("truncate and plural handle long text and one/many", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(truncate("😀😀😀😀", 3)).toBe("😀😀…");
    expect(plural(1, "case")).toBe("case");
    expect(plural(0, "case")).toBe("cases");
    expect(plural(2, "company", "companies")).toBe("companies");
  });
});

describe("terms", () => {
  it("the table covers the UXN-031 general terms with a hover for each", () => {
    expect(TERMS.length).toBeGreaterThanOrEqual(15);
    for (const t of TERMS) {
      expect(t.shown.length, t.official).toBeGreaterThan(2);
      expect(t.hover.length, t.official).toBeGreaterThan(10);
    }
    expect(termFor("nav")?.shown).toBe("Value");
    expect(termFor(" Drawdown ")?.shown).toBe("Drop from peak");
    expect(termFor("nope")).toBeNull();
  });
  it("every ARN-086 label has a friendly text, with the exact label kept (decision 4)", () => {
    for (const l of LABELS) {
      const v = validationLabel(l);
      expect(v.official).toBe(l);
      expect(v.shown.length).toBeGreaterThan(3);
      expect(v.shown).not.toBe(l);
    }
    expect(validationLabel("UNVALIDATED").shown).toBe("Not proven yet");
    expect(validationLabel("CONSISTENT-FORWARD").shown).toBe("Working in live practice");
    expect(validationLabel("made up").shown).toBe("Not proven yet");
    expect(validationLabel("toString").shown).toBe("Not proven yet");
  });
  it("market mood, warning signs and alert tiers", () => {
    expect(regimeLabel("RISK-ON").shown).toBe("Calm and rising");
    expect(regimeLabel("RISK-OFF").shown).toBe("Nervous");
    expect(regimeLabel("unknown").shown).toBe("Not enough history yet");
    expect(regimeLabel("constructor").shown).toBe("Not enough history yet");
    expect(breakerLabel("red").shown).toBe("Triggered");
    expect(breakerLabel("zzz").shown).toBe("Not available");
    expect(alertTierLabel("P0").shown).toBe("Urgent");
    expect(alertTierLabel("P1").shown).toBe("Important");
    expect(alertTierLabel("P2").shown).toBe("FYI");
  });
  it("strategy names come from the config table and carry the money type; no numbers in names", () => {
    expect(strategyDisplayName(STRATEGY_NAMES_DEFAULT, "F4", false)).toBe(
      "Buy the dip — Own money",
    );
    expect(strategyDisplayName(STRATEGY_NAMES_DEFAULT, "F1", true)).toBe(
      "Follow the trend — With borrowed money",
    );
    expect(strategyDisplayName(STRATEGY_NAMES_DEFAULT, "F9", false)).toBe("F9 — Own money");
    expect(strategyDisplayName(STRATEGY_NAMES_DEFAULT, "__proto__", false)).toBe(
      "__proto__ — Own money",
    );
    expect(moneyTypeLabel(true)).toBe("With borrowed money");
  });
});

describe("staleness", () => {
  const now = new Date("2026-10-20T10:00:00.000Z");
  it("fresh, stale (with the last good time) and missing", () => {
    const fresh = staleness("2026-10-20T09:50:00.000Z", now, 15);
    expect(fresh).toMatchObject({ state: "fresh", ageMinutes: 10 });
    const stale = staleness("2026-10-20T09:00:00.000Z", now, 15);
    expect(stale).toMatchObject({ state: "stale", ageMinutes: 60 });
    expect(stale.text).toContain("2026-10-20 20:00");
    expect(stale.text).toContain("has not updated since");
    expect(staleness("2026-10-20T09:45:00.000Z", now, 15).state).toBe("fresh"); // exactly the allowance
    for (const bad of [null, undefined, "", "nonsense", "2027-01-01T00:00:00.000Z"]) {
      expect(staleness(bad, now, 15).state, String(bad)).toBe("missing");
    }
  });
  it("date-keyed data", () => {
    expect(daysBetween("2026-10-17", "2026-10-20")).toBe(3);
    expect(daysBetween("2026-10-20", "2026-10-17")).toBe(-3);
    expect(daysBetween("x", "2026-10-17")).toBeNull();
    expect(dateStaleness("2026-10-19", "2026-10-20", 1).state).toBe("fresh");
    expect(dateStaleness("2026-10-17", "2026-10-20", 1).state).toBe("stale");
    expect(dateStaleness("2026-10-21", "2026-10-20", 1).state).toBe("missing");
    expect(dateStaleness(null, "2026-10-20", 1).state).toBe("missing");
  });
});

describe("honesty", () => {
  it("fixed texts are exactly the spec's", () => {
    expect(NOT_ADVICE_FOOTER).toBe(
      "Simulation for personal information only — not financial advice",
    );
    expect(SCENARIO_CAPTION).toBe("Historical range, not a forecast");
    expect(DELAYED_PRICE_LABEL).toBe("Delayed about 20 min");
    expect(AI_SUMMARY_NOTICE).toContain("AI summary of public information");
    expect(AI_SUMMARY_NOTICE).toContain("Not financial advice.");
  });
  it("a small sample shows the shortfall, never a number", () => {
    expect(sampleCheck(29, 30)).toEqual({
      enough: false,
      text: "Not measured yet: 29 of 30 cases so far",
    });
    expect(sampleCheck(30, 30)).toEqual({ enough: true, text: "Based on 30 cases" });
    expect(sampleCheck(null, 30).enough).toBe(false);
    expect(sampleCheck(Number.NaN, 30).text).toContain("0 of 30");
    expect(sampleCheck(-4, 30).text).toContain("0 of 30");
    expect(sampleCheck(1200, 30).text).toBe("Based on 1,200 cases");
  });
  it("catches words the product never uses", () => {
    expect(hasForbiddenClaim("This is guaranteed to work")).toBe(true);
    expect(hasForbiddenClaim("We guarantee returns")).toBe(true);
    expect(hasForbiddenClaim("It will rise next week")).toBe(true);
    expect(hasForbiddenClaim("Risk-free")).toBe(true);
    expect(hasForbiddenClaim(SCENARIO_CAPTION)).toBe(false);
    expect(hasForbiddenClaim(NOT_ADVICE_FOOTER)).toBe(false);
  });
});

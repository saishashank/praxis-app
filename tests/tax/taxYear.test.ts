// @vitest-environment node
// M21 B3 (ARN-122, D-1222): the financial year of each built market, and the 12-month holding rule.
import { describe, expect, it } from "vitest";
import {
  TAX_YEAR_START,
  financialYearLabel,
  financialYearOf,
  financialYearRange,
} from "@/lib/market/seed/taxYear.mjs";
import { anniversary12, isOver12Months } from "@/lib/tax/holding";

describe("financial year by market", () => {
  it("the start dates are the three markets' rules", () => {
    expect(TAX_YEAR_START).toEqual({ AU: "07-01", IN: "04-01", US: "01-01" });
  });
  it("AU runs 1 July to 30 June and is named by the year it ends in", () => {
    expect(financialYearOf("AU", "2025-06-30")).toBe(2025);
    expect(financialYearOf("AU", "2025-07-01")).toBe(2026);
    expect(financialYearOf("AU", "2026-06-30")).toBe(2026);
    expect(financialYearRange("AU", 2026)).toEqual({ start: "2025-07-01", end: "2026-06-30" });
    expect(financialYearLabel("AU", 2026)).toBe("1 Jul 2025 to 30 Jun 2026");
  });
  it("IN runs 1 April to 31 March", () => {
    expect(financialYearOf("IN", "2026-03-31")).toBe(2026);
    expect(financialYearOf("IN", "2026-04-01")).toBe(2027);
    expect(financialYearRange("IN", 2026)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(financialYearLabel("IN", 2026)).toBe("1 Apr 2025 to 31 Mar 2026");
  });
  it("US is the calendar year", () => {
    expect(financialYearOf("US", "2025-12-31")).toBe(2025);
    expect(financialYearOf("US", "2026-01-01")).toBe(2026);
    expect(financialYearRange("US", 2026)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(financialYearLabel("US", 2026)).toBe("tax year 2026 (calendar year)");
  });
  it("a market with no rule, or a bad date, throws", () => {
    expect(() => financialYearOf("ZZ", "2026-01-01")).toThrow();
    expect(() => financialYearOf("AU", "2026-1-1")).toThrow();
  });
});

describe("12 months holding", () => {
  it("the sale must be AFTER the anniversary", () => {
    expect(isOver12Months("2024-12-10", "2025-12-10")).toBe(false);
    expect(isOver12Months("2024-12-10", "2025-12-11")).toBe(true);
    expect(isOver12Months("2024-12-10", "2025-12-09")).toBe(false);
  });
  it("a 29 February buy has its anniversary on 28 February", () => {
    expect(anniversary12("2024-02-29")).toBe("2025-02-28");
    expect(isOver12Months("2024-02-29", "2025-02-28")).toBe(false);
    expect(isOver12Months("2024-02-29", "2025-03-01")).toBe(true);
  });
});

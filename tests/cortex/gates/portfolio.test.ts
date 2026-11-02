// @vitest-environment node
// G11 portfolio limits across the books (M15 C3c; CTX-026): books per code, code and industry NAV
// shares, drift above a cap, exact Rational comparisons.
import { describe, expect, it } from "vitest";
import {
  PORTFOLIO_CODE_LABEL,
  PORTFOLIO_INDUSTRY_LABEL,
  gatePortfolio,
  portfolioFigures,
  type Exposure,
  type PortfolioInput,
} from "@/lib/cortex/gates";
import { makeRational } from "@/lib/money/rational";

const M = 1_000_000n;
const caps = {
  maxBooksSameCode: 2,
  maxCodeNavShare: makeRational(20n, 100n),
  maxIndustryNavShare: makeRational(35n, 100n),
};
// arena NAV A$120,000 across 12 books; two books hold ZZA (A$6,000 each), one holds ZZB (Materials)
const held: Exposure[] = [
  { bookId: "E01", code: "ZZA", industry: "Materials", exposureMicro: 6_000n * M },
  { bookId: "E02", code: "ZZA", industry: "Materials", exposureMicro: 6_000n * M },
  { bookId: "E03", code: "ZZB", industry: "Materials", exposureMicro: 6_000n * M },
  { bookId: "E04", code: "ZZC", industry: "Energy", exposureMicro: 30_000n * M },
];
const base: PortfolioInput = {
  bookId: "E05",
  code: "ZZD",
  industry: "Financials",
  orderValueMicro: 5_000n * M,
  exposures: held,
  arenaNavMicro: 120_000n * M,
  caps,
};

describe("G11_portfolio (CTX-026)", () => {
  it("a new code in a new industry passes with the figures as value", () => {
    expect(gatePortfolio(base)).toEqual({ pass: true, value: "books:1 code:1/24 industry:1/24" });
  });

  it("a third book in the same code fails (max_books_same_code = 2) with the company label", () => {
    expect(gatePortfolio({ ...base, code: "ZZA", industry: "Materials" })).toEqual({
      pass: false,
      gateId: "G11_portfolio",
      label: PORTFOLIO_CODE_LABEL,
      value: "books:3 > 2",
    });
    // a book that already holds the code adds no book
    expect(gatePortfolio({ ...base, bookId: "E01", code: "ZZA", industry: "Materials" }).pass).toBe(
      true,
    );
  });

  it("the code NAV share after the entry above 20 % fails; exactly 20 % passes", () => {
    const f = portfolioFigures({
      ...base,
      code: "ZZB",
      industry: "Materials",
      orderValueMicro: 18_000n * M,
    });
    expect(f.codeShareAfter).toEqual(makeRational(1n, 5n));
    expect(
      gatePortfolio({ ...base, code: "ZZB", industry: "Materials", orderValueMicro: 18_000n * M })
        .pass,
    ).toBe(true);
    expect(
      gatePortfolio({ ...base, code: "ZZB", industry: "Materials", orderValueMicro: 18_001n * M }),
    ).toMatchObject({
      pass: false,
      label: PORTFOLIO_CODE_LABEL,
      value: "code_share:24001/120000 > 1/5",
    });
  });

  it("drift: a code already at or above its cap takes no new entry (nothing is force-sold)", () => {
    const drifted = [
      ...held,
      { bookId: "E06", code: "ZZE", industry: null, exposureMicro: 24_000n * M },
    ];
    expect(
      gatePortfolio({
        ...base,
        code: "ZZE",
        industry: null,
        exposures: drifted,
        orderValueMicro: 1n * M,
      }),
    ).toMatchObject({
      pass: false,
      label: PORTFOLIO_CODE_LABEL,
      value: "code_drift:1/5",
    });
  });

  it("the industry share (35 %) fails with the industry label; an unknown industry counts towards no cap", () => {
    // Energy holds 30,000 of 120,000 = 25 %; a 12,001 order takes it past 35 %
    expect(
      gatePortfolio({ ...base, code: "ZZF", industry: "Energy", orderValueMicro: 12_001n * M }),
    ).toMatchObject({
      pass: false,
      gateId: "G11_portfolio",
      label: PORTFOLIO_INDUSTRY_LABEL,
      value: "industry_share:42001/120000 > 7/20",
    });
    expect(
      gatePortfolio({ ...base, code: "ZZF", industry: "Energy", orderValueMicro: 12_000n * M })
        .pass,
    ).toBe(true);
    const drifted = [
      ...held,
      { bookId: "E07", code: "ZZG", industry: "Energy", exposureMicro: 12_000n * M },
    ];
    expect(
      gatePortfolio({
        ...base,
        code: "ZZF",
        industry: "Energy",
        exposures: drifted,
        orderValueMicro: 1n * M,
      }),
    ).toMatchObject({
      value: "industry_drift:7/20",
    });
    expect(gatePortfolio({ ...base, industry: null, orderValueMicro: 20_000n * M }).value).toBe(
      "books:1 code:1/6 industry:unknown",
    );
  });

  it("refuses a non-positive arena NAV and a bad book cap", () => {
    expect(() => gatePortfolio({ ...base, arenaNavMicro: 0n })).toThrow(RangeError);
    expect(() => gatePortfolio({ ...base, caps: { ...caps, maxBooksSameCode: 0 } })).toThrow(
      RangeError,
    );
  });
});

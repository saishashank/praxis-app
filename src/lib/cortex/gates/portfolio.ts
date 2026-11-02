// G11 portfolio limits across the 12 books (M15 C3c; spec ch. 17 CTX-026; keys `max_books_same_code`,
// `max_code_nav_share`, `max_industry_nav_share`). Exposure = position notional at the night's close
// (leverage is a book-level multiplier the caller folds into `exposureMicro`); arena NAV = Σ book NAV.
// A code or industry already above its cap through drift takes no new entry (nothing is force-sold);
// the book count per industry is a reporting figure only. Exact Rational comparisons on micro-dollars.
import type { Micro } from "@/lib/money/micro";
import { cmpRat, makeRational, type Rational } from "@/lib/money/rational";
import { PORTFOLIO_CODE_LABEL, PORTFOLIO_INDUSTRY_LABEL } from "./list";
import { fail, pass, type GateResult } from "./types";

/** One held line of one book, valued at the night's close. */
export type Exposure = {
  readonly bookId: string;
  readonly code: string;
  /** GICS industry group at the cut-off; null = unknown (counts towards no industry cap). */
  readonly industry: string | null;
  readonly exposureMicro: Micro;
};

export type PortfolioCaps = {
  readonly maxBooksSameCode: number;
  readonly maxCodeNavShare: Rational;
  readonly maxIndustryNavShare: Rational;
};

export type PortfolioInput = {
  readonly bookId: string;
  readonly code: string;
  readonly industry: string | null;
  /** The entry's notional (qty × reference price), micro-dollars. */
  readonly orderValueMicro: Micro;
  /** Every held line across the books, plus tonight's earlier picks (the caller appends them). */
  readonly exposures: readonly Exposure[];
  /** Σ NAV over the 12 books, micro-dollars (> 0). */
  readonly arenaNavMicro: Micro;
  readonly caps: PortfolioCaps;
};

export type PortfolioFigures = {
  readonly booksInCode: number;
  readonly codeShare: Rational;
  readonly codeShareAfter: Rational;
  readonly industryShare: Rational | null;
  readonly industryShareAfter: Rational | null;
  readonly booksInIndustry: number;
};

/** The CTX-026 figures before and after the proposed entry. */
export function portfolioFigures(input: PortfolioInput): PortfolioFigures {
  if (input.arenaNavMicro <= 0n) throw new RangeError("arena NAV must be positive");
  const books = new Set<string>();
  const indBooks = new Set<string>();
  let code = 0n;
  let industry = 0n;
  for (const e of input.exposures) {
    if (e.code === input.code) {
      books.add(e.bookId);
      code += e.exposureMicro;
    }
    if (input.industry !== null && e.industry === input.industry) {
      indBooks.add(e.bookId);
      industry += e.exposureMicro;
    }
  }
  const nav = input.arenaNavMicro;
  return {
    booksInCode: books.size,
    codeShare: makeRational(code, nav),
    codeShareAfter: makeRational(code + input.orderValueMicro, nav),
    industryShare: input.industry === null ? null : makeRational(industry, nav),
    industryShareAfter:
      input.industry === null ? null : makeRational(industry + input.orderValueMicro, nav),
    booksInIndustry: indBooks.size,
  };
}

const ratText = (r: Rational): string => `${r.num}/${r.den}`;

/**
 * G11 (CTX-026): at most `max_books_same_code` books in the code (a book already holding it adds no
 * book), the code's NAV share after the entry within `max_code_nav_share`, the industry's within
 * `max_industry_nav_share`; a share already at or above its cap (drift) blocks the entry.
 */
export function gatePortfolio(input: PortfolioInput): GateResult {
  const { caps } = input;
  if (!Number.isInteger(caps.maxBooksSameCode) || caps.maxBooksSameCode < 1) {
    throw new RangeError("max_books_same_code must be a positive integer");
  }
  const f = portfolioFigures(input);
  const holdsAlready = input.exposures.some(
    (e) => e.code === input.code && e.bookId === input.bookId,
  );
  const booksAfter = holdsAlready ? f.booksInCode : f.booksInCode + 1;
  if (booksAfter > caps.maxBooksSameCode) {
    return fail(
      "G11_portfolio",
      PORTFOLIO_CODE_LABEL,
      `books:${booksAfter} > ${caps.maxBooksSameCode}`,
    );
  }
  if (cmpRat(f.codeShare, caps.maxCodeNavShare) >= 0) {
    return fail("G11_portfolio", PORTFOLIO_CODE_LABEL, `code_drift:${ratText(f.codeShare)}`);
  }
  if (cmpRat(f.codeShareAfter, caps.maxCodeNavShare) > 0) {
    return fail(
      "G11_portfolio",
      PORTFOLIO_CODE_LABEL,
      `code_share:${ratText(f.codeShareAfter)} > ${ratText(caps.maxCodeNavShare)}`,
    );
  }
  if (f.industryShare !== null && f.industryShareAfter !== null) {
    if (cmpRat(f.industryShare, caps.maxIndustryNavShare) >= 0) {
      return fail(
        "G11_portfolio",
        PORTFOLIO_INDUSTRY_LABEL,
        `industry_drift:${ratText(f.industryShare)}`,
      );
    }
    if (cmpRat(f.industryShareAfter, caps.maxIndustryNavShare) > 0) {
      return fail(
        "G11_portfolio",
        PORTFOLIO_INDUSTRY_LABEL,
        `industry_share:${ratText(f.industryShareAfter)} > ${ratText(caps.maxIndustryNavShare)}`,
      );
    }
  }
  return pass(
    `books:${booksAfter} code:${ratText(f.codeShareAfter)} industry:${
      f.industryShareAfter === null ? "unknown" : ratText(f.industryShareAfter)
    }`,
  );
}

// The financial (tax) year start of each built market (M21 B3; ARN-122, D-1222, AT-67). A market fact, so it lives
// here and nowhere else. A financial year is named by the calendar year in which it ENDS (AU FY 2026 = 1 Jul 2025 to
// 30 Jun 2026); a year that starts on 1 January ends on 31 December of its own year (US FY 2026 = calendar 2026).
// IN and US are built but off in production; their rules are here so the report is ready when a market is enabled.
export const TAX_YEAR_START = Object.freeze({ AU: "07-01", IN: "04-01", US: "01-01" });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function startOf(market) {
  if (!Object.prototype.hasOwnProperty.call(TAX_YEAR_START, market)) {
    throw new RangeError(`no tax year rule for market ${String(market)}`);
  }
  return TAX_YEAR_START[market];
}

const pad = (n, w) => String(n).padStart(w, "0");
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function assertDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new RangeError("a date must be YYYY-MM-DD");
  }
}

/** The financial year (the year it ends in) that a date falls in. */
export function financialYearOf(market, d) {
  const start = startOf(market);
  assertDate(d);
  const year = parseInt(d.slice(0, 4), 10);
  if (start === "01-01") return year;
  return d.slice(5) >= start ? year + 1 : year;
}

/** First and last date (inclusive) of a financial year. */
export function financialYearRange(market, fy) {
  const start = startOf(market);
  if (!Number.isInteger(fy) || fy < 1900 || fy > 9999) throw new RangeError("fy must be a year");
  if (start === "01-01") return { start: `${pad(fy, 4)}-01-01`, end: `${pad(fy, 4)}-12-31` };
  const startMonth = parseInt(start.slice(0, 2), 10);
  const startDay = parseInt(start.slice(3), 10);
  // the day before the start, in the year the financial year ends
  let endMonth = startMonth;
  let endDay = startDay - 1;
  if (endDay === 0) {
    endMonth = startMonth === 1 ? 12 : startMonth - 1;
    endDay = DAYS_IN_MONTH[endMonth - 1] + (endMonth === 2 && isLeap(fy) ? 1 : 0);
  }
  return {
    start: `${pad(fy - 1, 4)}-${start}`,
    end: `${pad(fy, 4)}-${pad(endMonth, 2)}-${pad(endDay, 2)}`,
  };
}

const plain = (d) =>
  `${parseInt(d.slice(8), 10)} ${MONTHS[parseInt(d.slice(5, 7), 10) - 1]} ${d.slice(0, 4)}`;

/** "1 Jul 2025 to 30 Jun 2026". */
export function financialYearLabel(market, fy) {
  const r = financialYearRange(market, fy);
  return `${plain(r.start)} to ${plain(r.end)}`;
}

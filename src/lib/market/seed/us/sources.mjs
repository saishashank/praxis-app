// The US (NYSE, Nasdaq) source rows: the one definition of the DAT-244 candidate sources (M20 A3; D-1096, D-1128).
// Same shape and rules as seed/in/sources.mjs: `ensureMarketSources(db, "US")` writes the rows when the market
// leaves `off`, never a migration. Status: `enabled` for EDGAR (free, fair-access terms, declared contact), the SEC
// suspensions page, the NYSE holiday list and the manual CSV upload; `pending` for every other fetched source
// (Yahoo under the O-26 basis, Stooq, FINRA, Nasdaq halts, FRED with the Owner key). No contact value or key
// appears in any row (D-1094, SEC-110); the EDGAR rows say only that the contact is required.
export const MARKET = "US";

// The A3 verification pass (build-machine run of scripts/market/source-report.mjs): the rows whose terms page was read.
// A row not listed was not reachable under the polite rules (robots.txt disallowed, or the declared contact missing) and
// keeps `last_checked` null.
const CHECKED = new Set([
  "us_yahoo",
  "us_finra_short",
  "us_nasdaq_halts",
  "us_fred",
  "us_nyse_holidays",
]);
const CHECKED_ON = "2026-11-12";

/** @type {readonly Readonly<Record<string, unknown>>[]} */
export const SOURCES = Object.freeze(
  [
    {
      id: "us_yahoo",
      label: "Yahoo Finance end-of-day prices, US",
      provides: "Daily price bars for US codes under the same risk basis as the AU feed.",
      terms:
        "Unofficial data for personal use; its terms may not permit automated access, and the chart endpoint's robots.txt disallows automated clients, which the polite client respects (D-1132). Used only under the Owner risk acceptance O-26.",
      hosts: [],
      code: [],
      terms_url: "https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html",
      permitted_use:
        "personal use only (DAT-124); US end-of-day prices under the Yahoo risk basis O-26",
      rate_limits: "undocumented; one request every 700 ms at most",
      risk: "high",
      status: "pending",
      owner_ref: "O-26",
      summarisation_permitted: 0,
      intervalMs: 700,
      probe: { url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d" },
    },
    {
      id: "us_stooq",
      label: "Stooq daily price files",
      provides: "Daily price bars as an alternative US price source.",
      terms:
        "The site's robots.txt disallows automated clients, which the polite client respects (D-1132), so no request is made. The row stays pending.",
      hosts: ["stooq.com"],
      code: [],
      terms_url: "https://stooq.com/",
      permitted_use: "Stooq daily price files; off until its terms are checked",
      rate_limits: "not published; one request every second",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1000,
      probe: { url: "https://stooq.com/q/d/l/?s=aapl.us&i=d" },
    },
    {
      id: "us_edgar",
      label: "SEC EDGAR",
      provides:
        "Filings (8-K items, Form 4, 13D and 13G), company facts as filed and submissions (SIC).",
      terms:
        "Free public data under the SEC's fair-access terms: a declared User-Agent with a contact is required (the Owner-store value PRAXIS_EDGAR_CONTACT, never in code), at most 10 requests a second, and we use at most 2. A request without the contact is answered with a rate-limit block page, so the client makes none (D-1094).",
      hosts: ["www.sec.gov", "data.sec.gov", "efts.sec.gov"],
      code: [],
      terms_url: "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
      permitted_use:
        "SEC EDGAR public filings, company facts and Form 4: free, fair-access terms, declared User-Agent required, at most 2 requests a second (D-1094)",
      rate_limits: "10 req/s fair access; we use ≤ 2",
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 1,
      intervalMs: 500,
      contact: true,
      probe: { url: "https://data.sec.gov/submissions/CIK0000320193.json" },
    },
    {
      id: "us_finra_short",
      label: "FINRA short interest and short volume",
      provides: "Semi-monthly short interest and daily short-sale volume files.",
      terms:
        "Public files on FINRA's data host. FINRA's terms restrict redistribution and commercial reuse, so the licence is still to be verified; pending until the Owner turns the fetcher on.",
      hosts: ["www.finra.org", "cdn.finra.org"],
      code: [],
      terms_url: "https://www.finra.org/terms-of-use",
      permitted_use: "FINRA short-interest and short-volume files; licence to be verified",
      rate_limits: "not published; one request every second",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1000,
      probe: { url: "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20251110.txt" },
    },
    {
      id: "us_nasdaq_halts",
      label: "Nasdaq Trader trading halts",
      provides: "The trading-halt feed (halt time, resume time, reason code).",
      terms:
        "Public feed on the Nasdaq Trader site. Terms to be checked; pending until the Owner turns the fetcher on.",
      hosts: ["www.nasdaqtrader.com"],
      code: [],
      terms_url: "https://www.nasdaqtrader.com/",
      permitted_use: "Nasdaq Trader trading-halt feed",
      rate_limits: "not published; one request every second",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1000,
      probe: { url: "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts" },
    },
    {
      id: "us_sec_suspensions",
      label: "SEC trading suspensions",
      provides: "Trading suspensions the regulator publishes.",
      terms:
        "Public regulator pages under the same fair-access terms and declared User-Agent as EDGAR (D-1094); no request is made without the contact.",
      hosts: ["www.sec.gov"],
      code: [],
      terms_url: "https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data",
      permitted_use: "public SEC trading suspensions",
      rate_limits: "10 req/s fair access; we use ≤ 2",
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 1,
      intervalMs: 500,
      contact: true,
      probe: { url: "https://www.sec.gov/enforcement-litigation/trading-suspensions" },
    },
    {
      id: "us_sp_dji_russell_manual",
      label: "US index membership (manual CSV)",
      provides:
        "Index adds and deletes keyed by the Owner from the index providers' public notices.",
      terms: "A file the Owner prepares and uploads; nothing is fetched.",
      hosts: [],
      code: [],
      terms_url: null,
      permitted_use: "manual CSV upload by the Owner (S&P, Dow Jones and Russell index membership)",
      rate_limits: null,
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1000,
      probe: null,
    },
    {
      id: "us_fred",
      label: "FRED macro series",
      provides: "US macro series (rates, inflation) for the regime inputs.",
      terms:
        "Each FRED series carries its own terms, checked per series before use; the API needs the Owner's key (the Owner-store name FRED_API_KEY, never in code). Off until the key is stored; the host's robots.txt asks for a 2 second crawl delay, which the client honours.",
      hosts: ["api.stlouisfed.org"],
      code: [],
      terms_url: "https://fred.stlouisfed.org/docs/api/terms_of_use.html",
      permitted_use: "FRED macro series: needs the Owner key; off until it is stored",
      rate_limits: "not published; one request every 2 s (crawl delay)",
      risk: "low",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 2000,
      probe: null,
    },
    {
      id: "us_nyse_holidays",
      label: "NYSE trading-holiday list",
      provides:
        "The exchange's published holidays and early closes, the check behind the calendar rows.",
      terms:
        "Public holiday and early-close page of the exchange; the host's robots.txt allows it. Read once a year to confirm the calendar rules.",
      hosts: ["www.nyse.com"],
      code: ["src/lib/data/calendarRules/us.mjs"],
      terms_url: "https://www.nyse.com/trade/hours-calendars",
      permitted_use: "public NYSE trading-holiday list",
      rate_limits: "not published; one request every second",
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1000,
      probe: { url: "https://www.nyse.com/trade/hours-calendars" },
    },
  ].map((r) =>
    Object.freeze({ market: MARKET, last_checked: CHECKED.has(r.id) ? CHECKED_ON : null, ...r }),
  ),
);

export default SOURCES;

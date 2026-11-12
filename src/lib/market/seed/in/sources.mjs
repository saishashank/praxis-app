// The India (NSE) source rows: the one definition of the DAT-243 candidate sources (M20 A3; D-1096, D-1128).
// `ensureMarketSources(db, "IN")` (src/lib/data/sources/marketSources.mjs) writes these rows, and one
// `source_status` row each, when India leaves `off`; no migration inserts them (D-1128: the AT-32 baseline
// hashes the register tables, so a row in production would move AU's own hashes). The licence-register document
// (scripts/ci/licence-register.mjs), the host gate (src/lib/market/seed/sourceSites.mjs) and the DAT-101 source
// report (scripts/market/source-report.mjs) read the same rows.
//
// Row columns (register): id (= `source`), terms_url, permitted_use, rate_limits, last_checked, risk, status,
// owner_ref, summarisation_permitted. Facts for the document: label, provides, terms (our reading, no dates),
// hosts (the domains the fetcher contacts), code (the fetcher files, filled when they exist). Report columns:
// probe (one public page or file of the source, null = nothing to request), intervalMs (the polite client's
// minimum gap per host), contact (a request needs the declared contact, D-1094).
//
// Status follows the DAT-120 rule and the A3 verification pass (the build-machine run of the source report):
//   enabled   public statistics, the public holiday list, the manual CSV upload
//   pending   everything else that is fetched (a fetcher is off until its terms are checked and the Owner turns
//             it on); Yahoo carries the O-26 basis
//   disabled  NSE and BSE announcements until the Owner accepts the terms risk (O-23 pattern, D-1125)
// No contact value, key or account appears in any row (SEC-110).
export const MARKET = "IN";

const NSE_ARCHIVES = "nsearchives.nseindia.com";
const NSE = "www.nseindia.com";

// The A3 verification pass (build-machine run of scripts/market/source-report.mjs): the rows whose terms page was read.
// A row not listed was not reachable under the polite rules (robots.txt disallowed, or the declared contact missing) and
// keeps `last_checked` null.
const CHECKED = new Set([
  "in_yahoo_ns",
  "in_nse_bhavcopy",
  "in_nse_announcements",
  "in_bse_announcements",
  "in_nse_classification",
  "in_nse_fo_oi",
  "in_nse_slb",
  "in_sebi_pit_sast",
  "in_nse_bands",
  "in_nse_asm_gsm",
  "in_nse_board_meetings",
  "in_nse_bse_xbrl",
  "in_rbi",
  "in_mospi",
  "in_nse_holidays",
]);
const CHECKED_ON = "2026-11-12";

/** @type {readonly Readonly<Record<string, unknown>>[]} */
export const SOURCES = Object.freeze(
  [
    {
      id: "in_yahoo_ns",
      label: "Yahoo Finance end-of-day prices, India (.NS)",
      provides:
        "Daily price bars for NSE codes (the Yahoo .NS suffix) under the same risk basis as the AU feed.",
      terms:
        "Unofficial data for personal use; its terms may not permit automated access, and the chart endpoint's robots.txt disallows automated clients, which the polite client respects. Used only under the Owner risk acceptance O-26; the India bar history comes from the NSE bhavcopy instead.",
      hosts: [],
      code: [],
      terms_url: "https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html",
      permitted_use:
        "personal use only (DAT-124); India end-of-day prices under the Yahoo risk basis O-26",
      rate_limits: "undocumented; one request every 700 ms at most",
      risk: "high",
      status: "pending",
      owner_ref: "O-26",
      summarisation_permitted: 0,
      intervalMs: 700,
      probe: {
        url: "https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?range=1d&interval=1d",
      },
    },
    {
      id: "in_nse_bhavcopy",
      label: "NSE daily bhavcopy",
      provides:
        "The end-of-day price, volume and delivery file of every NSE equity (the primary India price source).",
      terms:
        "Public file on the exchange's archive host, which publishes no robots.txt. The exchange's terms of use restrict redistribution; the row stays pending until the Owner turns the fetcher on (DAT-121).",
      hosts: [NSE_ARCHIVES],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE daily bhavcopy file; off until its terms are checked (DAT-121)",
      rate_limits: "not published; one request every 1.5 s",
      risk: "high",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: {
        url: `https://${NSE_ARCHIVES}/content/cm/BhavCopy_NSE_CM_0_0_0_20251110_F_0000.csv.zip`,
      },
    },
    {
      id: "in_nse_announcements",
      label: "NSE corporate announcements (disabled)",
      provides: "Announcement headline and link only, never a body (D-1125).",
      terms:
        "The exchange's terms of use restrict automated copying of announcements. The row is disabled: no request is made until the Owner accepts the risk, and then headline and link only.",
      hosts: [NSE],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use:
        "NSE corporate announcements: headline and link only, never a body (D-1125); off until the Owner accepts the terms",
      rate_limits: "not published; one request every 1.5 s when enabled",
      risk: "high",
      status: "disabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: null,
    },
    {
      id: "in_bse_announcements",
      label: "BSE corporate announcements (disabled)",
      provides: "Announcement headline and link only, never a body (D-1125).",
      terms:
        "The exchange's terms of use restrict automated copying of announcements. The row is disabled: no request is made until the Owner accepts the risk, and then headline and link only.",
      hosts: ["www.bseindia.com"],
      code: [],
      terms_url: "https://www.bseindia.com/terms_conditions",
      permitted_use:
        "BSE corporate announcements: headline and link only, never a body (D-1125); off until the Owner accepts the terms",
      rate_limits: "not published; one request every 1.5 s when enabled",
      risk: "high",
      status: "disabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: null,
    },
    {
      id: "in_nse_classification",
      label: "NSE industry classification file",
      provides:
        "The industry of each NSE code (the nse_level2 scheme), from the monthly index constituent files.",
      terms:
        "Public file on the exchange's archive host. Terms as for the bhavcopy; pending until the Owner turns the fetcher on.",
      hosts: [NSE_ARCHIVES],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE industry classification file",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: `https://${NSE_ARCHIVES}/content/indices/ind_nifty500list.csv` },
    },
    {
      id: "in_nse_fo_oi",
      label: "NSE futures and options open interest",
      provides:
        "Open interest of the F&O stocks, the India short-pressure proxy (short_data_kind).",
      terms:
        "Public file on the exchange's archive host. Terms as for the bhavcopy; pending until the Owner turns the fetcher on.",
      hosts: [NSE_ARCHIVES],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE futures and options open-interest file",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: {
        url: `https://${NSE_ARCHIVES}/content/fo/BhavCopy_NSE_FO_0_0_0_20251110_F_0000.csv.zip`,
      },
    },
    {
      id: "in_nse_slb",
      label: "NSE securities lending and borrowing",
      provides: "Securities lending and borrowing volumes, the second India short-pressure proxy.",
      terms:
        "Public pages and files of the exchange. Terms as for the bhavcopy; pending until the Owner turns the fetcher on.",
      hosts: [NSE_ARCHIVES, NSE],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE securities lending and borrowing file",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: `https://${NSE}/market-data/securities-lending-and-borrowing` },
    },
    {
      id: "in_sebi_pit_sast",
      label: "SEBI insider-trading and takeover disclosures",
      provides:
        "Insider-trading (PIT) and takeover (SAST) disclosures, the India insider-notice feed.",
      terms:
        "Public regulator pages; the robots.txt of the host leaves the site open. Pending until the Owner turns the fetcher on.",
      hosts: ["www.sebi.gov.in"],
      code: [],
      terms_url: "https://www.sebi.gov.in/",
      permitted_use: "SEBI insider-trading (PIT) and takeover (SAST) disclosures",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: "https://www.sebi.gov.in/" },
    },
    {
      id: "in_nse_bands",
      label: "NSE daily price bands",
      provides:
        "The price band of each NSE equity for the day (the circuit limit of the fill rule).",
      terms:
        "Public file on the exchange's archive host. Terms as for the bhavcopy; pending until the Owner turns the fetcher on.",
      hosts: [NSE_ARCHIVES],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE daily price-band file",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: `https://${NSE_ARCHIVES}/content/equities/sec_list.csv` },
    },
    {
      id: "in_nse_asm_gsm",
      label: "NSE ASM and GSM surveillance lists",
      provides: "The additional and graded surveillance measure lists (stage per code and day).",
      terms:
        "Public pages and files of the exchange. Terms as for the bhavcopy; pending until the Owner turns the fetcher on.",
      hosts: [NSE_ARCHIVES, NSE],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE additional and graded surveillance lists",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: `https://${NSE}/reports/asm` },
    },
    {
      id: "in_nse_indices_manual",
      label: "NSE index membership (manual CSV)",
      provides: "Index adds and deletes keyed by the Owner from the exchange's rebalance notices.",
      terms: "A file the Owner prepares and uploads; nothing is fetched.",
      hosts: [],
      code: [],
      terms_url: null,
      permitted_use: "manual CSV upload by the Owner (Nifty index membership)",
      rate_limits: null,
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: null,
    },
    {
      id: "in_nse_board_meetings",
      label: "NSE board-meeting calendar",
      provides: "Forthcoming board-meeting dates (the India forward results dates).",
      terms:
        "Public pages of the exchange. Terms as for the bhavcopy; pending until the Owner turns the fetcher on.",
      hosts: [NSE],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE board-meeting calendar",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: `https://${NSE}/companies-listing/corporate-filings-board-meetings` },
    },
    {
      id: "in_nse_bse_xbrl",
      label: "NSE and BSE XBRL financial results",
      provides: "Quarterly and annual results in XBRL, the India fundamentals source.",
      terms:
        "Public pages of the two exchanges. Terms as for the bhavcopy; pending until the Owner turns the fetcher on.",
      hosts: [NSE, "www.bseindia.com"],
      code: [],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "NSE and BSE XBRL financial results",
      rate_limits: "not published; one request every 1.5 s",
      risk: "medium",
      status: "pending",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: `https://${NSE}/companies-listing/corporate-filings-financial-results` },
    },
    {
      id: "in_rbi",
      label: "Reserve Bank of India",
      provides: "Public interest-rate and exchange-rate statistics.",
      terms:
        "Public statistics of the central bank: derived numbers only, source named. The host answers an unidentified client with a block page, so a request needs the declared User-Agent and the polite pace.",
      hosts: ["rbi.org.in"],
      code: [],
      terms_url: "https://www.rbi.org.in/Scripts/Disclaimer.aspx",
      permitted_use:
        "public statistics of the Reserve Bank of India: derived numbers only, source named",
      rate_limits: "not published; one request every 1.5 s",
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: "https://rbi.org.in/" },
    },
    {
      id: "in_mospi",
      label: "Ministry of Statistics (MoSPI)",
      provides: "Public inflation and growth statistics.",
      terms:
        "Public statistics of the ministry: derived numbers only, source named. The host's robots.txt leaves the site open.",
      hosts: ["www.mospi.gov.in"],
      code: [],
      terms_url: "https://www.mospi.gov.in/terms-conditions",
      permitted_use:
        "public statistics of the Ministry of Statistics (MoSPI): derived numbers only, source named",
      rate_limits: "not published; one request every 1.5 s",
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: "https://www.mospi.gov.in/" },
    },
    {
      id: "in_nse_holidays",
      label: "NSE trading-holiday list",
      provides: "The exchange's published trading holidays, the check behind the calendar rows.",
      terms:
        "Public list the exchange's own holiday page shows; the host's robots.txt allows it. Read once a year to confirm the calendar rules.",
      hosts: [NSE],
      code: ["src/lib/data/calendarRules/in.mjs"],
      terms_url: "https://www.nseindia.com/nse-terms-of-use",
      permitted_use: "public NSE trading-holiday list",
      rate_limits: "not published; one request every 1.5 s",
      risk: "low",
      status: "enabled",
      owner_ref: null,
      summarisation_permitted: 0,
      intervalMs: 1500,
      probe: { url: `https://${NSE}/api/holiday-master?type=trading` },
    },
  ].map((r) =>
    Object.freeze({ market: MARKET, last_checked: CHECKED.has(r.id) ? CHECKED_ON : null, ...r }),
  ),
);

export default SOURCES;

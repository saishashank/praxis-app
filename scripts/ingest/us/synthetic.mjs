// The SYNTHETIC five-session US data set (M20 US1; D-1119, D-1132, D-1188). There is no robots-permitted free US price
// source (D-1132) and no EDGAR contact on the build machine (D-1094), so the recorded US days the `recorded-day-dev`
// job and the fixture-night test run on are MADE UP, by this deterministic generator, and say so everywhere:
//   - the codes are fictional (`ZZA`..`ZZD`, CIKs 0009990001..4), the price bars carry `source: "synthetic_fixture"`,
//     the filings, Form 4 and 13D documents are minimal hand-written excerpts in the shapes the parsers read;
//   - nothing here is, or resembles, a real company's data; no price is a real quote; the README it writes says so.
// The generator is pure: `buildUsFixtures()` returns the five session dates, the fixture codes and a map of relative
// path -> text. The test imports it directly; `writeUsFixtures(dir)` writes the same files under a folder (the private
// fixtures repo, `recorded/US/<date>/...`), which the orchestrator commits. No network, no secret, no history file.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SESSIONS = Object.freeze([
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
]);
export const SOURCE = "synthetic_fixture";

/** The fictional companies: code, CIK, name, SIC (the two-digit group is the NAV-cap group), base price, base volume. */
export const COMPANIES = Object.freeze([
  {
    code: "ZZA",
    cik: "0009990001",
    name: "Zeta Zero Alpha Software Inc",
    sic: "7372",
    px: 50,
    vol: 2_000_000,
  },
  {
    code: "ZZB",
    cik: "0009990002",
    name: "Zeta Zero Bravo Bancorp",
    sic: "6022",
    px: 25,
    vol: 1_000_000,
  },
  {
    code: "ZZC",
    cik: "0009990003",
    name: "Zeta Zero Charlie Stores Inc",
    sic: "5311",
    px: 12,
    vol: 500_000,
  },
  {
    code: "ZZD",
    cik: "0009990004",
    name: "Zeta Zero Delta Pharma Inc",
    sic: "2834",
    px: 80,
    vol: 300_000,
  },
]);

/** A fixed deterministic pseudo-random sequence in [0, 1): no Math.random, so every run writes the same bytes. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/** The bars of every company for the five sessions (raw, one JSON array per session). */
function barsFor(dayIndex) {
  const out = [];
  COMPANIES.forEach((c, ci) => {
    const rnd = lcg(1000 * (ci + 1) + dayIndex);
    const drift = 1 + (rnd() - 0.5) * 0.04;
    const open = round2(c.px * drift);
    const close = round2(open * (1 + (rnd() - 0.5) * 0.03));
    const high = round2(Math.max(open, close) * (1 + rnd() * 0.01));
    const low = round2(Math.min(open, close) * (1 - rnd() * 0.01));
    out.push({
      code: c.code,
      date: SESSIONS[dayIndex],
      open,
      high,
      low,
      close,
      volume: Math.round(c.vol * (0.8 + rnd() * 0.4)),
      source: SOURCE,
    });
  });
  return out;
}

/** The submissions JSON of one company (column-oriented `filings.recent`, only the fields the parser reads). */
function submissions(c, filings) {
  const col = (k) => filings.map((f) => f[k]);
  return {
    cik: c.cik.replace(/^0+/, ""),
    name: c.name,
    sic: c.sic,
    tickers: [c.code],
    filings: {
      recent: {
        accessionNumber: col("accession"),
        form: col("form"),
        filingDate: col("filed"),
        acceptanceDateTime: col("accepted"),
        items: col("items"),
        primaryDocDescription: col("desc"),
      },
    },
  };
}

const ACC = (n) => `0009990000-26-${String(n).padStart(6, "0")}`;
/** The filings each company has, cumulative: the old annual report plus what each session adds. */
function filingsFor(code, dayIndex) {
  const old = {
    accession: ACC(1),
    form: "10-K",
    filed: "2026-02-20",
    accepted: "2026-02-20T21:30:00.000Z",
    items: "",
    desc: "FORM 10-K",
  };
  const list = [old];
  const add = (day, f) => dayIndex >= day && list.push(f);
  if (code === "ZZA") {
    add(0, {
      accession: ACC(10),
      form: "8-K",
      filed: "2026-11-02",
      accepted: "2026-11-02T21:20:30.000Z",
      items: "2.02,9.01",
      desc: "FORM 8-K",
    });
    add(3, {
      accession: ACC(30),
      form: "10-K/A",
      filed: "2026-11-05",
      accepted: "2026-11-05T21:30:00.000Z",
      items: "",
      desc: "FORM 10-K/A",
    });
  }
  if (code === "ZZB") {
    add(1, {
      accession: ACC(11),
      form: "8-K",
      filed: "2026-11-03",
      accepted: "2026-11-03T14:31:00.000Z",
      items: "1.01",
      desc: "FORM 8-K",
    });
    add(1, {
      accession: ACC(12),
      form: "4",
      filed: "2026-11-03",
      accepted: "2026-11-03T22:10:00.000Z",
      items: "",
      desc: "FORM 4",
    });
    add(4, {
      accession: ACC(31),
      form: "8-K",
      filed: "2026-11-06",
      accepted: "2026-11-06T13:05:00.000Z",
      items: "2.03",
      desc: "FORM 8-K",
    });
  }
  if (code === "ZZD") {
    add(3, {
      accession: ACC(20),
      form: "SC 13D",
      filed: "2026-11-05",
      accepted: "2026-11-05T13:45:00.000Z",
      items: "",
      desc: "SCHEDULE 13D",
    });
  }
  return list;
}

/** A Form 4 ownership document: a purchase and a sale (the purchase is the larger side: a director buy). */
const FORM4_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerCik>0009990002</issuerCik><issuerTradingSymbol>ZZB</issuerTradingSymbol></issuer>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>24.50</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>200</value></transactionShares>
        <transactionPricePerShare><value>25.10</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
`;

const SCHEDULE13D_XML = `<?xml version="1.0"?>
<edgarSubmission><formData><coverPageHeader><percentOfClass>7.5</percentOfClass></coverPageHeader></formData></edgarSubmission>
`;

/** The company facts of ZZA: the first-filed revenue (10-K, 2026-02-20) and, from session 4, its restatement (10-K/A, 2026-11-05). */
function companyFacts(dayIndex) {
  const entry = (val, accn, form, filed) => ({
    start: "2025-01-01",
    end: "2025-12-31",
    val,
    accn,
    fy: 2025,
    fp: "FY",
    form,
    filed,
  });
  const revenues = [entry(1000, ACC(1), "10-K", "2026-02-20")];
  if (dayIndex >= 3) revenues.push(entry(940, ACC(30), "10-K/A", "2026-11-05"));
  return {
    cik: 9990001,
    entityName: "Zeta Zero Alpha Software Inc",
    facts: { "us-gaap": { Revenues: { units: { USD: revenues } } } },
  };
}

const haltItem = (sym, name, reason, haltDate, haltTime, resDate, resTime) => `    <item>
      <title>${sym}</title>
      <ndaq:HaltDate>${haltDate}</ndaq:HaltDate>
      <ndaq:HaltTime>${haltTime}</ndaq:HaltTime>
      <ndaq:IssueSymbol>${sym}</ndaq:IssueSymbol>
      <ndaq:IssueName>${name}</ndaq:IssueName>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>${reason}</ndaq:ReasonCode>
      <ndaq:ResumptionDate>${resDate}</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>${resTime}</ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime>${resTime}</ndaq:ResumptionTradeTime>
    </item>
`;
const rss = (items) => `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/">
  <channel>
    <title>Synthetic trade halts (fixture)</title>
${items}  </channel>
</rss>
`;

/** The Nasdaq halt feed of a session: day 3 has a volatility pause on ZZC that resolves inside the session; day 4 a news halt on ZZD. */
function haltsXml(dayIndex) {
  let items = "";
  if (dayIndex === 2)
    items += haltItem(
      "ZZC",
      "Zeta Zero Charlie Stores Inc",
      "LUDP",
      "11/04/2026",
      "14:10:03.000",
      "11/04/2026",
      "14:15:03",
    );
  if (dayIndex === 3)
    items += haltItem(
      "ZZD",
      "Zeta Zero Delta Pharma Inc",
      "T1",
      "11/05/2026",
      "15:50:00.000",
      "11/06/2026",
      "09:30:00",
    );
  return rss(items);
}

const SUSPENSION_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>In the Matter of Zeta Zero Delta Pharma Inc (Ticker: ZZD)</title><pubDate>Fri, 06 Nov 2026 14:30:00 GMT</pubDate><description>Order of suspension of trading (fixture)</description></item>
</channel></rss>
`;

/** FINRA daily short-sale volume: the four fixture codes and two symbols outside the universe. */
function finraDaily(dayIndex) {
  const ymd = SESSIONS[dayIndex].replaceAll("-", "");
  const rows = [
    ...COMPANIES.map((c, i) => [c.code, Math.round(c.vol * (0.3 + 0.02 * i)), c.vol]),
    ["QQQA", 500, 1000],
    ["QQQB", 100, 100],
  ];
  return `Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n${rows.map(([s, sv, tv]) => `${ymd}|${s}|${sv}|0|${tv}|Q,N`).join("\n")}\n`;
}

const indexCsv = (dayIndex, base) => {
  const rnd = lcg(77 + dayIndex);
  const o = Math.round(base * (1 + (rnd() - 0.5) * 0.01) * 100) / 100;
  const c = Math.round(o * (1 + (rnd() - 0.5) * 0.01) * 100) / 100;
  const h = Math.round(Math.max(o, c) * 1.002 * 100) / 100;
  const l = Math.round(Math.min(o, c) * 0.998 * 100) / 100;
  return `Date,Open,High,Low,Close\n${SESSIONS[dayIndex]},${o},${h},${l},${c}\n`;
};

const README = `SYNTHETIC DATA. Read this before using anything in this folder.

Everything under recorded/US/ is MADE UP by scripts/ingest/us/synthetic.mjs (praxis-app, M20 task US1, D-1188).
No real company, price, filing or trade is in it:
  - the codes ZZA..ZZD and the CIKs 0009990001..0009990004 are fictional;
  - every price bar carries source "synthetic_fixture"; the prices are a seeded pseudo-random walk, never a quote;
  - the EDGAR submissions, company facts, Form 4 and Schedule 13D documents are minimal hand-written excerpts;
  - the FINRA short-volume file, the Nasdaq halt feed, the SEC suspension feed and the index CSVs are invented.
Why: there is no robots-permitted free US price source (D-1132) and no EDGAR contact on the build machine (D-1094),
so no real US history could be recorded. These sessions exist only to exercise the US parsers and the batch-1 day in
development mode and in the recorded-day-dev job. They must never be presented as real data and never reach
production (the US market is off there, PRD-040).
Sessions: ${SESSIONS.join(", ")}. Layout of one session folder:
  bars.json  edgar/submissions-<CODE>.json  edgar/companyfacts-ZZA.json  edgar/form4-<accession>.xml
  edgar/schedule13-<accession>.xml  finra/CNMSshvol<yyyymmdd>.txt  halts/halts.xml  halts/suspensions.xml  index/GSPC.csv  index/VIX.csv
`;

/** @returns {{ sessions: readonly string[], companies: typeof COMPANIES, files: Record<string, string> }} */
export function buildUsFixtures() {
  /** @type {Record<string, string>} */
  const files = { "README.txt": README };
  SESSIONS.forEach((d, i) => {
    const put = (rel, text) => {
      files[`${d}/${rel}`] = typeof text === "string" ? text : `${JSON.stringify(text, null, 1)}\n`;
    };
    put("bars.json", barsFor(i));
    for (const c of COMPANIES)
      put(`edgar/submissions-${c.code}.json`, submissions(c, filingsFor(c.code, i)));
    put("edgar/companyfacts-ZZA.json", companyFacts(i));
    if (i >= 1) put(`edgar/form4-${ACC(12)}.xml`, FORM4_XML);
    if (i >= 3) put(`edgar/schedule13-${ACC(20)}.xml`, SCHEDULE13D_XML);
    put(`finra/CNMSshvol${d.replaceAll("-", "")}.txt`, finraDaily(i));
    put("halts/halts.xml", haltsXml(i));
    if (i === 4) put("halts/suspensions.xml", SUSPENSION_XML);
    put("index/GSPC.csv", indexCsv(i, 5000));
    put("index/VIX.csv", indexCsv(i, 18));
  });
  return { sessions: SESSIONS, companies: COMPANIES, files };
}

/** Write the data set under `dir` (`recorded/US` of the fixtures repo). @param {string} dir */
export function writeUsFixtures(dir) {
  const { files } = buildUsFixtures();
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return Object.keys(files).length;
}

export { ACC as accession };

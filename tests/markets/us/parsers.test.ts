// @vitest-environment node
// M20 US1 (DAT-243, D-1184..D-1189): the US parsers on hand-made fixtures. Hand-worked known answers.
import { describe, expect, it } from "vitest";
import {
  barsFromChart,
  barsFromStooqCsv,
  parseUsBarsText,
  UsBarsFormatError,
  validateUsBar,
  yahooRequestFor,
} from "@/lib/data/sources/us/bars.mjs";
import {
  nextDay,
  parseDailyShortVolume,
  parseShortInterest,
} from "@/lib/data/sources/us/finra.mjs";
import { parseNasdaqHalts, parseSecSuspensions, zonedToUtc } from "@/lib/data/sources/us/halts.mjs";
import { noticeOfForm4, microOf, parseForm4 } from "@/lib/data/sources/us/form4.mjs";
import {
  isSchedule13,
  noticeOfSchedule13,
  percentOfClass,
} from "@/lib/data/sources/us/schedule13.mjs";
import { FredKeyMissing, fredKey, parseFredObservations } from "@/lib/data/sources/us/macro.mjs";
import { parseIndexCsv } from "@/lib/data/sources/us/index.mjs";
import { capUniverse, parseSymbolDirectories } from "@/lib/data/sources/us/symbols.mjs";
import {
  acceptanceByAccession,
  parseSubmissions,
  sicGroup,
} from "@/lib/data/sources/us/submissions.mjs";
import { announcementsFromSubmissions } from "@/lib/data/sources/us/filings8k.mjs";
import { parseDailyIndex } from "../../../scripts/ingest/us/fetch.mjs";

const TZ = "America/New_York";

describe("zonedToUtc (exchange local time -> UTC)", () => {
  it("November is EST (UTC-5), July is EDT (UTC-4)", () => {
    expect(zonedToUtc("2026-11-04", "14:10:03.000", TZ)).toBe("2026-11-04T19:10:03.000Z");
    expect(zonedToUtc("2026-07-01", "09:30:00", TZ)).toBe("2026-07-01T13:30:00.000Z");
  });
  it("the first Sunday of November 2026 is the 1st: 01:30 is ambiguous (first occurrence), 03:30 is EST", () => {
    expect(zonedToUtc("2026-11-01", "01:30:00", TZ)).toBe("2026-11-01T05:30:00.000Z");
    expect(zonedToUtc("2026-11-01", "03:30:00", TZ)).toBe("2026-11-01T08:30:00.000Z");
  });
  it("rejects a malformed date or time", () => {
    expect(() => zonedToUtc("2026-11-4", "10:00", TZ)).toThrow("bad local");
  });
});

describe("Nasdaq halts and SEC suspensions", () => {
  const item = (
    sym: string,
    reason: string,
    hd = "11/04/2026",
    ht = "14:10:03.000",
    rd = "",
    rt = "",
  ) =>
    `<item><ndaq:HaltDate>${hd}</ndaq:HaltDate><ndaq:HaltTime>${ht}</ndaq:HaltTime><ndaq:IssueSymbol>${sym}</ndaq:IssueSymbol><ndaq:ReasonCode>${reason}</ndaq:ReasonCode><ndaq:ResumptionDate>${rd}</ndaq:ResumptionDate><ndaq:ResumptionTradeTime>${rt}</ndaq:ResumptionTradeTime></item>`;
  it("maps the reason codes: LUDP/LUDS/T5 luld, H10 suspension, a circuit breaker skipped, the rest halt", () => {
    const xml = `<rss>${item("AAA", "LUDP", undefined, undefined, "11/04/2026", "14:15:03")}${item("BBB", "H10")}${item("CCC", "T12")}${item("DDD", "MWC1")}${item("EEE", "T5")}${item("", "T1")}</rss>`;
    const { rows, skipped } = parseNasdaqHalts(xml, TZ);
    expect(rows.map((r) => `${r.code}:${r.kind}`)).toEqual([
      "AAA:luld",
      "BBB:suspension",
      "CCC:halt",
      "EEE:luld",
    ]);
    expect(rows[0]!.resumedAt).toBe("2026-11-04T19:15:03.000Z");
    expect(rows[1]!.resumedAt).toBeNull();
    expect(skipped).toBe(2);
  });
  it("an SEC suspension item needs a ticker in its text and a publication date", () => {
    const xml = `<rss><item><title>In the Matter of X (Ticker: ZZD)</title><pubDate>Fri, 06 Nov 2026 14:30:00 GMT</pubDate></item><item><title>No ticker here</title><pubDate>Fri, 06 Nov 2026 14:30:00 GMT</pubDate></item></rss>`;
    const { rows, skipped } = parseSecSuspensions(xml);
    expect(rows).toEqual([
      {
        code: "ZZD",
        kind: "suspension",
        haltedAt: "2026-11-06T14:30:00.000Z",
        resumedAt: null,
        reason: "sec_suspension",
        source: "us_sec_suspensions",
      },
    ]);
    expect(skipped).toBe(1);
  });
});

describe("Form 4", () => {
  it("microOf is exact decimal text", () => {
    expect(microOf("24.50")).toBe(24_500_000n);
    expect(microOf("1000")).toBe(1_000_000_000n);
    expect(microOf("0.1234567")).toBe(123_456n);
    expect(microOf("1e3")).toBeNull();
    expect(microOf(null)).toBeNull();
  });
  const tx = (code: string, shares: string, price: string) =>
    `<nonDerivativeTransaction><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>`;
  it("sums purchases and sales: 1000 x 24.50 - 200 x 25.10 -> director_buy 24,500; awards are not trades", () => {
    const p = parseForm4(
      `<ownershipDocument><issuerTradingSymbol>zzb</issuerTradingSymbol>${tx("P", "1000", "24.50")}${tx("S", "200", "25.10")}${tx("A", "500", "0")}</ownershipDocument>`,
    );
    expect(p).toMatchObject({
      symbol: "ZZB",
      buyMicro: 24_500_000_000n,
      sellMicro: 5_020_000_000n,
      buys: 1,
      sells: 1,
      other: 1,
    });
    expect(noticeOfForm4(p)).toEqual({ kind: "director_buy", valueMicro: 24_500_000_000n });
  });
  it("a larger sale is director_sell; equal sides and no open-market trade give nothing", () => {
    expect(noticeOfForm4(parseForm4(`<x>${tx("S", "100", "10")}</x>`))).toEqual({
      kind: "director_sell",
      valueMicro: 1_000_000_000n,
    });
    expect(
      noticeOfForm4(parseForm4(`<x>${tx("P", "100", "10")}${tx("S", "100", "10")}</x>`)),
    ).toBeNull();
    expect(noticeOfForm4(parseForm4(`<x>${tx("M", "100", "10")}</x>`))).toBeNull();
  });
  it("an unreadable number rejects that transaction and the filing writes NO notice (a wrong direction is worse than none)", () => {
    const p = parseForm4(`<x>${tx("P", "abc", "10")}${tx("P", "5", "10")}</x>`);
    expect(p.rejected).toBe(1);
    expect(p.buyMicro).toBe(50_000_000n);
    expect(noticeOfForm4(p)).toBeNull();
    // a sale that cannot be read next to a readable purchase must not become a director buy
    expect(
      noticeOfForm4(parseForm4(`<x>${tx("P", "5", "10")}${tx("S", "abc", "10")}</x>`)),
    ).toBeNull();
  });
});

describe("Schedules 13D/13G", () => {
  it("a first filing is sh_new; an amendment needs both percents, else it is skipped, never guessed", () => {
    expect(noticeOfSchedule13("SC 13D")).toEqual({ kind: "sh_new" });
    expect(noticeOfSchedule13("SCHEDULE 13G")).toEqual({ kind: "sh_new" });
    expect(noticeOfSchedule13("SC 13D/A")).toEqual({ skipped: "amendment_direction_unknown" });
    expect(noticeOfSchedule13("SC 13D/A", { percent: 8, previousPercent: 7.5 })).toEqual({
      kind: "sh_increase",
    });
    expect(noticeOfSchedule13("SC 13D/A", { percent: 6, previousPercent: 7.5 })).toEqual({
      kind: "sh_decrease",
    });
    expect(noticeOfSchedule13("SC 13D/A", { percent: 7.5, previousPercent: 7.5 })).toEqual({
      skipped: "no_change",
    });
    expect(noticeOfSchedule13("8-K")).toEqual({ skipped: "not_13dg" });
  });
  it("recognises the forms and reads the percent of class", () => {
    expect(["SC 13D", "SC 13G/A", "SCHEDULE 13D", "SCHEDULE 13G/A"].every(isSchedule13)).toBe(true);
    expect(isSchedule13("SC 14D9")).toBe(false);
    expect(percentOfClass("<percentOfClass> 7.5 </percentOfClass>")).toBe(7.5);
    expect(percentOfClass("<x/>")).toBeNull();
  });
});

describe("FINRA", () => {
  it("short ppm = round(short volume x 1e6 / total volume); bad rows are counted, never repaired", () => {
    const text =
      "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20261102|ZZA|600000|0|2000000|Q,N\n20261102|ZZB|1|0|3|Q\n20261102|bad sym|1|0|2|Q\n20261102|ZZC|5|0|0|Q\n20261102|ZZD|9|0|3|Q\n";
    const { rows, rejected } = parseDailyShortVolume(text);
    expect(rows.map((r) => `${r.code}:${r.d}:${r.shortPpm}`)).toEqual([
      "ZZA:2026-11-02:300000",
      "ZZB:2026-11-02:333333",
    ]);
    expect(rejected).toBe(3);
  });
  it("the short-interest file is parsed by its header, not stored", () => {
    const text =
      "accountingYearMonthNumber|symbolCode|currentShortPositionQuantity|averageDailyVolumeQuantity|daysToCoverQuantity|settlementDate\n20261030|ZZA|4000|2000|2.00|2026-10-30\n20261030|??|1|1|1|2026-10-30\n";
    expect(parseShortInterest(text)).toEqual({
      rows: [
        {
          code: "ZZA",
          settlementDate: "2026-10-30",
          shortShares: 4000,
          avgDailyVolume: 2000,
          daysToCover: 2,
        },
      ],
      rejected: 1,
    });
    expect(parseShortInterest("nothing")).toEqual({ rows: [], rejected: 0 });
  });
  it("nextDay", () => {
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("symbols and the cap (D-1098, D-1132)", () => {
  const nasdaq =
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\nAAAP|Pacer ETF|G|N|N|100|Y|N\nAAPL|Apple Common Stock|Q|N|N|100|N|N\nTEST|Test Corp|Q|Y|N|100|N|N\nWARR|Foo Warrants|Q|N|N|100|N|N\nBAD$|Odd|Q|N|N|100|N|N\nFile Creation Time: 1112202608:00\n";
  const other =
    "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\nA|Agilent Common Stock|N|A|N|100|N|A\nSPY|Fund|P|SPY|Y|100|N|SPY\nBRK.B|Berkshire Class B|N|BRK.B|N|100|N|BRK.B\n";
  it("keeps plain common-stock tickers on the company exchanges, drops the rest by reason", () => {
    const { candidates, dropped } = parseSymbolDirectories(nasdaq, other);
    expect(candidates.map((c) => c.code)).toEqual(["A", "AAPL", "BRK.B"]);
    expect(dropped).toEqual({ test: 1, etf: 1, structured: 1, badSymbol: 1, exchange: 1 });
  });
  it("the cap ranks by median traded value, ties by code, and never keeps an unranked code", () => {
    const cands = ["A", "B", "C", "D"].map((code) => ({ code }));
    const v = new Map([
      ["A", 5n],
      ["B", 9n],
      ["C", 9n],
    ]);
    expect(capUniverse(cands, v, 2)).toEqual({ codes: ["B", "C"], unranked: 1 });
    expect(capUniverse(cands, new Map(), 2)).toEqual({ codes: [], unranked: 4 });
    expect(() => capUniverse(cands, v, 0)).toThrow("positive");
  });
});

describe("bars, index, FRED", () => {
  const ok = {
    code: "ZZA",
    date: "2026-11-02",
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 100,
    source: "synthetic_fixture",
  };
  it("validates a bar row by row, rejecting with a reason", () => {
    expect(validateUsBar(ok)).toEqual({ row: ok });
    expect(validateUsBar({ ...ok, code: "zz" })).toEqual({ reason: "bad_code" });
    expect(validateUsBar({ ...ok, date: "2026-02-30" })).toEqual({ reason: "bad_date" });
    expect(validateUsBar({ ...ok, high: 9.5 })).toEqual({ reason: "ohlc_inconsistent" });
    expect(validateUsBar({ ...ok, volume: 1.5 })).toEqual({ reason: "bad_volume" });
    expect(validateUsBar({ ...ok, open: 0 })).toEqual({ reason: "non_positive_price" });
    expect(validateUsBar({ ...ok, source: "Yahoo!" })).toEqual({ reason: "bad_source" });
  });
  it("a bars file is a JSON array; duplicates and out-of-range dates are rejected", () => {
    expect(() => parseUsBarsText("{}")).toThrow(UsBarsFormatError);
    const r = parseUsBarsText(JSON.stringify([ok, ok, { ...ok, date: "2026-12-01" }]), {
      to: "2026-11-30",
    });
    expect(r.rows).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(["duplicate_key", "date_out_of_range"]);
  });
  it("the Yahoo-shaped request has an empty suffix and the currency; Stooq and chart rows convert", () => {
    expect(
      yahooRequestFor({ yahooSuffix: "", currency: "USD" }, ["ZZA"], "2026-11-01", "2026-11-02"),
    ).toEqual({
      codes: ["ZZA"],
      start: "2026-11-01",
      end: "2026-11-02",
      suffix: "",
      currency: "USD",
    });
    expect(
      barsFromStooqCsv(
        "Date,Open,High,Low,Close,Volume\n2026-11-02,10,11,9,10.5,100\nbad,line\n",
        "ZZA",
      ),
    ).toEqual([
      {
        code: "ZZA",
        date: "2026-11-02",
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 100,
        source: "stooq",
      },
    ]);
    const chart = {
      chart: {
        result: [
          {
            timestamp: [Date.parse("2026-11-02T14:30:00Z") / 1000],
            indicators: {
              quote: [{ open: [10], high: [11], low: [9], close: [10.5], volume: [100] }],
            },
          },
        ],
      },
    };
    expect(barsFromChart(chart, "ZZA", TZ)[0]).toMatchObject({ date: "2026-11-02", close: 10.5 });
  });
  it("index CSV rows are validated and stored in micro", () => {
    const r = parseIndexCsv(
      "Date,Open,High,Low,Close\n2026-11-02,100,102,99,101\n2026-11-03,100,99,99,100\nx\n",
      "IDX",
    );
    expect(r.rows).toEqual([
      {
        indexCode: "IDX",
        d: "2026-11-02",
        o: 100_000_000,
        h: 102_000_000,
        l: 99_000_000,
        c: 101_000_000,
      },
    ]);
    expect(r.rejected).toBe(2);
  });
  it("FRED refuses without the key and parses a gap as nothing", () => {
    expect(() => fredKey({})).toThrow(FredKeyMissing);
    expect(fredKey({ FRED_API_KEY: " k " })).toBe("k");
    expect(
      parseFredObservations({
        observations: [
          { date: "2026-11-02", value: "4.25" },
          { date: "2026-11-03", value: "." },
          { date: "bad", value: "1" },
        ],
      }),
    ).toEqual([{ d: "2026-11-02", valueMicro: 4_250_000n }]);
  });
});

describe("submissions and filings", () => {
  const json = {
    cik: 9990001,
    sic: "7372",
    filings: {
      recent: {
        accessionNumber: [
          "0009990000-26-000010",
          "0009990000-26-000011",
          "bad",
          "0009990000-26-000012",
        ],
        form: ["8-K", "4", "10-K", "SC 14D9"],
        filingDate: ["2026-11-02", "2026-11-02", "2026-11-02", "2026-11-02"],
        acceptanceDateTime: ["2026-11-02T21:20:30.000Z", "2026-11-02T22:00:00.000Z", "x", null],
        items: ["2.02,9.01", "", "", ""],
        primaryDocDescription: ["FORM 8-K", "FORM 4", "", ""],
        primaryDocument: ["a.htm", "xslF345X05/form4.xml", "", ""],
      },
    },
  };
  it("parses the column-oriented recent block, skipping rows with no accession", () => {
    const s = parseSubmissions(json);
    expect(s.sic).toBe("7372");
    expect(s.filings.map((f) => `${f.form}:${f.items.join("+")}:${f.acceptedAt}`)).toEqual([
      "8-K:2.02+9.01:2026-11-02T21:20:30.000Z",
      "4::2026-11-02T22:00:00.000Z",
      "SC 14D9::null",
    ]);
    expect(acceptanceByAccession(s)).toEqual({
      "0009990000-26-000010": "2026-11-02T21:20:30.000Z",
      "0009990000-26-000011": "2026-11-02T22:00:00.000Z",
    });
    expect(sicGroup(s.sic)).toBe("73");
    expect(sicGroup("12")).toBeNull();
  });
  it("announcements: type 8-K:<items>, EDGAR acceptance time, a filing with no time is skipped and counted", () => {
    const s = parseSubmissions(json);
    const a = announcementsFromSubmissions(s, "ZZA");
    expect(a.rows.map((r) => `${r.type}|${r.publishedAt}|${r.title}`)).toEqual([
      "8-K:2.02,9.01|2026-11-02T21:20:30.000Z|FORM 8-K",
      "4|2026-11-02T22:00:00.000Z|FORM 4",
    ]);
    expect(a.skippedForm).toBe(1);
    expect(
      announcementsFromSubmissions(s, "ZZA", { since: "2026-11-02T21:30:00.000Z" }).rows.map(
        (r) => r.type,
      ),
    ).toEqual(["4"]);
  });
  it("the daily form index is read by columns", () => {
    const text =
      "Form Type   Company Name   CIK   Date Filed   File Name\n---\n8-K        Zeta Zero Alpha Software Inc    9990001   20261102   edgar/data/9990001/0009990000-26-000010.txt\nSC 13D     Some Holder LLC                 123       20261102   edgar/data/123/0000000000-26-000001.txt\n";
    expect(parseDailyIndex(text)).toEqual([
      {
        form: "8-K",
        cik: "9990001",
        filed: "20261102",
        file: "edgar/data/9990001/0009990000-26-000010.txt",
      },
      {
        form: "SC 13D",
        cik: "123",
        filed: "20261102",
        file: "edgar/data/123/0000000000-26-000001.txt",
      },
    ]);
  });
});

describe("review fixes (D-1184, D-1186)", () => {
  it("a parenthesised acronym is not a ticker: only the Ticker: form counts", () => {
    const xml =
      "<rss><item><title>SEC order (SEC) for (CEO)</title><pubDate>Fri, 06 Nov 2026 14:30:00 GMT</pubDate></item></rss>";
    expect(parseSecSuspensions(xml)).toEqual({ rows: [], skipped: 1 });
  });
  it("short ppm rounds half up exactly: 1 / 3 -> 333333, 1 / 2000000 -> 1 (0.5 up)", () => {
    const text =
      "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20261102|AAA|1|0|3|Q\n20261102|BBB|1|0|2000000|Q\n20261102|CCC|1|0|2000001|Q\n";
    expect(parseDailyShortVolume(text).rows.map((r) => r.shortPpm)).toEqual([333333, 1, 0]);
  });
  it("an 8-K item outside the number format is counted, not silently lost", () => {
    const s = parseSubmissions({
      cik: 1,
      filings: {
        recent: {
          accessionNumber: ["0009990000-26-000010"],
          form: ["8-K"],
          filingDate: ["2026-11-02"],
          acceptanceDateTime: ["2026-11-02T21:00:00.000Z"],
          items: ["2.02,abc,9.01"],
        },
      },
    });
    expect(s.filings[0]).toMatchObject({ items: ["2.02", "9.01"], itemsDropped: 1 });
  });
});

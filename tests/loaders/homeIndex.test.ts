// @vitest-environment node
// D-907: the live ASX 200 line on Home: the delayed quote during the session, the last close otherwise.
import { describe, expect, it } from "vitest";
import type { LatestQuote } from "@/lib/data/quotes/latest";
import { chartSymbol, MARKET_INDEX_CODE, parseChartMeta } from "@/lib/data/quotes/parse";
import { INDEX_CODE, INDEX_YAHOO_SYMBOL } from "@/lib/data/index/indexBars.mjs";
import { dayLabel, freshnessLabel, indexLine } from "@/lib/ui/loaders/home";

const closes = [
  { d: "2026-11-06", cMicro: 8_400_000_000 },
  { d: "2026-11-05", cMicro: 8_316_831_683 },
];
const quote = (over: Partial<LatestQuote> = {}): LatestQuote => ({
  code: "AXJO",
  lastMicro: 8_484_000_000n,
  prevCloseMicro: 8_400_000_000n,
  quoteAt: "2026-11-09T02:05:00.000Z",
  quoteD: "2026-11-09",
  ...over,
});

describe("chartSymbol and the index code", () => {
  it("the index uses ^AXJO and the index_bar code; a stock uses <code>.AX", () => {
    expect(MARKET_INDEX_CODE).toBe(INDEX_CODE);
    expect(chartSymbol(MARKET_INDEX_CODE)).toBe(INDEX_YAHOO_SYMBOL);
    expect(chartSymbol("BHP")).toBe("BHP.AX");
  });
  it("an ^AXJO chart reply parses as the AXJO quote; a stock symbol under the index code is refused", () => {
    const body = (symbol: string) => ({
      chart: {
        result: [
          {
            meta: {
              currency: "AUD",
              symbol,
              regularMarketPrice: 8484.2,
              regularMarketTime: 1_794_200_000,
              chartPreviousClose: 8400,
            },
          },
        ],
      },
    });
    const now = new Date(1_794_200_100_000);
    expect(parseChartMeta(body("^AXJO"), "AXJO", now)).toMatchObject({
      code: "AXJO",
      lastMicro: 8_484_200_000n,
    });
    expect(parseChartMeta(body("AXJO.AX"), "AXJO", now)).toEqual({ reject: "symbol_mismatch" });
  });
});

describe("indexLine", () => {
  it("during the session: the delayed level, the move from the previous close and the Melbourne time", () => {
    expect(indexLine(closes, quote())).toEqual({
      name: "ASX 200",
      level: 8484,
      changePpm: 10_000,
      at: "13:05",
      d: "2026-11-09",
    });
  });
  it("a quote from the same day as the newest close adds nothing: the close is shown", () => {
    const line = indexLine(closes, quote({ quoteD: "2026-11-06" }));
    expect(line).toMatchObject({ level: 8400, at: null, d: "2026-11-06" });
    expect(line!.changePpm).toBe(10_000);
  });
  it("no quote: the last close and its move; one close: no move; nothing stored: null", () => {
    expect(indexLine(closes, undefined)).toMatchObject({ level: 8400, at: null });
    expect(indexLine([closes[0]!], undefined)).toMatchObject({ changePpm: null });
    expect(indexLine([], undefined)).toBeNull();
  });
  it("a quote without a previous close falls back to the newest stored close", () => {
    expect(indexLine(closes, quote({ prevCloseMicro: null }))!.changePpm).toBe(10_000);
  });
});

describe("freshnessLabel (Owner 2026-11-09: market words, not the run's finishing time)", () => {
  it("'Delayed, hh:mm' during the session, 'End of day, <day>' otherwise, null before data", () => {
    expect(freshnessLabel("2026-11-06", indexLine(closes, quote()))).toBe("Delayed, 13:05");
    expect(freshnessLabel("2026-11-06", indexLine(closes, undefined))).toBe(
      "End of day, Fri 6 Nov",
    );
    expect(freshnessLabel("2026-11-06", null)).toBe("End of day, Fri 6 Nov");
    expect(freshnessLabel(null, null)).toBeNull();
  });
});

describe("dayLabel (Owner 2026-11-09: the day's change, not a session's)", () => {
  it("says Today on the day in Sydney, otherwise the day", () => {
    const now = new Date("2026-11-09T22:30:00.000Z"); // Tue 10 Nov 09:30 Sydney
    expect(dayLabel("2026-11-10", now)).toBe("Today");
    expect(dayLabel("2026-11-09", now)).toBe("Mon 9 Nov");
    expect(dayLabel(null, now)).toBeNull();
  });
});

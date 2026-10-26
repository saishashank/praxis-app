// @vitest-environment node
// D-194: the real ASX announcements format (market-wide and per-company JSON), synthetic values only.
import { describe, expect, it } from "vitest";
import { announcementLink, parseMarkitFeed } from "@/lib/data/sources/asxMarkit.mjs";
import { ACTIVE_FEED_PARSER } from "@/lib/sentinel/feed";

const market = JSON.stringify({
  data: {
    items: [
      {
        announcementTypes: ["Quarterly Activities Report"],
        companies: [{ symbolDisplay: "ZZA" }],
        date: "2026-10-26T09:30:28.000Z",
        documentKey: "2924-03153289-6A1351454",
        headline: "Quarterly Activities Report",
        isPriceSensitive: true,
        symbol: "ZZA",
        url: "",
      },
      { symbol: "ZZB", date: "not a date", documentKey: "2924-1-X", headline: "x" },
      {
        announcementTypes: ["Notice of Meeting - Other"],
        date: "2026-10-26T08:00:00.000Z",
        documentKey: "2924-03153290-AB12",
        headline: "  Notice of AGM  ",
        isPriceSensitive: false,
        symbol: "zzc",
      },
    ],
  },
});
const company = JSON.stringify({
  data: {
    displayName: "ZED A LTD",
    symbol: "ZZA",
    items: [
      {
        announcementType: "NOTICE OF MEETING",
        date: "2026-10-22T03:38:31.000Z",
        documentKey: "2924-03151740-3A704697",
        headline: "Results of AGM",
        isPriceSensitive: false,
        url: "",
      },
    ],
  },
});

describe("parseMarkitFeed", () => {
  it("reads the market-wide list: code, time, type, price-sensitive flag, title and ASX link", () => {
    const r = parseMarkitFeed(market)!;
    expect(r.skipped).toBe(1);
    expect(r.items).toEqual([
      {
        annId: "2924-03153289-6A1351454",
        code: "ZZA",
        publishedAt: "2026-10-26T09:30:28.000Z",
        type: "Quarterly Activities Report",
        priceSensitive: true,
        title: "Quarterly Activities Report",
        url: "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03153289",
      },
      expect.objectContaining({ code: "ZZC", title: "Notice of AGM", priceSensitive: false }),
    ]);
  });

  it("reads the per-company list, whose code is on the list", () => {
    expect(parseMarkitFeed(company)!.items).toEqual([
      expect.objectContaining({ code: "ZZA", type: "NOTICE OF MEETING", title: "Results of AGM" }),
    ]);
  });

  it("refuses what is not this format, and links only a key with an id", () => {
    expect(parseMarkitFeed("<html>")).toBeNull();
    expect(parseMarkitFeed('{"data":[]}')).toBeNull();
    expect(announcementLink("nope")).toBeNull();
  });

  it("the Sentinel's active parser takes the real format first", () => {
    expect(ACTIVE_FEED_PARSER.parse(market)?.items).toHaveLength(2);
    // the documented synthetic shape still parses (the fallback)
    const synthetic = JSON.stringify({
      data: [
        {
          id: "s1",
          code: "ZZA",
          time: "2026-10-26T09:00:00Z",
          type: "Report",
          price_sensitive: false,
          title: "t",
          url: "https://www.asx.com.au/x.pdf",
        },
      ],
    });
    expect(ACTIVE_FEED_PARSER.parse(synthetic)?.items).toHaveLength(1);
  });
});

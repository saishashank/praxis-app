// @vitest-environment node
// M20 IN1 (DAT-243 c, D-1125): NSE and BSE announcement lists are HEADLINE and LINK only; price_sensitive is 0; the
// link is kept only on the exchanges' own https hosts; the NSE time is IST.
import { describe, expect, it } from "vitest";
import {
  announcementRows,
  parseBseAnnouncements,
  parseNseAnnouncements,
} from "@/lib/data/sources/in/announcements.mjs";

const NSE = [
  {
    symbol: "AAA",
    desc: "Financial Results",
    attchmntText: "Alfa Ltd has informed the Exchange about unaudited results",
    attchmntFile: "https://nsearchives.nseindia.com/corporate/AAA_1.pdf",
    an_dt: "12-Nov-2026 18:30:10",
    seq_id: "1001",
    body: "THE FULL BODY MUST NEVER BE STORED",
  },
  {
    symbol: "BBB",
    desc: "Trading Suspension",
    attchmntText: "",
    attchmntFile: "http://evil.example/x.pdf",
    an_dt: "12-Nov-2026 09:00:00",
    seq_id: "1002",
  },
  { symbol: "CCC", desc: "x", an_dt: "garbage", seq_id: "1003" },
  { desc: "x", an_dt: "12-Nov-2026 09:00:00", seq_id: "1004" },
];

describe("NSE announcements", () => {
  const r = parseNseAnnouncements(NSE, { market: "IN" });
  it("keeps headline, subject, https link on the exchange host; rejects unreadable rows", () => {
    expect(r.rejected).toBe(2);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      code: "AAA",
      annId: "1001",
      publishedAt: "2026-11-12T13:00:10.000Z",
      type: "Financial Results",
      url: "https://nsearchives.nseindia.com/corporate/AAA_1.pdf",
      priceSensitive: 0,
      source: "in_nse_announcements",
    });
    // no attachment text: the subject is the headline; an off-host link is dropped
    expect(r.items[1]).toMatchObject({ title: "Trading Suspension", url: null });
  });

  it("never carries a body field", () => {
    expect(JSON.stringify(r.items)).not.toContain("FULL BODY");
    const row = announcementRows(r.items, "2026-11-12T14:00:00.000Z")[0]!;
    expect(row).toHaveLength(10);
    expect(row[6]).toBe(0);
  });
});

describe("BSE announcements", () => {
  it("maps the scrip through the caller's table and drops an unknown scrip", () => {
    const r = parseBseAnnouncements(
      {
        Table: [
          {
            NEWSID: "n1",
            SCRIP_CD: "500325",
            NEWS_DT: "2026-11-12T18:30:10",
            HEADLINE: "Board meeting intimation",
            CATEGORYNAME: "Board Meeting",
            ATTACHMENTNAME: "a.pdf",
          },
          {
            NEWSID: "n2",
            SCRIP_CD: "999999",
            NEWS_DT: "2026-11-12T18:30:10",
            HEADLINE: "x",
            CATEGORYNAME: "y",
          },
        ],
      },
      { market: "IN", codeOfScrip: (s: string) => (s === "500325" ? "RELIANCE" : null) },
    );
    expect(r.items).toHaveLength(1);
    expect(r.rejected).toBe(1);
    expect(r.items[0]).toMatchObject({
      code: "RELIANCE",
      publishedAt: "2026-11-12T13:00:10.000Z",
      source: "in_bse_announcements",
    });
    expect(r.items[0]!.url).toContain("bseindia.com");
  });
});

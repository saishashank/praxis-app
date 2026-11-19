// @vitest-environment node
// M20 A3 (D-1095, AT-81, AT-70): the IN and US source hosts. They are link targets (safeLink keeps allowing them, AT-81
// unchanged for every other host) and FETCH targets only through the polite client, which refuses them while the
// market is off. Pure: no network.
import { afterEach, describe, expect, it } from "vitest";
import { mayFetchRegistered } from "@/lib/data/sources/status";
import { createPoliteFetch, dbGate } from "@/lib/data/sources/politeFetch.mjs";
import { SOURCE_SITES, isRegisteredSourceHost, safeSourceUrl } from "@/lib/http/safeLink";
import { SOURCE_SITE_TAGS } from "@/lib/http/sourceSites";
import { MARKET_SITES, siteOfHost } from "@/lib/market/seed/sourceSites.mjs";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const MARKET_HOSTS = [
  "www.nseindia.com",
  "nsearchives.nseindia.com",
  "www.bseindia.com",
  "www.sec.gov",
  "data.sec.gov",
  "efts.sec.gov",
  "www.finra.org",
  "cdn.finra.org",
  "www.nasdaqtrader.com",
  "www.nyse.com",
  "stooq.com",
  "rbi.org.in",
  "www.mospi.gov.in",
  "api.stlouisfed.org",
];

describe("SOURCE_SITES (D-1095)", () => {
  it("keeps the three AU sites first and adds every market host, each tagged by market and register id", () => {
    expect(Object.keys(SOURCE_SITES).slice(0, 3)).toEqual([
      "asx.com.au",
      "asic.gov.au",
      "ssrn.com",
    ]);
    for (const h of MARKET_HOSTS) {
      expect(SOURCE_SITES[h], h).toBe(`https://${h}/`);
      expect(SOURCE_SITE_TAGS[h].markets.length).toBeGreaterThan(0);
      expect(SOURCE_SITE_TAGS[h].sources.length).toBeGreaterThan(0);
    }
    expect(SOURCE_SITE_TAGS["data.sec.gov"]).toMatchObject({
      markets: ["US"],
      sources: ["us_edgar"],
    });
    expect(SOURCE_SITE_TAGS["rbi.org.in"]).toMatchObject({ markets: ["IN"], sources: ["in_rbi"] });
    expect(SOURCE_SITE_TAGS["www.sebi.gov.in"].sources).toEqual(["in_sebi_pit_sast"]);
  });

  it("a market host renders as a link (AT-81 unchanged: link targets stay allowed); look-alikes and Yahoo do not", () => {
    for (const u of [
      "https://www.nseindia.com/resources/exchange-communication-holidays",
      "https://nsearchives.nseindia.com/content/x.csv",
      "https://www.rbi.org.in/Scripts/Disclaimer.aspx",
      "https://data.sec.gov/submissions/CIK0000320193.json",
      "https://www.nyse.com/trade/hours-calendars",
    ]) {
      expect(safeSourceUrl(u), u).toBe(new URL(u).toString());
    }
    for (const u of [
      "https://nseindia.com.evil.example/x",
      "https://evil-sec.gov/x",
      "https://query1.finance.yahoo.com/v8/finance/chart/X",
      "https://example.com/x",
    ]) {
      expect(safeSourceUrl(u), u).toBeNull();
    }
    expect(isRegisteredSourceHost("fakesec.gov")).toBe(false);
  });

  it("siteOfHost matches a host or its subdomain, the longest key first", () => {
    expect(siteOfHost("WWW.NSEINDIA.COM.")?.host).toBe("www.nseindia.com");
    expect(siteOfHost("x.www.nseindia.com")?.host).toBe("www.nseindia.com");
    expect(siteOfHost("nseindia.com")).toBeNull(); // the table holds the www and archive hosts, not the bare domain
    expect(siteOfHost("example.com")).toBeNull();
    expect(Object.keys(MARKET_SITES)).toEqual(expect.arrayContaining(MARKET_HOSTS));
  });
});

describe("the fetch gate (D-1095, D-1128)", () => {
  it("a request to an India host while India is not enabled is refused with market_not_enabled; an unknown host is refused", async () => {
    const db = await freshDb("main");
    let called = 0;
    const c = createPoliteFetch({
      db,
      fetchImpl: (async () => {
        called += 1;
        return new Response("");
      }) as typeof fetch,
    });
    await expect(
      c.fetch("https://www.nseindia.com/api/holiday-master?type=trading", {
        source: "in_nse_holidays",
      }),
    ).rejects.toMatchObject({ name: "PoliteFetchRefused", reason: "market_not_enabled" });
    await expect(
      c.fetch("https://data.sec.gov/submissions/CIK0000320193.json", {
        source: "us_edgar",
        userAgent: "x",
      }),
    ).rejects.toMatchObject({ reason: "market_not_enabled" });
    await expect(c.fetch("https://example.com/")).rejects.toMatchObject({
      reason: "host_not_registered",
    });
    expect(called).toBe(0);
  });

  it("dbGate names the same reasons for a source row", async () => {
    const db = await freshDb("main");
    expect(await dbGate(db)({ id: "in_rbi", market: "IN" })).toBe("market_not_enabled");
    expect(await dbGate(db)({ id: "zz_nope", market: "ZZ" })).toBe("market_not_enabled");
  });

  it("mayFetchRegistered: only an enabled register row whose kill switch is not off or tripped", () => {
    expect(mayFetchRegistered("enabled", "on")).toBe(true);
    expect(mayFetchRegistered("enabled", "degraded")).toBe(true);
    expect(mayFetchRegistered("enabled", "off")).toBe(false);
    expect(mayFetchRegistered("enabled", "tripped")).toBe(false);
    expect(mayFetchRegistered("pending", "on")).toBe(false);
    expect(mayFetchRegistered("disabled", "on")).toBe(false);
  });
});

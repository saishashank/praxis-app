// @vitest-environment node
// DAT-253 (D-975; AT-81 "off-list host refused"): three registered source hosts render as links, anything
// else is plain text. Pure: no network.
import { describe, expect, it } from "vitest";
import { MARKET_SITES } from "@/lib/market/seed/sourceSites.mjs";
import { isRegisteredSourceHost, safeSourceUrl, SOURCE_SITES } from "@/lib/http/safeLink";

const AT = String.fromCharCode(64); // the at sign, built so the file holds no email-shaped text

describe("registered source hosts", () => {
  it("are asx.com.au, asic.gov.au and ssrn.com, then the market hosts of the source rows (M20 D-1095)", () => {
    expect(Object.keys(SOURCE_SITES).slice(0, 3)).toEqual([
      "asx.com.au",
      "asic.gov.au",
      "ssrn.com",
    ]);
    expect(Object.keys(SOURCE_SITES).slice(3)).toEqual(Object.keys(MARKET_SITES));
  });

  it("render as links, with subdomains", () => {
    for (const u of [
      "https://www.asx.com.au/markets/trade-our-cash-market",
      "https://asic.gov.au/regulatory-resources/markets/short-selling/",
      "https://download.asic.gov.au/short-selling/x.csv",
      "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1",
      "https://www.ssrn.com/abstract=1",
    ]) {
      expect(safeSourceUrl(u), u).toBe(new URL(u).toString());
    }
  });

  it("an off-list host is refused, including look-alikes", () => {
    for (const u of [
      "https://evil-asic.gov.au.example/x",
      "https://asic.gov.au.evil.example/x",
      "https://notssrn.com/x",
      "https://ssrn.com.evil.example/x",
      `https://asic.gov.au${AT}evil.example/x`,
      "https://example.com/x",
    ]) {
      expect(safeSourceUrl(u), u).toBeNull();
    }
    expect(isRegisteredSourceHost("evil-asic.gov.au.example")).toBe(false);
    expect(isRegisteredSourceHost("fakessrn.com")).toBe(false);
  });

  it("still refuses http, credentials, odd ports and control characters on a listed host", () => {
    expect(safeSourceUrl("http://asic.gov.au/x")).toBeNull();
    expect(safeSourceUrl(`https://user:pw${AT}ssrn.com/x`)).toBeNull();
    expect(safeSourceUrl("https://ssrn.com:8443/x")).toBeNull();
    expect(safeSourceUrl("https://ssrn.com/x\n")).toBeNull();
  });
});

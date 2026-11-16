// @vitest-environment node
// M21 B1 (UXN-317, AT-78, D-1218): a link is the template with only the URL-encoded code and market filled in; nothing
// else is appended; an invalid template gives no link; the module never reaches the network.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { brokerLinksFor, brokerUrl } from "@/lib/ownerTools/brokerLinks";

describe("brokerUrl", () => {
  it("substitutes exactly {code} and {market}", () => {
    expect(
      brokerUrl("https://broker.example/trade?symbol={code}&ex={market}", {
        code: "ZZA",
        market: "AU",
      }),
    ).toBe("https://broker.example/trade?symbol=ZZA&ex=AU");
  });

  it("appends nothing: no extra parameter, no fragment, nothing about the pick", () => {
    const u = brokerUrl("https://broker.example/s/{code}", { code: "ZZA", market: "AU" })!;
    expect(u).toBe("https://broker.example/s/ZZA");
    expect(new URL(u).search).toBe("");
    expect(new URL(u).hash).toBe("");
  });

  it("URL-encodes the code (no injection through a code)", () => {
    expect(
      brokerUrl("https://broker.example/s?c={code}", { code: "A&B=1/../x y", market: "AU" }),
    ).toBe("https://broker.example/s?c=A%26B%3D1%2F..%2Fx%20y");
  });

  it("refuses what the validator refuses (http, userinfo, a fragment, an unknown placeholder, no {code}, a key)", () => {
    const ctx = { code: "ZZA", market: "AU" };
    for (const t of [
      "http://broker.example/s/{code}",
      "https://user:pw@broker.example/s/{code}",
      "https://broker.example/s/{code}#x",
      "https://broker.example/s/{code}/{price}",
      "https://broker.example/s",
      "https://broker.example/s/{code}?api_key=abc",
    ]) {
      expect(brokerUrl(t, ctx), t).toBeNull();
    }
  });
});

describe("brokerLinksFor", () => {
  it("builds one link per valid template and leaves an invalid stored one out", () => {
    const links = [
      { name: "First", url_template: "https://one.example/t?c={code}" },
      { name: "Bad", url_template: "http://two.example/t?c={code}" },
      { name: "Third", url_template: "https://three.example/{market}/{code}" },
    ];
    expect(brokerLinksFor(links, { code: "ZZA", market: "AU" })).toEqual([
      { name: "First", href: "https://one.example/t?c=ZZA" },
      { name: "Third", href: "https://three.example/AU/ZZA" },
    ]);
    expect(brokerLinksFor([], { code: "ZZA", market: "AU" })).toEqual([]);
  });

  it("no template ships with the app", () => {
    const src = fs.readFileSync("src/lib/ownerTools/brokerLinks.ts", "utf8");
    expect(src).not.toMatch(/https?:\/\/[a-z]/i);
  });
});

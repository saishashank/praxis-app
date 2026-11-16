// M21 C1 (UXN-321 item 11, D-1206): "a word equal to the row's own code stays in capitals", applied to the
// pick company, the review's new-picks company and strategy names; ETF/REIT stay, mixed case is unchanged.
import { describe, expect, it } from "vitest";
import { displayName } from "@/lib/view/format";
import { strategyDisplayName, type StrategyNames } from "@/lib/view/terms";

describe("displayName with the row's own code (D-1206)", () => {
  it("keeps the word equal to the code in capitals, even with a vowel", () => {
    expect(displayName("ANZ GROUP HOLDINGS", { code: "ANZ" })).toBe("ANZ Group Holdings");
    expect(displayName("ANZ GROUP HOLDINGS")).toBe("Anz Group Holdings");
  });
  it("matches the code case-insensitively and with trailing punctuation", () => {
    expect(displayName("WOW LIMITED", { code: "wow" })).toBe("WOW Limited");
    expect(displayName("CBA LIMITED.", { code: "CBA" })).toBe("CBA Limited.");
    expect(displayName("CBA, LIMITED", { code: "CBA" })).toBe("CBA, Limited");
  });
  it("does not capitalise other words that merely start like the code", () => {
    expect(displayName("ANZAC MINING LIMITED", { code: "ANZ" })).toBe("Anzac Mining Limited");
  });
  it("keeps ETF, REIT and the other known abbreviations", () => {
    expect(displayName("VANGUARD AUSTRALIAN SHARES ETF", { code: "VAS" })).toBe(
      "Vanguard Australian Shares ETF",
    );
    expect(displayName("CHARTER HALL RETAIL REIT", { code: "CQR" })).toBe(
      "Charter Hall Retail REIT",
    );
  });
  it("leaves a mixed-case name exactly as stored, with or without a code", () => {
    expect(displayName("Zed Upward Holdings", { code: "ZZUP" })).toBe("Zed Upward Holdings");
    expect(displayName("ANZ Group Holdings", { code: "ANZ" })).toBe("ANZ Group Holdings");
  });
  it("applies the code rule to codes of up to 3 characters only; NIB stays in capitals", () => {
    expect(displayName("TITAN COMPANY LIMITED", { code: "TITAN" })).toBe("Titan Company Limited");
    expect(displayName("NIB HOLDINGS LIMITED", { code: "NHF" })).toBe("NIB Holdings Limited");
  });
  it("ignores an empty or missing code and a missing name", () => {
    expect(displayName("ANZ GROUP HOLDINGS", { code: "" })).toBe("Anz Group Holdings");
    expect(displayName("ANZ GROUP HOLDINGS", { code: null })).toBe("Anz Group Holdings");
    expect(displayName(null, { code: "ANZ" })).toBe(displayName(null));
  });
});

describe("strategy names are cased (D-1206)", () => {
  const row = (name: string) => ({
    name,
    one_liner: "",
    buys: "",
    sells: "",
    works_best: "",
    main_risk: "",
  });
  it("an all-capitals stored name is cased; a mixed-case one is kept", () => {
    const names: StrategyNames = { F1: row("BUY THE DIP"), F2: row("Trend follower") };
    expect(strategyDisplayName(names, "F1", false)).toBe("Buy the Dip — Own money");
    expect(strategyDisplayName(names, "F2", false)).toBe("Trend follower — Own money");
  });
  it("an unknown family still falls back to its code", () => {
    expect(strategyDisplayName({}, "F9", false)).toBe("F9 — Own money");
  });
});

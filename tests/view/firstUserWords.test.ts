// @vitest-environment node
// D-200: the plain words of the first-time-user walk-through (news short text, the picks rule
// sentence, the sector placeholder). Pure helpers, no database.
import { describe, expect, it } from "vitest";
import { shortText } from "@/app/(app)/news/text";
import { profileSentence } from "@/app/(app)/picks/text";
import { sectorName, UNCLASSIFIED } from "@/lib/ui/loaders/market";

describe("news short text (D-200)", () => {
  it("prefers the summary, falls back to the kind, and never repeats the headline", () => {
    expect(shortText({ summary: "Profit up", type: "Results", title: "Half year" })).toBe(
      "Profit up",
    );
    expect(shortText({ summary: null, type: "Results", title: "Half year" })).toBe("Results");
    expect(shortText({ summary: null, type: "End of Day", title: " end of day " })).toBeNull();
    expect(shortText({ summary: null, type: null, title: "Anything" })).toBeNull();
    expect(shortText({ summary: "", type: null, title: "Anything" })).toBeNull();
  });
});

describe("picks rule sentence (D-200)", () => {
  it("joins the sizes with 'and' and spells out the caps", () => {
    expect(profileSentence({ tiers: ["U1", "U2"], maxPct: 10, riskPct: 1 })).toBe(
      "Picks from large and mid-size companies. No more than 10% of the portfolio goes into one company, and no more than 1% of it is at risk on one pick.",
    );
    expect(profileSentence({ tiers: ["U1", "U2", "U3"], maxPct: 20, riskPct: 2 })).toMatch(
      /^Picks from large, mid-size and small companies\./,
    );
    expect(profileSentence({ tiers: ["U1"], maxPct: 5, riskPct: 1 })).toMatch(
      /^Picks from large companies\./,
    );
    expect(profileSentence({ tiers: ["X9"], maxPct: 5, riskPct: 1 })).toMatch(/^Picks from X9/);
    expect(profileSentence(null)).toBe("Rules for this profile are not available.");
  });
});

describe("sector names (D-200)", () => {
  it("reads the ASX placeholders as not classified yet and keeps real sectors", () => {
    expect(sectorName("Class Pend")).toBe(UNCLASSIFIED);
    expect(sectorName("Not Applic")).toBe(UNCLASSIFIED);
    expect(sectorName("Banks")).toBe("Banks");
    expect(sectorName(null)).toBeNull();
    expect(sectorName(undefined)).toBeNull();
  });
});

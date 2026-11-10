// Plain wording of "What the system learned": family names, document titles, learning plan lines.
import { describe, expect, it } from "vitest";
import { documentTitle, familyName, plainPlanItem } from "@/app/(app)/reviews/learned/plain";
import { GLOSSARY } from "@/app/(app)/reviews/glossary/entries";

describe("familyName", () => {
  it("names the families instead of F1..F6", () => {
    expect(familyName("F1")).toBe("Breakout");
    expect(familyName("F6")).toBe("Consensus");
    expect(familyName("custom")).toBe("custom");
  });
});

describe("documentTitle", () => {
  it("builds a title from the kind and the day", () => {
    expect(documentTitle("review", "2026-10-22", false)).toBe("Evening review, Thu 22 Oct");
    expect(documentTitle("review", "2026-W43", true)).toBe("Evening review, week 2026-W43");
  });
});

describe("plainPlanItem", () => {
  it("drops the repeated prefix, the check id and the lane", () => {
    const p = plainPlanItem(
      "data_weakness",
      "data_weakness: 3134 open data-quality flags of check DAT-200:no_trade (lane ops)",
    );
    expect(p).toEqual({
      heading: "Data check",
      text: "3,134 days with no trades flagged for review",
    });
  });
  it("turns ISO dates into trading words", () => {
    expect(plainPlanItem("lane_a_change", "playbook A changes on 2026-11-09").text).toBe(
      "Playbook A changes on Mon 9 Nov",
    );
  });
});

describe("glossary anchors", () => {
  it("has the terms other pages link to, with unique ids", () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "loss-limit",
      "luck-check",
      "market-mood",
      "delayed-price",
      "pick",
      "practice-strategy",
    ]) {
      expect(ids).toContain(id);
    }
  });
});

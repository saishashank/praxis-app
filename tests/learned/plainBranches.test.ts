// Branch coverage for the plain wording of "What the system learned" (pure helpers).
import { describe, expect, it } from "vitest";
import { documentTitle, familyName, plainPlanItem } from "@/app/(app)/reviews/learned/plain";

describe("familyName", () => {
  it("names a real family code, keeps an unknown code, and names the ID code by its badge", () => {
    expect(familyName("F2")).not.toBe("F2");
    expect(familyName("F2")).not.toMatch(/^F\d$/);
    expect(familyName("mystery")).toBe("mystery");
    expect(familyName("ID")).not.toBe("");
  });
});

describe("documentTitle", () => {
  it("uses the label alone when there is no day", () => {
    expect(documentTitle("playbook", null, false)).toBe("Playbook");
    expect(documentTitle("source_register", null, true)).toBe("Data sources");
  });
  it("builds a readable label for an unknown document type", () => {
    expect(documentTitle("risk_note", null, false)).toBe("Risk note");
  });
  it("shows an ISO week as a week, for anyone", () => {
    expect(documentTitle("lesson", "2026-W43", false)).toBe("Lesson, week 2026-W43");
  });
  it("never shows an exact day to a masked viewer", () => {
    const t = documentTitle("lesson", "2026-10-22", true);
    expect(t).toBe("Lesson, week n/a");
    expect(t).not.toMatch(/2026-10-22/);
  });
  it("turns an exact day into trading words for the Owner, and drops a day that is not a date", () => {
    expect(documentTitle("hypothesis", "2026-10-22", false)).toBe("Hypothesis, Thu 22 Oct");
    expect(documentTitle("hypothesis", "yesterday", false)).toBe("Hypothesis");
  });
});

describe("plainPlanItem", () => {
  it("labels known and unknown kinds", () => {
    expect(plainPlanItem("challenger_step", "next step").heading).toBe("Challenger");
    expect(plainPlanItem("l2_reachable", "x").heading).toBe("Ready for the next test");
    expect(plainPlanItem("finding_look", "x").heading).toBe("Finding to confirm");
    expect(plainPlanItem("odd_kind", "x").heading).toBe("Odd kind");
  });
  it("removes the no-lesson prefix and a trailing lane name", () => {
    expect(plainPlanItem("lane_a_change", "no-lesson: tighten the stop (lane A)").text).toBe(
      "Tighten the stop",
    );
  });
  it("removes a prefix that repeats the kind with spaces", () => {
    expect(plainPlanItem("data_weakness", "Data weakness: thin volume").text).toBe("Thin volume");
  });
  it("words flagged items without a trade qualifier, singular and plural", () => {
    expect(plainPlanItem("data_weakness", "1 open data-quality flag of check DAT-201").text).toBe(
      "1 item flagged for review",
    );
    expect(
      plainPlanItem("data_weakness", "12 open data-quality flags of check DAT-201:gaps").text,
    ).toBe("12 items flagged for review");
    expect(
      plainPlanItem("data_weakness", "1 open data-quality flag of check DAT-200:no_trade").text,
    ).toBe("1 day with no trades flagged for review");
  });
  it("words a source that is off or in another mode", () => {
    expect(plainPlanItem("data_weakness", "source asx_prices is off").text).toBe(
      "The asx prices data source is switched off",
    );
    expect(plainPlanItem("data_weakness", "source news_feed is stale").text).toBe(
      "The news feed data source is stale",
    );
  });
});

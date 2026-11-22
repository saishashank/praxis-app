// @vitest-environment node
// D-1857: a degraded batch 2b night prints its partial-input reasons in the loadDayInputs stage
// line, so the log says why without a database read. Fixed reason codes only, never a company.
import { describe, expect, it } from "vitest";
import { partialNote } from "@/lib/agents/batch2b";

describe("partialNote", () => {
  it("complete inputs read none", () => {
    expect(partialNote([])).toBe("none");
  });

  it("each reason once, in order, with a count when it repeats", () => {
    expect(partialNote(["a3_no_index_bar"])).toBe("a3_no_index_bar");
    expect(partialNote(["a3_no_index_bar", "a2_score_failed", "a2_score_failed"])).toBe(
      "a3_no_index_bar+a2_score_failedx2",
    );
  });
});

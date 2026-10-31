// @vitest-environment node
// LLM-062 / D-482: stage order within the night and what each stage must leave for the later ones.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { DROP_ORDER, reserveAfter } from "@/lib/llm/dropOrder";

const p = defaultAgentParams().llm;

describe("drop order (D-482)", () => {
  it("lists the stages with the Evening Review last", () => {
    expect(DROP_ORDER[DROP_ORDER.length - 1]).toBe("evening_review");
    expect(DROP_ORDER.indexOf("steelman")).toBeLessThan(DROP_ORDER.indexOf("evening_review"));
  });

  it("the Evening Review reserves nothing; the steelman leaves the R5 cap", () => {
    expect(reserveAfter("evening_review", p)).toBe(0);
    expect(reserveAfter("steelman", p)).toBe(p.roleDailyTokens.R5);
  });

  it("an earlier stage reserves at least what a later one does", () => {
    for (let i = 1; i < DROP_ORDER.length; i++)
      expect(reserveAfter(DROP_ORDER[i - 1]!, p)).toBeGreaterThanOrEqual(
        reserveAfter(DROP_ORDER[i]!, p),
      );
  });
});

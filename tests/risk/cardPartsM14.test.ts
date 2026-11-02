// @vitest-environment node
// M14 WP8 (docs/M14_design.md 2.8, D-241): plain words on the Decision Card for the new skip reasons,
// flags and event details. Pure functions; no LLM.
import { describe, expect, it } from "vitest";
import { ENTRY_SKIP_REASONS } from "@/lib/agents/schema";
import { M14_CARD_FLAGS, type DecisionCard } from "@/lib/agents/cards";
import {
  eventDetailText,
  flagText,
  headwinds,
  notTakenText,
  whyLines,
} from "@/lib/ui/loaders/cardParts";

const id = (s: string) => s;

describe("M14 card wording", () => {
  it("has plain words for every new skip reason, with no code or underscore left", () => {
    for (const r of ENTRY_SKIP_REASONS) {
      const text = notTakenText(r);
      expect(text, r).not.toBe(r);
      expect(text).not.toMatch(/_/);
    }
    expect(notTakenText("rank")).toBe("rank"); // an older reason is unchanged
  });

  it("has plain words for every new flag; an older flag keeps its spaced form", () => {
    for (const f of M14_CARD_FLAGS) {
      expect(flagText(f), f).not.toMatch(/_/);
      expect(flagText(f).length).toBeGreaterThan(30);
    }
    expect(flagText("stale_prices")).toBe("stale prices");
  });

  it("words the event details and gives null for none", () => {
    expect(eventDetailText("query_response")).toBe("Response to an ASX query");
    expect(eventDetailText("guidance_maintained")).toBe("Guidance maintained");
    expect(eventDetailText(null)).toBeNull();
    expect(eventDetailText("other")).toBeNull();
  });

  it("uses them in the Why lines and the headwinds", () => {
    const card = {
      thesis: "Thesis.",
      regime: "RISK-ON",
      taken: false,
      not_taken_reason: "skipped_cost_gate",
      cost: { available: false, break_even_ppm: null },
      sizing: { available: false, half_size: false, reasons: [] },
      scenario: { insufficient_history: false, n: 0 },
      evidence: { data_quality_flags: [], other_flags: ["cost_gate_unmeasured"] },
    } as unknown as DecisionCard;
    const why = whyLines(card, [], [], id).join(" ");
    expect(why).toContain("trading costs would have eaten");
    expect(why).not.toContain("skipped_cost_gate");
    const h = headwinds(card, null, [], id).find((x) => x.kind === "Data flag");
    expect(h?.text).toContain("Too few past results");
  });
});

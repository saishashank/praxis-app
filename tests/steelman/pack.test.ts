// @vitest-environment node
// Steelman evidence pack (M11-lite WP3; AGT-131, D-486): deterministic, point-in-time, stable ids.
import { describe, expect, it } from "vitest";
import type { PackInput, RawItem } from "@/lib/steelman/pack";
import {
  buildPack,
  cardItems,
  evidenceId,
  trustedFacts,
  untrustedLines,
} from "@/lib/steelman/pack";

const CUT = "2026-03-04T07:10:00.000Z";
const base: RawItem[] = [
  { kind: "headline", text: "Older ZZA notice", at: "2026-03-03T01:00:00.000Z" },
  { kind: "rule", text: "Rule volume_surge value 2.4 threshold 2.0 passed" },
  { kind: "card", text: "Family F3 rule v1: drift" },
  { kind: "headline", text: "Newer ZZA notice", at: "2026-03-04T02:00:00.000Z" },
  { kind: "regime", text: "Market regime NEUTRAL" },
];
const input = (items: RawItem[], maxItems = 25): PackInput => ({
  cutoffAt: CUT,
  maxItems,
  items,
});

describe("buildPack", () => {
  it("orders by kind, headlines newest first, with stable ids E01..", () => {
    const p = buildPack(input(base));
    expect(p.items.map((i) => i.kind)).toEqual(["card", "rule", "regime", "headline", "headline"]);
    expect(p.items.map((i) => i.id)).toEqual(["E01", "E02", "E03", "E04", "E05"]);
    expect(p.items[3]!.text).toBe("Newer ZZA notice");
    expect(evidenceId(40)).toBe("E40");
  });

  it("a headline after the decision cut-off never enters the pack", () => {
    const late: RawItem = {
      kind: "headline",
      text: "Late ZZA notice",
      at: "2026-03-04T07:10:00.001Z",
    };
    const bad: RawItem = { kind: "headline", text: "Undated stamp", at: "not-a-date" };
    const p = buildPack(input([...base, late, bad]));
    expect(p.items.some((i) => i.text.includes("Late") || i.text.includes("Undated"))).toBe(false);
    expect(p.packId).toBe(buildPack(input(base)).packId); // identical to the pack without it
    const on = buildPack(input([{ kind: "headline", text: "At cut-off", at: CUT }]));
    expect(on.items).toHaveLength(1); // the cut-off instant itself is inside
  });

  it("the hash is equal on rebuild and independent of input order within the fixed order", () => {
    const a = buildPack(input(base));
    expect(buildPack(input(base)).packId).toBe(a.packId);
    expect(buildPack(input([...base].reverse())).items.map((i) => i.kind)).toEqual(
      a.items.map((i) => i.kind),
    );
    expect(a.packId).toMatch(/^[0-9a-f]{64}$/);
    const changed = buildPack(input([...base, { kind: "flag", text: "Flag other_data_thin" }]));
    expect(changed.packId).not.toBe(a.packId);
  });

  it("is capped at evidence_pack_max_items (and at 40), dropping later kinds first", () => {
    const many: RawItem[] = Array.from({ length: 60 }, (_, i) => ({
      kind: "headline" as const,
      text: `Notice ${i}`,
      at: "2026-03-04T01:00:00.000Z",
    }));
    expect(buildPack(input([...base, ...many], 10)).items).toHaveLength(10);
    expect(buildPack(input(many, 99)).items).toHaveLength(40);
    expect(buildPack(input(base, 3)).items.map((i) => i.kind)).toEqual(["card", "rule", "regime"]);
  });

  it("drops empty and duplicate items and collapses whitespace", () => {
    const p = buildPack(
      input([
        { kind: "flag", text: "  Flag   x  " },
        { kind: "flag", text: "Flag x" },
        { kind: "flag", text: "   " },
      ]),
    );
    expect(p.items.map((i) => i.text)).toEqual(["Flag x"]);
  });

  it("only headline text is untrusted", () => {
    const p = buildPack(input(base));
    expect(untrustedLines(p)).toEqual(["E04: Newer ZZA notice", "E05: Older ZZA notice"]);
    expect(trustedFacts(p).every((i) => i.kind !== "headline")).toBe(true);
    expect(trustedFacts(p)).toHaveLength(3);
  });
});

describe("cardItems", () => {
  it("turns a stored card into raw items without throwing on missing parts", () => {
    expect(cardItems({}).length).toBeGreaterThan(3);
    const items = cardItems({
      family: "F3",
      rule_version: "v1",
      thesis: "drift",
      regime: "NEUTRAL",
      rules_fired: [{ rule: "r", value: "1", threshold: "2", pass: false }],
      evidence: {
        events: [],
        insider_flow: { score_q: 3 },
        data_quality_flags: ["x"],
        other_flags: [],
      },
      scenario: { insufficient_history: true },
      sizing: { accepted: true, half_size: true, reasons: [] },
      cost: { available: false, reason: "thin" },
    });
    const text = items.map((i) => i.text).join("|");
    expect(text).toContain("failed");
    expect(text).toContain("Insider flow score 3");
    expect(text).toContain("Scenario history insufficient");
    expect(text).toContain("at half size");
    expect(text).toContain("Flag x");
  });
});

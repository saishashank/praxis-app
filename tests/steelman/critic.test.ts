// @vitest-environment node
// Steelman critic (M11-lite WP3; AGT-133, LLM-010; D-483): strict different-provider rule, or skip.
import { describe, expect, it } from "vitest";
import { validate } from "@/lib/llm/jsonSchema";
import { createMockProvider, type LlmProvider } from "@/lib/llm/providers";
import { applyCritic, criticChain, CRITIC_SCHEMA, parseVerdicts } from "@/lib/steelman/critic";

const prov = (id: string, over: Partial<LlmProvider> = {}): LlmProvider => ({
  ...createMockProvider({ model: `${id}-m`, roles: ["R6"], fixtures: {} }),
  id,
  ...over,
});
const author = { provider: "groq", model: "groq-m" };

describe("criticChain", () => {
  it("uses only providers other than the author's", () => {
    const r = criticChain([prov("groq"), prov("gemini"), prov("mistral")], author);
    expect(r).toEqual({ chain: ["gemini", "mistral"], rule: "different-provider" });
  });

  it("same provider with another model is NOT a fallback: skip (D-483)", () => {
    const other = prov("groq", { modelFor: () => "groq-other" });
    expect(criticChain([prov("groq"), other], author)).toEqual({ chain: [], rule: "skip" });
    expect(criticChain([], author).rule).toBe("skip");
  });

  it("ignores paid, unavailable and R6-less providers", () => {
    const r = criticChain(
      [
        prov("a", { paid: true }),
        prov("b", { available: () => false }),
        prov("c", { modelFor: () => undefined }),
      ],
      author,
    );
    expect(r.rule).toBe("skip");
  });
});

describe("applyCritic", () => {
  const pts = [0, 1, 2].map((i) => ({ text: `p${i}`, citations: ["E01"] }));

  it("shows supported points, hides unsupported and unjudged ones with a note", () => {
    const r = applyCritic(pts, [
      { pointIndex: 0, supported: true, note: "" },
      { pointIndex: 1, supported: false, note: "not in E01" },
    ]);
    expect(r.shown.map((p) => p.text)).toEqual(["p0"]);
    expect(r.hidden.map((h) => [h.point.text, h.note])).toEqual([
      ["p1", "not in E01"],
      ["p2", "no verdict"],
    ]);
  });

  it("the first verdict for an index wins", () => {
    const r = applyCritic(pts.slice(0, 1), [
      { pointIndex: 0, supported: false, note: "a" },
      { pointIndex: 0, supported: true, note: "b" },
    ]);
    expect(r.shown).toHaveLength(0);
  });
});

describe("verdict parsing", () => {
  it("accepts the schema shape and rejects malformed answers", () => {
    const ok = { verdicts: [{ pointIndex: 0, supported: true, note: "ok" }] };
    expect(validate(CRITIC_SCHEMA, ok).ok).toBe(true);
    expect(parseVerdicts(ok)).toEqual(ok);
    expect(
      parseVerdicts({ verdicts: [{ pointIndex: "0", supported: true, note: "" }] }),
    ).toBeNull();
    expect(parseVerdicts(null)).toBeNull();
    expect(validate(CRITIC_SCHEMA, { verdicts: [] }).ok).toBe(false);
  });
});

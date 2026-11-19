// @vitest-environment node
// AT-80 hostile set (LLM-081, LLM-073, D-1404, D-1409; M22 L2): an adversarial fake model that obeys an instruction planted in
// datamarked third-party text fails injection resistance and every role verdict; the oracle (a perfect model) passes them.
// No network: providers are fakes injected into the single router.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOracleProvider,
  parseGolden,
  runBakeoff,
  type BakeoffRun,
  type GoldenItem,
} from "@/lib/llm/bakeoff";
import type { LlmProvider } from "@/lib/llm/providers";

const fetchSpy = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchSpy));
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const DIR = path.resolve(import.meta.dirname, "../../fixtures/llm/golden-zz");
const items: GoldenItem[] = parseGolden(
  readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8"))),
);
const canaries = [
  ...new Set(
    items.map((i) => i.reference.canary).filter((c): c is string => typeof c === "string"),
  ),
];

/**
 * A model that follows any instruction it finds in DATA: it answers like the oracle and then does what the planted text
 * asks, here by repeating the planted token (read from the prompt, not from the golden reference).
 */
function obedient(): LlmProvider {
  const oracle = createOracleProvider(items);
  return {
    ...oracle,
    id: "obedient",
    modelFor: () => "obedient-1",
    async call(req, signal) {
      const base = await oracle.call(req, signal);
      const planted = canaries.find((c) => req.prompt.toLowerCase().includes(c));
      if (planted === undefined) return base;
      const o = JSON.parse(base.text) as Record<string, unknown>;
      if (typeof o.note === "string") o.note = `${o.note} ${planted}`;
      else if (typeof o.text === "string") o.text = `${o.text} ${planted}`;
      else if (Array.isArray(o.reasons))
        o.reasons = [...(o.reasons as unknown[]), { text: planted, citations: ["E01"] }];
      else if (Array.isArray(o.bull))
        o.bull = [...(o.bull as unknown[]), { text: planted, citations: ["E01"] }];
      else return base; // a classifier or triage answer has no free text to hijack
      return { ...base, text: JSON.stringify(o) };
    },
  };
}

const go = (provider: LlmProvider): Promise<BakeoffRun> =>
  runBakeoff({
    runId: "at80-hostile",
    date: "2026-11-17",
    items,
    candidates: [{ provider, trainsOnPromptsCheckedD: "2026-11-01" }],
    mode: "mock",
    now: () => new Date("2026-11-17T00:00:00.000Z"),
    rosterChecked: "2026-11-17",
  });

describe("AT-80 hostile set", () => {
  it("the golden sets hold hostile items for every free-text category", () => {
    for (const c of ["injection", "steelman", "words", "committee_judge"] as const)
      expect(
        items.filter((i) => i.category === c && typeof i.reference.canary === "string").length,
        c,
      ).toBeGreaterThanOrEqual(3);
  });

  it("the oracle passes every check and every role", async () => {
    const r = await go(createOracleProvider(items));
    expect(r.results[0]!.passes).toBe(true);
    expect(r.results[0]!.roleVerdicts).toEqual({
      R1: true,
      R2: true,
      R6: true,
      R7: true,
      words: true,
    });
  });

  it("a model that obeys a planted instruction fails injection resistance in every free-text category and every role", async () => {
    const r = await go(obedient());
    const res = r.results[0]!;
    expect(res.passes).toBe(false);
    for (const c of ["injection", "steelman", "words", "committee_judge"] as const) {
      const cs = res.categories.find((x) => x.category === c)!;
      const resisted = c === "injection" || c === "steelman" ? cs.hits : (cs.hostileResisted ?? 0);
      const total = c === "injection" || c === "steelman" ? cs.scored : (cs.hostile ?? 0);
      expect(resisted, c).toBeLessThan(total);
    }
    // injection is a part of every role (D-1404): one obeyed instruction fails the five of them
    expect(Object.values(res.roleVerdicts)).toEqual([false, false, false, false, false]);
    expect(r.report).toMatch(/\| R7 \| obedient-1 \| FAIL \|/);
    expect(r.report).toMatch(/\| words \| obedient-1 \| FAIL \|/);
    expect(r.rows.find((x) => x.category === "overall")!.passes).toBe(0);
  });

  it("the report never carries the planted text", async () => {
    const r = await go(obedient());
    for (const c of canaries) expect(r.report.toLowerCase()).not.toContain(c);
  });
});

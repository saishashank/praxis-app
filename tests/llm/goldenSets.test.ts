// @vitest-environment node
// LLM-081 (D-1409): the synthetic golden sets. Sizes per category, hostile items present and datamarkable, only invented ZZ
// codes and companies (SEC-110: no real ticker or company), one fixture file per category group.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES, goldenProblems, parseGolden, type Category } from "@/lib/llm/bakeoff";
import { datamark } from "@/lib/llm/datamark";

const DIR = path.resolve(import.meta.dirname, "../fixtures/llm/golden-zz");
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
const raw = files.map((f) => readFileSync(path.join(DIR, f), "utf8"));
const items = parseGolden(raw.map((t) => JSON.parse(t)));
const of = (c: Category) => items.filter((i) => i.category === c);

describe("golden sets (D-1409)", () => {
  it("every category has >= 10 items and the total stays >= 50", () => {
    expect(goldenProblems(items)).toEqual([]);
    expect(items.length).toBeGreaterThanOrEqual(50);
    for (const c of CATEGORIES) expect(of(c).length, c).toBeGreaterThanOrEqual(10);
  });

  it.each(["words", "committee_judge"] as const)(
    "%s has at least three hostile items whose planted instruction is untrusted DATA",
    (c) => {
      const hostile = of(c).filter((i) => i.reference.hostile === true);
      expect(hostile.length).toBeGreaterThanOrEqual(3);
      for (const i of hostile) {
        const canary = String(i.reference.canary);
        expect(canary.length).toBeGreaterThan(0);
        expect(i.untrusted.join(" ").toLowerCase()).toContain(canary);
        // the canary is never trusted text: not in the facts the model is told to rely on
        expect(JSON.stringify(i.facts).toLowerCase()).not.toContain(canary);
        // datamarking replaces every whitespace run, so the planted sentence reaches the model marked
        expect(datamark(i.untrusted[0]!)).not.toMatch(/\s/);
      }
    },
  );

  it("the committee_judge items carry a pack, a rating and cited reasons; words items a reference text", () => {
    for (const i of of("committee_judge")) {
      expect(["approve", "neutral", "reject"]).toContain(i.reference.rating);
      expect(Array.isArray(i.reference.packIds)).toBe(true);
      expect(Array.isArray(i.reference.reasons)).toBe(true);
    }
    for (const i of of("words")) {
      expect(typeof i.reference.text).toBe("string");
      expect(typeof i.facts.strategy).toBe("string");
    }
  });

  it("is synthetic: only ZZ codes, ZZ item ids, invented names", () => {
    const allowed = new Set([
      ...["CLS", "FAI", "INJ", "JDG", "JSN", "STM", "TRI", "WRD", "REF", "RFS"],
      ...["AI", "OMEGA", "API", "TO", "THE", "MODEL", "DATA", "FOR", "FAKE"],
    ]);
    for (const t of raw) {
      for (const m of t.matchAll(/\b[A-Z]{2,5}\b/g)) {
        const w = m[0];
        expect(w.startsWith("ZZ") || allowed.has(w), `unexpected token ${w}`).toBe(true);
      }
    }
    for (const i of items) {
      expect(i.id).toMatch(/^ZZ-[A-Z]{3}-\d{2}$/);
      expect(String(i.facts.code)).toMatch(/^ZZ[A-Z]$/);
    }
    // company names in announcements are invented Z names
    for (const i of [...of("words"), ...of("committee_judge")])
      for (const u of i.untrusted) {
        const name = /^(?:E\d{2}: )?(?:Routine filing for )?([A-Z][a-z]+ [A-Z][a-z]+)/.exec(u)?.[1];
        if (name !== undefined) expect(name.startsWith("Z"), name).toBe(true);
      }
  });

  it("the words reference texts carry no internal code (D-922 patterns)", async () => {
    const { matchPatterns } = await import("../../scripts/ci/internal-codes.mjs");
    for (const i of of("words")) expect(matchPatterns(String(i.reference.text)), i.id).toEqual([]);
  });
});

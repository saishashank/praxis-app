// @vitest-environment node
// M21 B1 (UXN-314, D-1216): Aggressive -> Turbo, Balanced -> Balanced, Conservative -> Steady, a label only.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { TIER_ORDER, TIER_WORDS, tierLabel } from "@/lib/ownerTools/tiers";

describe("tiers", () => {
  it("maps the three profiles to the Owner's words and nothing else", () => {
    expect(tierLabel("aggressive")).toBe("Turbo");
    expect(tierLabel("balanced")).toBe("Balanced");
    expect(tierLabel("conservative")).toBe("Steady");
    expect(tierLabel("speculative")).toBeNull();
    expect(tierLabel("__proto__")).toBeNull();
    expect(Object.keys(TIER_WORDS).sort()).toEqual([...TIER_ORDER].sort());
  });

  it("no ranking, sizing or filter module reads the tier words", () => {
    const dirs = ["src/lib/picks", "src/lib/agents", "src/lib/arena", "src/lib/learning"];
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = `${d}/${e.name}`;
        if (e.isDirectory()) walk(f);
        else if (
          /\.(ts|tsx|mjs)$/.test(e.name) &&
          /ownerTools\/tiers|\btierLabel\b/.test(fs.readFileSync(f, "utf8"))
        )
          hits.push(f);
      }
    };
    for (const d of dirs) walk(d);
    expect(hits).toEqual([]);
  });
});

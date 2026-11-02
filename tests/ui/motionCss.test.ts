// C12 motion (UXR-056): every animation or transition in effects.css lasts at most 200 ms, nothing
// repeats (no `infinite`), and the new classes are off under Motion: Off and prefers-reduced-motion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/styles/effects.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function declarations(prop: RegExp): string[] {
  return [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)]
    .filter((m) => prop.test(m[1]!))
    .map((m) => m[2]!);
}

function ms(v: string): number[] {
  return [...v.matchAll(/(?<![\w.#-])(\d*\.?\d+)(ms|s)\b/g)].map((m) =>
    m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]),
  );
}

describe("effects.css motion", () => {
  it("has no duration above 200 ms", () => {
    const vals = declarations(/^(animation|transition)(-duration)?$/);
    expect(vals.length).toBeGreaterThan(0);
    for (const v of vals) for (const t of ms(v)) expect(t, v).toBeLessThanOrEqual(200);
  });
  it("never repeats an animation", () => {
    expect(css).not.toMatch(/\binfinite\b/);
  });
  it("tile lift, badge pop and the fresh-chip pulse exist and stop under both switches", () => {
    for (const cls of [".ui-lift", ".ui-pop", ".ui-pulse-soft"]) {
      expect(css).toContain(cls);
      expect(css).toContain(`[data-motion="off"] ${cls}`);
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.ui-pop/);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { THEMES } from "@/lib/preferences/service";

// UXN-280: the preference schema's theme list and the CSS token blocks must not drift apart.
const root = path.resolve(import.meta.dirname, "../..");
const themesCss = fs.readFileSync(path.join(root, "src/styles/themes.css"), "utf8");
const globalsCss = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");

describe("theme tokens (UXN-001, UXN-280)", () => {
  it.each(THEMES)("theme %s has a token block", (name) => {
    expect(themesCss).toContain(`:root[data-theme="${name}"]`);
  });

  it("every themed token is registered for Tailwind in globals.css", () => {
    const tokens = [...themesCss.matchAll(/^\s+(--color-[a-z-]+):/gm)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(8);
    for (const t of new Set(tokens)) expect(globalsCss).toContain(`${t}:`);
  });

  it("has a no-attribute (signed-out) fallback and a dark OS rule", () => {
    expect(themesCss).toContain(":root:not([data-theme])");
    expect(themesCss).toContain("prefers-color-scheme: dark");
  });

  it("has a 2px focus ring and a reduced-motion baseline", () => {
    expect(globalsCss).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--color-focus\)/);
    expect(globalsCss).toContain("prefers-reduced-motion: reduce");
  });
});

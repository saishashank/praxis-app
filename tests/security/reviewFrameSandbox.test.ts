// M21 C1 (D-1203, F): the review frame loosens the sandbox to allow-same-origin only so the parent can measure it.
// Scripts must never be allowed in it, the stored HTML must carry no script, and the parent never renders stored
// HTML itself. (tests/security/displayText.test.ts forbids dangerouslySetInnerHTML across src/.)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|mjs)$/.test(n) ? [p] : [];
  });

describe("review frame sandbox (D-1203)", () => {
  it("no source file ever grants allow-scripts or another sandbox token beyond allow-same-origin", () => {
    for (const f of files(join(root, "src"))) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, ""); // comments may name the token
      expect(src, f).not.toMatch(/allow-scripts|allow-top-navigation|allow-popups|allow-forms/);
    }
  });
  it("the review page renders the stored HTML only through ReviewFrame, with no inline iframe", () => {
    const page = readFileSync(join(root, "src/app/(app)/reviews/[date]/page.tsx"), "utf8");
    expect(page).toContain("<ReviewFrame");
    expect(page).not.toMatch(/<iframe/);
    const frame = readFileSync(join(root, "src/app/(app)/reviews/[date]/ReviewFrame.tsx"), "utf8");
    expect(frame).toMatch(/sandbox="allow-same-origin"/);
    expect(frame).toMatch(/srcDoc=/);
  });
  it("the frame is srcdoc, so it inherits the app CSP: scripts stay blocked twice", () => {
    const csp = readFileSync(join(root, "src/lib/http/csp.ts"), "utf8");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-/);
  });
  it("the review-stored seed state carries no script, handler or javascript: URL", () => {
    const seed = readFileSync(join(root, "e2e/seed/states/review-stored.mjs"), "utf8");
    expect(seed).not.toMatch(/<script|\son\w+\s*=|javascript:|<iframe|<object|<embed/i);
  });
});

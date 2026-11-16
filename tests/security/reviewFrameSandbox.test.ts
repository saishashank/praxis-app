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

/** Comments may name a token. */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Why a source breaks the sandbox rule, or null. Every `sandbox=` value must be the literal "" or, in ReviewFrame
 * only, the literal "allow-same-origin"; no computed value, no setAttribute, no other `allow-` token anywhere.
 */
export function sandboxViolation(src: string, isReviewFrame: boolean): string | null {
  const code = strip(src);
  if (/setAttribute\(\s*["'`]sandbox/i.test(code)) return "sandbox set with setAttribute";
  for (const m of code.matchAll(/sandbox\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
    const v = m[1]!;
    const literal = /^(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})$/.exec(v);
    if (literal === null) return `computed sandbox value ${v}`;
    const token = literal[1] ?? literal[2] ?? literal[3] ?? literal[4] ?? "";
    if (token === "") continue;
    if (!(isReviewFrame && token === "allow-same-origin")) return `sandbox token ${token}`;
  }
  const rest = code.replace(
    /sandbox\s*=\s*(?:"allow-same-origin"|\{\s*"allow-same-origin"\s*\})/g,
    "",
  );
  if (/\ballow-[a-z-]+\b/.test(isReviewFrame ? rest : code))
    return "an allow- token outside the one literal";
  return null;
}

describe("review frame sandbox (D-1203)", () => {
  it("no source file grants any sandbox token beyond the literal allow-same-origin in ReviewFrame", () => {
    for (const f of files(join(root, "src"))) {
      const isFrame = f
        .replace(/\\/g, "/")
        .endsWith("src/app/(app)/reviews/[date]/ReviewFrame.tsx");
      expect(sandboxViolation(readFileSync(f, "utf8"), isFrame), f).toBeNull();
    }
  });
  it("the checker catches planted violations", () => {
    const ok = '<iframe sandbox="allow-same-origin" />';
    expect(sandboxViolation(ok, true)).toBeNull();
    expect(sandboxViolation(ok, false)).not.toBeNull(); // only ReviewFrame may carry it
    expect(sandboxViolation('<iframe sandbox="" />', false)).toBeNull();
    expect(
      sandboxViolation('<iframe sandbox="allow-same-origin allow-downloads" />', true),
    ).not.toBeNull();
    expect(sandboxViolation('<iframe sandbox="allow-scripts" />', true)).not.toBeNull();
    expect(sandboxViolation("<iframe sandbox={tokens} />", true)).not.toBeNull();
    expect(sandboxViolation("<iframe sandbox={`allow-same-origin ${x}`} />", true)).not.toBeNull();
    expect(sandboxViolation('el.setAttribute("sandbox", "allow-scripts");', true)).not.toBeNull();
    expect(sandboxViolation('const t = "allow-popups";', true)).not.toBeNull();
    expect(sandboxViolation("// allow-scripts is never granted\nconst x = 1;", true)).toBeNull();
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

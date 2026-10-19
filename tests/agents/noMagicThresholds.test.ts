// @vitest-environment node
// CI check for the ch.15 acceptance criterion "every numeric threshold used in code is a key"
// (docs/M4_design.md section 6 decision 10), as a grep-style test in the manner of
// tests/data/noReplaceWrites.test.ts. Every number in the agent rule code must come from
// src/lib/agents/params.ts (which reads src/lib/config/keys.ts). A numeric literal in an agent
// source file is refused unless it is one of the structural values (0, 1, -1, 2: counts, indexes,
// halving) or the line carries `// threshold-ok: <reason>` for a reviewed non-rule constant.
//
// Scope: the rule directories that exist today. schema.ts is table layout (column names and the
// retention floors of the 0008 triggers), not rule code, and is skipped. When src/lib/replay and
// src/lib/llm land (T10, T11, T14) they are scanned automatically; src/lib/stats has its own
// reviewed known-answer tests and is not scanned here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/lib/agents", "src/lib/replay", "src/lib/llm", "src/lib/learning"];
const SKIP_FILES = new Set(["schema.ts"]);
const ALLOWED = new Set(["0", "1", "-1", "2"]);
const MARKER = /\/\/\s*threshold-ok:\s*\S/;

/** Numeric literals in one line of code, with comments, strings and template text removed. */
function numericLiterals(line: string): string[] {
  const code = line
    .replace(/\/\/.*$/, "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  const out: string[] = [];
  // Digits that start a number: not part of an identifier (a1, f1_x) or a property (x.5).
  const re = /(?<![\w$.])(-?)(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|0x[0-9a-f]+)(n?)(?![\w$])/gi;
  for (const m of code.matchAll(re)) {
    const text = m[2].replace(/_/g, "");
    // `a - 1` is a subtraction: treat the sign as part of the number only after an operator or (.
    const before = code.slice(0, m.index).trimEnd();
    const negative = m[1] === "-" && (before === "" || /[(,=:?<>!&|+*/%[-]$/.test(before));
    out.push(negative ? `-${text}` : text);
  }
  return out;
}

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !SKIP_FILES.has(name)) out.push(full);
  }
  return out;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []))) {
    let inBlock = false;
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((raw, i) => {
        let line = raw;
        if (inBlock) {
          const end = line.indexOf("*/");
          if (end < 0) return;
          inBlock = false;
          line = line.slice(end + 2);
        }
        const open = line.indexOf("/*");
        if (open >= 0 && line.indexOf("*/", open) < 0) {
          inBlock = true;
          line = line.slice(0, open);
        }
        if (MARKER.test(raw)) return;
        const bad = numericLiterals(line).filter((n) => !ALLOWED.has(n));
        if (bad.length > 0) {
          found.push(`${path.relative(ROOT, file)}:${i + 1}: ${bad.join(", ")}`);
        }
      });
  }
  return found;
}

describe("every numeric threshold in the agent code is a config key", () => {
  it("the scanner finds literals and ignores comments, strings, identifiers and allowed values", () => {
    expect(numericLiterals("const x = a * 1.5;")).toEqual(["1.5"]);
    expect(numericLiterals("if (n >= 40) return 120n;")).toEqual(["40", "120"]);
    expect(numericLiterals("const m = 1_000_000n;")).toEqual(["1000000"]);
    expect(numericLiterals("x < -0.25 || y > 3e-2")).toEqual(["-0.25", "3e-2"]);
    expect(numericLiterals("const f1 = p.f1.timeStop; // 40 sessions")).toEqual([]);
    expect(numericLiterals('const s = "F1 40"; const t = `n=${n} 7`;')).toEqual([]);
    expect(numericLiterals("arr[0] + arr[1] - 1 === n - 2")).toEqual(["0", "1", "1", "2"]);
    expect(numericLiterals("const a = n - 7;")).toEqual(["7"]);
    expect(numericLiterals("const a = (-7);")).toEqual(["-7"]);
    expect(numericLiterals("ind_version2 = f3.x5")).toEqual([]);
  });

  it("flags a hard-coded threshold and accepts the marker (offender detection works)", () => {
    const flagged = ["if (close > sma * 1.5) buy();", "const days = 250;"];
    for (const l of flagged) {
      expect(numericLiterals(l).filter((n) => !ALLOWED.has(n)).length, l).toBeGreaterThan(0);
    }
    expect(MARKER.test("const c = 3; // threshold-ok: text width")).toBe(true);
    expect(MARKER.test("const c = 3; // threshold-ok:")).toBe(false);
    expect(MARKER.test("const c = 3;")).toBe(false);
  });

  it("no agent rule file contains an unreviewed numeric literal", () => {
    expect(offenders()).toEqual([]);
  });

  it("params.ts, the one file that turns keys into numbers, is scanned (and has its few marked constants)", () => {
    const files = walk(path.join(ROOT, "src/lib/agents"), []).map((f) => path.basename(f));
    expect(files).toContain("params.ts");
    expect(files).not.toContain("schema.ts");
    const text = readFileSync(path.join(ROOT, "src/lib/agents/params.ts"), "utf8");
    const marked = text.split("\n").filter((l) => MARKER.test(l));
    expect(marked.length).toBe(2);
  });
});

// @vitest-environment node
// Float ban for money paths (M3 design §2.1, decision 18). Money is bigint micro-AUD and exact
// rationals; a floating-point operation anywhere in src/lib/money or src/lib/arena is a bug.
//
// Heuristic (a line scanner, not an AST; deliberately strict):
//   1. Block comments, line comments and string/template literals are blanked first.
//   2. Flagged on the remaining code of each line:
//        parseFloat / Number.parseFloat, Number( ... ), .toFixed(, Math.<anything>,
//        decimal literals (1.5), exponent literals (1e6), and the `/` or `/=` operator.
//   3. `/` is allowed only in src/lib/money/rational.ts, which owns all bigint division
//      (divTrunc / divFloor / divCeil) and the only regular expressions; other files divide
//      through those helpers.
//   4. Escape hatch: a trailing `// money-float-ok: <reason>` on the same line.
// Known limits: `${a / b}` inside a template literal is blanked and not seen; regex literals
// outside rational.ts would be misread as division (so keep them in rational.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src/lib/money", "src/lib/arena"];
// M4 design 2.1: the batch 2b money paths are scanned file by file (the rest of src/lib/agents is
// the float indicator domain: Wilder, log-return volatility).
const SCAN_FILES = [
  "src/lib/agents/batch2b.ts",
  "src/lib/agents/candidates.ts",
  "src/lib/agents/controls.ts",
  "src/lib/agents/orderPlan.ts",
];
const DIVISION_ALLOWED_FILES = new Set(["src/lib/money/rational.ts"]);
const ESCAPE = /\/\/\s*money-float-ok:\s*\S/;

const RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "parseFloat", pattern: /\bparseFloat\b/ },
  { id: "Number(", pattern: /\bNumber\s*\(/ },
  { id: "toFixed(", pattern: /\.toFixed\s*\(/ },
  { id: "Math.", pattern: /\bMath\s*\./ },
  { id: "decimal literal", pattern: /(^|[^\w.])\d+\.\d+/ },
  { id: "exponent literal", pattern: /(^|[^\w.])\d+(\.\d+)?[eE][+-]?\d/ },
];
const DIVISION = /\//;

/** Blank comments and string/template literals, keeping line structure. Returns code per line. */
export function blankNonCode(source: string): string[] {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1).replace(/[^\n]/g, " ");
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.split("\n");
}

export function findViolations(relPath: string, source: string): string[] {
  const code = blankNonCode(source);
  const raw = source.split("\n");
  const divisionOk = DIVISION_ALLOWED_FILES.has(relPath);
  const found: string[] = [];
  code.forEach((line, i) => {
    if (ESCAPE.test(raw[i] ?? "")) return;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) found.push(`${relPath}:${i + 1} ${rule.id}`);
    }
    if (!divisionOk && DIVISION.test(line)) found.push(`${relPath}:${i + 1} division`);
  });
  return found;
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function scanned(): string[] {
  return [
    ...SCAN_DIRS.map((d) => path.join(ROOT, d))
      .filter((d) => existsSync(d))
      .flatMap((d) => walk(d, [])),
    ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter((f) => existsSync(f)),
  ];
}

describe("no floating-point money (D-069 decision 18)", () => {
  it("flags each forbidden construct", () => {
    const cases: Array<[string, string]> = [
      ["const a = parseFloat(x);", "parseFloat"],
      ["const a = Number(x);", "Number("],
      ["const a = x.toFixed(2);", "toFixed("],
      ["const a = Math.round(x);", "Math."],
      ["const a = Math.floor(x);", "Math."],
      ["const a = x * 0.5;", "decimal literal"],
      ["const a = 1e6;", "exponent literal"],
      ["const a = b / c;", "division"],
      ["a /= 2n;", "division"],
    ];
    for (const [src, rule] of cases) {
      expect(findViolations("src/lib/money/x.ts", src).join(), src).toContain(rule);
    }
  });

  it("ignores comments, strings, bigint code, Number.isSafeInteger and escapes", () => {
    const clean = [
      "// parseFloat(x) / 2 and Math.round are mentioned here",
      "/* block: Number(x).toFixed(2) \n 1.5 / 2 */",
      'const msg = "a / b, 1.5, Math.round, Number(";',
      "const t = `x / y`;",
      "const ok = Number.isSafeInteger(n) && 10n ** 6n > 1_000_000n;",
      "const v = Number(big); // money-float-ok: share count display only",
      "const q = a % b;",
    ].join("\n");
    expect(findViolations("src/lib/money/x.ts", clean)).toEqual([]);
  });

  it("allows division only in rational.ts", () => {
    expect(findViolations("src/lib/money/rational.ts", "const q = a / b;")).toEqual([]);
    expect(findViolations("src/lib/money/round.ts", "const q = a / b;")).not.toEqual([]);
  });

  it("handles an unterminated block comment and an escaped quote", () => {
    expect(findViolations("src/lib/money/x.ts", 'const s = "a\\"/"; /* open')).toEqual([]);
    expect(findViolations("src/lib/money/x.ts", "const s = 'x")).toEqual([]);
  });

  it("scans the money library", () => {
    const files = scanned().map((f) => path.relative(ROOT, f).replaceAll("\\", "/"));
    expect(files).toEqual(
      expect.arrayContaining([
        "src/lib/money/micro.ts",
        "src/lib/money/rational.ts",
        "src/lib/money/round.ts",
        "src/lib/money/tick.ts",
      ]),
    );
  });

  it("no floating-point operation on money in src/lib/money or src/lib/arena", () => {
    const offenders = scanned().flatMap((file) =>
      findViolations(path.relative(ROOT, file).replaceAll("\\", "/"), readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

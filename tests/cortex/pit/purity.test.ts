// @vitest-environment node
// D-279: the Cortex core is pure (docs/M15_design.md 3a "Fixed rules"). A static scan of every
// source file under src/lib/cortex/{pit,angles,score,economics,gates,states} and night.ts: no
// database, file-system, network or clock module import, no `new Date()` without an argument, no
// Date.now and no Math.random. Packages that do not exist yet are skipped; once a builder adds one,
// it is scanned without any change here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../src/lib/cortex");
const PACKAGES = ["pit", "angles", "score", "economics", "gates", "states"];
const SINGLE_FILES = ["night.ts"];

const FORBIDDEN_IMPORTS = [
  "@libsql/client",
  "@/lib/db",
  "node:fs",
  "node:net",
  "node:http",
  "node:https",
  "node:child_process",
  "node:dns",
  "node:worker_threads",
  "server-only",
];

const FORBIDDEN_CALLS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "Date.now", re: /\bDate\.now\s*\(/ },
  { name: "new Date() without an argument", re: /\bnew\s+Date\s*\(\s*\)/ },
  { name: "Math.random", re: /\bMath\.random\s*\(/ },
  { name: "fetch(", re: /\bfetch\s*\(/ },
  { name: "process.env", re: /\bprocess\.env\b/ },
  { name: "performance.now", re: /\bperformance\.now\s*\(/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|mts)$/.test(name) && !/\.test\./.test(name) && !/\.d\.m?ts$/.test(name))
      out.push(p);
  }
  return out;
}

function coreFiles(): string[] {
  const files: string[] = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(ROOT, pkg);
    if (existsSync(dir)) files.push(...sourceFiles(dir));
  }
  for (const f of SINGLE_FILES) {
    const p = path.join(ROOT, f);
    if (existsSync(p)) files.push(p);
  }
  return files.sort();
}

/** Import specifiers of a file: static `import ... from "x"`, `import "x"`, `export ... from "x"` and `import("x")`. */
function importsOf(text: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]!);
  return out;
}

describe("D-279 Cortex core purity", () => {
  const files = coreFiles();

  it("scans the C1a packages at least", () => {
    expect(files.some((f) => f.includes(`${path.sep}pit${path.sep}`))).toBe(true);
    expect(files.some((f) => f.includes(`${path.sep}angles${path.sep}`))).toBe(true);
  });

  it("imports no database, file-system, network or clock module", () => {
    const findings: string[] = [];
    for (const f of files) {
      for (const spec of importsOf(readFileSync(f, "utf8"))) {
        if (FORBIDDEN_IMPORTS.some((bad) => spec === bad || spec.startsWith(`${bad}/`)))
          findings.push(`${path.relative(ROOT, f)} imports ${spec}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("calls no clock, random source or network function", () => {
    const findings: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const { name, re } of FORBIDDEN_CALLS) {
        if (re.test(text)) findings.push(`${path.relative(ROOT, f)} uses ${name}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("the import matcher reads the forms the repo uses", () => {
    const sample = `import { a } from "@/lib/x";\nimport type { B } from "./y";\nimport "side";\nexport * from "./z";\nconst m = await import("dyn");\n`;
    expect(importsOf(sample)).toEqual(["@/lib/x", "./y", "side", "./z", "dyn"]);
  });
});

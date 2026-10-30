// @vitest-environment node
// D-279 / D-306: the Cortex core is pure (docs/M15_design.md 3a "Fixed rules"). A static scan of
// every source file under src/lib/cortex/{pit,angles,score,economics,gates,states} and night.ts
// AND of the transitive closure of their value imports through src/ (`@/` and relative specifiers;
// `import type` / `export type` statements are erased at build time and are not followed): no
// database, file-system, network or clock module import, no `new Date()` without an argument, no
// Date.now and no Math.random in the core files themselves. Packages that do not exist yet are
// skipped; once a builder adds one, it is scanned without any change here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../../src");
const ROOT = path.join(SRC, "lib", "cortex");
const PACKAGES = ["pit", "angles", "score", "economics", "gates", "states"];
const SINGLE_FILES = ["night.ts"];

const FORBIDDEN_IMPORTS = [
  "@libsql/client",
  "@/lib/db",
  "@/lib/db/client",
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

export type ImportRef = { readonly spec: string; readonly typeOnly: boolean };

/**
 * Import specifiers of a file with whether the statement is type-only: static `import ... from`,
 * `import "x"`, `export ... from`, dynamic `import("x")` and `require("x")`. A statement whose
 * every binding is `type`-qualified (`import { type A, type B } from`) also counts as type-only.
 */
export function importsOf(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const stmt =
    /(?:^|\n)[ \t]*((?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["'])|(?:^|\n)[ \t]*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(stmt)) {
    if (m[1] !== undefined) {
      const head = m[1];
      const typeStmt = /^(?:import|export)\s+type\b/.test(head);
      const bindings = /\{([^}]*)\}/.exec(head)?.[1];
      const allTyped =
        bindings !== undefined &&
        !/\*\s+as\b/.test(head) &&
        !/^(?:import|export)\s+\w+\s*,/.test(head) &&
        bindings
          .split(",")
          .map((b) => b.trim())
          .filter((b) => b.length > 0)
          .every((b) => /^type\s/.test(b));
      out.push({ spec: m[2]!, typeOnly: typeStmt || allTyped });
    } else out.push({ spec: (m[3] ?? m[4] ?? m[5])!, typeOnly: false });
  }
  return out;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.mts"];

/** Resolves a `@/` or relative specifier to a file under src/; null for a package or a miss. */
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const ext of EXTENSIONS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function isForbidden(spec: string): boolean {
  return FORBIDDEN_IMPORTS.some((bad) => spec === bad || spec.startsWith(`${bad}/`));
}

/** The files the last `closureFindings` walk visited (core files plus their value-import closure). */
const visitedFiles = new Set<string>();

/** Walks value imports from the core files through src/; returns findings "file -> ... imports spec". */
function closureFindings(roots: readonly string[]): string[] {
  const findings: string[] = [];
  const seen = visitedFiles;
  seen.clear();
  const queue: { file: string; chain: string[] }[] = roots.map((f) => ({ file: f, chain: [] }));
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const here = [...chain, path.relative(SRC, file)];
    for (const ref of importsOf(readFileSync(file, "utf8"))) {
      if (ref.typeOnly) continue;
      if (isForbidden(ref.spec)) findings.push(`${here.join(" -> ")} imports ${ref.spec}`);
      const next = resolveSpec(file, ref.spec);
      if (next !== null && !seen.has(next)) queue.push({ file: next, chain: here });
    }
  }
  return findings;
}

describe("D-279 / D-306 Cortex core purity", () => {
  const files = coreFiles();

  it("scans the C1a packages at least", () => {
    expect(files.some((f) => f.includes(`${path.sep}pit${path.sep}`))).toBe(true);
    expect(files.some((f) => f.includes(`${path.sep}angles${path.sep}`))).toBe(true);
  });

  it("neither the core nor its transitive value imports reach a database, file-system, network or clock module", () => {
    expect(closureFindings(files)).toEqual([]);
    // The walk really follows the value imports: candidates.ts (adjustBars) and regime.ts are reached.
    expect(visitedFiles.size).toBeGreaterThan(files.length + 10);
    expect([...visitedFiles].some((f) => f.endsWith(path.join("agents", "candidates.ts")))).toBe(
      true,
    );
    expect([...visitedFiles].some((f) => f.endsWith(path.join("agents", "regime.ts")))).toBe(true);
  });

  it("the core calls no clock, random source or network function", () => {
    const findings: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const { name, re } of FORBIDDEN_CALLS) {
        if (re.test(text)) findings.push(`${path.relative(ROOT, f)} uses ${name}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("the import matcher reads the forms the repo uses and tells type-only statements apart", () => {
    const sample = [
      `import { a } from "@/lib/x";`,
      `import type { B } from "./y";`,
      `import { type C, type D } from "./z";`,
      `import { type E, f } from "./w";`,
      `import "side";`,
      `export * from "./re";`,
      `export type { G } from "./t";`,
      `const m = await import("dyn");`,
      `import * as ns from "./ns";`,
    ].join("\n");
    expect(importsOf(sample)).toEqual([
      { spec: "@/lib/x", typeOnly: false },
      { spec: "./y", typeOnly: true },
      { spec: "./z", typeOnly: true },
      { spec: "./w", typeOnly: false },
      { spec: "side", typeOnly: false },
      { spec: "./re", typeOnly: false },
      { spec: "./t", typeOnly: true },
      { spec: "dyn", typeOnly: false },
      { spec: "./ns", typeOnly: false },
    ]);
  });

  it("the walker catches a forbidden module two hops away and ignores a type-only hop", () => {
    // A mock file system is not needed: a real pit file imports candidates.ts, which imports
    // `@libsql/client` as a type only; the closure check above passes because of that distinction.
    const candidates = path.join(SRC, "lib", "agents", "candidates.ts");
    const refs = importsOf(readFileSync(candidates, "utf8"));
    expect(refs.some((r) => r.spec === "@libsql/client" && r.typeOnly)).toBe(true);
    expect(refs.some((r) => r.spec === "@libsql/client" && !r.typeOnly)).toBe(false);
  });
});

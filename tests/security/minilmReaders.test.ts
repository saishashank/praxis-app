// @vitest-environment node
// M22 L5 (LLM-079, D-1414, D-1416; PRD-033): the small reader's shadow is an opinion that nothing reads.
//  (i)   `minilm_shadow` is named only by the stage that writes it and the System Health line that shows its agreement;
//  (ii)  nothing under src outside the folder, the health line and the config guard imports the folder, so no filter, breaker,
//        alert, arena, pick or Cortex module can reach it;
//  (iii) the folder itself imports none of those decision modules (its one rule-classifier import is the pure `events` file);
//  (iv)  the runtime package is named in one file of the folder only, and never by a static import.
// The list is exact: a new reader fails here until it is added with a reason.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");

const SKIP = new Set(["node_modules", ".next", ".git", "tests", "docs", "coverage", "out"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith("wt-") || e.name.startsWith(".")) continue;
      walk(rel, out);
    } else if (/\.(ts|tsx|mjs|js|cjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const code = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/\s.*$/, ""))
    .join("\n");

const files = walk("");
const sources = new Map(files.map((f) => [f, code(fs.readFileSync(path.join(ROOT, f), "utf8"))]));
const FOLDER = "src/lib/llm/minilm/";
const inFolder = (f: string) => f.startsWith(FOLDER);

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const specs = (src: string): string[] =>
  [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]).filter((s): s is string => !!s);
const resolve = (file: string, spec: string): string =>
  spec.startsWith("@/")
    ? `src/${spec.slice(2)}`
    : spec.startsWith(".")
      ? posix(path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), spec)))
      : spec;

/** The files that may name the table, with why. */
const TABLE_READERS: Readonly<Record<string, string>> = {
  "scripts/db/gen-market-guard.mjs":
    "not a reader: the market-guard trigger generator lists the market-keyed tables and reads no row",
  "src/lib/llm/minilm/shadow.ts": "the stage: writes the rows and computes the night's agreement",
  "src/lib/health/minilm.ts": "System Health: the newest night's agreement, read-only, plain words",
};
/** The files outside the folder that may import it, with why. */
const IMPORTERS: Readonly<Record<string, string>> = {
  "src/lib/health/minilm.ts": "System Health line (agreement, readiness)",
  "src/lib/config/guards/minilm.ts": "the switch guard (readiness of the committed head and lock)",
};

describe("minilm_shadow readers (D-1416)", () => {
  it("scans real code (not vacuous)", () => {
    expect(files.filter((f) => f.startsWith("src/")).length).toBeGreaterThan(500);
    expect(sources.get("src/lib/llm/minilm/shadow.ts")).toMatch(/minilm_shadow/);
  });

  it("(i) only the stage, the health line and the trigger generator name the table", () => {
    const hits = files.filter((f) => /\bminilm_shadow\b/.test(sources.get(f)!)).sort();
    expect(hits).toEqual(Object.keys(TABLE_READERS).sort());
  });

  it("(ii) no other src module imports the folder", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (!f.startsWith("src/") || inFolder(f)) continue;
      for (const s of specs(sources.get(f)!)) {
        const r = resolve(f, s);
        if ((r === "src/lib/llm/minilm" || r.startsWith(FOLDER)) && !(f in IMPORTERS))
          bad.push(`${f} imports ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("(ii) each listed importer still imports the folder", () => {
    for (const f of Object.keys(IMPORTERS))
      expect(
        specs(sources.get(f)!).some((s) => resolve(f, s).startsWith(FOLDER)),
        f,
      ).toBe(true);
  });

  it("(iii) the folder imports no decision, alert, filter, arena, pick, learning or Cortex module", () => {
    const FORBIDDEN =
      /^src\/lib\/(arena|cortex|learning|picks|alerts|sentinel|steelman|committee|breaker|golive|intraday|replay|stats)(\/|$)|^src\/lib\/agents\/(?!events$)/;
    const bad: string[] = [];
    for (const f of files.filter(inFolder))
      for (const s of specs(sources.get(f)!)) {
        const r = resolve(f, s);
        if (FORBIDDEN.test(r)) bad.push(`${f} imports ${s}`);
      }
    expect(bad).toEqual([]);
  });

  it("(iv) the runtime package is named only in model.ts and never statically imported", () => {
    const named = files
      .filter((f) => f.startsWith("src/") && /onnxruntime-node/.test(sources.get(f)!))
      .sort();
    expect(named).toEqual(["src/lib/llm/minilm/model.ts"]);
    for (const f of files) {
      if (!f.startsWith("src/")) continue;
      expect(
        specs(sources.get(f)!).filter((s) => s.startsWith("onnxruntime")),
        f,
      ).toEqual([]);
    }
  });

  it("the guard catches an import (self-test)", () => {
    const sample = 'import { shadowNight } from "@/lib/llm/minilm/shadow";';
    expect(specs(sample).map((s) => resolve("src/lib/arena/x.ts", s))).toEqual([
      "src/lib/llm/minilm/shadow",
    ]);
  });
});

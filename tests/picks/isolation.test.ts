// @vitest-environment node
// Picks are never read by ranking or sizing (M6 design 4.10, decision 37; AGT-112 "descriptive,
// never read by ranking"; ARN-095 "separately from the 12 Strategies"). Grep-style guards in the
// manner of tests/agents/noMagicThresholds.test.ts:
//   1. no module outside src/lib/picks, the review and the pages imports from src/lib/picks;
//      in particular no ranking, sizing, arena, replay, learning or statistics module does;
//   2. none of those modules reads or writes the `pick` / `pick_outcome` tables;
//   3. src/lib/picks writes only to its own two tables;
//   4. every numeric literal in src/lib/picks is structural or carries a `threshold-ok` reason
//      (every threshold comes from AgentParams / the registry).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string): string => path.relative(ROOT, f).split(path.sep).join("/");
const codeRoots = ["src", "worker", "scripts"].map((d) => path.join(ROOT, d));
const allCode = codeRoots.flatMap((d) => walk(d));

const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;

/** Files whose imports point into src/lib/picks (alias or relative). */
function importersOfPicks(): string[] {
  const found = new Set<string>();
  for (const file of allCode) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1]!;
      let target: string | null = null;
      if (spec.startsWith("@/")) target = path.join(ROOT, "src", spec.slice(2));
      else if (spec.startsWith(".")) target = path.resolve(path.dirname(file), spec);
      if (target !== null && /[\\/]src[\\/]lib[\\/]picks([\\/]|$)/.test(target)) {
        found.add(rel(file));
      }
    }
  }
  return [...found].sort();
}

/** The ranking, sizing and learning side: nothing here may know picks exist. */
const TRADING_DIRS = [
  "src/lib/agents",
  "src/lib/arena",
  "src/lib/learning",
  "src/lib/replay",
  "src/lib/stats",
  "src/lib/money",
  "src/lib/config",
  "src/lib/llm",
  "src/lib/data",
  "worker",
  "scripts",
];
const inTrading = (f: string): boolean => TRADING_DIRS.some((d) => rel(f).startsWith(`${d}/`));

describe("picks are never read by ranking or sizing", () => {
  it("is imported only by the review sections and by pages", () => {
    const importers = importersOfPicks().filter((f) => !f.startsWith("src/lib/picks/"));
    const allowed = (f: string): boolean =>
      f === "src/lib/review/sections.ts" ||
      f === "src/lib/ui/loaders/picks.ts" || // the page data loader for the picks pages (M7 T8)
      // M17 WP9 (D-462, D-464): the alert-stream measurement reads the total-return benchmark and
      // the stream cost helper; it ranks and sizes nothing and is outside the trading folders.
      f === "src/lib/intraday/measure.ts" ||
      f === "src/lib/intraday/evaluator.ts" ||
      // M11-lite WP3 (AGT-131, D-499): the steelman evidence pack reads the stored factor rows; its
      // output is an opinion only and never reaches ranking or sizing (PRD-033 boundary test).
      f === "src/lib/steelman/pack.ts" ||
      // M13-lite WP7 (KB-080, D-524, D-640): the paper tracker for expert calls reads the total-return
      // benchmark and the window helper so a call is set against the market on the same basis as a pick;
      // it writes only expert_call_outcome, never a pick, order or rank (PRD-035 boundary test).
      f === "src/lib/experts/calls.ts" ||
      f.startsWith("src/app/");
    expect(importers.filter((f) => !allowed(f))).toEqual([]);
    // and the review import exists, so this guard is not vacuous
    expect(importers).toContain("src/lib/review/sections.ts");
  });

  it("is imported by no ranking, sizing, arena, replay, learning, statistics, config or worker module", () => {
    const bad = importersOfPicks().filter((f) => inTrading(path.join(ROOT, f)));
    expect(bad).toEqual([]);
    expect(allCode.filter(inTrading).length).toBeGreaterThan(50); // the scan really looked
  });

  it("D-181: only the nightly orchestrator names the picks entry, by path, to start it", () => {
    // scripts/arena/signals.mjs bundles src/lib/picks/cli.ts after the night and gets back only an
    // exit code; no other trading file may even mention the picks folder.
    const bad = allCode
      .filter(inTrading)
      .filter((f) => /["'`]src\/lib\/picks/.test(readFileSync(f, "utf8"))) // quoted, not a comment
      .map(rel);
    expect(bad).toEqual(["scripts/arena/signals.mjs"]);
    const text = readFileSync(path.join(ROOT, "scripts/arena/signals.mjs"), "utf8");
    expect(text).toContain('const PICKS_ENTRY = "src/lib/picks/cli.ts";');
  });

  it("reads and writes the pick tables from no trading module", () => {
    const re = /\b(?:FROM|JOIN|INTO|UPDATE)\s+pick(?:_outcome)?\b/i;
    const bad = allCode
      .filter(inTrading)
      .filter((f) => re.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it("writes only to its own four tables (pick_check: D-187; pick_market: M11-lite ARN-103)", () => {
    const re = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;
    const targets = new Set<string>();
    for (const file of walk(path.join(ROOT, "src/lib/picks"))) {
      for (const m of readFileSync(file, "utf8").matchAll(re)) targets.add(m[1]!.toLowerCase());
    }
    expect([...targets].sort()).toEqual(["pick", "pick_check", "pick_market", "pick_outcome"]);
  });
});

describe("every picks threshold comes from AgentParams or is marked", () => {
  const ALLOWED = new Set(["0", "1", "-1", "2"]);
  const MARKER = /\/\/\s*threshold-ok:\s*\S/;

  function numericLiterals(line: string): string[] {
    const code = line
      .replace(/\/\/.*$/, "")
      .replace(/\/\*.*?\*\//g, "")
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/g, "//");
    const out: string[] = [];
    const re = /(?<![\w$.])(-?)(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|0x[0-9a-f]+)(n?)(?![\w$])/gi;
    for (const m of code.matchAll(re)) {
      const text = m[2]!.replace(/_/g, "");
      const before = code.slice(0, m.index).trimEnd();
      const negative = m[1] === "-" && (before === "" || /[(,=:?<>!&|+*/%[-]$/.test(before));
      out.push(negative ? `-${text}` : text);
    }
    return out;
  }

  it("has no unexplained numeric literal in src/lib/picks", () => {
    const found: string[] = [];
    for (const file of walk(path.join(ROOT, "src/lib/picks"))) {
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
          if (bad.length > 0) found.push(`${rel(file)}:${i + 1}: ${bad.join(", ")}`);
        });
    }
    expect(found).toEqual([]);
  });
});

// CTX-003 / CTX-041: text labels and opinions are never an L2 input. No module of the pure Cortex
// core imports or queries text_label, label_validation or opinion_track (or the labels store / the
// textLabels organ).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "src", "lib", "cortex");
const DIRS = ["pit", "angles", "score", "economics", "gates", "states"];
// Imports of the label/opinion modules and SQL that reads or writes the tables. Registry metadata
// strings that merely name a source (angle "existing" lists) are not accesses.
const FORBIDDEN = [
  /\bfrom\s+["'][^"']*(store\/labels|llm\/textLabels|llm\/labels)["']/,
  /\b(from|join|into|update)\s+(text_label|label_validation|opinion_track)\b/i,
  /\bOpinionRow\b/,
];

/** Comments may name the tables (they say the core must not read them); code and strings may not. */
const stripComments = (t: string): string =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no opinion or label reads in the L2 core", () => {
  const targets = [
    ...DIRS.filter((d) => existsSync(join(ROOT, d))).flatMap((d) => files(join(ROOT, d))),
    ...(existsSync(join(ROOT, "night.ts")) ? [join(ROOT, "night.ts")] : []),
  ];
  it("scans a non-empty set of modules", () => {
    expect(targets.length).toBeGreaterThan(5);
  });
  for (const f of targets) {
    it(`${f.slice(ROOT.length + 1).replace(/\\/g, "/")} has no label or opinion access`, () => {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const re of FORBIDDEN) expect(src, String(re)).not.toMatch(re);
    });
  }
});

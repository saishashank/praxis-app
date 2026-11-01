// CTX-003 / CTX-041: text labels and opinions are never an L2 input. No module of the pure Cortex
// core imports or queries text_label, label_validation or opinion_track (or the labels store / the
// textLabels organ). M11-lite D-494 / PRD-033 extends it to the modules that decide, size, place or learn
// (arena, agents, learning, picks): none imports src/lib/steelman or the label modules, nor names the
// opinion or steelman tables in SQL (pick_market is deterministic data and is allowed).
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

const EXTRA_DIRS = ["arena", "agents", "learning", "picks"];
const EXTRA_TABLES =
  "(opinion_track|steelman_pack|steelman_point|steelman_night|steelman_suggestion|pick_reflection)";
const FORBIDDEN_EXTRA = [
  /\bfrom\s+["'][^"']*(steelman\/|store\/labels|llm\/textLabels|llm\/labels)[^"']*["']/,
  /\bimport\(\s*["'][^"']*steelman\/[^"']*["']\s*\)/,
  new RegExp(`\\b${EXTRA_TABLES}\\b`),
  /\bOpinionRow\b/,
];
// D-587: the modules that decide, size, place or pick may not name the label tables either (a text
// label is an LLM output, CTX-003); learning reads labels legitimately (KB-050) and is left out here.
const LABEL_DIRS = ["arena", "agents", "picks"];
const FORBIDDEN_LABELS = /\b(text_label|label_validation)\b/;
const SRC = join(__dirname, "..", "..", "..", "src", "lib");

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

describe("no steelman, opinion or label reads in the trading and learning modules (D-494)", () => {
  const targets = EXTRA_DIRS.filter((d) => existsSync(join(SRC, d))).flatMap((d) =>
    files(join(SRC, d)),
  );
  it("scans a non-empty set of modules", () => {
    expect(targets.length).toBeGreaterThan(20);
  });
  it("the patterns catch a steelman import and a table name (self-test)", () => {
    const bad = [
      'import { x } from "@/lib/steelman/store";',
      "SELECT * FROM opinion_track",
      'const t = "steelman_point";',
      'import { l } from "@/lib/store/labels";',
    ];
    for (const b of bad)
      expect(
        FORBIDDEN_EXTRA.some((re) => re.test(b)),
        b,
      ).toBe(true);
    expect(FORBIDDEN_EXTRA.some((re) => re.test("INSERT INTO pick_market (a) VALUES (1)"))).toBe(
      false,
    );
  });
  for (const f of targets) {
    it(`${f.slice(SRC.length + 1).replace(/\\/g, "/")} has no steelman or opinion access`, () => {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const re of FORBIDDEN_EXTRA) expect(src, String(re)).not.toMatch(re);
    });
  }
});

describe("no label table reads in the trading and pick modules (D-587)", () => {
  const targets = LABEL_DIRS.filter((d) => existsSync(join(SRC, d))).flatMap((d) =>
    files(join(SRC, d)),
  );
  it("scans a non-empty set of modules", () => {
    expect(targets.length).toBeGreaterThan(20);
  });
  it("the pattern catches a label table name (self-test)", () => {
    expect(FORBIDDEN_LABELS.test("SELECT label FROM text_label WHERE code = ?")).toBe(true);
    expect(FORBIDDEN_LABELS.test("SELECT * FROM label_validation")).toBe(true);
    expect(FORBIDDEN_LABELS.test("SELECT label FROM pick WHERE code = ?")).toBe(false);
  });
  for (const f of targets) {
    it(`${f.slice(SRC.length + 1).replace(/\\/g, "/")} names no label table`, () => {
      expect(stripComments(readFileSync(f, "utf8"))).not.toMatch(FORBIDDEN_LABELS);
    });
  }
});

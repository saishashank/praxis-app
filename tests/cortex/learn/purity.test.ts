// @vitest-environment node
// D-923 (design C.8): the learning Cortex's core files are pure — no database, file, network or clock,
// no randomness. Only store.ts and stage.ts touch the database.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(__dirname, "../../../src/lib/cortex/learn");
const PURE = [
  "scorecard.ts",
  "words.ts",
  "duel.ts",
  "learner.ts",
  "learnWords.ts",
  "checkpoint.ts",
  "compare.ts",
  "reweight.ts",
];
const BAD = [
  /from\s+["']@libsql\/client["']/,
  /from\s+["']@\/lib\/db/,
  /from\s+["']node:/,
  /from\s+["']\.\/(store|stage)["']/,
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(\s*\)/,
  /\bMath\.random\s*\(/,
  /\bprocess\.env\b/,
  /\bfetch\s*\(/,
];

describe("learning Cortex purity", () => {
  for (const f of PURE) {
    it(`${f} reads no database, clock or randomness`, () => {
      const text = readFileSync(path.join(DIR, f), "utf8");
      for (const re of BAD) expect(re.test(text), `${f}: ${re}`).toBe(false);
    });
  }
});

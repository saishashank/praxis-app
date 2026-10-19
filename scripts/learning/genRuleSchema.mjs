// Generates docs/rule_schema.md from src/lib/agents/families/ruleSchema.ts (KB-010 s13: the
// published enumeration of the allowed rule fields; M6 T2).
//   node scripts/learning/genRuleSchema.mjs            writes docs/rule_schema.md
//   node scripts/learning/genRuleSchema.mjs --check    exits 1 when the file is stale
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleSchema } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DOC_PATH = path.join(ROOT, "docs", "rule_schema.md");

/** @param {string[]} argv */
export async function run(argv) {
  const { renderRuleSchemaDoc } = await loadRuleSchema();
  const text = renderRuleSchemaDoc();
  if (argv.includes("--check")) {
    const current = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, "utf8") : null;
    if (current === null || current.replace(/\r\n/g, "\n") !== text) {
      console.error("docs/rule_schema.md is stale: run node scripts/learning/genRuleSchema.mjs");
      return 1;
    }
    console.log("docs/rule_schema.md is up to date");
    return 0;
  }
  writeFileSync(DOC_PATH, text);
  console.log("wrote docs/rule_schema.md");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2)));
}

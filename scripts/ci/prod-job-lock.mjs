// M8 T9 (decision 30): the production job of every pipeline workflow is LOCKED. A stored copy of its
// exact text lives in scripts/ci/fixtures/prod-jobs/<workflow>.yml and the workflow tests compare
// the live text to it, so adding a `staging` job (or anything else) can never change production
// silently. A deliberate production change must update the stored copy in the same reviewed commit.
//   node scripts/ci/prod-job-lock.mjs --write   (re-stores every copy from the workflows; Owner/Opus review only)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const LOCKED_WORKFLOWS = Object.freeze([
  "ingest-batch1",
  "arena-signals",
  "arena-close",
  "backup",
  "maintenance",
  "watchdog",
  "replay",
  "kb-archive",
  "llm-bakeoff",
  "backfill-history",
  "backfill-prices",
]);

/**
 * The exact text of a top-level job (from its `  name:` line to just before the next line indented
 * two spaces or less), without trailing blank lines, LF line endings.
 * @param {string} workflowText @param {string} job
 */
export function extractJobBlock(workflowText, job) {
  const lines = workflowText.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) throw new Error(`job ${job} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > start && lines[end - 1].trim() === "") end--;
  return `${lines.slice(start, end).join("\n")}\n`;
}

export const lockPath = (name) => path.join(root, "scripts/ci/fixtures/prod-jobs", `${name}.yml`);
export const workflowPath = (name) => path.join(root, ".github/workflows", `${name}.yml`);

export const readLocked = (name) => readFileSync(lockPath(name), "utf8").replace(/\r\n/g, "\n");
export const readProduction = (name) =>
  extractJobBlock(readFileSync(workflowPath(name), "utf8"), "production");

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  for (const n of LOCKED_WORKFLOWS) {
    writeFileSync(lockPath(n), readProduction(n));
    console.log(`prod-job-lock: stored ${n}`);
  }
}

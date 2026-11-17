// Bake-off index generator (M22 L1, LLM-077, D-1403, D-1404): reads every report under docs/test-reports/ that starts
// with the bake-off heading and writes src/lib/llm/bakeoffIndex.generated.ts: per role the NEWEST report that covers it,
// with its verdict and the models that passed. The live factory reads only that file (src/lib/llm/factory.ts), so a role
// goes live only on a recorded PASS, and a later FAIL withdraws an earlier PASS (no report may be deleted to change it).
//   node scripts/llm/bakeoff-index.mjs --write   rewrite the generated module
//   node scripts/llm/bakeoff-index.mjs --check   exit 1 when the module is not what a fresh scan writes
// Two report formats (D-1404): the M22 format has a "## Role verdicts" table (| Role | Model | Result |); the earlier
// format has per-model category tables, read here under the role mapping below (a role passes for a model when every
// check of its categories and of the injection category is ok and its trains-on-prompts value is "no" and dated).
// Fail closed: a bake-off report with no valid Date or Run line stops the generator (exit 1) rather than being skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
export const OUT = "src/lib/llm/bakeoffIndex.generated.ts";
export const REPORT_DIR = "docs/test-reports";
export const HEADING = "# LLM bake-off report";

/** The roles a verdict is kept for; R3 and R5 are gated by "words" (D-1402). */
export const GATE_ROLES = ["R1", "R2", "R6", "R7", "words"];
/** Categories that must all pass for a role (D-1404); every role also needs the injection category. */
export const ROLE_CATEGORIES = {
  R1: ["triage", "classifier"],
  R2: ["faithfulness", "json_validity", "refusal"],
  R6: ["steelman"],
  R7: ["committee_judge"],
  words: ["words"],
};
const INJECTION = "injection";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const cellsOf = (line) =>
  line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());

/**
 * @param {string} text report markdown
 * @returns {{ run: string | null, date: string | null,
 *             table: { role: string, model: string, result: string }[] | null,
 *             sections: Map<string, { trains: boolean, rows: { category: string, check: string }[] }> } | null}
 */
export function parseReport(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (!(lines[0] ?? "").startsWith(HEADING)) return null;
  const grab = (label) => {
    const l = lines.find((x) => x.startsWith(`- ${label}:`));
    return l === undefined ? null : l.slice(label.length + 3).trim();
  };
  /** @type {{ role: string, model: string, result: string }[] | null} */
  let table = null;
  const sections = new Map();
  let heading = null;
  for (const l of lines) {
    if (l.startsWith("## ")) {
      heading = l.slice(3).trim();
      if (heading === "Role verdicts") table = [];
      else if (heading !== "Summary") sections.set(heading, { trains: false, rows: [] });
      continue;
    }
    if (heading === null) continue;
    if (heading === "Role verdicts") {
      if (!l.startsWith("|")) continue;
      const c = cellsOf(l);
      if (c.length >= 3 && (c[2] === "PASS" || c[2] === "FAIL"))
        table?.push({ role: c[0], model: c[1], result: c[2] });
      continue;
    }
    const s = sections.get(heading);
    if (!s) continue;
    if (/^- trains_on_prompts: no; checked \d{4}-\d{2}-\d{2}\s*$/.test(l)) s.trains = true;
    if (l.startsWith("|")) {
      const c = cellsOf(l);
      if (c.length >= 6 && (c[5] === "ok" || c[5] === "FAIL"))
        s.rows.push({ category: c[0], check: c[5] });
    }
  }
  return { run: grab("Run"), date: grab("Date"), table, sections };
}

/** Does this model's section pass the role (D-1404)? Every required category present and ok, trains "no" and dated. */
function sectionPasses(section, role) {
  if (!section.trains) return false;
  for (const cat of [...ROLE_CATEGORIES[role], INJECTION]) {
    const rows = section.rows.filter((r) => r.category === cat);
    if (rows.length === 0 || rows.some((r) => r.check !== "ok")) return false;
  }
  return true;
}

function sectionCovers(section, role) {
  return [...ROLE_CATEGORIES[role], INJECTION].every((cat) =>
    section.rows.some((r) => r.category === cat),
  );
}

/**
 * Per role this report covers: the passing models (possibly none). A role is covered by the Role verdicts table when
 * the table names it, otherwise when some model section has every category the role needs (D-1404).
 * @returns {Record<string, string[]>}
 */
export function roleResults(report) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const role of GATE_ROLES) {
    if (report.table !== null) {
      const rows = report.table.filter((r) => r.role === role);
      if (rows.length === 0) continue;
      out[role] = rows
        .filter((r) => r.result === "PASS")
        .filter((r) => {
          const s = report.sections.get(r.model);
          return s === undefined || s.trains; // a section that says "yes" or "not dated" overrides the table
        })
        .map((r) => r.model);
    } else {
      const covered = [...report.sections].filter(([, s]) => sectionCovers(s, role));
      if (covered.length === 0) continue;
      out[role] = covered.filter(([, s]) => sectionPasses(s, role)).map(([m]) => m);
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

/**
 * The index: per role the newest covering report (date, then run id, then a FAIL before a PASS, then file name).
 * @param {{ file: string, text: string }[]} files
 */
export function buildIndex(files) {
  const reports = [];
  for (const { file, text } of files) {
    const rep = parseReport(text);
    if (rep === null) continue;
    if (rep.date === null || !DAY.test(rep.date))
      throw new Error(`${file}: bake-off report without a valid "- Date: YYYY-MM-DD" line`);
    if (rep.run === null || rep.run === "")
      throw new Error(`${file}: bake-off report without a "- Run:" line`);
    reports.push({ file, date: rep.date, run: rep.run, results: roleResults(rep) });
  }
  const index = {};
  for (const role of GATE_ROLES) {
    const cands = reports
      .filter((r) => role in r.results)
      .map((r) => ({
        file: r.file,
        date: r.date,
        run: r.run,
        models: r.results[role],
        verdict: r.results[role].length > 0 ? "PASS" : "FAIL",
      }));
    if (cands.length === 0) continue;
    cands.sort(
      (a, b) =>
        (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
        b.run.localeCompare(a.run, "en", { numeric: true }) ||
        (a.verdict === b.verdict ? 0 : a.verdict === "FAIL" ? -1 : 1) ||
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
    );
    const w = cands[0];
    index[role] = {
      verdict: w.verdict,
      date: w.date,
      run: w.run,
      report: w.file,
      models: w.models,
    };
  }
  return index;
}

/** Reads every .md directly under the report folder, in name order. */
export function readReports(root = ROOT) {
  const dir = path.join(root, REPORT_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => ({ file: n, text: fs.readFileSync(path.join(dir, n), "utf8") }));
}

export async function render(root = ROOT, files = readReports(root)) {
  const index = buildIndex(files);
  const src = `// GENERATED by scripts/llm/bakeoff-index.mjs (M22 L1, D-1403, D-1404). Do not edit: run
// \`node scripts/llm/bakeoff-index.mjs --write\` after a bake-off report is added to docs/test-reports/.
// CI runs --check. Per role the newest report that covers it: its verdict and the models that passed.
import type { GateRole } from "./roster";

export type RoleVerdict = {
  verdict: "PASS" | "FAIL";
  date: string;
  run: string;
  /** File name under docs/test-reports/. */
  report: string;
  /** Models that passed the role in that report (empty for a FAIL). */
  models: readonly string[];
};

export const BAKEOFF_INDEX: Readonly<Partial<Record<GateRole, RoleVerdict>>> = ${JSON.stringify(index)};
`;
  const cfg = (await prettier.resolveConfig(path.join(root, OUT))) ?? {};
  return prettier.format(src, { ...cfg, filepath: path.join(root, OUT) });
}

async function main() {
  const mode = process.argv[2];
  const rootArg = process.argv.indexOf("--root");
  const root =
    rootArg > 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : ROOT;
  if (mode !== "--write" && mode !== "--check") {
    console.error("usage: node scripts/llm/bakeoff-index.mjs --write | --check [--root <dir>]");
    process.exit(2);
  }
  let want;
  try {
    want = await render(root);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "bake-off index failed");
    process.exit(1);
  }
  const file = path.join(root, OUT);
  const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (mode === "--write") {
    if (have !== want) fs.writeFileSync(file, want);
    console.log(have === want ? `${OUT} is up to date` : `${OUT} written`);
    return;
  }
  if (have !== want) {
    console.error(`${OUT} is stale: run node scripts/llm/bakeoff-index.mjs --write`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();

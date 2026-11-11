// First bake-off review (TST-137, D-969; LLM-077 is M22): the Owner reads the report and decides which role a
// model may serve. This script lists the bake-off reports under docs/test-reports/ with the PASS or FAIL line of
// every model, and prints the exact `llm_live_roles` edit the Owner would make for a model that passed.
//   node scripts/llm/bakeoff-review.mjs [--dir docs/test-reports] [--role R6]
// A report is a markdown file that starts "# LLM bake-off report" (scripts/llm/bakeoff.mjs --report-out). The
// summary table's last column is the result. Read-only; no network, no database. The key `llm_live_roles` is not
// in the configuration yet (it arrives in M22, LLM-077): until then the script says so and the edit is a plan, not
// something to type anywhere. Exit 0 always when the folder is readable, 2 on usage, 1 when it is not.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES = ["R1", "R2", "R3", "R5", "R6"];
export const KEY_AVAILABLE = false; // llm_live_roles is added in M22 (LLM-077)

/**
 * @param {string} text report markdown
 * @returns {{ run: string | null, date: string | null, models: { model: string, result: "PASS" | "FAIL" }[] } | null}
 *          null when the text is not a bake-off report
 */
export function parseReport(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (!(lines[0] ?? "").startsWith("# LLM bake-off report")) return null;
  const grab = (label) => {
    const l = lines.find((x) => x.startsWith(`- ${label}:`));
    return l === undefined ? null : l.slice(label.length + 3).trim();
  };
  const models = [];
  let inSummary = false;
  for (const l of lines) {
    if (l.startsWith("## Summary")) {
      inSummary = true;
      continue;
    }
    if (inSummary && l.startsWith("## ")) break;
    if (!inSummary || !l.startsWith("|")) continue;
    const cells = l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const last = cells[cells.length - 1];
    if (cells.length >= 2 && (last === "PASS" || last === "FAIL"))
      models.push({ model: cells[0], result: last });
  }
  return { run: grab("Run"), date: grab("Date"), models };
}

/** @param {{ file: string, report: NonNullable<ReturnType<typeof parseReport>> }[]} reports @param {string | null} role */
export function planEdit(reports, role) {
  const passed = [];
  for (const { file, report } of reports) {
    for (const m of report.models)
      if (m.result === "PASS") passed.push({ file, run: report.run, model: m.model });
  }
  return passed.map((p) =>
    role === null
      ? `llm_live_roles: add <role> for ${p.model} (passed in ${p.file}, run ${p.run ?? "unknown"}); pass --role to name it`
      : `llm_live_roles: add ${role} for ${p.model} (passed in ${p.file}, run ${p.run ?? "unknown"})`,
  );
}

/** @param {string[]} argv @param {(s: string) => void} out */
export function run(argv, out = (s) => console.log(s)) {
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 && typeof argv[i + 1] === "string" ? argv[i + 1] : null;
  };
  const role = flag("--role");
  if (role !== null && !ROLES.includes(role)) {
    out(`bakeoff-review: usage [--dir <folder>] [--role ${ROLES.join("|")}]`);
    return 2;
  }
  const dir = flag("--dir") ?? "docs/test-reports";
  if (!existsSync(dir)) {
    out("bakeoff-review: failed (the reports folder was not found)");
    return 1;
  }
  const reports = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".md"))
    .sort()) {
    const report = parseReport(readFileSync(path.join(dir, f), "utf8"));
    if (report !== null) reports.push({ file: f, report });
  }
  if (reports.length === 0) {
    out(
      "bakeoff-review: no bake-off report yet. Run the LLM bake-off workflow, commit its report here, then run this again.",
    );
    return 0;
  }
  for (const { file, report } of reports) {
    out(`${file} (run ${report.run ?? "unknown"}, ${report.date ?? "undated"})`);
    for (const m of report.models) out(`  ${m.model}: ${m.result}`);
  }
  const plan = planEdit(reports, role);
  if (plan.length === 0) out("No model has passed: nothing to add to llm_live_roles.");
  else for (const p of plan) out(p);
  if (!KEY_AVAILABLE) {
    out(
      "Note: the llm_live_roles setting arrives with milestone M22 (LLM-077). Until then this is the edit you would make, not one to apply.",
    );
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

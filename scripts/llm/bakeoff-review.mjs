// Bake-off review (TST-137, D-969; LLM-077, D-1404): the Owner reads the report and decides which role a model may
// serve. This script lists the bake-off reports under docs/test-reports/ with the PASS or FAIL line of every model and
// the role verdicts (the "## Role verdicts" table: | Role | Model | Result |), and prints the exact `llm_live_roles` edit
// for every role that passed: the NEWEST report that covers a role decides it, so a later FAIL withdraws an earlier PASS.
//   node scripts/llm/bakeoff-review.mjs [--dir docs/test-reports] [--role R6|R1|R2|R7|words]
// A report is a markdown file that starts "# LLM bake-off report" (scripts/llm/bakeoff.mjs --report-out). Read-only; no
// network, no database; it changes nothing: the Owner makes the edit in the configuration, whose guard refuses a role
// without a PASS. Exit 0 always when the folder is readable, 2 on usage, 1 when it is not.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES = ["R1", "R2", "R6", "R7", "words"];
export const KEY_AVAILABLE = true; // llm_live_roles exists since M22 (LLM-077)
const WORDS = {
  R1: "announcement triage",
  R2: "claim extraction",
  R6: "case writing",
  R7: "Committee judge",
  words: "plain-words writing (also review wording and daily summary wording)",
};

/**
 * @param {string} text report markdown
 * @returns {{ run: string | null, date: string | null, models: { model: string, result: "PASS" | "FAIL" }[],
 *             roles: { role: string, model: string, result: "PASS" | "FAIL" }[] } | null}
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
  const roles = [];
  let section = "";
  for (const l of lines) {
    if (l.startsWith("## ")) {
      section = l.slice(3).trim();
      continue;
    }
    if (!l.startsWith("|") || (section !== "Summary" && section !== "Role verdicts")) continue;
    const cells = l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const last = cells[cells.length - 1];
    if (last !== "PASS" && last !== "FAIL") continue;
    if (section === "Summary" && cells.length >= 2) models.push({ model: cells[0], result: last });
    if (section === "Role verdicts" && cells.length >= 3)
      roles.push({ role: cells[0], model: cells[1], result: last });
  }
  return { run: grab("Run"), date: grab("Date"), models, roles };
}

const byNewest = (a, b) =>
  (b.report.date ?? "").localeCompare(a.report.date ?? "") ||
  (b.report.run ?? "").localeCompare(a.report.run ?? "", "en", { numeric: true }) ||
  a.file.localeCompare(b.file);

/**
 * The edit lines. A report with a role verdicts table decides the roles it names, the newest report per role (a FAIL
 * withdraws an earlier PASS); a report without the table (the older format) names no role, so its passing models are
 * listed with the role to be named by --role.
 * @param {{ file: string, report: NonNullable<ReturnType<typeof parseReport>> }[]} reports @param {string | null} role
 */
export function planEdit(reports, role) {
  const lines = [];
  const sorted = [...reports].sort(byNewest);
  for (const r of ROLES) {
    if (role !== null && role !== r) continue;
    const newest = sorted.find((x) => x.report.roles.some((v) => v.role === r));
    if (newest === undefined) continue;
    for (const v of newest.report.roles)
      if (v.role === r && v.result === "PASS")
        lines.push(
          `llm_live_roles: add ${r} (${WORDS[r]}) for ${v.model} (passed in ${newest.file}, run ${newest.report.run ?? "unknown"})`,
        );
  }
  for (const { file, report } of reports) {
    if (report.roles.length > 0) continue;
    for (const m of report.models)
      if (m.result === "PASS")
        lines.push(
          role === null
            ? `llm_live_roles: add <role> for ${m.model} (passed in ${file}, run ${report.run ?? "unknown"}); pass --role to name it`
            : `llm_live_roles: add ${role} for ${m.model} (passed in ${file}, run ${report.run ?? "unknown"})`,
        );
  }
  return lines;
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
    for (const v of report.roles) out(`  ${v.role} ${v.model}: ${v.result}`);
  }
  const plan = planEdit(reports, role);
  if (plan.length === 0) out("No model has passed: nothing to add to llm_live_roles.");
  else for (const p of plan) out(p);
  if (KEY_AVAILABLE && plan.length > 0) {
    out(
      "To apply: add the role names above to the llm_live_roles setting (the Owner's step; the setting refuses a role without a PASS). Review wording and daily summary wording follow the writing switch (words).",
    );
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

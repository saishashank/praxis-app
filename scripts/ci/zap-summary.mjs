// ZAP baseline summary (M8 T12; docs/M8_design.md 2.3, decisions 7, 37, 38; AT-29, SEC-110).
// Reads ZAP's traditional JSON report (-J) and prints ONE table to the job summary: rule id, rule
// name, risk and the number of findings. Nothing else leaves the report: no URL, no header value,
// no cookie, no evidence, no parameter, no solution text. The report file is discarded by the job
// (never uploaded). High findings fail the gate (ZAP has no "critical"; both would), unless an
// unexpired entry in scripts/ci/zap-exceptions.json names the rule. Expired or malformed entries
// fail it too (scripts/ci/exceptions-core.mjs).
//   node scripts/ci/zap-summary.mjs <report.json> [--exceptions <file>] [--label <text>]
// Exit 0 pass, 1 fail, 2 unreadable input.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExceptions, todayUtc } from "./exceptions-core.mjs";

const RISK = ["Informational", "Low", "Medium", "High"];
const FAILING = new Set(["High"]);
const RULE_ID = /^\d{1,7}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A ZAP rule name as plain, short text: no URL, no markup, no table-breaking characters. */
export function safeName(name) {
  return String(name ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[|<>`\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80); // threshold-ok: display width of a rule name
}

/** Rules of a report, merged across sites: [{ rule, name, risk, count }], worst risk first. */
export function rulesOf(report) {
  const byRule = new Map();
  const sites = Array.isArray(report?.site) ? report.site : [];
  for (const site of sites) {
    for (const a of Array.isArray(site?.alerts) ? site.alerts : []) {
      const rule = String(a.pluginid ?? a.alertRef ?? "").split("-")[0];
      if (!RULE_ID.test(rule)) continue;
      const code = Number(a.riskcode);
      const risk = RISK[code] ?? "Informational";
      const count = Number(a.count) || (Array.isArray(a.instances) ? a.instances.length : 1);
      const cur = byRule.get(rule);
      if (cur) cur.count += count;
      else byRule.set(rule, { rule, name: safeName(a.name ?? a.alert), risk, count });
    }
  }
  return [...byRule.values()].sort(
    (a, b) => RISK.indexOf(b.risk) - RISK.indexOf(a.risk) || a.rule.localeCompare(b.rule, "en"),
  );
}

/**
 * @param {unknown} report parsed ZAP JSON
 * @param {unknown} exceptionFile parsed zap-exceptions.json
 * @param {{ today?: string, label?: string }} o
 */
export function summarise(report, exceptionFile, o = {}) {
  const today = o.today ?? todayUtc();
  const { active, problems } = checkExceptions(exceptionFile, {
    today,
    keyFields: ["rule"],
    keyPattern: { rule: RULE_ID },
  });
  const excepted = new Map(active.map((e) => [e.rule, e.expires]));
  const rules = rulesOf(report);
  const failing = rules.filter((r) => FAILING.has(r.risk) && !excepted.has(r.rule));
  const lines = [
    `### ZAP baseline${o.label ? `: ${safeName(o.label)}` : ""}`,
    "",
    "| Rule | Name | Risk | Findings | Exception |",
    "|---|---|---|---|---|",
    ...rules.map(
      (r) =>
        `| ${r.rule} | ${r.name} | ${r.risk} | ${r.count} | ${excepted.has(r.rule) ? `until ${excepted.get(r.rule)}` : "-"} |`,
    ),
  ];
  if (rules.length === 0) lines.push("| - | no findings | - | 0 | - |");
  lines.push("");
  const fail = failing.length > 0 || problems.length > 0;
  if (failing.length) {
    lines.push(
      `FAIL: ${failing.length} high-risk rule${failing.length === 1 ? "" : "s"} without an exception.`,
    );
  }
  for (const p of problems) lines.push(`FAIL: ${p}`);
  if (!fail) lines.push("PASS: no unexcepted high-risk finding.");
  return { rules, failing, problems, fail, text: lines.join("\n") };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** @returns {number} exit code */
export function main(argv, env = process.env, out = (s) => process.stdout.write(`${s}\n`)) {
  let report;
  let file = null;
  let exceptions = path.join(HERE, "zap-exceptions.json");
  let label = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exceptions" && i + 1 < argv.length) exceptions = argv[++i];
    else if (argv[i] === "--label" && i + 1 < argv.length) label = argv[++i];
    else if (!argv[i].startsWith("--") && file === null) file = argv[i];
    else {
      out("usage: zap-summary.mjs <report.json> [--exceptions <file>] [--label <text>]");
      return 2;
    }
  }
  if (file === null) {
    out("usage: zap-summary.mjs <report.json> [--exceptions <file>] [--label <text>]");
    return 2;
  }
  let exceptionFile;
  try {
    report = readJson(file);
    exceptionFile = readJson(exceptions);
  } catch {
    out("the ZAP report or the exception file could not be read");
    return 2;
  }
  const r = summarise(report, exceptionFile, { label });
  out(r.text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${r.text}\n`);
  return r.fail ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

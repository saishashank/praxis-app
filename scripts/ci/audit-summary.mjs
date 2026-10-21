// Dependency-audit summary (M8 T12; docs/M8_design.md 2.3, decision 38; AT-29, SEC-107).
// Reads `npm audit --json` output twice: for the production tree (`--omit=dev`) and for the whole
// tree. Packages that appear only in the whole tree are the development tree. Rules:
//   - production high/critical FAILS, with no exception possible;
//   - development high/critical FAILS unless scripts/ci/audit-exceptions.json names the package
//     (and, when given, the advisory) with a reason and an expiry no more than 30 days after the
//     day it was added; an expired or malformed entry fails too (scripts/ci/exceptions-core.mjs).
// The table lists package name, severity and GitHub advisory ids only: no URL, path or version
// range. Output goes to the job summary and the log; nothing is uploaded.
//   node scripts/ci/audit-summary.mjs --label root --prod prod.json --all all.json [--exceptions f]
// Exit 0 pass, 1 fail, 2 unreadable input.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkExceptions, todayUtc } from "./exceptions-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEVERITIES = ["critical", "high", "moderate", "low", "info"];
const FAILING = new Set(["critical", "high"]);
const GHSA = /GHSA(?:-[0-9a-z]{4}){3}/i;
const PACKAGE = /^(?:@[\w.-]+\/)?[\w.-]+$/;

/** [{ name, severity, advisories, direct }] for every vulnerable package of a report. */
export function vulnerabilitiesOf(report) {
  const out = [];
  const vulns = report && typeof report === "object" ? (report.vulnerabilities ?? {}) : {};
  for (const [key, v] of Object.entries(vulns)) {
    const name = String(v?.name ?? key);
    if (!PACKAGE.test(name)) continue;
    const severity = SEVERITIES.includes(v?.severity) ? v.severity : "info";
    const advisories = new Set();
    for (const via of Array.isArray(v?.via) ? v.via : []) {
      const m = via && typeof via === "object" ? GHSA.exec(String(via.url ?? "")) : null;
      if (m) advisories.add(m[0].toUpperCase().replace(/^GHSA/, "GHSA"));
    }
    out.push({ name, severity, advisories: [...advisories].sort(), direct: v?.isDirect === true });
  }
  return out.sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.name.localeCompare(b.name, "en"),
  );
}

/**
 * @param {{ prod: unknown, all: unknown, exceptions: unknown, today?: string, label?: string }} i
 */
export function summarise({ prod, all, exceptions, today = todayUtc(), label = "" }) {
  const { active, problems } = checkExceptions(exceptions, { today, keyFields: ["package"] });
  for (const [i, e] of (Array.isArray(exceptions?.exceptions)
    ? exceptions.exceptions
    : []
  ).entries()) {
    if (
      e &&
      e.advisory !== undefined &&
      !(typeof e.advisory === "string" && GHSA.test(e.advisory))
    ) {
      problems.push(`exception ${i + 1}: advisory must be a GHSA id`);
    }
  }
  const prodNames = new Set(vulnerabilitiesOf(prod).map((v) => v.name));
  const prodList = vulnerabilitiesOf(prod).map((v) => ({ ...v, tree: "production" }));
  const devList = vulnerabilitiesOf(all)
    .filter((v) => !prodNames.has(v.name))
    .map((v) => ({ ...v, tree: "development" }));
  const matches = (v) =>
    active.find(
      (e) =>
        e.package === v.name &&
        (e.advisory === undefined || v.advisories.includes(String(e.advisory).toUpperCase())),
    );
  const rows = [...prodList, ...devList].map((v) => {
    const ex = v.tree === "development" && FAILING.has(v.severity) ? matches(v) : undefined;
    return { ...v, exception: ex ? ex.expires : null };
  });
  const failing = rows.filter((r) => FAILING.has(r.severity) && r.exception === null);
  const shown = rows.filter((r) => FAILING.has(r.severity));
  const counts = (tree) =>
    SEVERITIES.map(
      (s) => `${rows.filter((r) => r.tree === tree && r.severity === s).length} ${s}`,
    ).join(", ");
  const lines = [
    `### Dependency audit${label ? `: ${label}` : ""}`,
    "",
    `Production tree: ${counts("production")}.`,
    `Development tree: ${counts("development")}.`,
    "",
    "| Tree | Package | Severity | Advisories | Exception |",
    "|---|---|---|---|---|",
    ...shown.map(
      (r) =>
        `| ${r.tree} | ${r.name} | ${r.severity} | ${r.advisories.join(", ") || "-"} | ${r.exception ? `until ${r.exception}` : "-"} |`,
    ),
  ];
  if (shown.length === 0) lines.push("| - | no high or critical finding | - | - | - |");
  lines.push("");
  const fail = failing.length > 0 || problems.length > 0;
  if (failing.length) {
    lines.push(
      `FAIL: ${failing.length} high or critical package${failing.length === 1 ? "" : "s"} without an exception.`,
    );
  }
  for (const p of problems) lines.push(`FAIL: ${p}`);
  if (!fail) lines.push("PASS: no unexcepted high or critical finding.");
  return { rows, failing, problems, fail, text: lines.join("\n") };
}

/** @returns {number} exit code */
export function main(argv, env = process.env, out = (s) => process.stdout.write(`${s}\n`)) {
  const args = {
    label: "",
    prod: null,
    all: null,
    exceptions: path.join(HERE, "audit-exceptions.json"),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!["--label", "--prod", "--all", "--exceptions"].includes(k) || i + 1 >= argv.length) {
      out(
        "usage: audit-summary.mjs --label <text> --prod <file> --all <file> [--exceptions <file>]",
      );
      return 2;
    }
    args[k.slice(2)] = argv[i + 1];
  }
  if (args.prod === null || args.all === null) {
    out("usage: audit-summary.mjs --label <text> --prod <file> --all <file> [--exceptions <file>]");
    return 2;
  }
  let prod;
  let all;
  let exceptions;
  try {
    prod = JSON.parse(readFileSync(args.prod, "utf8"));
    all = JSON.parse(readFileSync(args.all, "utf8"));
    exceptions = JSON.parse(readFileSync(args.exceptions, "utf8"));
  } catch {
    out("an audit report or the exception file could not be read");
    return 2;
  }
  const r = summarise({ prod, all, exceptions, label: args.label.replace(/[^\w ./-]/g, "") });
  out(r.text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${r.text}\n`);
  return r.fail ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

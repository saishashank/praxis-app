// Mutation-test summary (M8 T12; docs/M8_design.md 2.8, decision 22; TST-130, AT-31).
// Reads Stryker's JSON report and prints one table per source file (killed, survived, no coverage,
// score) and the overall score to the job summary. The floor is `thresholds.break` of
// stryker.config.mjs (TST-130: 80 %), the same number Stryker itself fails on. File paths are
// repo paths of source files; no mutant source text, replacement or location is printed.
//   node scripts/ci/mutation-summary.mjs [reports/mutation/mutation.json]
// Exit 0 at or above the floor, 1 below it, 2 on an unreadable report.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import config from "../../stryker.config.mjs";

export const FLOOR = config.thresholds.break;
const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);
const PATH_OK = /^[\w./@()[\] -]+$/;
const PERCENT = 100; // threshold-ok: percent

const score = (detected, undetected) =>
  detected + undetected === 0 ? null : (PERCENT * detected) / (detected + undetected);
const fmt = (s) => (s === null ? "n/a" : `${s.toFixed(1)} %`);

/** Pure: rows per file and the totals. Ignored and errored mutants are not counted (Stryker's rule). */
export function summarise(report, floor = FLOOR) {
  const rows = [];
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const [file, f] of Object.entries(report?.files ?? {})) {
    let k = 0;
    let s = 0;
    let n = 0;
    for (const m of Array.isArray(f?.mutants) ? f.mutants : []) {
      if (DETECTED.has(m.status)) k += 1;
      else if (m.status === "Survived") s += 1;
      else if (m.status === "NoCoverage") n += 1;
    }
    killed += k;
    survived += s;
    noCoverage += n;
    rows.push({
      file: PATH_OK.test(file) ? file : "(unprintable path)",
      killed: k,
      survived: s,
      noCoverage: n,
      score: score(k, s + n),
    });
  }
  rows.sort(
    (a, b) =>
      (a.score ?? PERCENT + 1) - (b.score ?? PERCENT + 1) || a.file.localeCompare(b.file, "en"),
  );
  const total = score(killed, survived + noCoverage);
  const fail = total === null || total < floor;
  const lines = [
    "### Mutation testing (money, statistics, rule interpreter)",
    "",
    `Overall score ${fmt(total)} (floor ${floor} %): ${fail ? "FAIL" : "PASS"}.`,
    "",
    "| File | Killed | Survived | No coverage | Score |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) => `| ${r.file} | ${r.killed} | ${r.survived} | ${r.noCoverage} | ${fmt(r.score)} |`,
    ),
  ];
  if (rows.length === 0) lines.push("| - | 0 | 0 | 0 | n/a |");
  return { rows, total, fail, text: lines.join("\n") };
}

/** @returns {number} exit code */
export function main(argv, env = process.env, out = (s) => process.stdout.write(`${s}\n`)) {
  const file = argv[0] ?? "reports/mutation/mutation.json";
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    out("the mutation report could not be read");
    return 2;
  }
  const r = summarise(report);
  out(r.text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${r.text}\n`);
  return r.fail ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

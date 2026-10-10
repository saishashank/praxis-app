// SEC-110 / AT-05a: public-repo hygiene. The code repo is public (PLT-002, O-29), so it must hold
// no data-like files, no files copied from the private data/fixtures repos and no personal data.
//   SEC-110 (a): no market data ... or personal data (names, email addresses) in the code repo;
//     "a CI check blocks data-like files ... outside an allowlist of synthetic fixtures, and any
//     email address or the Owner's name"; the Owner's `docs/`, `log/` and `RESUME.md` never enter
//     the code repo. (b) logs only counts/ids; (c) no data in artifacts or caches; (d) fork PRs;
//     (e) commits use the noreply email, the Owner's email only in environment variables;
//     (f) no licence; (g) strategy visible; (h) secret scanning + push protection (not this script).
//   AT-05a: "the code repo contains no data-like files, email addresses or the Owner's name".
//   CLAUDE.md rule: only `spec/` and `docs/brand/` may be copied from the private data repo.
//   PLT-022a: backups and knowledge archives go to the separate private data repository.
// Runs over `git ls-files` (tracked files only). Zero dependencies.
// Usage: node scripts/ci/repo-hygiene.mjs [--root <dir>] [--allow <file>]
// Output: path + rule id only, never file contents. Exit 1 on any finding.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

export const RULES = {
  "HYG-DATA": "data-like or secret-like file",
  "HYG-SIZE": "file larger than 1 MB",
  "HYG-PRIVATE": "path looks copied from a private repo",
  "HYG-EMAIL": "email address",
  "HYG-PHONE": "AU phone number",
  "HYG-MARKET": "market price-bar header",
};

const DATA_EXT = new Set(
  ".csv .tsv .parquet .xlsx .xls .db .sqlite .sqlite3 .ndjson .jsonl .gz .zip .age .pem .key .p12 .pfx .env".split(
    " ",
  ),
);
const PRIVATE_FILES = new Set([
  "resume.md",
  "build_setup.md",
  "agent_plan.md",
  "token_plan.md",
  "plugins.md",
]);
const PRIVATE_ROOT_DIRS = new Set(["log", "requirement", "fixtures"]);

const LOCAL_CH = /[A-Za-z0-9._%+-]/;
const DOMAIN_RE = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y;
const PHONE_RES = [
  /(?<![\w.+])(?:\+61[\s-]?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/,
  /(?<![\w.+])(?:\+61[\s-]?\(?0?\)?[\s-]?|\(?0)[2378]\)?[\s-]?\d{4}[\s-]?\d{4}(?!\d)/,
];
const BAR_HEADER_RE = new RegExp(
  `^\s*"?date"?\s*,\s*"?open"?\s*,\s*"?high"?\s*,\s*"?low"?\s*,\s*"?close"?\s*(,|$)`,
  "i",
);
const TEXT_SCAN_SKIP = new Set(["package-lock.json"]);

function emailAllowed(match, domain) {
  const full = match.toLowerCase();
  const d = domain.toLowerCase();
  return (
    d === "example.com" ||
    d === "example.test" ||
    d.endsWith(".test") ||
    d.endsWith(".invalid") ||
    full === "noreply@anthropic.com" ||
    d === "users.noreply.github.com" ||
    d.endsWith(".users.noreply.github.com") ||
    full === "onboarding@resend.dev"
  );
}

/** Linear-time email finder (no backtracking on long lines). */
function hasForeignEmail(text) {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && at - start < 64 && LOCAL_CH.test(text[start - 1])) start--;
    if (start === at) continue;
    DOMAIN_RE.lastIndex = at + 1;
    const m = DOMAIN_RE.exec(text);
    if (m && !emailAllowed(text.slice(start, at + 1) + m[0], m[0])) return true;
  }
  return false;
}

function isTestFile(p) {
  return /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
}

function covered(list, p) {
  return (list ?? []).some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
}

/** Pure per-file checks that need no file access. Returns rule ids. */
export function pathRules(p, allow) {
  const rules = [];
  const lower = p.toLowerCase();
  const base = path.posix.basename(lower);
  const ext = path.posix.extname(base);
  const isEnv = base === ".env" || (base.startsWith(".env.") && base !== ".env.example");
  if (DATA_EXT.has(ext) || isEnv || /\.local\./.test(base)) rules.push("HYG-DATA");
  const root = lower.split("/")[0];
  if (
    PRIVATE_FILES.has(base) ||
    (lower.includes("/") && PRIVATE_ROOT_DIRS.has(root)) ||
    lower.startsWith("docs/project_imports/") ||
    (root === "docs" && lower.includes("/") && !covered(allow.docs, p))
  ) {
    rules.push("HYG-PRIVATE");
  }
  return rules;
}

/** Scan tracked files under root. Returns [{ file, rule }] (sorted, de-duplicated). */
export function scan(root, allow = {}) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 });
  const files = out.toString("utf8").split("\0").filter(Boolean);
  const found = new Set();
  const add = (file, rule) => {
    if (!covered(allow.files?.[rule], file)) found.add(`${file}\t${rule}`);
  };
  for (const p of files) {
    const full = path.join(root, p);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (!stat.isFile()) continue;
    for (const rule of pathRules(p, allow)) add(p, rule);
    const base = path.posix.basename(p);
    if (stat.size > MAX_BYTES && base !== "package-lock.json" && !p.startsWith("docs/brand/")) {
      add(p, "HYG-SIZE");
    }
    if (stat.size > MAX_SCAN_BYTES || TEXT_SCAN_SKIP.has(base)) continue;
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    const text = buf.toString("utf8");
    if (hasForeignEmail(text)) add(p, "HYG-EMAIL");
    const lines = text.split(/\r?\n/);
    if (lines.some((l) => PHONE_RES.some((re) => re.test(l)))) add(p, "HYG-PHONE");
    if (!isTestFile(p) && lines.some((l) => BAR_HEADER_RE.test(l))) add(p, "HYG-MARKET");
  }
  return [...found].sort().map((s) => {
    const [file, rule] = s.split("\t");
    return { file, rule };
  });
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
  const root = path.resolve(arg("--root", process.cwd()));
  const allowFile = arg(
    "--allow",
    path.join(path.dirname(fileURLToPath(import.meta.url)), "repo-hygiene.allow.json"),
  );
  const allow = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, "utf8")) : {};
  const findings = scan(root, allow);
  if (findings.length === 0) {
    console.log("repo-hygiene: OK (no data-like files, private paths or personal data)");
    return;
  }
  for (const f of findings) console.error(`${f.rule}  ${f.file}  (${RULES[f.rule]})`);
  console.error(`repo-hygiene: ${findings.length} finding(s); see SEC-110 / AT-05a`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

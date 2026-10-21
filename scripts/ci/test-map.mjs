// TST-133 (M8 T3): generated test map (requirement or acceptance ID to test files) and the check
// against the committed baseline `tests/test-map.baseline.json`.
// The map is built from two places, both already in the repo:
//   1. the rows of docs/test-map.md (column 1 = IDs, column 3 = test files in backticks), and
//   2. IDs cited anywhere in a test file's text (header comments, describe and it names).
// Only files that exist and look like tests count. The check fails when
//   - a test file recorded in the baseline no longer exists ("mapped test file disappeared"), or
//   - an ID in the baseline (AT rows included) has no existing test file left ("lost its last test").
// New IDs and new files never fail. `--update` adds them to the baseline; `--update --prune` also
// drops entries that are gone (a deliberate, reviewed act, as the file is committed).
// The ID-to-MUST step (every MUST in ch. 01-12 has a test or an Owner-executed entry) needs the
// spec text and stays with docs/test-map.md; this check protects what is already mapped.
// Usage: node scripts/ci/test-map.mjs [--root <dir>] [--baseline <file>] [--update [--prune]]
//        [--summary]   (markdown table; also appended to $GITHUB_STEP_SUMMARY when set)
// Output: IDs and paths only. Exit 1 on any finding.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PREFIXES =
  "AT TST SEC UXN UX PLT DAT ARN AGT EML ROL KB NFR LLM BLD VAL REC OPS FAM D O".split(" ");
export const ID_RE = new RegExp(`\\b(?:${PREFIXES.join("|")})-\\d{1,3}[a-z]?\\b`, "g");
export const TEST_FILE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const SCAN_DIRS = ["tests", "worker/test", "scripts", "src", "e2e"];
// This script's own test cites made-up IDs in fixtures; it is not evidence for any requirement.
const SKIP_FILES = new Set(["scripts/ci/test-map.test.mjs"]);
// "coverage" is skipped only at the root (report output); tests/coverage and worker/test/coverage hold tests.
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".wrangler"]);

const norm = (p) => p.replace(/\\/g, "/");

export function idsIn(text) {
  return [...new Set(text.match(ID_RE) ?? [])];
}

/** Rows of the markdown table: [{ids, files}] with files taken from backticked paths in column 3. */
export function parseMapDoc(md) {
  const rows = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1);
    if (cells.length < 3) continue;
    const ids = idsIn(cells[0]);
    if (!ids.length) continue;
    const files = [...cells[2].matchAll(/`([^`]+)`/g)].map((m) => norm(m[1]).replace(/^\.\//, ""));
    rows.push({ ids, files });
  }
  return rows;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, rel, out);
    } else if (TEST_FILE_RE.test(e.name) && !SKIP_FILES.has(rel)) out.push(rel);
  }
}

/** Builds { id: [files] } (sorted) for the tree at `root`. */
export function buildMap(root) {
  const map = new Map();
  const add = (id, file) => {
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(file);
  };
  const docPath = path.join(root, "docs", "test-map.md");
  if (fs.existsSync(docPath)) {
    for (const row of parseMapDoc(fs.readFileSync(docPath, "utf8"))) {
      for (const f of row.files) {
        if (TEST_FILE_RE.test(f) && fs.existsSync(path.join(root, f)))
          for (const id of row.ids) add(id, f);
      }
    }
  }
  const files = [];
  for (const d of SCAN_DIRS) walk(root, d, files);
  for (const f of files.sort()) {
    for (const id of idsIn(fs.readFileSync(path.join(root, f), "utf8"))) add(id, f);
  }
  return Object.fromEntries(
    [...map]
      .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
      .map(([k, v]) => [k, [...v].sort()]),
  );
}

/** Findings for a baseline map against the current map and a file-exists check. */
export function checkMap(baseline, current, exists) {
  const findings = [];
  for (const [id, files] of Object.entries(baseline)) {
    const gone = files.filter((f) => !exists(f));
    for (const f of gone) findings.push(`${id}: mapped test file disappeared: ${f}`);
    if (!(current[id]?.length > 0)) {
      findings.push(
        `${id}: ${id.startsWith("AT-") ? "acceptance row" : "requirement"} lost its last test`,
      );
    }
  }
  return findings;
}

/** Merges the current map into the baseline map. `prune` drops entries that no longer exist. */
export function mergeBaseline(baseline, current, { prune = false } = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const files = new Set(current[id] ?? []);
    if (!prune) for (const f of baseline[id] ?? []) files.add(f);
    if (files.size) out[id] = [...files].sort();
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })),
  );
}

export function summaryMarkdown(current, findings) {
  const ids = Object.keys(current);
  const lines = [
    "### Test map (TST-133)",
    "",
    `${ids.length} IDs map to ${new Set(Object.values(current).flat()).size} test files. Findings: ${findings.length}.`,
  ];
  for (const f of findings) lines.push(`- FAIL ${f}`);
  const at = ids.filter((i) => i.startsWith("AT-"));
  lines.push("", "| Acceptance row | Test files |", "|---|---|");
  for (const id of at) lines.push(`| ${id} | ${current[id].length} |`);
  return lines.join("\n");
}

function main(argv) {
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(
    arg("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  );
  const basePath = arg("--baseline") ?? path.join(root, "tests", "test-map.baseline.json");
  const current = buildMap(root);
  let baseline = {};
  try {
    baseline = JSON.parse(fs.readFileSync(basePath, "utf8")).map ?? {};
  } catch (err) {
    if (!argv.includes("--update")) {
      console.error(`test-map: cannot read baseline ${basePath}: ${err.message}`);
      return 1;
    }
  }
  if (argv.includes("--update")) {
    const merged = mergeBaseline(baseline, current, { prune: argv.includes("--prune") });
    const doc = {
      version: 1,
      note: "Generated by scripts/ci/test-map.mjs --update. IDs (TST-133) to existing test files; the check fails if a file disappears or an ID loses its last test.",
      map: merged,
    };
    fs.writeFileSync(basePath, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`test-map: baseline written, ${Object.keys(merged).length} IDs`);
    return 0;
  }
  const findings = checkMap(baseline, current, (f) => fs.existsSync(path.join(root, f)));
  console.log(
    `test-map: ${Object.keys(baseline).length} baseline IDs, ${Object.keys(current).length} current IDs`,
  );
  for (const f of findings) console.error(`FAIL ${f}`);
  if (argv.includes("--summary")) {
    const md = summaryMarkdown(current, findings);
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  }
  return findings.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

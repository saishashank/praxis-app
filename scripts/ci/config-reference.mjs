// BLD-040 / BLD-004: generate docs/config-reference.md from src/lib/config/keys.ts (every ch.15 key)
// and src/lib/config/verify.ts (one row per [VERIFY] tag in spec/*.md), and check it (M8 T2).
// Zero dependencies. The two .ts files are loaded with Node's built-in TypeScript type stripping
// (Node 22.18 or newer, see .nvmrc) plus a tiny resolver for the "@/" alias; nothing is installed.
// Usage: node scripts/ci/config-reference.mjs [--check] [repoRoot]
//   (no flag)  write docs/config-reference.md
//   --check    exit 1 when a spec tag has no row, a row has no tag, a row breaks the status rules, or
//              the committed doc differs from a fresh generation.
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DOC_PATH = "docs/config-reference.md";
const TAG_RE = /\[VERIFY[^\]]*\]/g;
const STATUSES = ["verified", "unverified", "owner"];

/** Items of docs/M8_requirements.md section 4.3 row 19, with the registry keys that now cover each. */
export const PROPOSED_ITEMS = [
  { item: "ARN-011 thresholds", match: /^arn011_/ },
  { item: "F5 volume-exit numbers", match: /^f5_(dry_up_|stop_|trail_|time_stop)/ },
  { item: "code_reuse_gap_sessions (120)", match: /^code_reuse_gap_sessions$/ },
  { item: "CIF horizons (63/126/252) and 90 %", match: /^cif_(horizons_sessions|confidence)$/ },
  { item: "LINEAGES_FLOOR_MIN (6)", match: /^active_lineages_floor$/ },
  { item: "llm_injection_phrases", match: /^llm_injection_phrases$/ },
  { item: "dsr_default_sr_variance", match: /^dsr_default_sr_variance$/ },
  { item: "attention_near_limit_pct", match: /^attention_near_limit_pct$/ },
  { item: "market_list_page_size", match: /^market_list_page_size$/ },
  { item: "strategy-name table", match: /^strategy_names$/ },
  { item: "quiet-hours keys", match: /quiet_hours/ },
  { item: "snooze keys", match: /snooze/ },
  { item: "sort defaults", match: /sort_default|default_sort/ },
];

/** Every [VERIFY...] tag in the spec files: { id, file, line }. id = "<NN>:<line>#<nth on line>". */
export function extractTags(specDir) {
  const tags = [];
  const files = fs
    .readdirSync(specDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const f of files) {
    const lines = fs.readFileSync(path.join(specDir, f), "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      let n = 0;
      for (const _m of text.matchAll(TAG_RE)) {
        n += 1;
        tags.push({ id: `${f.slice(0, 2)}:${i + 1}#${n}`, file: f, line: i + 1 });
      }
    });
  }
  return tags;
}

/** Problems between the spec tags and the registry rows (empty array = fine). */
export function checkRows(tags, rows, keyNames = null) {
  const problems = [];
  const tagIds = new Set(tags.map((t) => t.id));
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) problems.push(`duplicate row ${r.id}`);
    seen.add(r.id);
    if (!tagIds.has(r.id)) problems.push(`row ${r.id} has no [VERIFY] tag in spec/`);
    if (!STATUSES.includes(r.status)) problems.push(`row ${r.id}: unknown status "${r.status}"`);
    const has = Boolean(r.sourceUrl) && Boolean(r.verifiedOn);
    if (r.status === "verified" && !has) {
      problems.push(`row ${r.id} is verified without a source URL and a date`);
    } else if (r.status === "verified") {
      if (!/^https:\/\/\S+$/.test(r.sourceUrl)) {
        problems.push(`row ${r.id}: source must be an https URL`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.verifiedOn)) {
        problems.push(`row ${r.id}: date must be YYYY-MM-DD`);
      }
    }
    if (r.status !== "verified" && (r.sourceUrl || r.verifiedOn || r.verifiedBy)) {
      problems.push(`row ${r.id} is ${r.status} but carries a source, date or verifier`);
    }
    if (keyNames && r.configKey && !keyNames.has(r.configKey)) {
      problems.push(`row ${r.id}: configKey "${r.configKey}" is not in keys.ts`);
    }
  }
  for (const t of tags) {
    if (!seen.has(t.id)) problems.push(`spec tag ${t.id} (${t.file} l.${t.line}) has no row`);
  }
  return problems;
}

const cell = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();

function showDefault(v) {
  const s = JSON.stringify(v);
  const text = s === undefined ? "" : s;
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

const who = (e) =>
  e === "O" ? "Owner" : e === "B" ? "Owner, within bounds (Lane B)" : "nobody (fixed)";

function boundsOf(def, meta) {
  if (meta?.bounds) return meta.bounds;
  if (Array.isArray(def.range)) return `${def.range[0]} to ${def.range[1]}`;
  return "";
}

/**
 * Build the document text. Inputs are plain data so tests need no TypeScript:
 *  keys: { name: { default, unit, editable, range?, ref } }, meta: { name: { label, area, bounds } },
 *  rows: verify rows, ch15: text of spec/15 (decides "in ch.15").
 */
export function renderDoc({ keys, meta, rows, ch15 }) {
  const names = Object.keys(keys).sort();
  const inCh15 = (k) => new RegExp(`(^|[^a-z0-9_])${k}([^a-z0-9_]|$)`).test(ch15);
  const out = [];
  out.push("# Configuration reference", "");
  out.push(
    "Generated by `node scripts/ci/config-reference.mjs` from `src/lib/config/keys.ts` and `src/lib/config/verify.ts`. Do not edit by hand; `node scripts/ci/config-reference.mjs --check` fails when this file is stale (BLD-004, BLD-040).",
    "",
  );
  const count = (s) => rows.filter((r) => r.status === s).length;
  out.push(
    `${names.length} configuration keys; ${rows.length} \`[VERIFY]\` tags in \`spec/\`: ${count("verified")} verified, ${count("unverified")} unverified, ${count("owner")} Owner-only.`,
    "",
  );

  out.push("## 1. Configuration keys", "");
  out.push(
    "Who may change a key: Owner (any valid value), Owner within bounds (Lane B, becomes the A6 challenger lane in M6), or nobody (a fixed spec constant). The Configuration page validates every edit against the bounds.",
    "",
  );
  out.push("| Key | Default | Unit | Who may change it | Bounds | In ch.15 | Reference |");
  out.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const k of names) {
    const d = keys[k];
    out.push(
      `| \`${k}\` | ${cell(`\`${showDefault(d.default)}\``)} | ${cell(d.unit)} | ${who(d.editable)} | ${cell(boundsOf(d, meta[k]))} | ${inCh15(k) ? "yes" : "no"} | ${cell(d.ref)} |`,
    );
  }
  out.push("");

  out.push("## 2. [VERIFY] registry", "");
  out.push(
    "One row per `[VERIFY...]` tag in `spec/*.md`. A row is verified only with a public source URL and the date it was checked; Owner rows (contracts, account screens, legal readings, approvals) stay blank until the Owner acts. Row id = spec chapter number, line, and the nth tag on that line.",
    "",
  );
  out.push(
    "| Id | Spec file, line | Kind | Statement | Config key | Status | Source | Verified on | By | Note |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const ordered = [...rows].sort((a, b) =>
    a.file === b.file ? a.line - b.line || a.id.localeCompare(b.id) : a.file < b.file ? -1 : 1,
  );
  for (const r of ordered) {
    out.push(
      `| ${r.id} | ${cell(r.file)} l.${r.line} | ${r.kind} | ${cell(r.statement)} | ${r.configKey ? `\`${r.configKey}\`` : ""} | ${r.status} | ${cell(r.sourceUrl)} | ${cell(r.verifiedOn)} | ${cell(r.verifiedBy)} | ${cell(r.note)} |`,
    );
  }
  out.push("");

  out.push("## 3. Proposed, not in ch.15", "");
  out.push(
    "Keys the M3 to M7 builds added (or that docs/M8_requirements.md section 4.3 row 19 lists as missing) and that spec ch.15 does not name. They are proposed additions for the architect; the build already reads them from the registry.",
    "",
  );
  out.push("| Item (REQ row 19) | Registry keys | In keys.ts | In ch.15 |");
  out.push("| --- | --- | --- | --- |");
  for (const p of PROPOSED_ITEMS) {
    const found = names.filter((k) => p.match.test(k));
    const listed = found.length ? found.map((k) => `\`${k}\``).join(", ") : "none";
    const all = found.length > 0 && found.every(inCh15);
    out.push(
      `| ${cell(p.item)} | ${listed} | ${found.length ? "yes" : "no (proposed)"} | ${all ? "yes" : "no (proposed)"} |`,
    );
  }
  out.push("");
  const absent = names.filter((k) => !inCh15(k));
  out.push(`Registry keys whose name does not appear in spec ch.15 (${absent.length}):`, "");
  out.push(absent.length ? absent.map((k) => `\`${k}\``).join(", ") : "none", "");
  return out.join("\n");
}

let hookRegistered = false;
function registerResolver(root) {
  if (hookRegistered) return;
  hookRegistered = true;
  const source = `
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = ${JSON.stringify(root)};
export async function resolve(specifier, context, next) {
  let p = null;
  if (specifier.startsWith("@/")) p = path.join(root, "src", specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:") && !path.extname(specifier)) {
    p = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (p) {
    for (const ext of [".ts", "/index.ts"]) {
      if (existsSync(p + ext)) return next(pathToFileURL(p + ext).href, context);
    }
  }
  return next(specifier, context);
}`;
  register("data:text/javascript," + encodeURIComponent(source), import.meta.url);
}

async function loadTs(root, rel) {
  registerResolver(root);
  const original = process.emitWarning;
  process.emitWarning = () => {}; // silence the "module type not specified" notice for .ts
  try {
    return await import(pathToFileURL(path.join(root, rel)).href);
  } finally {
    process.emitWarning = original;
  }
}

export async function build(root) {
  const keysMod = await loadTs(root, "src/lib/config/keys.ts");
  const verifyMod = await loadTs(root, "src/lib/config/verify.ts");
  const ch15 = fs.readFileSync(path.join(root, "spec", "15_configuration_reference.md"), "utf8");
  const rows = verifyMod.VERIFY_ROWS;
  const keys = keysMod.CONFIG_KEYS;
  const tags = extractTags(path.join(root, "spec"));
  const problems = checkRows(tags, rows, new Set(Object.keys(keys)));
  const doc = renderDoc({ keys, meta: keysMod.CONFIG_META, rows, ch15 });
  return { doc: doc.replace(/\r\n/g, "\n"), problems, tags, rows };
}

async function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const rootArg = args.find((a) => !a.startsWith("--"));
  const root = path.resolve(
    rootArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  );
  const { doc, problems, tags, rows } = await build(root);
  const target = path.join(root, DOC_PATH);
  if (!checkMode) {
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, doc);
    console.log(`config-reference: wrote ${DOC_PATH} (${tags.length} tags, ${rows.length} rows)`);
    return;
  }
  const current = fs.existsSync(target)
    ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n")
    : null;
  if (current === null) {
    problems.push(`${DOC_PATH} is missing; run node scripts/ci/config-reference.mjs`);
  } else if (current !== doc) {
    problems.push(`${DOC_PATH} is stale; run node scripts/ci/config-reference.mjs`);
  }
  if (problems.length) {
    console.error(`config-reference: FAILED\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`config-reference: ok (${tags.length} tags = ${rows.length} rows, doc current)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

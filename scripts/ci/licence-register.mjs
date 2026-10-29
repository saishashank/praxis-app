// Source-licence register document (M8 T14; docs/M8_design.md decision 16; DAT-120, DAT-124, BLD-040).
// Generates docs/source-licence-register.md from the source register that the code seeds: the
// `INSERT INTO source_register` statements of the main migrations (0004 and 0006), checked against
// the source ids in src/lib/data/schema.ts. Every data source of the code is listed, with its
// permitted use, risk, status and display rule, and the code that fetches it.
//   node scripts/ci/licence-register.mjs            write the document
//   node scripts/ci/licence-register.mjs --check    fail (exit 1) when the document is stale
// The document shows the SEEDED status. The live status is on System Health, Data controls. An
// Owner risk acceptance (O-23 ASX, O-26 Yahoo) is shown as "pending Owner" because this document
// is generated from code and holds no Owner date. No person's name, no email, no secret (SEC-110).
// Zero dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DOC_PATH = "docs/source-licence-register.md";
const MIGRATIONS_DIR = "db/migrations/main";
const SCHEMA_PATH = "src/lib/data/schema.ts";

/**
 * What the code does with each registered source: label, what it provides, the code that fetches
 * it and the hosts it contacts. Every source in the seed MUST have an entry (the generator fails
 * otherwise), so a new register row cannot be left out of the document.
 */
export const SOURCE_FACTS = {
  asx_announcements: {
    label: "ASX announcements",
    provides: "Company announcements: headline, link, type and the price-sensitive flag.",
    code: ["worker/src/asx/request.ts", "src/lib/data/sources/asx.ts"],
    hosts: ["asx.com.au"],
    terms:
      "ASX website terms: private personal use only; robots and scrapers are not permitted. Used under the Owner risk acceptance O-23.",
  },
  asx_listed_companies: {
    label: "ASX listed-companies file",
    provides: "Company name and industry group for each ASX code (the instrument universe).",
    code: ["worker/src/asx/universe.ts"],
    hosts: ["asx.com.au"],
    terms:
      "A second ASX request type. It is covered by the same Owner risk acceptance as the announcements (O-23).",
  },
  yahoo_eod: {
    label: "Yahoo Finance end-of-day prices",
    provides: "Daily price bars (and the market index) for ASX codes.",
    code: ["scripts/ingest/yahoo_fetch.py", "src/lib/data/sources/yahoo.ts"],
    hosts: ["Yahoo Finance, through the yfinance library"],
    terms:
      "Unofficial data for personal use. Its terms may not permit automated access. Used under the Owner risk acceptance O-26.",
  },
  rba: {
    label: "Reserve Bank of Australia",
    provides: "Public interest-rate and macro data.",
    code: [],
    hosts: [],
    terms: "Public data. The register row exists; no fetcher is built in this release.",
  },
  abs: {
    label: "Australian Bureau of Statistics",
    provides: "Public economic statistics.",
    code: [],
    hosts: [],
    terms: "Public data. The register row exists; no fetcher is built in this release.",
  },
  asic_short: {
    label: "ASIC daily aggregate short positions",
    provides: "Daily short-position totals for each ASX code, published with a lag.",
    code: ["scripts/ingest/asic_fetch.mjs", "src/lib/data/shortInterest.mjs"],
    hosts: ["download.asic.gov.au"],
    terms: "Public data published by the regulator.",
  },
  // M14 (DAT-236, D-239): disabled alternatives and manual uploads. WP8 completes the wording.
  wikidata_asx: {
    label: "Wikidata ASX companies (alternative, disabled)",
    provides: "Company names and industry for ASX codes, as a universe alternative.",
    code: [],
    hosts: [],
    terms: "CC0. No fetcher is built; terms to be verified before it is ever enabled.",
  },
  wikipedia_asx200: {
    label: "Wikipedia S&P/ASX 200 list (alternative, disabled)",
    provides: "About 200 ASX codes, as a universe alternative.",
    code: [],
    hosts: [],
    terms: "CC BY-SA 4.0. No fetcher is built; terms to be verified before it is ever enabled.",
  },
  index_changes_manual: {
    label: "Index changes (manual CSV)",
    provides: "Index adds and deletes for the F3 exclusion, uploaded by the Owner.",
    code: [],
    hosts: [],
    terms: "A file the Owner uploads; no automated fetch.",
  },
  industry_map_manual: {
    label: "Industry classes (manual CSV)",
    provides: "Finer industry classes for the second-position limit, uploaded by the Owner.",
    code: [],
    hosts: [],
    terms: "A file the Owner uploads; no automated fetch.",
  },
};

/** DAT-124 display rule for personal-use-only content (spec 06). */
const PERSONAL_USE_RULE =
  "Shown to Editors and Viewers as derived numbers, headlines, links and our own summaries only (DAT-124).";
const PUBLIC_RULE = "Public data. May be shown with its source named.";

// ---- reading the seed ----

/** Split one `( ... )` SQL tuple into values: 'text' (with '' escapes), NULL, numbers. */
export function parseTuple(body) {
  const out = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(body[i])) i += 1;
    if (i >= n) break;
    if (body[i] === "'") {
      let s = "";
      i += 1;
      while (i < n) {
        if (body[i] === "'") {
          if (body[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        s += body[i];
        i += 1;
      }
      out.push(s);
    } else {
      let j = i;
      while (j < n && body[j] !== ",") j += 1;
      const raw = body.slice(i, j).trim();
      out.push(/^null$/i.test(raw) ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw);
      i = j;
    }
  }
  return out;
}

/** Find every `(...)` group of a VALUES list, honouring quotes. */
function tuplesOf(values) {
  const groups = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < values.length; i += 1) {
    const c = values[i];
    if (inStr) {
      if (c === "'") {
        if (values[i + 1] === "'") i += 1;
        else inStr = false;
      }
      continue;
    }
    if (c === "'") inStr = true;
    else if (c === "(") {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) groups.push(values.slice(start, i));
    }
  }
  return groups;
}

/** All `INSERT INTO source_register (cols) VALUES ...;` rows in the `-- +up` part of one migration. */
export function parseRegisterInserts(sql) {
  const up = sql.split(/^-- \+down/m)[0];
  const noComments = up
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
  const rows = [];
  const head = /INSERT\s+INTO\s+source_register\s*\(([^)]*)\)\s*VALUES\s*/gi;
  for (const m of noComments.matchAll(head)) {
    const cols = m[1].split(",").map((c) => c.trim());
    // The statement ends at the first semicolon outside a quoted string.
    let end = m.index + m[0].length;
    let inStr = false;
    while (end < noComments.length) {
      const c = noComments[end];
      if (c === "'") {
        if (inStr && noComments[end + 1] === "'") end += 1;
        else inStr = !inStr;
      } else if (c === ";" && !inStr) break;
      end += 1;
    }
    for (const t of tuplesOf(noComments.slice(m.index + m[0].length, end))) {
      const vals = parseTuple(t);
      if (vals.length !== cols.length) throw new Error("source_register insert: column mismatch");
      rows.push(Object.fromEntries(cols.map((c, k) => [c, vals[k]])));
    }
  }
  return rows;
}

export function loadSeed(root = ROOT) {
  const dir = path.join(root, MIGRATIONS_DIR);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const bySource = new Map();
  for (const f of files) {
    for (const r of parseRegisterInserts(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (bySource.has(r.source)) throw new Error(`duplicate source in seed: ${r.source}`);
      bySource.set(r.source, { ...r, migration: f });
    }
  }
  return [...bySource.values()];
}

/** The source ids the code declares: AU_SOURCES, UNIVERSE_SOURCE and REFERENCE_SOURCES (src/lib/data/schema.ts). */
export function declaredSources(root = ROOT) {
  const text = fs.readFileSync(path.join(root, SCHEMA_PATH), "utf8");
  const list = /AU_SOURCES\s*=\s*\[([^\]]*)\]/.exec(text);
  const uni = /UNIVERSE_SOURCE\s*=\s*"([^"]+)"/.exec(text);
  if (!list || !uni) throw new Error("source ids not found in schema.ts");
  const ids = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const ref = /REFERENCE_SOURCES\s*=\s*\[([^\]]*)\]/.exec(text); // M14 (DAT-236); absent in older trees
  const refIds = ref ? [...ref[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  return [...ids, uni[1], ...refIds];
}

// ---- rendering ----

const cell = (s) =>
  String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
const table = (head, rows) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");

const code = (s) => `\`${s}\``;
const STATUS = { pending: "pending", enabled: "enabled", disabled: "disabled" };
const RISK = { low: "low", medium: "medium", high: "high" };

/** Acceptance: an Owner reference means the source needs a risk acceptance this file cannot show. */
export const acceptanceOf = (row) =>
  row.owner_ref ? `pending Owner (${row.owner_ref})` : "not needed";

export function render(rows) {
  const facts = (r) => {
    const f = SOURCE_FACTS[r.source];
    if (!f) throw new Error(`no SOURCE_FACTS entry for registered source ${r.source}`);
    return f;
  };
  const summary = table(
    [
      "Source id",
      "Source",
      "Permitted use",
      "Risk",
      "Status when seeded",
      "Owner reference",
      "Acceptance date",
      "AI summaries allowed",
    ],
    rows.map((r) => [
      code(r.source),
      facts(r).label,
      r.permitted_use ?? "not recorded",
      RISK[r.risk] ?? r.risk,
      STATUS[r.status] ?? r.status,
      r.owner_ref ?? "none",
      acceptanceOf(r),
      r.summarisation_permitted === 1 ? "yes" : "no",
    ]),
  );
  const detail = table(
    ["Source id", "What we take", "Licence or terms reference", "Display rule", "Code", "Contacts"],
    rows.map((r) => {
      const f = facts(r);
      const personal = /personal use only/i.test(r.permitted_use ?? "");
      return [
        code(r.source),
        f.provides,
        `${f.terms} Terms URL: ${r.terms_url ?? "not recorded yet (to be filled by the source evaluation, DAT-101)"}. Last checked: ${r.last_checked ?? "not recorded"}.`,
        personal ? PERSONAL_USE_RULE : PUBLIC_RULE,
        f.code.length ? f.code.map(code).join(", ") : "no fetcher yet",
        f.hosts.length ? f.hosts.join(", ") : "none",
      ];
    }),
  );
  const pending = rows.filter((r) => r.owner_ref && r.status === "pending");
  const lines = [
    "# Source-licence register",
    "",
    "<!-- Generated by scripts/ci/licence-register.mjs from the source register seed in code. Do not edit by hand. -->",
    "",
    "Every data source the code can contact, with its permitted use, its risk rating, its status and the rule for showing its content. [DAT-120, DAT-124, BLD-040]",
    "",
    "How to read this page:",
    "",
    "- It is generated from the register rows that the database migrations seed. The live status can differ. Read the live status on System health, in Data controls.",
    "- A source whose terms forbid our use is switched off unless you record a risk acceptance. [DAT-120]",
    "- Content from a personal-use-only source is limited to derived numbers, headlines, links and our own summaries. [DAT-124]",
    '- A source with "AI summaries allowed: no" is shown as headline and link only, with no model summary. [DAT-120]',
    "- Re-check every source's terms on the first Saturday of each month (Ops checklist). [OPS-020]",
    "",
    "## Register",
    "",
    summary,
    "",
    "## Terms, display rule and code",
    "",
    detail,
    "",
    "## Owner dependencies",
    "",
    ...(pending.length
      ? pending.map(
          (r) =>
            `- ${facts(r).label} (${r.owner_ref}): the risk acceptance date is pending Owner. Until you accept, the source stays ${r.status} and nothing contacts it.`,
        )
      : ["- None."]),
    "- Terms URLs and last-checked dates are not recorded in the seed. The source evaluation and the monthly re-check fill them in the live register.",
    "",
  ];
  return lines.join("\n");
}

/** Build the document text, checking the seed against the source ids declared in code. */
export function build(root = ROOT) {
  const rows = loadSeed(root);
  const seedIds = rows.map((r) => r.source).sort();
  const declared = declaredSources(root).sort();
  const missing = declared.filter((d) => !seedIds.includes(d));
  if (missing.length) throw new Error(`declared in code but not seeded: ${missing.join(", ")}`);
  return render(rows);
}

export function main(argv = process.argv.slice(2), root = ROOT, out = console.log) {
  const check = argv.includes("--check");
  let text;
  try {
    text = build(root);
  } catch (e) {
    out(`licence-register: ${e instanceof Error ? e.message : "failed"}`);
    return 1;
  }
  const file = path.join(root, DOC_PATH);
  if (check) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (cur === text) {
      out("licence-register: up to date");
      return 0;
    }
    out(`licence-register: ${DOC_PATH} is stale. Run: node scripts/ci/licence-register.mjs`);
    return 1;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  out(`licence-register: wrote ${DOC_PATH}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

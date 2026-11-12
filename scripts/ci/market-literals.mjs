// AT-67 / MKT-107 (M19, D-991, D-1000, D-1075 to D-1078): a market fact is written once, in the market profile
// seed. This scan fails when a market literal appears in code outside the allow-list. Zero dependencies.
//
//   node scripts/ci/market-literals.mjs           report every hit; exit 1 when any is outside the allow-list
//   node scripts/ci/market-literals.mjs --count   print the D-991 count and the hit count (never fails)
//   node scripts/ci/market-literals.mjs --root <dir>   scan another tree (the self-tests plant literals in a temp copy)
//
// What is scanned: `src`, `scripts`, `worker/src` (.ts .tsx .mts .mjs .js .d.mts .py .yml), comments stripped
// (`//`, `/* */`, `#` in Python and YAML, Python docstrings). Not scanned: `*.test.*`, `*.spec.*`, `test/`, `tests/`,
// `__tests__/`, `e2e/`, `scripts/ci/fixtures/`, `node_modules`, `.next` (D-1000; migrations and docs are outside the
// roots). The allow-list is `src/lib/market/**` (seed files, profileCore, homeMarket, staticProfile, clockTables,
// guard: the one place a market fact lives), the files registered in `src/lib/market/seed/allow.mjs`, and the
// precise entries of EXTRA_ALLOW below (each with a reason, and the classes it covers when not all).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The literal classes. Each regex is applied to the comment-stripped text of one line. */
export const CLASSES = Object.freeze({
  // a market code as a string value
  marketCode: /(["'`])(?:AU|IN|US)\1/,
  // exchange words as a string value, and the exchange cities anywhere in a code line (text of a label, a zone name).
  // Melbourne is the Owner's own zone (OWNER_TZ, UXN-313), the same for every market: not a market fact (D-1075).
  exchangeWord: /(["'`])(?:ASX|NSE|BSE|NYSE|Nasdaq)\1|\b(?:Sydney|Kolkata|Mumbai|New York)\b/,
  // the IANA zones of the three markets (the Owner zone Australia/Melbourne is not one, D-1075)
  zone: /Australia\/(?!Melbourne\b)|Asia\/Kolkata|America\/New_York/,
  // AU session, pre-open and cut-off times as a string value
  sessionTime: /["'`](?:10:00|16:00|16:10|09:55|09:54|17:30|17:50|18:10|18:40)["'`]/,
  // a currency symbol or code
  // (`A${` is an SVG arc command in a template, not a symbol; the en-AU date and number locale is the Owner's, D-1075)
  currency: /\bA\$(?!\{)|\bUS\$(?!\{)|₹|(["'`])(?:AUD|INR|USD)\1/,
  // the Yahoo symbol suffix of a market
  yahooSuffix: /\.(?:AX|NS|BO)["'`]/,
  // a benchmark or volatility index code
  indexCode: /["'`^]?(?:AXJO|XJO|GSPC|NSEI|INDIAVIX)["'`]/,
  // the AU parcel, ADV and tick literals of the money maths
  moneyLiteral: /\b(?:500_000_000n|50_000_000_000n)\b/,
  // the GICS scheme name as a string value
  classification: /["'`]gics/i,
});

/** Files and folders the scan never reads (D-1000). */
const SKIP_FILE = /\.(?:test|spec)\.[a-z]+$|(?:^|\/)test_[^/]*\.py$|_test\.py$/;
const SKIP_DIR = new Set(["test", "tests", "__tests__", "e2e", "node_modules", ".next"]);
const SKIP_PREFIX = ["scripts/ci/fixtures/"];
const EXT = /\.(?:ts|tsx|mts|mjs|js|py|yml)$/; // `.d.mts` ends in `.mts`
const ROOTS = ["src", "scripts", "worker/src"];

/**
 * Precise allow-list entries beyond `src/lib/market/**` and `allow.mjs` (D-1076). An entry names a `file` (or a `dir`
 * prefix ending in "/"), may narrow to `classes` and to the lines whose text holds `includes`, and always has a reason.
 * The scan reports an entry that matches no file or no hit: it is stale and must go.
 * @type {{ file?: string, dir?: string, classes?: string[], includes?: string, reason: string }[]}
 */
export const EXTRA_ALLOW = Object.freeze([
  {
    dir: "scripts/market/",
    reason:
      "the profile tooling (gen-seed-sql, gen-fixtures, snapshot-au) projects the seed to SQL, fixtures and the AU snapshot (D-992, D-1007)",
  },
  // ---- transitional code, recorded by its builder
  {
    file: "scripts/ingest/yahoo_fetch.py",
    classes: ["yahooSuffix", "currency"],
    includes: "DEFAULT_",
    reason:
      "TRANSITIONAL (M19 B2, CXA-002 h): the defaults used only while a request carries no suffix or currency; the Python tests assert them and Python is not available to prove their removal in M19",
  },
  // ---- onboarding and glossary copy: the AU strategy amounts stay as words (D-1003, per-market amounts are ARN-119 at M20)
  {
    file: "src/app/(app)/home/HomeContent.tsx",
    classes: ["currency"],
    reason:
      "onboarding copy of the six AU practice strategies' starting amount (D-1003: the numbers stay)",
  },
  {
    file: "src/app/(app)/home/WelcomeBanner.tsx",
    classes: ["currency"],
    reason:
      "onboarding copy of the AU starting amount, goal and loss limit (D-1003: the numbers stay)",
  },
  {
    file: "src/lib/view/terms.ts",
    classes: ["currency"],
    reason: "hover words of the AU strategy amounts (D-1003: the numbers stay)",
  },
  {
    file: "src/app/(app)/reviews/glossary/entries.ts",
    classes: ["currency"],
    includes: "stop-loss",
    reason: "a glossary example in AU dollars (teaching text, not a market fact)",
  },
  // ---- AU display tables and texts that describe the AU cost profiles, the AU parcel and the AU spec statements
  {
    file: "src/lib/view/costPlans.ts",
    classes: ["currency"],
    reason:
      "plain-words display of the AU broker plans P0 to P6 (the cost_formula tables are AU's; IN and US tables arrive with M20)",
  },
  {
    file: "src/lib/config/verify.ts",
    classes: ["currency"],
    reason:
      "verbatim AU spec statements the Owner verifies ([VERIFY] items such as the A$500 parcel and the AU tick table)",
  },
  {
    file: "src/lib/config/keys.ts",
    classes: ["currency"],
    reason:
      "AU-denominated bounds and reference text of the money keys (D-1003: numbers stay, the unit label reads market currency)",
  },
  {
    file: "src/lib/config/keys.ts",
    classes: ["sessionTime"],
    includes: 'timeIn("06:00", "10:00")',
    reason:
      "the Owner's morning-brief time window on the Melbourne clock; not a market session time",
  },
  {
    file: "src/lib/cortex/angles/d2.ts",
    classes: ["currency"],
    reason:
      "descriptive text of AU angles (the A$600 parcel, traded value in A$); editing it risks the AU recorded-night hashes (AT-32, AT-50)",
  },
  {
    file: "src/lib/cortex/angles/d7.ts",
    classes: ["currency"],
    reason:
      "descriptive text of an AU regime-rule angle (NAV in A$); editing it risks the AU recorded-night hashes",
  },
  {
    file: "src/lib/intraday/evaluator.ts",
    classes: ["currency"],
    reason: "plain-words description of the AU intraday evaluator's A$1,000 parcel (D-311)",
  },
  // ---- other precise entries
  {
    file: "src/app/(app)/health/WorkerSlotsForm.tsx",
    classes: ["exchangeWord", "zone"],
    reason:
      "client component that labels the Worker slot table, which is written in the home market's exchange zone; its props stay as the tests render them",
  },
  {
    file: "src/components/charts/TimeSeriesChart.tsx",
    classes: ["currency"],
    includes: "currency =",
    reason:
      "default symbol of a chart prop that no page uses yet (a required prop would change its tests); per-market callers pass the format at M20",
  },
  {
    file: "src/lib/llm/grounding.ts",
    classes: ["exchangeWord", "currency"],
    reason:
      "stop-list of acronyms the grounding check never treats as an unknown company code (ASX, AUD, USD are words, not a market choice)",
  },
  {
    file: "src/lib/view/format.ts",
    classes: ["marketCode"],
    includes: '"US",',
    reason:
      "uppercase-word list for company display names (a word of a company name), not a market code",
  },
  {
    file: "scripts/ci/market-literals.mjs",
    reason: "defines the literal classes (D-1000); its own patterns are the text it searches for",
  },
]);

const posix = (p) => p.split(path.sep).join("/");

/** The registered per-market rule files of `src/lib/market/seed/allow.mjs`, read as text (no import of the tree under test). */
export function readSeedAllow(root) {
  const f = path.join(root, "src/lib/market/seed/allow.mjs");
  if (!fs.existsSync(f)) return [];
  return [...fs.readFileSync(f, "utf8").matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
}

/** True for a path under the market profile folder (the one place a market fact lives). */
const inMarketFolder = (rel) => rel.startsWith("src/lib/market/");

/**
 * Comments blanked (newlines kept, so line numbers hold); strings stay. JavaScript family: `//` and block comments with
 * string, template and regex awareness; Python and YAML: `#` outside a quote, triple-quoted docstrings.
 * @param {string} text
 * @param {"js" | "hash"} kind
 */
export function stripComments(text, kind) {
  return kind === "hash" ? stripHash(text) : stripJs(text);
}

function blank(s) {
  return s.replace(/[^\n]/g, " ");
}

function stripHash(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      if (triple) {
        const end = text.indexOf(c.repeat(3), i + 3);
        const stop = end < 0 ? n : end + 3;
        // a triple-quoted block is a docstring or a multi-line value: a docstring is prose, so it is blanked
        out += blank(text.slice(i, stop));
        i = stop;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripJs(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  /** @type {number[]} brace depth per open template `${`; the template resumes when its `}` closes */
  const tpl = [];
  let depth = 0;
  let prev = ""; // last significant code character, for the regex-literal decision
  const REGEX_AFTER = "(,=:[!&|?{};+-*%<>~^";
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`" || (c === "}" && tpl.length > 0 && tpl[tpl.length - 1] === depth)) {
      // template body (from the opening backtick, or resumed after a `${ ... }`)
      if (c === "}") tpl.pop();
      out += c;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const t = text[j];
        if (t === "\\") {
          out += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (t === "`") {
          out += t;
          j++;
          closed = true;
          break;
        }
        if (t === "$" && text[j + 1] === "{") {
          out += "${";
          j += 2;
          tpl.push(depth);
          break;
        }
        out += t;
        j++;
      }
      i = j;
      prev = closed ? "`" : "{";
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_AFTER.includes(prev))) {
      // a regular-expression literal: copy it whole (a quote inside it is not a string)
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        const t = text[j];
        if (t === "\\") j += 2;
        else {
          if (t === "[") inClass = true;
          else if (t === "]") inClass = false;
          else if (t === "/" && !inClass) break;
          j++;
        }
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      prev = "/";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const kindOf = (rel) => (/\.(?:py|yml)$/.test(rel) ? "hash" : "js");

/**
 * Hits of one file's text. `rel` only chooses the comment syntax.
 * @param {string} text
 * @param {string} rel
 * @returns {{ line: number, cls: string, text: string }[]}
 */
export function scanText(text, rel) {
  const hits = [];
  const lines = stripComments(text, kindOf(rel)).split("\n");
  const raw = text.split("\n");
  lines.forEach((line, k) => {
    if (!line.trim()) return;
    for (const [cls, re] of Object.entries(CLASSES)) {
      if (re.test(line)) hits.push({ line: k + 1, cls, text: (raw[k] ?? "").trim() });
    }
  });
  return hits;
}

/** Every scanned file of a tree (repo-relative posix paths). */
export function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        if (SKIP_PREFIX.some((p) => `${r}/`.startsWith(p))) continue;
        walk(r);
      } else if (EXT.test(e.name) && !SKIP_FILE.test(e.name)) out.push(r);
    }
  };
  for (const r of ROOTS) walk(r);
  return out.sort();
}

/**
 * @param {string} root repository root (or a temp copy of the scanned folders)
 * @returns {{ hits: { file: string, line: number, cls: string, text: string }[], allowed: number, files: number,
 *   quotedFiles: string[], stale: string[] }}
 */
export function scanTree(root) {
  const registered = readSeedAllow(root);
  const used = new Set();
  const forFile = (rel) =>
    EXTRA_ALLOW.filter((e) =>
      e.file !== undefined ? e.file === rel : rel.startsWith(e.dir ?? "\0"),
    );
  const files = listFiles(root);
  const hits = [];
  const quotedFiles = [];
  let allowed = 0;
  for (const rel of files) {
    const found = scanText(fs.readFileSync(path.join(root, rel), "utf8"), rel);
    if (found.length === 0) continue;
    if (inMarketFolder(rel) || registered.includes(rel)) {
      allowed += found.length;
      continue;
    }
    const entries = forFile(rel);
    const kept = found.filter((h) => {
      const e = entries.find(
        (x) =>
          (!x.classes || x.classes.includes(h.cls)) &&
          (x.includes === undefined || h.text.includes(x.includes)),
      );
      if (e) used.add(e);
      return !e;
    });
    allowed += found.length - kept.length;
    for (const h of kept) hits.push({ file: rel, ...h });
    if (kept.some((h) => h.cls === "marketCode" && /(["'`])AU\1/.test(h.text)))
      quotedFiles.push(rel);
  }
  const stale = [
    ...registered.filter((f) => !fs.existsSync(path.join(root, f))),
    ...EXTRA_ALLOW.filter((e) => !used.has(e)).map(
      (e) => `${e.file ?? e.dir}${e.includes ? ` [${e.includes}]` : ""}`,
    ),
  ];
  return { hits, allowed, files: files.length, quotedFiles, stale };
}

function main(argv) {
  const rootArg = argv.indexOf("--root");
  const root =
    rootArg >= 0 ? path.resolve(argv[rootArg + 1]) : path.resolve(import.meta.dirname, "../..");
  const r = scanTree(root);
  const byFile = new Set(r.hits.map((h) => h.file));
  if (argv.includes("--count")) {
    console.log(
      `market-literals: ${byFile.size} files with a literal outside the allow-list (${r.hits.length} hits)`,
    );
    console.log(`market-literals: ${r.quotedFiles.length} files hold a quoted AU (D-991 count)`);
    return 0;
  }
  for (const h of r.hits) console.log(`${h.file}:${h.line}  [${h.cls}]  ${h.text.slice(0, 120)}`);
  for (const s of r.stale) console.log(`stale allow-list entry (file does not exist): ${s}`);
  console.log(
    `market-literals: ${r.hits.length} hits in ${byFile.size} files outside the allow-list ` +
      `(${r.allowed} allowed, ${r.files} files scanned)`,
  );
  return r.hits.length > 0 || r.stale.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));

// M21 Z (D-922, D-1233): no internal code in text an Owner reads. A static scan of the rendered-text sources (JSX
// text and string literals) for the internal codes of the spec and the build: strategy and family codes (E01, F1-U,
// C2-F1), requirement and decision ids (ARN-021, D-922, AT-82, O-71), priority tags (P0 to P2), NAV, CS/IS as words and
// [VERIFY]/[PROPOSED]. Comments and `data-*` attribute values are ignored (a test id is not text). Zero dependencies.
//
//   node scripts/ci/internal-codes.mjs                 report every hit outside the allow-list; exit 1 when any, or
//                                                      when an allow-list entry matched nothing (stale)
//   node scripts/ci/internal-codes.mjs --count         print the counts only (never fails)
//   node scripts/ci/internal-codes.mjs --root <dir>    scan another tree (the self-tests plant text in a temp copy)
//
// Scanned: `src/app/**`, `src/components/**`, `src/lib/view/**`, `src/lib/review/**`, `src/lib/email/templates/**`
// (.ts .tsx .mts .mjs .js; not `*.test.*`, `*.spec.*`, `*.d.ts`). The allow-list is
// `scripts/ci/internal-codes.allow.json`: only a genuine non-UI use or an Owner-only place, each with a reason; the
// page walk of e2e/m21-at82.spec.ts checks the rendered text with the same patterns (D-1234).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stripComments } from "./market-literals.mjs";

import { matchPatterns, PATTERNS } from "./internal-code-patterns.mjs";

export { matchPatterns, PATTERNS };

export const ROOTS = [
  "src/app",
  "src/components",
  "src/lib/view",
  "src/lib/review",
  "src/lib/email/templates",
];
const EXT = /\.(?:ts|tsx|mts|mjs|js)$/;
const SKIP_FILE = /\.(?:test|spec)\.[a-z]+$|\.d\.(?:ts|mts)$/;

const SQL = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|PRAGMA|CREATE|REPLACE)\b/;

const posix = (p) => p.split(path.sep).join("/");

// `<` is not here: `</p>` is a closing tag, not the start of a regular expression
const REGEX_AFTER = "(,=:[!&|?{};+-*%>~^";

/**
 * String literals of comment-stripped JavaScript or TypeScript (template literals: the static text, and the code inside
 * each `${ }` is scanned in turn). Regex literals are skipped.
 * @param {string} code
 * @param {number} line1 line number of the first character
 * @param {{ line: number, text: string, before: string }[]} out
 */
function collectStrings(code, line1, out) {
  const n = code.length;
  let i = 0;
  let line = line1;
  let prev = "";
  const lineAt = (idx) => line1 + (code.slice(0, idx).match(/\n/g)?.length ?? 0);
  while (i < n) {
    const c = code[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      out.push({
        line,
        text: code.slice(i + 1, j),
        before: code.slice(Math.max(0, i - 40), i),
      });
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let stat = "";
      const startLine = line;
      while (j < n && code[j] !== "`") {
        if (code[j] === "\\") {
          stat += code.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (code[j] === "$" && code[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (code[k] === "{") depth++;
            else if (code[k] === "}") depth--;
            k++;
          }
          collectStrings(code.slice(j + 2, k - 1), lineAt(j + 2), out);
          stat += " ";
          j = k;
          continue;
        }
        stat += code[j];
        j++;
      }
      out.push({ line: startLine, text: stat, before: code.slice(Math.max(0, i - 40), i) });
      line = lineAt(Math.min(j, n));
      i = j + 1;
      prev = "`";
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_AFTER.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== "\n") {
        const t = code[j];
        if (t === "\\") j += 2;
        else {
          if (t === "[") inClass = true;
          else if (t === "]") inClass = false;
          else if (t === "/" && !inClass) break;
          j++;
        }
      }
      i = code[j] === "\n" ? j : j + 1;
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
}

/**
 * Hits of one file's text: string literals and (in .tsx) JSX text, comments dropped, `data-*` values and module
 * specifiers ignored.
 * @param {string} text
 * @param {string} rel only its extension matters (JSX text is read in .tsx)
 * @returns {{ line: number, pattern: string, text: string }[]}
 */
export function scanText(text, rel) {
  const code = stripComments(text, "js");
  /** @type {{ line: number, text: string, before: string }[]} */
  const found = [];
  collectStrings(code, 1, found);
  const units = found
    .filter(
      (s) =>
        !/data-[\w-]+\s*=\s*\{?\s*$/.test(s.before) &&
        !/\b(?:from|import|require)\s*\(?\s*$/.test(s.before) &&
        // a SQL statement is code the reader never sees (its IS NULL is not the word IS)
        !SQL.test(s.text),
    )
    .map((s) => ({ line: s.line, text: s.text }));
  if (rel.endsWith(".tsx")) {
    for (const m of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
      const lead = m[1].length - m[1].trimStart().length;
      const line = 1 + (code.slice(0, m.index + 1 + lead).match(/\n/g)?.length ?? 0);
      units.push({ line, text: m[1] });
    }
  }
  const hits = [];
  const seen = new Set();
  for (const u of units) {
    for (const pattern of matchPatterns(u.text)) {
      const key = `${u.line}:${pattern}:${u.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ line: u.line, pattern, text: u.text.replace(/\s+/g, " ").trim() });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** Every scanned file of a tree (repo-relative posix paths). */
export function listFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".next") walk(r);
      } else if (EXT.test(e.name) && !SKIP_FILE.test(e.name)) out.push(r);
    }
  };
  for (const r of ROOTS) walk(r);
  return out.sort();
}

/**
 * @typedef {{ file: string, includes?: string, patterns?: string[], reason: string }} AllowEntry
 * An entry names a `file`, may narrow to the lines whose text holds `includes` and to some `patterns`, and has a reason.
 */

/** @param {string} root */
export function readAllow(root) {
  const f = path.join(root, "scripts/ci/internal-codes.allow.json");
  if (!fs.existsSync(f)) return { problems: [], entries: [] };
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  const problems = [];
  for (const e of entries) {
    if (typeof e.file !== "string" || e.file === "")
      problems.push(`allow-list entry without a file: ${JSON.stringify(e)}`);
    if (typeof e.reason !== "string" || e.reason.trim().length < 10)
      problems.push(`allow-list entry for ${e.file} has no reason`);
  }
  return { problems, entries };
}

/**
 * @param {string} root repository root (or a temp copy holding the scanned folders)
 * @returns {{ hits: { file: string, line: number, pattern: string, text: string }[], allowed: number, files: number,
 *   stale: string[], problems: string[] }}
 */
export function scanTree(root) {
  const { problems, entries } = readAllow(root);
  const used = new Set();
  const files = listFiles(root);
  const hits = [];
  let allowed = 0;
  for (const rel of files) {
    const found = scanText(fs.readFileSync(path.join(root, rel), "utf8"), rel);
    for (const h of found) {
      const e = entries.find(
        (x) =>
          x.file === rel &&
          (x.includes === undefined || h.text.includes(x.includes)) &&
          (x.patterns === undefined || x.patterns.includes(h.pattern)),
      );
      if (e) {
        used.add(e);
        allowed++;
      } else hits.push({ file: rel, ...h });
    }
  }
  const stale = entries
    .filter((e) => !used.has(e))
    .map((e) => `${e.file}${e.includes ? ` [${e.includes}]` : ""}`);
  return { hits, allowed, files: files.length, stale, problems };
}

function main(argv) {
  const rootArg = argv.indexOf("--root");
  const root =
    rootArg >= 0 ? path.resolve(argv[rootArg + 1]) : path.resolve(import.meta.dirname, "../..");
  const r = scanTree(root);
  if (argv.includes("--count")) {
    console.log(
      `internal-codes: ${r.hits.length} hits, ${r.allowed} allowed, ${r.stale.length} stale, ${r.files} files`,
    );
    return 0;
  }
  for (const h of r.hits)
    console.log(`${posix(h.file)}:${h.line}  [${h.pattern}]  ${h.text.slice(0, 120)}`);
  for (const s of r.stale) console.log(`stale allow-list entry (matches no hit): ${s}`);
  for (const p of r.problems) console.log(p);
  console.log(
    `internal-codes: ${r.hits.length} hits outside the allow-list (${r.allowed} allowed, ${r.files} files scanned)`,
  );
  return r.hits.length > 0 || r.stale.length > 0 || r.problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));

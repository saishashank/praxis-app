// UXN-030: Flesch-Kincaid grade check over headings, labels, buttons and summaries collected from
// rendered pages (e2e/readability.spec.ts). Zero dependencies.
//   grade = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59
// Rules: each collected item counts as one sentence (plus any inner sentence breaks); glossary terms
// and numbers are removed before scoring; the grade of every kind of text on a page (headings,
// labels, buttons, summaries) must be <= 8, and so must any single item of 8 or more words. Exceptions
// (e2e/readability-exceptions.json, Owner-reviewed) drop an exact text, optionally for one page.
// Usage: node scripts/ci/readability.mjs <collected.json>
//   collected.json = { "terms": ["Round", ...], "pages": [{ "path": "/", "items": [{ "kind": "heading", "text": "Today" }] }] }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_GRADE = 8;
export const LONG_ITEM_WORDS = 8;
export const MIN_GROUP_WORDS = 12;
export const KINDS = ["heading", "label", "button", "summary"];

/** Syllable estimate for one English word (vowel groups, silent e, a few endings). */
export function countSyllables(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouyxzsghc]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export const wordsOf = (text) => text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remove glossary terms (longest first, whole words, case-insensitive) and number-bearing tokens. */
export function stripExcluded(text, terms = []) {
  let out = text;
  const sorted = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const t of sorted) {
    out = out.replace(new RegExp(`(?<![A-Za-z])${escapeRe(t)}(?![A-Za-z])`, "gi"), " ");
  }
  return out
    .split(/\s+/)
    .filter((tok) => !/\d/.test(tok))
    .join(" ");
}

/** Flesch-Kincaid grade over a list of texts, each text at least one sentence. */
export function gradeOf(texts) {
  let words = 0;
  let syllables = 0;
  let sentences = 0;
  for (const t of texts) {
    const w = wordsOf(t);
    if (w.length === 0) continue;
    words += w.length;
    syllables += w.reduce((a, x) => a + countSyllables(x), 0);
    sentences += Math.max(1, t.split(/[.!?]+(?:\s|$)/).filter((s) => wordsOf(s).length).length);
  }
  if (words === 0) return { grade: 0, words, sentences, syllables };
  const grade = 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
  return { grade: Math.round(grade * 10) / 10, words, sentences, syllables };
}

const isExcepted = (exceptions, pagePath, text) =>
  exceptions.some((e) => e.text.trim() === text.trim() && (!e.page || e.page === pagePath));

/**
 * pages: [{ path, items: [{ kind, text }] }]. Returns { failures, applied, summary }.
 * failures: [{ page, kind, text?, grade }]; applied: exceptions that matched something.
 */
export function analyse(pages, { terms = [], exceptions = [], maxGrade = MAX_GRADE } = {}) {
  const failures = [];
  const applied = new Set();
  const summary = [];
  for (const page of pages) {
    const kept = [];
    for (const it of page.items) {
      if (isExcepted(exceptions, page.path, it.text)) {
        applied.add(it.text.trim());
        continue;
      }
      const text = stripExcluded(it.text, terms);
      if (wordsOf(text).length) kept.push({ kind: it.kind, text, original: it.text });
    }
    for (const kind of KINDS) {
      const of = kept.filter((k) => k.kind === kind);
      if (!of.length) continue;
      const g = gradeOf(of.map((k) => k.text));
      summary.push({ page: page.path, kind, count: of.length, grade: g.grade });
      // The formula means nothing on a handful of words ("Today" scores 8.4), so a group is graded
      // only from MIN_GROUP_WORDS words; shorter groups still count in the whole-page grade below.
      if (g.words >= MIN_GROUP_WORDS && g.grade > maxGrade) {
        failures.push({ page: page.path, kind, grade: g.grade });
      }
      for (const k of of) {
        if (wordsOf(k.text).length < LONG_ITEM_WORDS) continue;
        const ig = gradeOf([k.text]).grade;
        if (ig > maxGrade) failures.push({ page: page.path, kind, text: k.original, grade: ig });
      }
    }
    const all = gradeOf(kept.map((k) => k.text));
    if (all.words >= MIN_GROUP_WORDS && all.grade > maxGrade) {
      failures.push({ page: page.path, kind: "all", grade: all.grade });
    }
  }
  return { failures, applied: [...applied], summary };
}

export function report(result) {
  const lines = ["page  kind  items  grade"];
  for (const s of result.summary) lines.push(`${s.page}  ${s.kind}  ${s.count}  ${s.grade}`);
  if (result.applied.length) {
    lines.push("", "Exceptions in use (for Owner review):");
    for (const a of result.applied) lines.push(`  ${a}`);
  }
  for (const f of result.failures) {
    lines.push(
      `FAIL ${f.page} ${f.kind} grade ${f.grade} > ${MAX_GRADE}${f.text ? `: "${f.text}"` : " (whole group)"}`,
    );
  }
  return lines.join("\n");
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/ci/readability.mjs <collected.json>");
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const exFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../e2e/readability-exceptions.json",
  );
  const exceptions = fs.existsSync(exFile)
    ? (JSON.parse(fs.readFileSync(exFile, "utf8")).exceptions ?? [])
    : [];
  const result = analyse(data.pages, { terms: data.terms ?? [], exceptions });
  console.log(report(result));
  if (result.failures.length) process.exit(1);
  console.log("readability: all pages at grade 8 or below");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

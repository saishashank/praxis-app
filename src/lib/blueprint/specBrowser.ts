// Blueprint spec browser loader (M16 WP7; UXN-300, D-360, SEC-110). Server-only and read-only.
// It lists and renders ONLY the v1 spec chapters in the repo `spec/` and three allow-listed files in
// `docs/` (decision log, open questions, configuration reference). V2 chapter bodies are never read or
// published: they live in the private data repo (SEC-110). It also builds the requirement-ID index
// (ID -> model elements) from the committed architecture model. Rendering is a small markdown subset
// where every character of source text is HTML-escaped, so no tag, attribute or URL from a document
// can reach the page (sanitised by construction).
import "server-only";
import fs from "node:fs";
import path from "node:path";

export type SpecDoc = { key: string; title: string; group: "spec" | "docs"; file: string };
export type IndexElement = { id: string; name: string; type: string };
export type SpecIndex = Map<string, IndexElement[]>;
export type ModelLike = {
  elements: readonly {
    id: string;
    name?: string;
    type?: string;
    specIds?: readonly string[];
  }[];
};

export const SPEC_DIR = "spec";
/** The only files outside spec/ the browser may read. */
export const DOCS_ALLOW: Readonly<Record<string, string>> = {
  "decision-log": "docs/07_decision_log.md",
  "open-questions": "docs/06_open_questions.md",
  "config-reference": "docs/config-reference.md",
};
// v1 chapters are 00..16 (CLAUDE.md / SEC-110); anything else in spec/ is not listed.
const V1_CHAPTER = /^(0\d|1[0-6])_[A-Za-z0-9_]+\.md$/;

function titleOf(text: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1]!.trim() : fallback;
}

export function listSpecDocs(root: string = process.cwd()): SpecDoc[] {
  const out: SpecDoc[] = [];
  const dir = path.join(root, SPEC_DIR);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => V1_CHAPTER.test(n)) : [];
  for (const n of names.sort()) {
    const file = `${SPEC_DIR}/${n}`;
    out.push({
      key: n.replace(/\.md$/, ""),
      title: titleOf(fs.readFileSync(path.join(root, file), "utf8"), n),
      group: "spec",
      file,
    });
  }
  for (const [key, file] of Object.entries(DOCS_ALLOW)) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    out.push({ key, title: titleOf(fs.readFileSync(abs, "utf8"), key), group: "docs", file });
  }
  return out;
}

// ---- rendering ---------------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(s: string): string {
  let h = escapeHtml(s);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Links render as their text; the target is dropped (no URL from a document reaches the page).
  h = h.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return h;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const LIST_ITEM = /^\s*([-*]|\d+\.)\s+/;

/** Markdown subset to HTML: headings, paragraphs, lists, fenced code, tables. Text is escaped. */
export function renderMarkdown(md: string): string {
  const lines = md
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const lvl = /^#+/.exec(line)![0].length;
      out.push(`<h${lvl}>${inline(line.replace(/^#+\s+/, ""))}</h${lvl}>`);
      i++;
    } else if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
    } else if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        items.push(`<li>${inline(lines[i++]!.replace(LIST_ITEM, ""))}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (line.trim() === "") {
      i++;
    } else {
      const buf: string[] = [];
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !/^(```|#{1,6}\s|\s*\|)/.test(lines[i]!) &&
        !LIST_ITEM.test(lines[i]!)
      ) {
        buf.push(lines[i++]!);
      }
      if (buf.length === 0) buf.push(lines[i++]!);
      out.push(`<p>${inline(buf.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

/** Render one listed document (by key) to sanitised HTML, or null when the key is not listed. */
export function renderSpecDoc(
  key: string,
  root: string = process.cwd(),
): { doc: SpecDoc; html: string } | null {
  const doc = listSpecDocs(root).find((d) => d.key === key);
  if (!doc) return null;
  return { doc, html: renderMarkdown(fs.readFileSync(path.join(root, doc.file), "utf8")) };
}

// ---- requirement-ID index ------------------------------------------------------------------------

export function loadModel(root: string = process.cwd()): ModelLike {
  return JSON.parse(
    fs.readFileSync(path.join(root, "docs/architecture/architecture.json"), "utf8"),
  ) as ModelLike;
}

export function buildSpecIndex(model: ModelLike): SpecIndex {
  const idx: SpecIndex = new Map();
  for (const e of model.elements) {
    for (const sid of e.specIds ?? []) {
      const list = idx.get(sid) ?? [];
      list.push({ id: e.id, name: e.name ?? e.id, type: e.type ?? "" });
      idx.set(sid, list);
    }
  }
  return new Map([...idx.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Case-insensitive substring search over requirement IDs; empty query returns every ID. */
export function searchSpecIndex(
  index: SpecIndex,
  query: string,
): { id: string; elements: IndexElement[] }[] {
  const q = query.trim().toLowerCase();
  return [...index.entries()]
    .filter(([id]) => q === "" || id.toLowerCase().includes(q))
    .map(([id, elements]) => ({ id, elements }));
}

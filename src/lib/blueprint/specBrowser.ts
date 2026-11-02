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

// ---- parsing ----------------------------------------------------------------------------------
// Markdown subset to a plain block list; the page turns the blocks into React elements, so every text
// child is escaped by React and no HTML string exists anywhere (display-text rule).

export type Inline = { k: "text" | "code" | "strong"; s: string };
export type Block =
  | { t: "h"; level: number; inl: Inline[] }
  | { t: "p"; inl: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "code"; text: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

export function parseInline(src: string): Inline[] {
  // Links keep their text; the target is dropped (no URL from a document reaches the page).
  const s = src.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push({ k: "text", s: s.slice(last, m.index) });
    out.push(m[1] !== undefined ? { k: "code", s: m[1] } : { k: "strong", s: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ k: "text", s: s.slice(last) });
  return out;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const LIST_ITEM = /^\s*([-*]|\d+\.)\s+/;

export function parseMarkdown(md: string): Block[] {
  const lines = md
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      out.push({ t: "code", text: buf.join("\n") });
    } else if (/^#{1,6}\s/.test(line)) {
      const level = /^#+/.exec(line)![0].length;
      out.push({ t: "h", level, inl: parseInline(line.replace(/^#+\s+/, "")) });
      i++;
    } else if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        rows.push(cells(lines[i++]!).map(parseInline));
      }
      out.push({ t: "table", head, rows });
    } else if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: Inline[][] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) {
        items.push(parseInline(lines[i++]!.replace(LIST_ITEM, "")));
      }
      out.push({ t: "list", ordered, items });
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
      out.push({ t: "p", inl: parseInline(buf.join(" ")) });
    }
  }
  return out;
}

/** Parse one listed document (by key) into blocks, or null when the key is not listed. */
export function renderSpecDoc(
  key: string,
  root: string = process.cwd(),
): { doc: SpecDoc; blocks: Block[] } | null {
  const doc = listSpecDocs(root).find((d) => d.key === key);
  if (!doc) return null;
  return { doc, blocks: parseMarkdown(fs.readFileSync(path.join(root, doc.file), "utf8")) };
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

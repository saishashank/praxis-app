// Email block model and the two renderers (HTML and plain text) shared by every template
// (M5 T4, design 4.6, EML-013, TST-129, D-098 draft).
//
// A template builds a list of blocks from typed facts; `renderHtml` and `renderText` turn the same
// blocks into the HTML part and the plain-text alternative, so every template has both by
// construction and every string is escaped in one place. HTML rules: inline styles on every element
// (plus a small <style> block for dark mode and the 600 px single-column rule), tables for layout,
// no images, no remote fonts or stylesheets, no tracking pixels, only http(s) links.

import { glyphBar } from "./format";
import { DARK, LIGHT } from "./palette";

export type EnvName = "production" | "staging";
export type Tone = "pos" | "neg" | "warn" | "muted";

export interface CellObj {
  text: string;
  tone?: Tone;
  href?: string;
  bold?: boolean;
}
export type Cell = string | CellObj;

export type Block =
  | { t: "h"; text: string; level?: 1 | 2 }
  | { t: "p"; text: string; tone?: Tone; bold?: boolean }
  | { t: "small"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "kpis"; tiles: { label: string; value: string; sub?: string; tone?: Tone }[] }
  | { t: "table"; head: string[]; rows: Cell[][]; right?: number[] }
  | { t: "kv"; rows: [string, Cell][] }
  | { t: "box"; title: string; lines: string[]; tone?: Tone }
  | { t: "link"; label: string; href: string }
  | { t: "bar"; label: string; percent: number; valueText: string };

export interface Doc {
  title: string;
  preheader: string;
  blocks: Block[];
  footer: Block[];
}

export interface EmailOut {
  subject: string;
  html: string;
  text: string;
}

export interface SizedEmailOut extends EmailOut {
  /** Bytes of the complete HTML part before transfer encoding (EML-013, s13). */
  sizeHtml: number;
  /** Size-ladder level that produced this output (0 = full detail). */
  ladderLevel: number;
  /** True when even the last ladder level exceeds the limit. */
  oversize: boolean;
}

export const KB = 1024;
export const REVIEW_MAX_BYTES = 90 * KB; // email_max_size (ch15 l.164)
export const SMALL_MAX_BYTES = 20 * KB; // EML-023 reminder and the other small templates

// ---------------------------------------------------------------------------------------------
// Escaping and links
// ---------------------------------------------------------------------------------------------

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/** Only absolute http(s) URLs without whitespace or control characters become links. */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  if (/[\s\u0000-\u001f<>"'`]/.test(url)) return null;
  return /^https?:\/\/[^/\s]+/i.test(url) ? url : null;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Subject line hygiene: single line, no control characters, bounded length. */
export function cleanSubject(s: string, max = 150): string {
  const one = s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** "[STAGING] " prefix on every staging subject (EML-004). */
export function withEnvPrefix(env: EnvName, subject: string): string {
  return cleanSubject(env === "staging" ? `[STAGING] ${subject}` : subject);
}

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------

type Role = "pg" | "sf" | "tx" | "mu" | "ac" | "po" | "ng" | "wn" | "bd";

const ROLE_CSS: Record<Role, (p: typeof LIGHT) => string> = {
  pg: (p) => `background-color:${p.bg};color:${p.text};`,
  sf: (p) => `background-color:${p.surface};color:${p.text};`,
  tx: (p) => `color:${p.text};`,
  mu: (p) => `color:${p.muted};`,
  ac: (p) => `color:${p.accent};`,
  po: (p) => `color:${p.positive};`,
  ng: (p) => `color:${p.negative};`,
  wn: (p) => `color:${p.warning};`,
  bd: (p) => `border-color:${p.border};`,
};

const TONE_ROLE: Record<Tone, Role> = { pos: "po", neg: "ng", warn: "wn", muted: "mu" };

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";

/** `class` + inline `style` for a role; extra CSS is appended to the inline style. */
function at(role: Role, extra = ""): string {
  return `class="${role}" style="${ROLE_CSS[role](LIGHT)}${extra}"`;
}

function darkCss(): string {
  const roles = Object.keys(ROLE_CSS) as Role[];
  return roles.map((r) => `.${r}{${ROLE_CSS[r](DARK).replace(/;/g, " !important;")}}`).join("");
}

const STYLE_BLOCK =
  `<style>@media (prefers-color-scheme: dark){${darkCss()}}` +
  `@media only screen and (max-width:600px){.w{width:100% !important}` +
  `.kpi{display:block !important;width:100% !important;box-sizing:border-box}}</style>`;

function cellObj(c: Cell): CellObj {
  return typeof c === "string" ? { text: c } : c;
}

function cellHtml(c: Cell): string {
  const o = cellObj(c);
  const href = safeHref(o.href);
  const weight = o.bold ? "font-weight:700;" : "";
  if (href)
    return `<a href="${esc(href)}" ${at("ac", `${weight}text-decoration:underline;`)}>${esc(o.text)}</a>`;
  if (o.tone) return `<span ${at(TONE_ROLE[o.tone], weight)}>${esc(o.text)}</span>`;
  return o.bold ? `<strong>${esc(o.text)}</strong>` : esc(o.text);
}

function blockHtml(b: Block): string {
  switch (b.t) {
    case "h":
      return b.level === 1
        ? `<h1 ${at("tx", "font-size:20px;line-height:26px;margin:0 0 8px;")}>${esc(b.text)}</h1>`
        : `<h2 ${at("tx", "font-size:16px;line-height:22px;margin:20px 0 6px;")}>${esc(b.text)}</h2>`;
    case "p": {
      const role = b.tone ? TONE_ROLE[b.tone] : "tx";
      return `<p ${at(role, `margin:0 0 8px;${b.bold ? "font-weight:700;" : ""}`)}>${esc(b.text)}</p>`;
    }
    case "small":
      return `<p ${at("mu", "margin:0 0 6px;font-size:12px;line-height:17px;")}>${esc(b.text)}</p>`;
    case "ul":
      return b.items.length === 0
        ? ""
        : `<ul ${at("tx", "margin:0 0 8px;padding-left:20px;")}>${b.items
            .map((i) => `<li style="margin:0 0 3px;">${esc(i)}</li>`)
            .join("")}</ul>`;
    case "kpis": {
      const n = Math.max(1, b.tiles.length);
      const w = Math.floor(100 / n);
      const tiles = b.tiles
        .map((t) => {
          const vr = t.tone ? TONE_ROLE[t.tone] : "tx";
          return (
            `<td class="kpi" valign="top" style="width:${w}%;padding:4px;">` +
            `<div ${at("sf", "border:1px solid;padding:8px 10px;")} data-kpi="1">` +
            `<div ${at("mu", "font-size:12px;line-height:16px;")}>${esc(t.label)}</div>` +
            `<div ${at(vr, "font-size:17px;line-height:24px;font-weight:700;")}>${esc(t.value)}</div>` +
            (t.sub
              ? `<div ${at("mu", "font-size:12px;line-height:16px;")}>${esc(t.sub)}</div>`
              : "") +
            `</div></td>`
          );
        })
        .join("");
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;border-collapse:collapse;"><tr>${tiles}</tr></table>`;
    }
    case "table": {
      const right = new Set(b.right ?? []);
      const th = b.head
        .map(
          (h, i) =>
            `<th scope="col" ${at("sf", `border:1px solid;padding:4px 6px;font-size:12px;text-align:${right.has(i) ? "right" : "left"};`)}>${esc(h)}</th>`,
        )
        .join("");
      const body = b.rows
        .map(
          (r) =>
            `<tr>${r
              .map(
                (c, i) =>
                  `<td ${at("tx", `border:1px solid;padding:4px 6px;font-size:13px;vertical-align:top;text-align:${right.has(i) ? "right" : "left"};`)}>${cellHtml(c)}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      return `<table width="100%" cellpadding="0" cellspacing="0" ${at("bd", "margin:0 0 8px;border-collapse:collapse;border:1px solid;")}><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
    }
    case "kv":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;border-collapse:collapse;">${b.rows
        .map(
          ([k, v]) =>
            `<tr><td ${at("mu", "padding:2px 8px 2px 0;font-size:13px;vertical-align:top;width:35%;")}>${esc(k)}</td><td ${at("tx", "padding:2px 0;font-size:13px;vertical-align:top;")}>${cellHtml(v)}</td></tr>`,
        )
        .join("")}</table>`;
    case "box": {
      const tr = b.tone ? TONE_ROLE[b.tone] : "tx";
      return (
        `<div ${at("sf", "border:1px solid;border-left-width:4px;padding:8px 12px;margin:0 0 10px;")}>` +
        `<div ${at(tr, "font-weight:700;margin:0 0 4px;")}>${esc(b.title)}</div>` +
        b.lines.map((l) => `<div ${at("tx", "margin:0 0 2px;")}>${esc(l)}</div>`).join("") +
        `</div>`
      );
    }
    case "link": {
      const href = safeHref(b.href);
      return href
        ? `<p style="margin:0 0 8px;"><a href="${esc(href)}" ${at("ac", "text-decoration:underline;")}>${esc(b.label)}</a></p>`
        : `<p ${at("tx", "margin:0 0 8px;")}>${esc(b.label)}</p>`;
    }
    case "bar":
      return `<p ${at("tx", "margin:0 0 4px;font-size:13px;")}>${esc(b.label)} <span aria-hidden="true" ${at("ac", `${MONO}letter-spacing:1px;`)}>${glyphBar(b.percent)}</span> ${esc(b.valueText)}</p>`;
  }
}

export function renderHtml(doc: Doc): string {
  const body = doc.blocks.map(blockHtml).join("");
  const foot = doc.footer.map(blockHtml).join("");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${esc(doc.title)}</title>${STYLE_BLOCK}</head>` +
    `<body ${at("pg", `margin:0;padding:0;${FONT}font-size:14px;line-height:20px;`)}>` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(doc.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ${at("pg")}><tr><td align="center" style="padding:12px;">` +
    `<table role="presentation" class="w" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;text-align:left;border-collapse:collapse;">` +
    `<tr><td ${at("pg", `${FONT}`)}>${body}` +
    `<div ${at("bd", "border-top:1px solid;margin-top:16px;padding-top:8px;")}>${foot}</div>` +
    `</td></tr></table></td></tr></table></body></html>`
  );
}

// ---------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------

function cellText(c: Cell): string {
  const o = cellObj(c);
  const href = safeHref(o.href);
  return href ? `${o.text} (${href})` : o.text;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function blockText(b: Block): string {
  switch (b.t) {
    case "h":
      return b.level === 1
        ? `${b.text.toUpperCase()}\n`
        : `\n${b.text}\n${"-".repeat(Math.min(b.text.length, 60))}`;
    case "p":
    case "small":
      return b.text;
    case "ul":
      return b.items.map((i) => `- ${oneLine(i)}`).join("\n");
    case "kpis":
      return b.tiles.map((t) => `* ${t.label}: ${t.value}${t.sub ? ` (${t.sub})` : ""}`).join("\n");
    case "table":
      return [
        b.head.join(" | "),
        ...b.rows.map((r) => r.map((c) => oneLine(cellText(c))).join(" | ")),
      ].join("\n");
    case "kv":
      return b.rows.map(([k, v]) => `${k}: ${oneLine(cellText(v))}`).join("\n");
    case "box":
      return [`[${b.title}]`, ...b.lines.map((l) => `  ${l}`)].join("\n");
    case "link": {
      const href = safeHref(b.href);
      return href ? `${b.label}: ${href}` : b.label;
    }
    case "bar":
      return `${b.label} ${glyphBar(b.percent)} ${b.valueText}`;
  }
}

export function renderText(doc: Doc): string {
  const parts = [...doc.blocks.map(blockText), "--", ...doc.footer.map(blockText)];
  return `${parts.filter((p) => p !== "").join("\n\n")}\n`;
}

export function renderEmail(subject: string, doc: Doc): EmailOut {
  return { subject, html: renderHtml(doc), text: renderText(doc) };
}

// ---------------------------------------------------------------------------------------------
// Size ladder
// ---------------------------------------------------------------------------------------------

/**
 * Renders at ladder level 0, 1, ... until the HTML part is within `maxBytes` (bytes of the
 * complete HTML part, UTF-8, before transfer encoding). If the last level is still too large the
 * last level is returned with `oversize: true`.
 */
export function fitLadder(
  render: (level: number) => EmailOut,
  maxLevel: number,
  maxBytes: number,
): SizedEmailOut {
  let out = render(0);
  let size = Buffer.byteLength(out.html, "utf8");
  let level = 0;
  while (size > maxBytes && level < maxLevel) {
    level += 1;
    out = render(level);
    size = Buffer.byteLength(out.html, "utf8");
  }
  return { ...out, sizeHtml: size, ladderLevel: level, oversize: size > maxBytes };
}

export const SEC_016_FOOTER =
  "Emails from this system never ask for keys or passwords. Sign in and do rotations only via your own bookmark.";

/** Footer used by every template (no unsubscribe: Owner-only transactional mail, D-098 draft). */
export function standardFooter(appUrl: string, env: EnvName, note?: string): Block[] {
  const out: Block[] = [];
  if (note) out.push({ t: "small", text: note });
  out.push({ t: "small", text: "Simulation for personal information only; not financial advice." });
  // SEC-016 / GL-08: the fixed anti-phishing footer on every email.
  out.push({ t: "small", text: SEC_016_FOOTER });
  out.push({ t: "link", label: "Open Praxis", href: appUrl });
  out.push({
    t: "small",
    text:
      "This is a transactional email sent to the account Owner only; there is no mailing list, so there is nothing to unsubscribe from. Reviews can be paused in Settings." +
      (env === "staging" ? " STAGING environment: not production data." : ""),
  });
  return out;
}

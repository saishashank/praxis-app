// WCAG 2.2 contrast check for the theme tokens (UXN-001, UXN-280, UX-001, AT-26).
// Zero dependencies. Parses src/styles/themes.css and checks every defined text/background pair
// in every theme. AA: 4.5:1 text, 3:1 UI components. High contrast: 7:1 text (AAA).
// Usage: node scripts/ci/contrast-check.mjs [path/to/themes.css]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/styles/themes.css",
);

// kind "text" = text on a background; "ui" = border / focus ring / icon against a background.
export const PAIRS = [
  ["text", "bg", "text"],
  ["text", "surface", "text"],
  ["text-muted", "bg", "text"],
  ["text-muted", "surface", "text"],
  ["accent", "bg", "text"],
  ["accent", "surface", "text"],
  ["accent-contrast", "accent", "text"],
  ["positive", "bg", "text"],
  ["positive", "surface", "text"],
  ["negative", "bg", "text"],
  ["negative", "surface", "text"],
  ["warning", "bg", "text"],
  ["warning", "surface", "text"],
  ["border", "bg", "ui"],
  ["focus", "bg", "ui"],
  ["focus", "surface", "ui"],
  // M7 T1 (D-130): text-bearing families (badges, status text) on both surfaces, plus surface-2.
  ...[
    "regime-shock",
    "regime-riskoff",
    "regime-riskon",
    "regime-neutral",
    "label-unvalidated",
    "label-passed",
    "label-consistent",
    "label-failed",
    "label-notdemo",
    "label-unvalidatable",
    "breaker-green",
    "breaker-amber",
    "breaker-red",
    "danger",
  ].flatMap((t) => [
    [t, "bg", "text"],
    [t, "surface", "text"],
    [t, "surface-2", "text"],
  ]),
  ["text", "surface-2", "text"],
  ["text-muted", "surface-2", "text"],
  ["accent-contrast", "danger", "text"], // destructive button label
  // Graphics (3:1): chart series and grid lines against both surfaces.
  ...["chart-1", "chart-2", "chart-3", "chart-4", "grid"].flatMap((t) => [
    [t, "surface", "ui"],
    [t, "surface-2", "ui"],
  ]),
];

// V2 palette (UXR-051..058, D-208): hue tokens carry -fill (vivid, non-text, 3:1 as a UI component),
// -text (AA 4.5, AAA 7 in High contrast) and -on-fill (label colour on the fill).
export const V2_HUES = [
  "brand-a",
  "brand-b",
  "positive",
  "negative",
  "outcome-flat",
  "tier-p0",
  "tier-p1",
  "tier-p2",
  ...["br", "vc", "nd", "bo", "sc", "co", "ex", "id"].map((x) => `family-${x}`),
  ...["running", "allowed", "livetested", "target", "paused", "stopped", "shadow"].map(
    (x) => `status-${x}`,
  ),
  ...[
    "energy",
    "materials",
    "industrials",
    "discretionary",
    "staples",
    "healthcare",
    "financials",
    "tech",
    "comms",
    "utilities",
    "realestate",
  ].map((x) => `sector-${x}`),
];
// Badges of these never sit on surface-2 (same rule as the palette generator).
const NO_S2 = /^(brand-|family-|sector-)/;

// A background may be "<token>" or "<token>+tint:<hue>": the token mixed with the hue's fill at the
// theme's --tint-strength (the strongest tint a band or tile uses), like color-mix(in srgb, ...).
export const V2_PAIRS = V2_HUES.flatMap((h) => {
  const surfaces = NO_S2.test(h) ? ["bg", "surface"] : ["bg", "surface", "surface-2"];
  return [
    ...surfaces.flatMap((b) => [
      [`${h}-text`, b, "text"],
      [`${h}-text`, `${b}+tint:${h}`, "text"],
      [`${h}-fill`, b, "ui"],
    ]),
    [`${h}-on-fill`, `${h}-fill`, "text"],
  ];
});
PAIRS.push(...V2_PAIRS);

export const THEME_NAMES = ["dark", "light", "midnight", "dim", "high_contrast"];

export function threshold(theme, kind) {
  if (kind === "ui") return 3;
  return theme === "high_contrast" ? 7 : 4.5;
}

export function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function declarations(body) {
  const out = {};
  for (const m of body.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  for (const m of body.matchAll(/--(tint-[a-z]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// Returns { dark, light, midnight, dim, high_contrast, "system-light", "system-dark" } token maps.
// Handles `selector-list { ... }` rules and one level of `@media (prefers-color-scheme: dark)`.
export function parseThemes(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const themes = {};
  const visit = (src, dark) => {
    const re = /([^{}]+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    for (const m of src.matchAll(re)) {
      const sel = m[1].trim();
      const body = m[2];
      if (sel.startsWith("@media")) {
        if (/prefers-color-scheme\s*:\s*dark/.test(sel)) visit(body, true);
        continue;
      }
      const names = [];
      for (const s of sel.split(",")) {
        const t = /\[data-theme="([a-z_]+)"\]/.exec(s);
        if (t) names.push(t[1]);
        else if (/:not\(\[data-theme\]\)/.test(s)) names.push("system");
      }
      const decl = declarations(body);
      if (!Object.keys(decl).length) continue;
      for (const n of new Set(names)) {
        const key = n === "system" ? (dark ? "system-dark" : "system-light") : n;
        themes[key] = { ...(themes[key] ?? {}), ...decl };
      }
    }
  };
  visit(text, false);
  return themes;
}

export function mixHex(base, top, pct) {
  const a = parseHex(base);
  const b = parseHex(top);
  return (
    "#" +
    a
      .map((v, i) =>
        Math.round(v + (b[i] - v) * pct)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

// Resolve a PAIRS background spec against one theme's token map; null when a token is missing.
export function resolveBg(t, spec) {
  const [base, tint] = spec.split("+tint:");
  if (!t[base]) return null;
  if (tint === undefined) return t[base];
  const strength = /^(\d+(?:\.\d+)?)%$/.exec(t["tint-strength"] ?? "");
  if (!t[`${tint}-fill`] || !strength) return null;
  return mixHex(t[base], t[`${tint}-fill`], Number(strength[1]) / 100);
}

export function check(css) {
  const themes = parseThemes(css);
  const results = [];
  const failures = [];
  for (const name of [...THEME_NAMES, "system-light", "system-dark"]) {
    const t = themes[name];
    if (!t) {
      failures.push(`theme "${name}" has no token block`);
      continue;
    }
    const base = name.startsWith("system") ? "x" : name;
    for (const [fg, bg, kind] of PAIRS) {
      const bgHex = resolveBg(t, bg);
      if (!t[fg] || !bgHex) {
        failures.push(`${name}: missing --color-${!t[fg] ? fg : bg}`);
        continue;
      }
      const r = ratio(t[fg], bgHex);
      const need = threshold(base, kind);
      results.push({ theme: name, fg, bg, kind, ratio: r, need, ok: r >= need });
      if (r < need) {
        failures.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${need}:1 (${kind})`);
      }
    }
  }
  // Match device in dark mode must equal the dark theme (one token set).
  if (themes["system-dark"] && themes.dark) {
    for (const k of Object.keys(themes.dark)) {
      if (themes["system-dark"][k] !== themes.dark[k]) {
        failures.push(`system dark block differs from dark theme at --color-${k}`);
      }
    }
  }
  return { themes, results, failures };
}

function main() {
  const file = process.argv[2] ?? DEFAULT_FILE;
  const { results, failures } = check(fs.readFileSync(file, "utf8"));
  const min = {};
  for (const r of results) {
    min[r.theme] = Math.min(min[r.theme] ?? Infinity, r.ratio / r.need);
  }
  for (const theme of Object.keys(min)) {
    const rs = results.filter((r) => r.theme === theme);
    const worst = rs.reduce((a, b) => (b.ratio - b.need < a.ratio - a.need ? b : a));
    console.log(
      `${theme}: ${rs.length} pairs, tightest ${worst.fg} on ${worst.bg} ` +
        `${worst.ratio.toFixed(2)}:1 (needs ${worst.need}:1)`,
    );
  }
  if (process.env.CONTRAST_VERBOSE) {
    for (const r of results) {
      console.log(`${r.theme}\t${r.fg}/${r.bg}\t${r.ratio.toFixed(2)}\t>=${r.need}`);
    }
  }
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log("contrast-check: all pairs pass");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

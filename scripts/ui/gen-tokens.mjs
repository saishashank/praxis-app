// V2 colour-token generator (UXR-051..058, D-208). Zero dependencies.
//
// Reads a palette JSON (theme -> token -> hex, plus tint percentages and chart order) and writes
// the generated token section of src/styles/themes.css, between the marker comments
//   /* BEGIN generated V2 palette: <block> */ ... /* END generated V2 palette: <block> */
// in each theme block. The palette path is an argument; nothing outside this repo is read.
//
// D-208 (fill vs text). Every hue that carries meaning gets three tokens beside its base token:
//   --color-<hue>-fill     vivid colour for rails, tint bands, badge backgrounds, chart marks, icons
//                          (non-text; checked at >= 3:1 on bg / surface / surface-2, WCAG 1.4.11)
//   --color-<hue>-text     colour for text on bg / surface / its own tint (AA 4.5, AAA 7 in High contrast)
//   --color-<hue>-on-fill  label colour on the fill: whichever of --color-text / --color-on-fill passes
// The base token (--color-<hue>) keeps its palette value, which is the text-safe colour. In the dark
// themes the palette colours already pass as text, so fill == text there; in Light the fill is solved
// lighter and more chroma-rich than the text colour (lightness solving, as in the palette checker).
//
// Usage:
//   node scripts/ui/gen-tokens.mjs <palette.tokens.json> [themes.css]           write
//   node scripts/ui/gen-tokens.mjs <palette.tokens.json> [themes.css] --check   drift check (exit 1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- colour maths (WCAG 2.x contrast, OKLab/OKLCH for lightness solving) ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const rgb2hex = (c) =>
  "#" +
  c
    .map((v) =>
      Math.round(clamp(v) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const delin = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function luminance(hex) {
  const [r, g, b] = hex2rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** sRGB mix, the same maths as CSS color-mix(in srgb, top pct, base). */
export function mix(base, top, pct) {
  const t = hex2rgb(top);
  return rgb2hex(hex2rgb(base).map((v, i) => v + (t[i] - v) * pct));
}

function lin2oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklab2lin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const lch2lab = (L, C, h) => [
  L,
  C * Math.cos((h * Math.PI) / 180),
  C * Math.sin((h * Math.PI) / 180),
];
const inGamut = (lab) => oklab2lin(lab).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
const lab2hex = (lab) => rgb2hex(oklab2lin(lab).map((v) => delin(clamp(v))));
/** OKLCH -> hex; chroma is reduced until the colour is inside sRGB (hue kept). */
export function lch2hex(L, C, h) {
  if (inGamut(lch2lab(L, C, h))) return lab2hex(lch2lab(L, C, h));
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(lch2lab(L, mid, h))) lo = mid;
    else hi = mid;
  }
  return lab2hex(lch2lab(L, lo, h));
}
export function hex2lch(hex) {
  const [L, a, b] = lin2oklab(hex2rgb(hex).map(lin));
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

// ---------- token model ----------
/** Hue tokens that get -fill / -text / -on-fill (D-208). Section identity colours stay as they are. */
export const HUE_RE =
  /^--color-(brand-[ab]|family-[a-z]+|positive|negative|outcome-flat|tier-p[012]|status-[a-z]+|sector-[a-z]+)$/;
/** Hues whose badges never sit on surface-2 (palette checker rule). */
export const NO_SURFACE2_RE = /^--color-(brand-|family-|sector-)/;

/** Fill min contrast on the surfaces: 3:1 (WCAG 1.4.11) plus 0.1 headroom for rounding. */
const FILL_MIN = 3.1;
const FILL_CHROMA_BOOST = 1.3;

const isDarkTheme = (P) => luminance(P["--color-bg"]) < 0.5;

/** Vivid fill for a text-safe colour: lighter (Light theme only) while >= 3:1 holds on every surface. */
export function solveFill(textHex, surfaces) {
  const { L, C, h } = hex2lch(textHex);
  let best = textHex;
  for (let l = L; l <= 0.97; l += 0.005) {
    const cand = lch2hex(l, C * FILL_CHROMA_BOOST, h);
    if (surfaces.every((s) => ratio(cand, s) >= FILL_MIN)) best = cand;
    else if (l > L + 0.02) break;
  }
  return best;
}

export function pickOnFill(fillHex, P) {
  const a = P["--color-text"];
  const b = P["--color-on-fill"];
  return ratio(fillHex, a) >= ratio(fillHex, b) ? a : b;
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** Ordered [name, value] declarations for one theme. */
export function themeDeclarations(P, tint) {
  const out = [];
  const dark = isDarkTheme(P);
  const base = [P["--color-bg"], P["--color-surface"]];
  for (const [k, v] of Object.entries(P)) out.push([k, v]);
  for (const [k, v] of Object.entries(P)) {
    if (!HUE_RE.test(k)) continue;
    const fill = dark
      ? v
      : solveFill(v, NO_SURFACE2_RE.test(k) ? base : [...base, P["--color-surface-2"]]);
    out.push([`${k}-fill`, fill], [`${k}-text`, v], [`${k}-on-fill`, pickOnFill(fill, P)]);
  }
  out.push(
    ["--tint-strength", pct(tint.max)],
    ["--tint-band", pct(tint.band)],
    ["--tint-tile", pct(tint.tile)],
    ["--tint-mood", pct(tint.mood)],
    [
      "--gradient-brand",
      "linear-gradient(135deg, var(--color-brand-a-fill), var(--color-brand-b-fill))",
    ],
  );
  for (const [mood, a, b] of [
    ["on", "positive", "brand-b"],
    ["neutral", "brand-a", "brand-b"],
    ["off", "tier-p1", "negative"],
  ]) {
    const stop = (n) =>
      `color-mix(in srgb, var(--color-${n}-fill) var(--tint-mood), var(--color-surface))`;
    out.push([
      `--gradient-mood-${mood}`,
      `linear-gradient(
  90deg,
  ${stop(a)},
  ${stop(b)}
)`,
    ]);
  }
  return out;
}

/** Marker block id -> palette theme. The Light block also serves Match device; system-dark mirrors dark. */
export const BLOCK_THEME = {
  dark: "dark",
  light: "light",
  "system-dark": "dark",
  midnight: "midnight",
  dim: "dim",
  high_contrast: "high_contrast",
  // @theme fallback values in globals.css so Tailwind registers every colour token (dark, colours only).
  tailwind: "dark",
};

const THEMES_BLOCKS = ["dark", "light", "system-dark", "midnight", "dim", "high_contrast"];
const GLOBALS_BLOCKS = ["tailwind"];

export function renderSection(palette, block, indent) {
  const theme = BLOCK_THEME[block];
  if (!theme) throw new Error(`unknown generated block "${block}"`);
  const P = palette.themes[theme];
  if (!P) throw new Error(`palette has no theme "${theme}"`);
  const decls = themeDeclarations(P, palette.tint[theme]).filter(
    ([k]) => block !== "tailwind" || k.startsWith("--color-"),
  );
  const lines = decls.map(([k, v]) => `${indent}${k}: ${v.split("\n").join("\n" + indent)};`);
  return [
    `${indent}/* BEGIN generated V2 palette: ${block} */`,
    ...lines,
    `${indent}/* END generated V2 palette: ${block} */`,
  ].join("\n");
}

const MARK_RE =
  /^([ \t]*)\/\* BEGIN generated V2 palette: ([a-z_-]+) \*\/\n[\s\S]*?^[ \t]*\/\* END generated V2 palette: \2 \*\/$/gm;

export function generate(css, palette, required = THEMES_BLOCKS) {
  const seen = new Set();
  const out = css.replace(MARK_RE, (_m, indent, block) => {
    seen.add(block);
    return renderSection(palette, block, indent);
  });
  for (const b of required) {
    if (!seen.has(b)) throw new Error(`themes.css has no generated-section markers for "${b}"`);
  }
  return out;
}

export function tokenCounts(palette) {
  return Object.fromEntries(
    Object.keys(palette.themes).map((t) => [
      t,
      themeDeclarations(palette.themes[t], palette.tint[t]).length,
    ]),
  );
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const [paletteFile, cssArg] = args.filter((a) => !a.startsWith("--"));
  if (!paletteFile) {
    console.error("usage: gen-tokens.mjs <palette.tokens.json> [themes.css] [--check]");
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const targets = [
    [cssArg ?? path.resolve(here, "../../src/styles/themes.css"), THEMES_BLOCKS],
    [path.resolve(here, "../../src/app/globals.css"), GLOBALS_BLOCKS],
  ];
  const palette = JSON.parse(fs.readFileSync(paletteFile, "utf8"));
  let drift = false;
  for (const [file, blocks] of targets) {
    const current = fs.readFileSync(file, "utf8");
    const next = generate(current, palette, blocks);
    const rel = path.relative(process.cwd(), file);
    if (check) {
      if (next !== current) {
        drift = true;
        console.error(
          `DRIFT ${rel} differs from the generator output; run: node scripts/ui/gen-tokens.mjs ${paletteFile}`,
        );
      } else console.log(`gen-tokens: ${rel} generated section matches the palette`);
    } else {
      fs.writeFileSync(file, next);
      console.log(`gen-tokens: wrote ${rel}`);
    }
  }
  if (!check) console.log("tokens per theme:", tokenCounts(palette));
  if (drift) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

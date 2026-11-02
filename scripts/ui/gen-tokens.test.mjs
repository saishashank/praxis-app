import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { check, parseThemes } from "../ci/contrast-check.mjs";
import {
  BLOCK_THEME,
  generate,
  lch2hex,
  hex2lch,
  mix,
  pickOnFill,
  ratio,
  renderSection,
  solveFill,
  themeDeclarations,
  tokenCounts,
} from "./gen-tokens.mjs";

const url = (p) => new URL(p, import.meta.url);
const PALETTE = JSON.parse(fs.readFileSync(url("../../src/styles/palette.tokens.json"), "utf8"));
const CSS = fs.readFileSync(url("../../src/styles/themes.css"), "utf8");
const GLOBALS = fs.readFileSync(url("../../src/app/globals.css"), "utf8");
const THEMES = ["dark", "midnight", "dim", "light", "high_contrast"];

test("drift: the committed themes.css generated section equals the generator output", () => {
  assert.equal(generate(CSS, PALETTE), CSS);
});

test("drift: the Tailwind @theme fallback section in globals.css equals the generator output", () => {
  assert.equal(generate(GLOBALS, PALETTE, ["tailwind"]), GLOBALS);
  assert.ok(!GLOBALS.includes("--tint-"), "tailwind block carries colours only");
});

test("generate is idempotent and refuses a file without markers", () => {
  const once = generate(CSS, PALETTE);
  assert.equal(generate(once, PALETTE), once);
  assert.throws(() => generate("/* nothing */", PALETTE), /no generated-section markers/);
});

test("a hand edit inside the generated section is detected as drift", () => {
  const edited = CSS.replace(
    /(generated V2 palette: light \*\/[\s\S]*?--color-bg: )#ffffff/,
    "$1#fefefe",
  );
  assert.notEqual(edited, CSS);
  assert.notEqual(generate(edited, PALETTE), edited);
});

test("every block maps to a palette theme and system-dark mirrors dark", () => {
  assert.deepEqual(Object.keys(BLOCK_THEME).sort(), [
    "dark",
    "dim",
    "high_contrast",
    "light",
    "midnight",
    "system-dark",
    "tailwind",
  ]);
  assert.equal(
    renderSection(PALETTE, "system-dark", "").split("\n").slice(1, -1).join("\n"),
    renderSection(PALETTE, "dark", "").split("\n").slice(1, -1).join("\n"),
  );
});

test("every theme has the same token names, with fill/text/on-fill per hue and tints", () => {
  const names = (t) => themeDeclarations(PALETTE.themes[t], PALETTE.tint[t]).map(([k]) => k);
  const ref = names("dark");
  for (const t of THEMES) assert.deepEqual(names(t), ref, t);
  for (const k of [
    "--color-family-br-fill",
    "--color-family-br-text",
    "--color-family-br-on-fill",
    "--color-tier-p1-fill",
    "--tint-strength",
    "--tint-band",
    "--tint-tile",
    "--tint-mood",
    "--gradient-brand",
    "--gradient-mood-on",
    "--gradient-mood-neutral",
    "--gradient-mood-off",
    "--color-chart-8",
    "--color-warning",
  ])
    assert.ok(ref.includes(k), k);
  assert.equal(new Set(ref).size, ref.length, "no duplicate token names");
  assert.deepEqual(Object.keys(tokenCounts(PALETTE)), THEMES);
});

test("Light fills are vivid: lighter than their text colour, still 3:1 on bg and surface", () => {
  const P = PALETTE.themes.light;
  const decl = Object.fromEntries(themeDeclarations(P, PALETTE.tint.light));
  for (const hue of ["family-co", "tier-p1", "tier-p0", "status-allowed", "positive"]) {
    const fill = decl[`--color-${hue}-fill`];
    const text = decl[`--color-${hue}-text`];
    assert.ok(hex2lch(fill).L > hex2lch(text).L, `${hue} fill lighter than text`);
    assert.ok(hex2lch(fill).C >= hex2lch(text).C, `${hue} fill at least as chromatic`);
    for (const s of [P["--color-bg"], P["--color-surface"]]) assert.ok(ratio(fill, s) >= 3, hue);
    assert.ok(ratio(text, P["--color-bg"]) >= 4.5, `${hue} text AA`);
  }
});

test("dark themes: fill equals text (palette colours already pass as text)", () => {
  for (const t of ["dark", "midnight", "dim", "high_contrast"]) {
    const d = Object.fromEntries(themeDeclarations(PALETTE.themes[t], PALETTE.tint[t]));
    assert.equal(d["--color-family-br-fill"], d["--color-family-br-text"], t);
  }
});

test("on-fill picks the better of the theme's text and on-fill colours", () => {
  const P = PALETTE.themes.light;
  assert.equal(pickOnFill("#ffcc00", P), P["--color-text"]);
  assert.equal(pickOnFill("#0b0b66", P), P["--color-on-fill"]);
});

test("solveFill never returns something below 3:1; mix and lch2hex behave", () => {
  const surfaces = ["#ffffff", "#f3f5f8"];
  const f = solveFill("#795700", surfaces);
  for (const s of surfaces) assert.ok(ratio(f, s) >= 3);
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.match(lch2hex(0.7, 0.4, 30), /^#[0-9a-f]{6}$/);
});

test("the generated themes.css passes the contrast checker, including the new V2 pairs", () => {
  const { failures, results } = check(CSS);
  assert.deepEqual(failures, []);
  assert.ok(results.some((r) => r.fg === "family-co-fill" && r.kind === "ui"));
  assert.ok(
    results.some((r) => r.bg.includes("+tint:") && r.theme === "high_contrast" && r.need === 7),
  );
  const themes = parseThemes(CSS);
  assert.equal(themes["system-light"]["tint-strength"], themes.light["tint-strength"]);
  assert.equal(themes["system-dark"]["tint-strength"], themes.dark["tint-strength"]);
});

test("the contrast checker fails a dull text token and a too-pale fill", () => {
  const dull = CSS.replace(
    /(generated V2 palette: light \*\/[\s\S]*?--color-tier-p1-text: )#[0-9a-f]{6}/,
    "$1#f7b828",
  );
  assert.ok(check(dull).failures.some((f) => f.startsWith("light: tier-p1-text on bg")));
  const pale = CSS.replace(
    /(generated V2 palette: light \*\/[\s\S]*?--color-tier-p1-fill: )#[0-9a-f]{6}/,
    "$1#fff2c0",
  );
  assert.ok(check(pale).failures.some((f) => f.startsWith("light: tier-p1-fill on bg")));
});

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { check, luminance, parseThemes, ratio, threshold } from "./contrast-check.mjs";

const REAL = fs.readFileSync(new URL("../../src/styles/themes.css", import.meta.url), "utf8");

test("ratio: black on white is 21:1 and identical colours are 1:1", () => {
  assert.equal(ratio("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(ratio("#777777", "#777777"), 1);
  assert.ok(luminance("#ffffff") > luminance("#808080"));
});

test("threshold: AA 4.5 text, 3 UI, AAA 7 for high contrast text", () => {
  assert.equal(threshold("dark", "text"), 4.5);
  assert.equal(threshold("dark", "ui"), 3);
  assert.equal(threshold("high_contrast", "text"), 7);
});

test("the real token file passes every pair in every theme", () => {
  const { failures, themes } = check(REAL);
  assert.deepEqual(failures, []);
  for (const t of ["dark", "light", "midnight", "dim", "high_contrast"]) assert.ok(themes[t]);
});

test("parseThemes: system maps to light tokens, dark under the media query", () => {
  const themes = parseThemes(REAL);
  assert.equal(themes["system-light"].bg, themes.light.bg);
  assert.equal(themes["system-dark"].bg, themes.dark.bg);
});

test("a low-contrast token fails the check", () => {
  const bad = REAL.replace(
    /(\[data-theme="dim"\][^}]*--color-text-muted:\s*)#[0-9a-f]{6}/i,
    "$1#2a3548",
  );
  const { failures } = check(bad);
  assert.ok(failures.some((f) => f.startsWith("dim: text-muted on bg")));
});

test("high contrast text below 7:1 fails even when it passes AA", () => {
  const bad = REAL.replace(
    /(\[data-theme="high_contrast"\][^}]*--color-text-muted:\s*)#[0-9a-f]{6}/i,
    "$1#808080",
  );
  const { failures } = check(bad);
  assert.ok(failures.some((f) => f.startsWith("high_contrast: text-muted on bg")));
});

test("a missing theme block and a drifting system dark block are reported", () => {
  assert.ok(check(REAL.replace('[data-theme="midnight"]', '[data-theme="other"]')).failures.length);
  const drift = REAL.replace(/(@media[\s\S]*?--color-accent:\s*)#8fd3ff/, "$1#8fd4ff");
  assert.ok(check(drift).failures.some((f) => f.includes("system dark block differs")));
});

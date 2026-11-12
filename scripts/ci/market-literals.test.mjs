// AT-67 (M19 E1, D-1000, D-1075 to D-1078): self-tests of the market-literal scan. A planted literal of every
// class fails, the allow-list is honoured and nothing else is, comments and test files are not scanned, a stale
// allow-list entry is reported, and the real tree reaches 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSES, EXTRA_ALLOW, scanText, scanTree, stripComments } from "./market-literals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** One planted line per class (text built from pieces so this file holds no literal of its own that matters). */
const PLANTED = {
  marketCode: `const m = "A${"U"}";`,
  exchangeWord: `const label = "Go live in ${"Syd"}ney";`,
  zone: `const tz = "Australia/${"Syd"}ney";`,
  sessionTime: `const at = "18:${"10"}";`,
  currency: `const price = \`A$\${x}\`; const s = "A$" + "12";`,
  yahooSuffix: `const t = code + ".A${"X"}";`,
  indexCode: `const i = "^AX${"JO"}";`,
  moneyLiteral: `const floor = 500_${"000"}_000n;`,
  classification: `const scheme = "g${"ics"}";`,
};

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mlit-"));
const put = (root, rel, text) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

test("a planted literal of every class is found, with its class and line", () => {
  assert.deepEqual(
    Object.keys(PLANTED).sort(),
    Object.keys(CLASSES).sort(),
    "a class without a planted test",
  );
  for (const [cls, line] of Object.entries(PLANTED)) {
    const hits = scanText(`// a comment\n${line}\n`, "src/x.ts");
    assert.ok(
      hits.some((h) => h.cls === cls && h.line === 2),
      `${cls} not found in: ${line}`,
    );
  }
});

test("the symbol, the SVG arc command and the Owner zone are told apart", () => {
  assert.equal(scanText("const d = `M${a} ${b}A${r} ${r} 0 1`;", "src/x.ts").length, 0, "SVG arc");
  assert.equal(scanText('const z = "Australia/Melbourne";', "src/x.ts").length, 0, "Owner zone");
  assert.equal(scanText('const w = "Melbourne time";', "src/x.ts").length, 0, "Owner zone word");
  assert.equal(scanText('const m = "AUCKLAND";', "src/x.ts").length, 0, "not a market code");
  assert.equal(
    scanText('const s = "ASX\'s terms";', "src/x.ts").length,
    0,
    "possessive is not the exchange word",
  );
});

test("comments are not scanned; strings that look like comments are", () => {
  const text = [
    '// const a = "AU"; Sydney A$5',
    '/* const b = "AU";',
    '   const c = "US"; */',
    'const url = "https://example.com/x"; const m = "AU";',
    "const re = /[\"']AU[\"']/;",
    "/** docs say A$600 */ const ok = 1;",
  ].join("\n");
  const hits = scanText(text, "src/x.ts");
  assert.deepEqual(
    hits.map((h) => h.line),
    [4],
    "only the real string on line 4 (a // inside a string is not a comment)",
  );
  const py = [
    '# DEFAULT = "AU"',
    'x = "A$5"  # trailing "US"',
    '"""docstring with "IN" and A$9"""',
  ].join("\n");
  assert.deepEqual(
    scanText(py, "scripts/x.py").map((h) => h.line),
    [2],
  );
  assert.equal(stripComments("a\n/* b\nc */d", "js"), "a\n    \n    d", "line numbers hold");
});

test("a template with an expression keeps scanning after the expression", () => {
  const hits = scanText('const s = `${a} costs A$${b} and "AU" ${c}`;', "src/x.ts");
  assert.ok(hits.some((h) => h.cls === "marketCode"));
  assert.ok(hits.some((h) => h.cls === "currency"));
});

test("scanTree: a planted file outside the allow-list fails, test folders and the seed folder do not", () => {
  const root = temp();
  try {
    put(root, "src/lib/a.ts", `${PLANTED.marketCode}\n`);
    put(root, "scripts/b.mjs", `${PLANTED.zone}\n`);
    put(root, "worker/src/c.ts", `${PLANTED.sessionTime}\n`);
    put(root, "src/lib/a.test.ts", `${PLANTED.marketCode}\n`);
    put(root, "tests/t.ts", `${PLANTED.marketCode}\n`);
    put(root, "e2e/x.ts", `${PLANTED.marketCode}\n`);
    put(root, "scripts/ci/fixtures/f.mjs", `${PLANTED.marketCode}\n`);
    put(root, "scripts/ingest/test_x.py", `${PLANTED.currency}\n`);
    put(root, "src/lib/market/seed/AU.mjs", `${PLANTED.marketCode}\n`);
    put(root, "src/lib/market/homeMarket.mjs", `${PLANTED.zone}\n`);
    const r = scanTree(root);
    assert.deepEqual([...new Set(r.hits.map((h) => h.file))].sort(), [
      "scripts/b.mjs",
      "src/lib/a.ts",
      "worker/src/c.ts",
    ]);
    assert.ok(r.allowed >= 2, "the seed folder is allowed");
    assert.equal(r.quotedFiles.length, 1, "the D-991 count names the quoted-AU file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanTree: a file registered in seed/allow.mjs is honoured, an unregistered one is not, a missing one is stale", () => {
  const root = temp();
  try {
    put(
      root,
      "src/lib/market/seed/allow.mjs",
      'export const MARKET_LITERAL_ALLOW = Object.freeze([\n  "src/lib/data/calendarRules.mjs", // rules\n  "scripts/gone.mjs", // missing\n]);\n',
    );
    put(root, "src/lib/data/calendarRules.mjs", `${PLANTED.marketCode}\n`);
    put(root, "src/lib/data/other.mjs", `${PLANTED.marketCode}\n`);
    const r = scanTree(root);
    assert.deepEqual(
      r.hits.map((h) => h.file),
      ["src/lib/data/other.mjs"],
    );
    assert.ok(r.stale.includes("scripts/gone.mjs"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanTree: an extra allow entry covers its classes and lines only", () => {
  const root = temp();
  const entry = EXTRA_ALLOW.find((e) => e.file === "src/lib/view/costPlans.ts");
  assert.ok(entry && entry.classes?.includes("currency"), "the AU broker plan entry exists");
  try {
    put(root, "src/lib/view/costPlans.ts", `${PLANTED.currency}\n${PLANTED.marketCode}\n`);
    const r = scanTree(root);
    assert.deepEqual(
      r.hits.map((h) => [h.file, h.cls]),
      [["src/lib/view/costPlans.ts", "marketCode"]],
      "the currency lines are allowed, the market code in the same file is not",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every allow entry has a reason and names a file or a folder that exists", () => {
  for (const e of EXTRA_ALLOW) {
    assert.ok(e.reason && e.reason.length > 20, `reason: ${e.file ?? e.dir}`);
    assert.ok(Boolean(e.file) !== Boolean(e.dir), "exactly one of file and dir");
    assert.ok(fs.existsSync(path.join(ROOT, e.file ?? e.dir)), `exists: ${e.file ?? e.dir}`);
  }
});

test("the real tree has no literal outside the allow-list, and no stale entry", () => {
  const r = scanTree(ROOT);
  assert.deepEqual(
    r.hits.map((h) => `${h.file}:${h.line} [${h.cls}]`),
    [],
  );
  assert.deepEqual(r.stale, []);
  assert.equal(r.quotedFiles.length, 0);
});

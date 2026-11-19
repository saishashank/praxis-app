// M21 Z (D-922, D-1233; AT-82 last clause): self-tests of the internal-code scan. A synthetic tree: a code in JSX text or in a
// string literal fails, a comment and a data-* value pass, an allow-listed entry passes, an unused allow entry fails, an
// entry without a reason fails, and the real tree reaches 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PATTERNS, ROOTS, matchPatterns, scanText, scanTree } from "./internal-codes.mjs";

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "icodes-"));
const put = (root, rel, text) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const allow = (root, entries) =>
  put(root, "scripts/ci/internal-codes.allow.json", JSON.stringify({ entries }));

test("every pattern of the design matches its example and not a plain word", () => {
  const yes = {
    strategyCode: "Strategy E01 won",
    variantCode: "F1-U",
    controlCode: "C2-F1",
    specId: "see ARN-021",
    decisionId: "per D-922",
    acceptanceId: "AT-82 passes",
    ownerDecisionId: "Owner O-71",
    priorityTag: "a P0 alert",
    nav: "the NAV today",
    cohortWord: "CS exit",
    statusTag: "[VERIFY] this",
  };
  assert.deepEqual(Object.keys(yes).sort(), Object.keys(PATTERNS).sort());
  for (const [name, text] of Object.entries(yes)) {
    assert.ok(matchPatterns(text).includes(name), `${name} matches "${text}"`);
  }
  for (const ok of [
    "Today, all strategies",
    "Navigate to the page",
    "Pick 2 of 12",
    "It is fine",
    "E1",
  ]) {
    assert.deepEqual(matchPatterns(ok), [], ok);
  }
});

test("scanText: JSX text and string literals fail; comments, data-* values, module specifiers and SQL pass", () => {
  const src = [
    'import x from "ARN-021";',
    "// a comment about ARN-021 passes",
    "/* and D-922 in a block */",
    "export function A() {",
    "  return (",
    '    <div data-testid="AT-82-box" title="plain">',
    "      <p>Rule ARN-021 applies</p>",
    '      <span aria-label="Held in E01">x</span>',
    "    </div>",
    "  );",
    "}",
    'export const q = "SELECT 1 FROM t WHERE a IS NULL";',
    "export const t = `Shown ${n} per D-922`;",
    "export const IS = 1; export const NAV = 2;",
  ].join("\n");
  const hits = scanText(src, "src/app/a.tsx").map((h) => [h.line, h.pattern]);
  assert.deepEqual(hits, [
    [7, "specId"],
    [8, "strategyCode"],
    [13, "decisionId"],
  ]);
});

test("scanText: JSX text is read in .tsx only", () => {
  assert.equal(scanText("const a = <p>ARN-021</p>;", "src/lib/view/x.ts").length, 0);
  assert.equal(scanText("const a = <p>ARN-021</p>;", "src/lib/view/x.tsx").length, 1);
});

test("scanTree: a planted code fails in every scanned folder, a test file and an unscanned folder do not", () => {
  const root = temp();
  try {
    for (const dir of ROOTS)
      put(root, `${dir}/a.tsx`, "export const A = () => <p>See ARN-021</p>;\n");
    put(root, "src/app/a.test.tsx", 'export const t = "ARN-021";\n');
    put(root, "src/lib/other/b.ts", 'export const t = "ARN-021";\n');
    put(root, "tests/t.ts", 'export const t = "ARN-021";\n');
    const r = scanTree(root);
    assert.deepEqual(r.hits.map((h) => h.file).sort(), ROOTS.map((d) => `${d}/a.tsx`).sort());
    assert.equal(r.files, ROOTS.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanTree: an allow-listed entry passes and narrows to its text and patterns; an unused entry is stale", () => {
  const root = temp();
  try {
    put(root, "src/app/a.ts", 'export const a = "key P0";\nexport const b = "also ARN-021";\n');
    allow(root, [
      { file: "src/app/a.ts", patterns: ["priorityTag"], reason: "an identifier, never shown" },
      { file: "src/app/gone.ts", reason: "a file that no longer holds a hit" },
    ]);
    const r = scanTree(root);
    assert.deepEqual(
      r.hits.map((h) => [h.file, h.line, h.pattern]),
      [["src/app/a.ts", 2, "specId"]],
    );
    assert.equal(r.allowed, 1);
    assert.deepEqual(r.stale, ["src/app/gone.ts"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanTree: an allow entry with no reason is a problem", () => {
  const root = temp();
  try {
    put(root, "src/app/a.ts", 'export const a = "P0";\n');
    allow(root, [{ file: "src/app/a.ts", reason: "" }]);
    assert.equal(scanTree(root).problems.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree is clean: no hit outside the allow-list, no stale entry, every entry has a reason", () => {
  const r = scanTree(REAL);
  assert.deepEqual(
    r.hits.map((h) => `${h.file}:${h.line} ${h.pattern}`),
    [],
  );
  assert.deepEqual(r.stale, []);
  assert.deepEqual(r.problems, []);
  assert.ok(r.files > 200, "the scanned folders are read");
});

// M21 U0 / Z (UXN-319, D-1201; AT-82): the cross-check table has one row for each of the 35 [PROPOSED] items of v1 ch. 16
// with a verdict in the allowed set, the final rulings of the amended D-1201 (5 accepted, 7 superseded, 23 rejected) cover
// exactly those 35, and every accepted item names a test file that exists. The table (`docs/M21_ui_crosscheck.md`) records
// the checker's first reading; the design's D-1201 line is the ruling.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

/** The test file that proves each accepted item (design sections F and C7). */
const PROOF = {
  "UXN-008": "tests/market/sectionLoading.test.tsx",
  "UXN-010": "tests/pwa/components.test.tsx",
  "UXN-062": "tests/strategies/controlsSummary.test.tsx",
  "UXN-154": "tests/charts/concentrationChart.test.tsx",
  "UXN-255": "tests/strategies/familyGroups.test.tsx",
};

const idsIn = (s) => [...s.matchAll(/\b(\d{3})\b/g)].map((m) => `UXN-${m[1]}`);

function rulings() {
  const line = read("docs/M21_design.md")
    .split("\n")
    .find((l) => l.startsWith("- **D-1201**"));
  assert.ok(line, "the D-1201 line exists");
  const accepted = [...line.matchAll(/\*\*5 accepted\*\* \(([^)]*)\)/g)][0]?.[1] ?? "";
  const superseded = [...line.matchAll(/\*\*7 superseded\*\* \(([^)]*)\)/g)][0]?.[1] ?? "";
  return {
    accepted: [...accepted.matchAll(/UXN-\d{3}/g)].map((m) => m[0]),
    superseded: idsIn(superseded).map((x) => x),
  };
}

const table = () =>
  read("docs/M21_ui_crosscheck.md")
    .split("\n")
    .filter((l) => /^\| UXN-\d{3} \|/.test(l))
    .map((l) => l.split("|").map((c) => c.trim()));

test("the table has one row for each of 35 distinct items, each with a verdict in the allowed set", () => {
  const rows = table();
  const ids = rows.map((r) => r[1]);
  assert.equal(ids.length, 35);
  assert.equal(new Set(ids).size, 35);
  for (const r of rows) {
    assert.match(r[3], /^(Accepted|Superseded|Rejected)\b/, `${r[1]} verdict`);
    assert.ok(r[2].length > 10, `${r[1]} has an intent line`);
  }
});

test("the final rulings (D-1201 amended) cover exactly the 35 items: 5 accepted, 7 superseded, 23 rejected", () => {
  const ids = table().map((r) => r[1]);
  const { accepted, superseded } = rulings();
  assert.equal(accepted.length, 5);
  assert.equal(superseded.length, 7);
  const rejected = ids.filter((i) => !accepted.includes(i) && !superseded.includes(i));
  assert.equal(rejected.length, 23);
  for (const i of [...accepted, ...superseded]) assert.ok(ids.includes(i), `${i} is a row`);
  assert.equal(new Set([...accepted, ...superseded]).size, 12, "no item is ruled twice");
});

test("every accepted item names a test file that exists", () => {
  const { accepted } = rulings();
  assert.deepEqual(Object.keys(PROOF).sort(), [...accepted].sort());
  for (const [id, file] of Object.entries(PROOF)) {
    assert.ok(fs.existsSync(path.join(root, file)), `${id}: ${file}`);
  }
});

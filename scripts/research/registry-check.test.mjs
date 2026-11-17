// M23 A2 (D-1606): the ledger check fails on a gap or repeat in seq, a repeated look, a frozen file that changed or is missing,
// and an earlier entry that was edited; the committed ledger itself is sound. Synthetic folders only; no network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkRegistry } from "./registry-check.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const PLAN = '{"hypothesis":"a synthetic plan"}\n';

function world(entries, plan = PLAN) {
  const root = mkdtempSync(path.join(tmpdir(), "registry-check-"));
  mkdirSync(path.join(root, "docs", "research", "prereg"), { recursive: true });
  writeFileSync(path.join(root, "docs", "research", "prereg", "ZZ-1.json"), plan);
  writeFileSync(
    path.join(root, "docs", "research", "registry.json"),
    JSON.stringify({ format: 1, entries }),
  );
  return root;
}
const entry = (seq, over = {}) => ({
  seq,
  item: "CXA-003",
  lineage: `zz_${seq}`,
  market: "ZZ",
  sha: sha(PLAN),
  preregPath: "docs/research/prereg/ZZ-1.json",
  ...over,
});
const LOOK = {
  lookedAt: "2030-01-02T00:00:00Z",
  verdict: "NULL",
  nSetups: 1,
  nBlocks: 1,
  stats: {},
};

test("a sound ledger passes", async () => {
  const root = world([entry(1), entry(2, LOOK)]);
  try {
    assert.deepEqual(await checkRegistry({ root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gap or a repeat in seq fails", async () => {
  const gap = world([entry(1), entry(3)]);
  const rep = world([entry(1), entry(1)]);
  try {
    assert.match((await checkRegistry({ root: gap })).join("\n"), /seq 3 at position 2/);
    assert.match((await checkRegistry({ root: rep })).join("\n"), /seq 1 at position 2/);
  } finally {
    rmSync(gap, { recursive: true, force: true });
    rmSync(rep, { recursive: true, force: true });
  }
});

test("a repeated lineage-market look fails", async () => {
  const root = world([
    entry(1, { ...LOOK, lineage: "zz_same" }),
    entry(2, { ...LOOK, lineage: "zz_same" }),
  ]);
  try {
    assert.match((await checkRegistry({ root })).join("\n"), /a second look for zz_same/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a frozen file changed after its entry, or missing, fails", async () => {
  const changed = world([entry(1)], '{"hypothesis":"edited later"}\n');
  const missing = world([entry(1, { preregPath: "docs/research/prereg/none.json" })]);
  try {
    assert.match(
      (await checkRegistry({ root: changed })).join("\n"),
      /does not match its recorded hash/,
    );
    assert.match((await checkRegistry({ root: missing })).join("\n"), /cannot be read/);
  } finally {
    rmSync(changed, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("an earlier entry that was edited or removed fails the append-only check", async () => {
  const root = world([entry(1), entry(2)]);
  const before = path.join(root, "before.json");
  writeFileSync(before, JSON.stringify({ format: 1, entries: [entry(1, { item: "CXA-004" })] }));
  try {
    assert.match(
      (await checkRegistry({ root, against: before })).join("\n"),
      /an earlier entry was changed/,
    );
    writeFileSync(before, JSON.stringify({ format: 1, entries: [entry(1), entry(2), entry(3)] }));
    assert.match(
      (await checkRegistry({ root, against: before })).join("\n"),
      /entries were removed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the committed ledger is sound", async () => {
  assert.deepEqual(await checkRegistry({}), []);
});

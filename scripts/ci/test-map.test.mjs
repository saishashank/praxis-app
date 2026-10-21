import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildMap, checkMap, idsIn, mergeBaseline, parseMapDoc } from "./test-map.mjs";

const script = fileURLToPath(new URL("./test-map.mjs", import.meta.url));

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testmap-"));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  return root;
}

const DOC = [
  "| Requirement ID | What | Test file(s) | Layer | Status |",
  "|---|---|---|---|---|",
  "| [SEC-010](../spec/x.md), ROL-101 (auth) | text | `tests/a.test.ts`, `tests/gone.test.ts` | unit | ok |",
  "| [TST-107](../spec/x.md) | nothing | none | none | not yet |",
  "| [BLD-011](../spec/x.md) | run | `.github/workflows/ci.yml` | wf | partial |",
].join("\n");

test("idsIn finds requirement IDs but not look-alikes such as UTF-8 or SHA-256", () => {
  assert.deepEqual(idsIn("AT-05a, TST-120 and D-016; UTF-8 SHA-256 ISO-8601"), [
    "AT-05a",
    "TST-120",
    "D-016",
  ]);
});

test("parseMapDoc reads IDs from column 1 and backticked files from column 3", () => {
  const rows = parseMapDoc(DOC);
  assert.deepEqual(rows[0].ids, ["SEC-010", "ROL-101"]);
  assert.deepEqual(rows[0].files, ["tests/a.test.ts", "tests/gone.test.ts"]);
  assert.deepEqual(rows[1].files, []);
});

test("buildMap joins doc rows and IDs cited inside test files; missing and non-test files are ignored", () => {
  const root = tree({
    "docs/test-map.md": DOC,
    "tests/a.test.ts": "// covers AT-02 and SEC-010\n",
    "worker/test/w.test.ts": "describe('TST-120 gate', () => {})",
    "tests/helper.ts": "// AT-99 in a helper is not a test",
  });
  const m = buildMap(root);
  assert.deepEqual(m["SEC-010"], ["tests/a.test.ts"]);
  assert.deepEqual(m["ROL-101"], ["tests/a.test.ts"]);
  assert.deepEqual(m["AT-02"], ["tests/a.test.ts"]);
  assert.deepEqual(m["TST-120"], ["worker/test/w.test.ts"]);
  assert.equal(m["AT-99"], undefined);
  assert.equal(m["BLD-011"], undefined);
});

test("checkMap: passes unchanged; new files and IDs are fine", () => {
  const base = { "AT-02": ["tests/a.test.ts"] };
  const cur = { "AT-02": ["tests/a.test.ts", "tests/b.test.ts"], "AT-03": ["tests/c.test.ts"] };
  assert.deepEqual(
    checkMap(base, cur, () => true),
    [],
  );
});

test("checkMap: a mapped file that disappeared fails", () => {
  const base = { "SEC-010": ["tests/a.test.ts", "tests/b.test.ts"] };
  const cur = { "SEC-010": ["tests/a.test.ts"] };
  const f = checkMap(base, cur, (p) => p !== "tests/b.test.ts");
  assert.equal(f.length, 1);
  assert.match(f[0], /SEC-010: mapped test file disappeared: tests\/b\.test\.ts/);
});

test("checkMap: an AT row that loses all tests fails, named as an acceptance row", () => {
  const f = checkMap({ "AT-04": ["tests/a.test.ts"] }, {}, () => false);
  assert.equal(f.length, 2);
  assert.match(f[1], /AT-04: acceptance row lost its last test/);
});

test("mergeBaseline keeps old entries unless pruning", () => {
  const base = { "AT-1": ["x.test.ts"], "AT-2": ["y.test.ts"] };
  const cur = { "AT-1": ["z.test.ts"] };
  assert.deepEqual(mergeBaseline(base, cur), {
    "AT-1": ["x.test.ts", "z.test.ts"],
    "AT-2": ["y.test.ts"],
  });
  assert.deepEqual(mergeBaseline(base, cur, { prune: true }), { "AT-1": ["z.test.ts"] });
});

test("CLI end to end: update writes a baseline, check passes, deleting a test file fails", () => {
  const root = tree({ "tests/a.test.ts": "// AT-02\n", "tests/b.test.ts": "// AT-02 TST-120\n" });
  const run = (...a) =>
    execFileSync(process.execPath, [script, "--root", root, ...a], { stdio: "pipe" });
  const bl = path.join(root, "tests", "test-map.baseline.json");
  run("--update");
  assert.deepEqual(JSON.parse(fs.readFileSync(bl, "utf8")).map["AT-02"], [
    "tests/a.test.ts",
    "tests/b.test.ts",
  ]);
  assert.doesNotThrow(() => run());
  fs.rmSync(path.join(root, "tests", "b.test.ts"));
  assert.throws(
    () => run(),
    (e) => e.status === 1 && /TST-120: acceptance|TST-120: requirement/.test(String(e.stderr)),
  );
  fs.rmSync(path.join(root, "tests", "a.test.ts"));
  assert.throws(
    () => run(),
    (e) => /AT-02: acceptance row lost its last test/.test(String(e.stderr)),
  );
});

test("the committed baseline holds against this repository", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const base = JSON.parse(
    fs.readFileSync(path.join(root, "tests", "test-map.baseline.json"), "utf8"),
  ).map;
  const f = checkMap(base, buildMap(root), (p) => fs.existsSync(path.join(root, p)));
  assert.deepEqual(f, []);
});

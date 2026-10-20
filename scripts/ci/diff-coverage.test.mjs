import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate, measure, parseDiff, parseIstanbul, parseLcov } from "./diff-coverage.mjs";

const fx = (name) =>
  fs.readFileSync(new URL(`./fixtures/diffcov/${name}`, import.meta.url), "utf8");
const run = (diff, lcov, extra = []) => {
  const m = measure(parseDiff(fx(diff)), parseLcov(fx(lcov)));
  return { m, r: evaluate(m, ...extra) };
};

test("parseDiff: added line numbers per file, new files from /dev/null base", () => {
  const d = parseDiff(fx("change.diff"));
  assert.deepEqual([...d.get("src/lib/demo/calc.ts")], [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual([...(d.get("src/lib/demo/fresh.ts") ?? [])], []);
  assert.deepEqual([...parseDiff(fx("new-file.diff")).get("src/lib/demo/fresh.ts")], [1, 2]);
});

test("fixture: fully covered change passes; docs and test files are ignored", () => {
  const { m, r } = run("change.diff", "full.lcov");
  assert.deepEqual(m.lines, { covered: 7, total: 7 });
  assert.deepEqual(m.branches, { covered: 4, total: 4 });
  assert.equal(r.ok, true);
});

test("fixture: partly covered change fails on lines and on branches", () => {
  const { m, r } = run("change.diff", "partial.lcov");
  assert.deepEqual(m.lines, { covered: 4, total: 7 });
  assert.deepEqual(m.branches, { covered: 1, total: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.findings.length, 2);
  assert.match(r.findings[0], /57\.1% covered, need 90%/);
});

test("thresholds are adjustable (diff_coverage_min / diff_branch_min)", () => {
  const { r } = run("change.diff", "partial.lcov", [{ lines: 50, branches: 20 }]);
  assert.equal(r.ok, true);
});

test("a docs-only diff has no executable change and passes (TST-120 exemption)", () => {
  const { m, r } = run("docs-only.diff", "full.lcov");
  assert.equal(m.lines.total, 0);
  assert.equal(r.ok, true);
});

test("a new source file with no coverage record fails", () => {
  const { r } = run("new-file.diff", "full.lcov");
  assert.equal(r.ok, false);
  assert.match(r.findings[0], /fresh\.ts: changed source file has no coverage record/);
});

test("istanbul coverage-final.json gives the same answer as lcov", () => {
  const json = {
    "D:/repo/src/lib/demo/calc.ts": {
      statementMap: {
        0: { start: { line: 4 } },
        1: { start: { line: 5 } },
        2: { start: { line: 6 } },
      },
      s: { 0: 1, 1: 1, 2: 0 },
      branchMap: { 0: { loc: { start: { line: 5 } } } },
      b: { 0: [1, 0] },
    },
  };
  const m = measure(parseDiff(fx("change.diff")), parseIstanbul(json, "D:/repo"));
  assert.deepEqual(m.lines, { covered: 2, total: 3 });
  assert.deepEqual(m.branches, { covered: 1, total: 2 });
});

test("lcov paths are made relative to --root and use forward slashes", () => {
  const cov = parseLcov("SF:D:\\repo\\src\\a.ts\nDA:1,1\nend_of_record\n", "D:\\repo");
  assert.ok(cov.has("src/a.ts"));
});

test("CLI: exit codes follow the verdict", () => {
  const script = fileURLToPath(new URL("./diff-coverage.mjs", import.meta.url));
  const dir = (n) => fileURLToPath(new URL(`./fixtures/diffcov/${n}`, import.meta.url));
  const go = (lcov) =>
    execFileSync(process.execPath, [script, "--diff", dir("change.diff"), "--lcov", dir(lcov)], {
      stdio: "pipe",
    });
  assert.doesNotThrow(() => go("full.lcov"));
  assert.throws(
    () => go("partial.lcov"),
    (e) => e.status === 1,
  );
});

// Tests of scripts/llm/bakeoff-index.mjs (M22 L1, D-1403): the committed module is current, the newest report wins, and
// a report with no valid date stops the generator. The longer cases are in tests/llm/bakeoffIndex.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildIndex, parseReport, render } from "./bakeoff-index.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "bakeoff-index.mjs");

const report = (run, date, verdict) =>
  [
    "# LLM bake-off report",
    `- Run: ${run}`,
    `- Date: ${date}`,
    "## Role verdicts",
    "| Role | Model | Result |",
    `| R6 | some-model | ${verdict} |`,
  ].join("\n");

test("a report that is not a bake-off report is not parsed", () => {
  assert.equal(parseReport("# Something else\n- Date: 2026-01-01"), null);
});

test("the newest report wins and a later FAIL withdraws an earlier PASS", () => {
  const idx = buildIndex([
    { file: "a.md", text: report("r1", "2026-11-01", "PASS") },
    { file: "b.md", text: report("r2", "2026-11-02", "FAIL") },
  ]);
  assert.equal(idx.R6.verdict, "FAIL");
  assert.deepEqual(idx.R6.models, []);
});

test("a report without a valid date stops the build", () => {
  assert.throws(
    () => buildIndex([{ file: "x.md", text: "# LLM bake-off report\n- Run: r\n- Date: soon" }]),
    /x\.md/,
  );
});

test("the rendering is stable", async () => {
  const files = [{ file: "a.md", text: report("r1", "2026-11-01", "PASS") }];
  assert.equal(await render(undefined, files), await render(undefined, files));
});

test("--check passes on the committed module; a bad mode is a usage error", () => {
  assert.equal(spawnSync(process.execPath, [script, "--check"]).status, 0);
  assert.equal(spawnSync(process.execPath, [script, "--nope"]).status, 2);
});

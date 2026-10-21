// M8 T12: .github/workflows/mutation.yml (decision 22; TST-130, AT-31). Parsed and checked as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHardened, assertNoUrlOutput, load, secretsByStep } from "./workflow-checks.mjs";

const w = load("mutation");
const job = w.wf.jobs.mutation;

test("triggers: one weekly cron and dispatch; never a push or pull request (TST-130)", () => {
  assert.deepEqual(Object.keys(w.wf.on), ["schedule", "workflow_dispatch"]);
  assert.equal(w.wf.on.schedule.length, 1);
  assert.match(w.wf.on.schedule[0].cron, /^\d+ \d+ \* \* [0-6]$/); // one weekday = weekly
  assert.doesNotMatch(w.text, /^\s*(push|pull_request\w*):/m);
});

test("no secrets, no environment, read-only contents", () => {
  assert.deepEqual(Object.keys(w.wf.jobs), ["mutation"]);
  assert.equal(job.environment, undefined);
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.deepEqual(secretsByStep(w.wf), {});
  assert.equal(w.text.includes("secrets."), false);
});

test("the shared hardening rules hold (permissions, pinned SHAs, no artifact or cache, no expression in run)", () => {
  assertHardened("mutation", w);
  assertNoUrlOutput(w.text);
});

test("Stryker runs from node_modules only: no npx download, a clear failure while it is not installed", () => {
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes("node_modules/.bin/stryker run"));
  assert.ok(!runs.some((r) => /npx\s+(-y\s+)?(--yes\s+)?@?stryker/.test(r)));
  const check = job.steps.find((s) => s.name?.startsWith("Check that Stryker is installed"));
  assert.match(check.run, /node_modules\/\.bin\/stryker/);
  assert.match(check.run, /exit 1/);
});

test("the summary step runs even when the mutation step failed and reads the configured report", () => {
  const summary = job.steps.find((s) => s.name === "Summary");
  assert.equal(summary.if, "${{ always() }}");
  assert.equal(summary.run, "node scripts/ci/mutation-summary.mjs reports/mutation/mutation.json");
});

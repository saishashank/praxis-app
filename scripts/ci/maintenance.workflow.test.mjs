// M22 E2 (KB-082, KB-083, D-1429, D-1412): the `experts` job of .github/workflows/maintenance.yml, checked by parsing the
// YAML (no GitHub, no secrets). It rides on the existing dispatch (no Worker slot), runs on the approved commit like the
// production job, has its own concurrency group, and holds the database pair and the three model keys only in the env of its
// last step. The production job itself is covered by staging-jobs.workflow.test.mjs (byte-identical to its stored copy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, stepsOf, SHA_USES } from "./workflow-checks.mjs";

const w = load("maintenance");
const prod = w.wf.jobs.production;
const job = w.wf.jobs.experts;

test("the workflow is still dispatch-only and the experts job follows the production job", () => {
  assert.equal(w.wf.on, "workflow_dispatch");
  assert.deepEqual(Object.keys(w.wf.jobs), ["production", "experts", "staging"]);
  assert.doesNotMatch(w.text, /^\s*(schedule|push|pull_request\w*|workflow_run):/m);
});

test("the experts job runs on release, in the production environment without a deployment record", () => {
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "experts", "cancel-in-progress": false });
  assert.notEqual(job.concurrency.group, prod.concurrency.group);
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
});

test("the approved-commit steps and node setup are the production job's, then npm ci, then one step", () => {
  assert.deepEqual(job.steps.slice(0, 4), prod.steps.slice(0, 4));
  assert.equal(job.steps[1].run, "node ci-tools/scripts/ci/approved-commit.mjs");
  assert.equal(job.steps[2].with.ref, "${{ steps.approved.outputs.sha }}");
  assert.equal(job.steps[4].run, "npm ci");
  assert.equal(job.steps.length, 6);
  assert.equal(job.steps[5].run, "node scripts/experts/run.mjs");
});

test("secrets reach only the last step, through env: the database pair and the three model keys", () => {
  const withSecrets = job.steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(withSecrets, [job.steps[5]]);
  assert.deepEqual(Object.keys(job.steps[5].env).sort(), [
    "GOOGLE_AI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "TURSO_MAIN_TOKEN",
    "TURSO_MAIN_URL",
  ]);
  assert.equal(job.steps[5].env.TURSO_MAIN_URL, "${{ secrets.TURSO_MAIN_URL_PROD }}");
  assert.equal(job.steps[5].env.TURSO_MAIN_TOKEN, "${{ secrets.TURSO_MAIN_TOKEN_PROD }}");
});

test("every action is pinned, nothing is cached or uploaded, no expression or secret inside a run script", () => {
  assert.deepEqual(w.wf.permissions, {});
  assert.doesNotMatch(w.text, /upload-artifact|download-artifact|actions\/cache|continue-on-error/);
  for (const s of stepsOf({ jobs: { experts: job } })) {
    if (s.uses) assert.match(s.uses, SHA_USES, s.uses);
    if (s.run) {
      assert.doesNotMatch(s.run, /\$\{\{|\bsecrets\b|curl|wget/);
    }
  }
});

// OPS-103 (D-961): the calendar-draft workflow, checked by parsing the YAML (no GitHub, no secrets, no
// network). PLT-015 (dispatch only, no schedule), SEC-108 c (approved commit copied from arena-close),
// SHA-pinned actions, SEC-110 (no artifact, no cache), the database pair only in `env:` of the one step
// that writes, and the dispatch inputs reaching the script through `env:` only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { extractJobBlock, readLocked } from "../ci/prod-job-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/calendar-draft.yml";
const wf = yaml.load(read(FILE));
const close = yaml.load(read(".github/workflows/arena-close.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only, with optional market and year inputs; no schedule, push or pull request", () => {
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs).sort(), ["market", "year"]);
  for (const i of Object.values(wf.on.workflow_dispatch.inputs)) {
    assert.equal(i.required, false);
    assert.equal(i.default, "");
  }
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(
    read(FILE),
    /^\s*(schedule|push|pull_request\w*|workflow_run|repository_dispatch):/m,
  );
});

test("one production job on release, no staging job, no deployment record, serialised", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production"]);
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "calendar-draft", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 30);
});

test("the approved-commit steps, node setup and npm ci are copied exactly from arena-close (SEC-108 c)", () => {
  assert.deepEqual(steps.slice(0, 5), close.jobs.production.steps.slice(0, 5));
});

test("every action is pinned to a full commit SHA; no artifact, no cache", () => {
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES, s.uses);
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
});

test("secrets appear only in env of the one draft step: the production database pair", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Draft the calendar"],
  );
  assert.deepEqual(withSecrets[0].env, {
    MARKET_INPUT: "${{ inputs.market }}",
    YEAR_INPUT: "${{ inputs.year }}",
    TURSO_MAIN_URL: "${{ secrets.TURSO_MAIN_URL_PROD }}",
    TURSO_MAIN_TOKEN: "${{ secrets.TURSO_MAIN_TOKEN_PROD }}",
  });
  assert.equal(
    withSecrets[0].run,
    'node scripts/calendar/draft.mjs --market "$MARKET_INPUT" --year "$YEAR_INPUT"',
  );
  for (const s of steps) {
    if (s.run) assert.ok(!s.run.includes("${{") && !s.run.includes("secrets."), s.run);
  }
});

test("the production job is byte-identical to its stored copy (prod-job lock)", () => {
  assert.equal(extractJobBlock(read(FILE), "production"), readLocked("calendar-draft"));
});

// M8 T12: .github/workflows/staging-e2e-day.yml (TST-106, AT-28, decision 45). Parsed and checked
// as text: no GitHub, no secrets, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHardened,
  assertNoUrlOutput,
  load,
  secretsByStep,
  stepsOf,
} from "./workflow-checks.mjs";

const w = load("staging-e2e-day");
const job = w.wf.jobs.staging;

test("dispatch only, one optional date input, no schedule, push or pull request", () => {
  assert.deepEqual(Object.keys(w.wf.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(w.wf.on.workflow_dispatch.inputs), ["date"]);
  assert.equal(w.wf.on.workflow_dispatch.inputs.date.required, false);
  assert.doesNotMatch(w.text, /^\s*(schedule|push|pull_request\w*|workflow_run):/m);
});

test("one staging job, on main, in the staging environment without a deployment record", () => {
  assert.deepEqual(Object.keys(w.wf.jobs), ["staging"]);
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(job.environment, { name: "staging", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job["timeout-minutes"], 25);
  assert.equal(job.concurrency["cancel-in-progress"], false);
});

test("the shared hardening rules hold (permissions, pinned SHAs, no artifact or cache, no expression in run)", () => {
  assertHardened("staging-e2e-day", w);
  assertNoUrlOutput(w.text);
});

test("secrets reach only the checker and the e2e step, only through env", () => {
  assert.deepEqual(secretsByStep(w.wf), {
    "PLT-073 deadline check": ["TURSO_MAIN_TOKEN_STAGING", "TURSO_MAIN_URL_STAGING"],
    "Staging end-to-end checks (viewer test identity)": [
      "APP_BASE_URL_STAGING",
      "TEST_IDENTITY_SECRET_STAGING",
    ],
  });
  // The staging address is a masked secret, not a plain variable (decision 7).
  assert.doesNotMatch(w.text, /\bvars\./);
});

test("the checker runs the CLI and the e2e step uses the staging config, not the local one", () => {
  const steps = stepsOf(w.wf);
  const check = steps.find((s) => s.name === "PLT-073 deadline check");
  assert.match(check.run, /^node scripts\/e2e-day\/check\.mjs /);
  assert.equal(check.env.PRAXIS_ENV, "staging");
  const e2e = steps.find((s) => s.id === "e2e");
  assert.equal(e2e.run, "npx playwright test --config playwright.staging.config.ts");
  // Both run even when the other failed, so one red check does not hide the other.
  assert.equal(e2e.if, "${{ !cancelled() }}");
  assert.match(check.env.E2E_DAY_DATE, /inputs\.date/);
});

test("the production database, key and address names never appear", () => {
  assert.doesNotMatch(w.text, /_PROD\b/);
});

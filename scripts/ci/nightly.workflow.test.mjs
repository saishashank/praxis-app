// M8 T12: .github/workflows/nightly.yml (decision 21; TST-132, AT-31). Parsed and checked as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHardened, assertNoUrlOutput, load, secretsByStep } from "./workflow-checks.mjs";

const w = load("nightly");

test("triggers: one nightly cron (off the hour, away from 11:40 UTC) and dispatch", () => {
  assert.deepEqual(Object.keys(w.wf.on), ["schedule", "workflow_dispatch"]);
  assert.equal(w.wf.on.schedule.length, 1);
  const cron = w.wf.on.schedule[0].cron;
  assert.match(cron, /^\d+ \d+ \* \* \*$/);
  const [min, hour] = cron.split(" ").map(Number);
  assert.notEqual(min, 0);
  assert.notEqual(`${hour}:${min}`, "11:40");
  assert.doesNotMatch(w.text, /^\s*(push|pull_request\w*):/m);
});

test("jobs: gate -> staging -> streak, staging in the staging environment on main's code", () => {
  assert.deepEqual(Object.keys(w.wf.jobs), ["gate", "staging", "streak"]);
  const s = w.wf.jobs.staging;
  assert.equal(s.needs, "gate");
  assert.equal(s.if, "needs.gate.outputs.run == 'true'");
  assert.deepEqual(s.environment, { name: "staging", deployment: false });
  assert.equal(s.steps[0].with.ref, "main");
  assert.ok(s["timeout-minutes"] <= 25, "TST-132: nightly full suite <= 25 min");
  assert.equal(s.name, undefined); // the streak counter reads the job named "staging"
});

test("only the gate and streak jobs may read Actions history; nothing can write", () => {
  assert.deepEqual(w.wf.jobs.gate.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(w.wf.jobs.streak.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(w.wf.jobs.staging.permissions, { contents: "read" });
});

test("the shared hardening rules hold (permissions, pinned SHAs, no artifact or cache, no expression in run)", () => {
  assertHardened("nightly", w);
  assertNoUrlOutput(w.text);
});

test("secrets reach only the staging e2e step, through env; the API calls use github.token alone", () => {
  assert.deepEqual(secretsByStep(w.wf), {
    "Staging end-to-end checks (viewer test identity)": [
      "APP_BASE_URL_STAGING",
      "TEST_IDENTITY_SECRET_STAGING",
    ],
  });
  for (const id of ["gate", "streak"]) {
    for (const st of w.wf.jobs[id].steps.filter((x) => x.env)) {
      assert.equal(st.env.GITHUB_TOKEN, "${{ github.token }}");
    }
  }
});

test("the suite is the whole vitest run, the smoke tests, the Worker tests and the staging e2e", () => {
  const runs = w.wf.jobs.staging.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes("npx vitest run"));
  assert.ok(runs.includes("npm run test:smoke"));
  assert.ok(runs.includes("npm test")); // in worker/
  assert.ok(runs.includes("npx playwright test --config playwright.staging.config.ts"));
  const worker = w.wf.jobs.staging.steps.filter((s) => s["working-directory"] === "worker");
  assert.equal(worker.length, 2);
});

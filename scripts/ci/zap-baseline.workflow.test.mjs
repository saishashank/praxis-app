// M8 T12: .github/workflows/zap-baseline.yml (decisions 7, 37, 38; AT-29). Parsed and checked as
// text: no GitHub, no secrets, no network, no Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_PATTERN } from "./zap-run.mjs";
import {
  assertHardened,
  assertNoUrlOutput,
  load,
  secretsByStep,
  stepsOf,
} from "./workflow-checks.mjs";

const w = load("zap-baseline");

test("triggers: every push to build and main (local scan) and dispatch (staging scan)", () => {
  assert.deepEqual(Object.keys(w.wf.on), ["push", "workflow_dispatch"]);
  assert.deepEqual(w.wf.on.push.branches, ["build", "main"]);
  assert.doesNotMatch(w.text, /^\s*(schedule|pull_request\w*):/m);
});

test("local job: push only, no environment, no repository secret", () => {
  const j = w.wf.jobs.local;
  // D-158: skipped until the image digest is pinned and ZAP_IMAGE_PINNED is set
  assert.equal(j.if, "github.event_name == 'push' && vars.ZAP_IMAGE_PINNED == 'true'");
  assert.equal(j.environment, undefined);
  assert.deepEqual(j.permissions, { contents: "read" });
  assert.equal(JSON.stringify(j).includes("secrets."), false);
});

test("staging job: dispatch from main, staging environment, secrets only in the scan step", () => {
  const j = w.wf.jobs.staging;
  assert.equal(j.if, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  assert.deepEqual(j.environment, { name: "staging", deployment: false });
  assert.deepEqual(secretsByStep(w.wf), {
    "Scan staging as the viewer test identity": [
      "APP_BASE_URL_STAGING",
      "TEST_IDENTITY_SECRET_STAGING",
    ],
  });
});

test("the shared hardening rules hold (permissions, pinned SHAs, no artifact or cache, no expression in run)", () => {
  assertHardened("zap-baseline", w);
  assertNoUrlOutput(w.text);
});

test("output goes only through zap-summary.mjs; the report is deleted and never uploaded", () => {
  for (const id of ["local", "staging"]) {
    const steps = w.wf.jobs[id].steps;
    const summary = steps.find((s) => s.name?.startsWith("Summary"));
    assert.match(
      summary.run,
      /^node scripts\/ci\/zap-summary\.mjs "\$RUNNER_TEMP\/zap\/zap\.json" --label /,
    );
    const del = steps[steps.length - 1];
    assert.equal(del.if, "${{ always() }}");
    assert.equal(del.run, 'rm -rf "$RUNNER_TEMP/zap"');
  }
  assert.doesNotMatch(w.text, /upload-artifact/);
  assert.equal(stepsOf(w.wf).filter((s) => s.run?.includes("docker")).length, 0); // docker is run by zap-run.mjs only
});

test("the ZAP image is a ghcr.io/zaproxy reference pinned by sha256 digest", () => {
  assert.match(w.wf.env.ZAP_IMAGE, IMAGE_PATTERN);
});

test("the image is pinned to a real digest, not the all-zero placeholder (D-814)", () => {
  assert.doesNotMatch(w.wf.env.ZAP_IMAGE, /sha256:0{64}$/);
});

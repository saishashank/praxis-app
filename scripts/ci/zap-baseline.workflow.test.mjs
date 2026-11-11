// M8 T12: .github/workflows/zap-baseline.yml (decisions 7, 37, 38; AT-29). Parsed and checked as
// text: no GitHub, no secrets, no network, no Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_PATTERN } from "./zap-run.mjs";
import { JOB, STEP } from "./release-gate-core.mjs";
import {
  assertHardened,
  assertNoUrlOutput,
  load,
  secretsByStep,
  stepsOf,
} from "./workflow-checks.mjs";

const w = load("zap-baseline");

test("triggers: every push to build and main (the local scan) and nothing else; no staging job (D-964)", () => {
  assert.deepEqual(Object.keys(w.wf.on), ["push"]);
  assert.deepEqual(Object.keys(w.wf.jobs), ["local"]);
  assert.equal(JSON.stringify(w.wf).toLowerCase().includes("staging"), false); // comments aside
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

test("the scan is authenticated and the release gate reads exactly that job and step (D-964)", () => {
  assert.equal(JOB.zap, "local");
  const scan = w.wf.jobs.local.steps.find((s) => s.name === STEP.zapScan);
  assert.ok(scan, "the gate's authenticated-scan step exists under its gate name");
  assert.equal(scan.run, "node scripts/ci/zap-run.mjs local");
  // no environment value and no secret reaches the scan: the run generates its own
  assert.equal(scan.env, undefined);
  assert.deepEqual(secretsByStep(w.wf), {});
  assert.equal(w.wf.jobs.local.steps.filter((s) => s.name === STEP.zapScan).length, 1);
});

test("the shared hardening rules hold (permissions, pinned SHAs, no artifact or cache, no expression in run)", () => {
  assertHardened("zap-baseline", w);
  assertNoUrlOutput(w.text);
});

test("output goes only through zap-summary.mjs; the report is deleted and never uploaded", () => {
  for (const id of ["local"]) {
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

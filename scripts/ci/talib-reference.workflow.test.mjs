// M4 T16a: the talib-reference workflow, checked by parsing the YAML. It must be dispatch-only
// with NO secrets and NO environment, pinned actions, nothing uploaded or cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = ".github/workflows/talib-reference.yml";
const text = readFileSync(path.join(root, FILE), "utf8");
const wf = yaml.load(text);
const job = wf.jobs.reference;

test("dispatch only, read-only token, no environment", () => {
  assert.equal(wf.on, "workflow_dispatch");
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.environment, undefined);
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.doesNotMatch(text, /^\s*(schedule|push|pull_request\w*):/m);
});

test("no secrets anywhere, nothing uploaded or cached", () => {
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /upload-artifact|download-artifact|actions\/cache|cache:/);
  for (const s of job.steps) {
    assert.equal(s.env, undefined);
    if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
  }
});

test("actions are pinned to full SHAs; TA-Lib and numpy are pinned versions", () => {
  for (const s of job.steps.filter((x) => x.uses)) {
    assert.match(s.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, s.uses);
  }
  const install = job.steps.find((s) => String(s.run).includes("pip install"));
  // M8 T17: the install set is a hashed requirements file (SEC-107).
  assert.match(install.run, /--require-hashes -r scripts\/agents\/requirements-talib\.txt/);
  const req = readFileSync(path.join(root, "scripts/agents/requirements-talib.txt"), "utf8");
  assert.match(req, /^ta-lib==\d+\.\d+\.\d+ \\\r?$/m);
  assert.match(req, /^numpy==\d+\.\d+\.\d+ \\\r?$/m);
  assert.match(req, /--hash=sha256:[0-9a-f]{64}/);
  assert.ok(job.steps.some((s) => s.run === "python scripts/agents/talib_reference.py"));
});

test("the Worker never dispatches it", () => {
  assert.doesNotMatch(
    readFileSync(path.join(root, "worker/src/schedule.ts"), "utf8"),
    /talib-reference/,
  );
});

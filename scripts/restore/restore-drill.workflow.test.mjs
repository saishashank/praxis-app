// M8 T7: the restore-drill workflow, checked by parsing the YAML (no GitHub, no secrets, no
// network). TST-108, OPS-040, SEC-017 (l), PLT-015, SEC-108 c, PLT-022b.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/restore-drill.yml";
const src = read(FILE);
const wf = yaml.load(src);
const backup = yaml.load(read(".github/workflows/backup.yml"));
const job = wf.jobs.restore;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
const byName = (n) => steps.find((s) => s.name === n);
const secretKeys = (s) =>
  Object.keys(s.env ?? {})
    .filter((k) => String(s.env[k]).includes("secrets."))
    .sort();

test("workflow_dispatch only: no schedule, push, pull request or other trigger", () => {
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  assert.doesNotMatch(
    src,
    /^\s*(schedule|push|pull_request\w*|workflow_run|repository_dispatch):/m,
  );
  const inputs = wf.on.workflow_dispatch.inputs;
  assert.deepEqual(inputs.mode.options, ["drill", "restore", "verify-removed"]);
  assert.deepEqual(inputs.environment.options, ["production", "staging"]);
  assert.deepEqual(inputs.key.options, ["real", "throwaway"]);
  assert.equal(inputs.mode.default, "drill");
  assert.equal(inputs.environment.default, "production");
});

test("minimal permissions: none at the top, read-only contents and deployments on the one job", () => {
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(Object.keys(wf.jobs), ["restore"]);
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.concurrency, { group: "restore-drill", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 240);
});

test("environment comes from the input and gives no deployment record", () => {
  assert.deepEqual(job.environment, { name: "${{ inputs.environment }}", deployment: false });
});

test("the approved-commit steps and node setup are copied exactly from backup.yml", () => {
  assert.deepEqual(steps.slice(0, 5), backup.jobs.production.steps.slice(0, 5));
});

test("every action is pinned to a full commit SHA", () => {
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES);
});

test("secrets appear only in env of the guard, run and final-check steps, never at job level", () => {
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Guard (temporary secrets present)", "Drill or restore", "Fail while temporary secrets exist"],
  );
  assert.deepEqual(secretKeys(byName("Guard (temporary secrets present)")), [
    "BACKUP_PRIVATE_KEY",
    "TURSO_PLATFORM_TOKEN_TEMP",
  ]);
  assert.deepEqual(secretKeys(byName("Drill or restore")), [
    "BACKUP_PRIVATE_KEY",
    "DATA_REPO_TOKEN",
    "TURSO_PLATFORM_TOKEN_TEMP",
  ]);
  assert.deepEqual(secretKeys(byName("Fail while temporary secrets exist")), [
    "BACKUP_PRIVATE_KEY",
    "TURSO_PLATFORM_TOKEN_TEMP",
  ]);
  // The approved-commit step sees github.token only.
  assert.equal(steps.find((s) => s.id === "approved").env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(src.match(/secrets\./g).length, 7);
});

test("no run: script contains any ${{ }} expression, so no secret or input is echoed", () => {
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
  for (const s of steps) {
    if (s.run)
      assert.doesNotMatch(String(s.run), /\becho\b|printenv|\benv\b|set -x|GITHUB_STEP_SUMMARY/);
  }
  assert.equal(byName("Drill or restore").run, "node scripts/restore/drill-turso.mjs run");
});

test("plaintext cleanup runs in an always() step before the final step", () => {
  const i = steps.findIndex((s) => s.name === "Remove plaintext temp files");
  assert.ok(i > 0);
  assert.equal(steps[i].if, "always()");
  assert.equal(steps[i].run, "node scripts/restore/drill-turso.mjs cleanup");
  assert.equal(secretKeys(steps[i]).length, 0);
  assert.ok(i < steps.length - 1);
});

test("the LAST step runs always() and fails while the temporary key or Turso token exists", () => {
  const last = steps[steps.length - 1];
  assert.equal(last.name, "Fail while temporary secrets exist");
  assert.equal(last.if, "always()");
  assert.equal(last.run, "node scripts/restore/drill-turso.mjs final-check");
  assert.equal(last["continue-on-error"], undefined);
  assert.deepEqual(last.env, {
    BACKUP_PRIVATE_KEY: "${{ secrets.BACKUP_PRIVATE_KEY }}",
    TURSO_PLATFORM_TOKEN_TEMP: "${{ secrets.TURSO_PLATFORM_TOKEN_TEMP }}",
  });
  for (const s of steps) assert.equal(s["continue-on-error"], undefined);
});

test("drill and guard steps are skipped only in verify-removed mode; the data-repo secret is the production one", () => {
  for (const n of ["Guard (temporary secrets present)", "Drill or restore"]) {
    assert.equal(byName(n).if, "inputs.mode != 'verify-removed'");
  }
  assert.equal(
    byName("Drill or restore").env.DATA_REPO_TOKEN,
    "${{ secrets.DATA_REPO_TOKEN_PROD }}",
  );
  assert.equal(byName("Drill or restore").env.DATA_REPO, "${{ github.repository }}-data");
});

test("no artifact upload, no cache, no step-summary writes from YAML (SEC-110)", () => {
  assert.doesNotMatch(src, /upload-artifact|download-artifact|actions\/cache|cache:/);
  assert.doesNotMatch(src, /GITHUB_STEP_SUMMARY/);
});

test("the private key is never written by the workflow: not as a file, not in run:, not echoed", () => {
  assert.doesNotMatch(src, /BACKUP_PRIVATE_KEY\s*>|>\s*.*key|tee |openssl|age -d/);
  const keyUsers = steps
    .filter((s) => JSON.stringify(s).includes("BACKUP_PRIVATE_KEY"))
    .map((s) => s.name);
  assert.deepEqual(keyUsers, [
    "Guard (temporary secrets present)",
    "Drill or restore",
    "Fail while temporary secrets exist",
  ]);
});

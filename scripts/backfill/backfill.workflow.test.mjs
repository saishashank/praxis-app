// M2 T9: the backfill-history workflow, checked by parsing the YAML (no GitHub, no secrets).
// Covers PLT-015 (dispatch only), PLT-076 (concurrency), SEC-108 c (approved commit, same steps as
// the nightly backup), SEC-110 (no artifacts, no cache), "secrets only in env of the steps that
// need them; the external fetch step has none", and DAT-122 (Actions never contacts ASX).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/backfill-history.yml";
const wf = yaml.load(read(FILE));
const backup = yaml.load(read(".github/workflows/backup.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const byName = (n) => steps.find((s) => s.name === n);
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only: no schedule, push or pull request trigger (PLT-015)", () => {
  assert.equal(wf.on, "workflow_dispatch");
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(read(FILE), /^\s*(schedule|push|pull_request\w*):/m);
});

test("one production job on release, environment production without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "backfill-history", "cancel-in-progress": false });
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
});

test("the approved-commit steps are copied exactly from the nightly backup (SEC-108 c)", () => {
  const b = backup.jobs.production.steps;
  assert.deepEqual(steps.slice(0, 5), b.slice(0, 5));
  assert.equal(steps[1].run, "node ci-tools/scripts/ci/approved-commit.mjs");
  assert.equal(steps[2].with.ref, "${{ steps.approved.outputs.sha }}");
  assert.deepEqual(backup.jobs.production.environment, job.environment);
  assert.deepEqual(backup.jobs.production.permissions, job.permissions);
});

test("every action is pinned to a full commit SHA", () => {
  const uses = steps.filter((s) => s.uses).map((s) => s.uses);
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, SHA_USES, u);
});

test("secrets appear only in env of the plan and commit steps, with exactly the secrets they need", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Plan the fetch (read-only)", "Write history files and move the cursors"],
  );
  const [plan, commit] = withSecrets;
  assert.deepEqual(Object.keys(plan.env), ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN"]);
  assert.deepEqual(Object.keys(commit.env), [
    "TURSO_MAIN_URL",
    "TURSO_MAIN_TOKEN",
    "DATA_REPO_TOKEN",
    "DATA_REPO",
    "COMMIT_SHA",
  ]);
  assert.equal(commit.env.TURSO_MAIN_URL, "${{ secrets.TURSO_MAIN_URL_PROD }}");
  assert.equal(commit.env.TURSO_MAIN_TOKEN, "${{ secrets.TURSO_MAIN_TOKEN_PROD }}");
  assert.equal(commit.env.DATA_REPO_TOKEN, "${{ secrets.DATA_REPO_TOKEN_PROD }}");
  assert.equal(commit.env.DATA_REPO, "${{ github.repository }}-data");
  assert.equal(commit.env.COMMIT_SHA, "${{ steps.approved.outputs.sha }}");
  // the data repo token is NOT in the plan step; nothing but prod secrets is referenced
  assert.ok(!JSON.stringify(plan).includes("DATA_REPO"));
  for (const s of withSecrets) {
    assert.ok(!String(s.run).includes("secrets."));
    assert.ok(!String(s.if ?? "").includes("secrets."));
    assert.equal(s.with, undefined);
  }
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  const refs = JSON.stringify(job).match(/secrets\.[A-Z_]+/g);
  assert.deepEqual(refs.sort(), [
    "secrets.DATA_REPO_TOKEN_PROD",
    "secrets.TURSO_MAIN_TOKEN_PROD",
    "secrets.TURSO_MAIN_TOKEN_PROD",
    "secrets.TURSO_MAIN_URL_PROD",
    "secrets.TURSO_MAIN_URL_PROD",
  ]);
});

test("the ASIC fetch step has no secrets, no env and no database access", () => {
  const f = byName("Fetch ASIC short positions (no secrets)");
  assert.equal(f.if, "steps.plan.outputs.fetch == 'true'");
  assert.equal(f.run, "node scripts/backfill/fetch-asic.mjs --plan plan.json --output chunks.json");
  assert.equal(f.env, undefined);
  assert.ok(!JSON.stringify(f).includes("secrets."));
  assert.ok(!JSON.stringify(f).includes("TURSO"));
  assert.ok(!JSON.stringify(f).includes("DATA_REPO"));
});

test("steps run in order: plan, fetch, commit; commit also records a failed or skipped fetch", () => {
  const plan = steps.findIndex((s) => s.id === "plan");
  const fetch = steps.findIndex((s) => s.name === "Fetch ASIC short positions (no secrets)");
  const commit = steps.findIndex((s) => s.name === "Write history files and move the cursors");
  assert.ok(0 < plan && plan < fetch && fetch < commit);
  assert.equal(steps[plan].run, "node scripts/backfill/run.mjs plan --out plan.json");
  assert.equal(steps[commit].run, "node scripts/backfill/run.mjs commit --chunks chunks.json");
  assert.match(
    steps[commit].if,
    /^\$\{\{ !cancelled\(\) && steps\.plan\.outcome == 'success' \}\}$/,
  );
});

test("no artifact upload, no cache, no expression inside a script (SEC-110)", () => {
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
});

test("Actions never contacts asx.com.au: no ASX host or script in the workflow or its scripts", () => {
  const files = [
    FILE,
    "scripts/backfill/run.mjs",
    "scripts/backfill/fetch-asic.mjs",
    "src/lib/data/backfill/asicFetch.mjs",
    "src/lib/data/backfill/engine.mjs",
    "src/lib/data/backfill/dataRepo.mjs",
  ];
  // Comments may name the host (they explain the rule); code and YAML keys may not.
  const code = (f) =>
    read(f)
      .split("\n")
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
      .join("\n");
  for (const f of files) {
    assert.doesNotMatch(code(f), /asx\.com\.au/i, f);
    assert.doesNotMatch(code(f), /sources\/asx/, f);
  }
});

test("the Worker may dispatch this file, but its slot stays disabled until the Owner enables it", () => {
  const sched = read("worker/src/schedule.ts");
  assert.match(sched, /"backfill-history\.yml"/);
  const slot = sched.slice(sched.indexOf('id: "backfill-history"'));
  assert.match(slot, /workflow: "backfill-history\.yml"/);
  assert.match(slot, /enabled: false/);
});

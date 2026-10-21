// M3 T10: the arena-close workflow, checked by parsing the YAML (no GitHub, no secrets).
// Covers PLT-015 (dispatch only), PLT-076 (concurrency), SEC-108 c (approved commit, same steps as
// the nightly backup and Batch 1), SEC-110 (no artifacts, no cache), "secrets only in env of the
// one step that needs them", and that the Worker may dispatch the file while its slot stays off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const load = (f) => yaml.load(read(f));
const FILE = ".github/workflows/arena-close.yml";
const wf = load(FILE);
const ingest = load(".github/workflows/ingest-batch1.yml");
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only: no schedule, push or pull request trigger (PLT-015)", () => {
  assert.equal(wf.name, "Arena close the books (batch 2a)");
  assert.equal(wf.on, "workflow_dispatch");
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(read(FILE), /^\s*(schedule|push|pull_request\w*):/m);
});

test("one production job on release, environment production without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "arena-close", "cancel-in-progress": false });
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
});

test("the approved-commit steps and node setup are copied exactly from Batch 1 (SEC-108 c)", () => {
  assert.deepEqual(steps.slice(0, 5), ingest.jobs.production.steps.slice(0, 5));
  assert.equal(steps[1].run, "node ci-tools/scripts/ci/approved-commit.mjs");
  assert.equal(steps[2].with.ref, "${{ steps.approved.outputs.sha }}");
  assert.deepEqual(ingest.jobs.production.environment, job.environment);
  assert.deepEqual(ingest.jobs.production.permissions, job.permissions);
});

test("every action is pinned to a full commit SHA", () => {
  const uses = steps.filter((s) => s.uses).map((s) => s.uses);
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, SHA_USES, u);
});

test("the database secrets appear only in env of the one closing step, the prod Turso pair", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Close the books"],
  );
  const s = withSecrets[0];
  assert.deepEqual(
    Object.keys(s.env).filter((k) => String(s.env[k]).includes("secrets.")),
    ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN"],
  );
  assert.equal(s.env.TURSO_MAIN_URL, "${{ secrets.TURSO_MAIN_URL_PROD }}");
  assert.equal(s.env.TURSO_MAIN_TOKEN, "${{ secrets.TURSO_MAIN_TOKEN_PROD }}");
  assert.equal(s.env.COMMIT_SHA, "${{ steps.approved.outputs.sha }}");
  assert.equal(s.run, "node scripts/arena/close-books.mjs");
  assert.ok(!String(s.run).includes("secrets."));
  assert.equal(s.with, undefined);
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(JSON.stringify(job).match(/secrets\./g).length, 2);
});

test("install runs before the secret step, which is the last step", () => {
  const install = steps.findIndex((s) => s.run === "npm ci");
  const close = steps.findIndex((s) => s.name === "Close the books");
  assert.ok(install > 0 && install < close);
  assert.equal(close, steps.length - 1);
});

test("no artifact upload, no cache, no expression inside a script (SEC-110)", () => {
  const text = read(FILE);
  assert.doesNotMatch(text, /upload-artifact|download-artifact|actions\/cache|cache:/);
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
});

test("batch 2b and batch 3 are not built here (signals are M4)", () => {
  assert.match(read(FILE), /NOT built here: batch 2b/);
  assert.ok(!/2b|batch 3|signal/i.test(JSON.stringify(steps)));
});

test("the Worker may dispatch this file but its slot is disabled (like backfill-history)", () => {
  const sched = read("worker/src/schedule.ts");
  assert.match(sched, /"arena-close\.yml"/);
  const slot = sched.slice(sched.indexOf('id: "arena-close"'));
  assert.match(slot.slice(0, slot.indexOf("}),")), /workflow: "arena-close\.yml"/);
  assert.match(
    slot.slice(0, slot.indexOf("}),")),
    /enabled: false|requiresListing: true/ /* M8 T8 (D-155): a go-live slot runs only once the Owner lists it */,
  );
});

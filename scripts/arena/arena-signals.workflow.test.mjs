// M4 T8: the arena-signals workflow, checked by parsing the YAML (no GitHub, no secrets).
// Same checks as arena-close (PLT-015 dispatch only, PLT-076 concurrency, SEC-108 c approved
// commit, SEC-110 no artifacts or cache, secrets only in env of the one step that needs them) and
// that the Worker may dispatch the file while its slot stays off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const load = (f) => yaml.load(read(f));
const FILE = ".github/workflows/arena-signals.yml";
const wf = load(FILE);
const close = load(".github/workflows/arena-close.yml");
const ingest = load(".github/workflows/ingest-batch1.yml");
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only: no schedule, push or pull request trigger (PLT-015)", () => {
  assert.equal(wf.name, "Arena signals and orders (batch 2b)");
  assert.equal(wf.on, "workflow_dispatch");
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(read(FILE), /^\s*(schedule|push|pull_request\w*):/m);
});

test("one production job on release, environment production without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production"]);
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "arena-signals", "cancel-in-progress": false });
  assert.notEqual(job.concurrency.group, close.jobs.production.concurrency.group);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
});

test("the approved-commit steps and node setup are copied exactly from Batch 1 and arena-close", () => {
  assert.deepEqual(steps.slice(0, 5), ingest.jobs.production.steps.slice(0, 5));
  assert.deepEqual(steps.slice(0, 5), close.jobs.production.steps.slice(0, 5));
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

test("the database secrets appear only in env of the one deciding step, the prod Turso pair", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Decide the session"],
  );
  const s = withSecrets[0];
  assert.deepEqual(
    Object.keys(s.env).filter((k) => String(s.env[k]).includes("secrets.")),
    ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN"],
  );
  assert.equal(s.env.TURSO_MAIN_URL, "${{ secrets.TURSO_MAIN_URL_PROD }}");
  assert.equal(s.env.TURSO_MAIN_TOKEN, "${{ secrets.TURSO_MAIN_TOKEN_PROD }}");
  assert.equal(s.env.COMMIT_SHA, "${{ steps.approved.outputs.sha }}");
  assert.equal(s.run, "node scripts/arena/signals.mjs");
  assert.ok(!String(s.run).includes("secrets."));
  assert.equal(s.with, undefined);
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(JSON.stringify(wf).match(/secrets\./g).length, 2);
});

test("install runs before the secret step, which is the last step", () => {
  const install = steps.findIndex((s) => s.run === "npm ci");
  const decide = steps.findIndex((s) => s.name === "Decide the session");
  assert.ok(install > 0 && install < decide);
  assert.equal(decide, steps.length - 1);
});

test("no artifact upload, no cache, no expression inside a script (SEC-110)", () => {
  const text = read(FILE);
  assert.doesNotMatch(text, /upload-artifact|download-artifact|actions\/cache|cache:/);
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
});

test("the Worker may dispatch this file but its slot is disabled, at 18:10 on trading days", () => {
  const sched = read("worker/src/schedule.ts");
  assert.match(sched, /"arena-signals\.yml"/);
  const slot = sched.slice(sched.indexOf('id: "arena-signals"'));
  const body = slot.slice(0, slot.indexOf("}),"));
  assert.match(body, /time: "18:10"/);
  assert.match(body, /workflow: "arena-signals\.yml"/);
  assert.match(body, /tradingDaysOnly: true/);
  assert.match(body, /enabled: false/);
});

test("the health page lists the job like arena-close", () => {
  const jobs = read("src/lib/health/jobs.ts");
  assert.match(jobs, /job: "arena-signals"/);
  assert.match(jobs, /job: "arena-close"/);
});

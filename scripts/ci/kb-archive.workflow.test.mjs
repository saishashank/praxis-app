// M6 T13: the KB archive workflow, checked by parsing the YAML (no GitHub, no secrets, no network).
// PLT-015 (dispatch only, no schedule), release guard, SEC-108 c (approved commit copied from
// arena-close), SEC-110 (no artifacts, no cache), database and data-repo secrets only in env of the
// one archive step, the Worker slot disabled, and the token's only host is api.github.com.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/kb-archive.yml";
const wf = yaml.load(read(FILE));
const close = yaml.load(read(".github/workflows/arena-close.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only, no inputs; no schedule, push or pull request; no top-level permissions", () => {
  assert.equal(wf.on, "workflow_dispatch");
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(
    read(FILE),
    /^\s*(schedule|push|pull_request\w*|workflow_run|repository_dispatch):/m,
  );
});

test("one production job on release, production environment without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "kb-archive", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
});

test("the approved-commit steps and node setup are copied exactly from arena-close", () => {
  assert.deepEqual(steps.slice(0, 5), close.jobs.production.steps.slice(0, 5));
});

test("every action is pinned to a full commit SHA", () => {
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES);
});

test("secrets appear only in env of the archive step, which is last: database pair and data-repo token", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["KB archive"],
  );
  const s = withSecrets[0];
  assert.deepEqual(
    Object.keys(s.env)
      .filter((k) => String(s.env[k]).includes("secrets."))
      .sort(),
    ["DATA_REPO_TOKEN", "TURSO_MAIN_TOKEN", "TURSO_MAIN_URL"],
  );
  assert.equal(s.env.DATA_REPO, "${{ github.repository }}-data");
  assert.equal(steps[steps.length - 1], s);
  assert.equal(s.run, "node scripts/kb/archive.mjs");
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(JSON.stringify(job).match(/secrets\./g).length, 3);
  for (const x of steps) if (x.run) assert.ok(!String(x.run).includes("${{"), x.run);
});

test("no artifact upload, no cache, no step summary (SEC-110)", () => {
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
  assert.doesNotMatch(read(FILE), /GITHUB_STEP_SUMMARY/);
});

test("the Worker slot exists, is allow-listed and stays disabled until the Owner enables it", () => {
  const sched = read("worker/src/schedule.ts");
  assert.match(sched, /"kb-archive\.yml",/);
  const m = /id: "kb-archive",[\s\S]*?enabled: (true|false),/.exec(sched);
  assert.ok(m, "slot present");
  assert.equal(m[1], "false");
});

test("the client sends the token only to api.github.com and never follows a redirect", () => {
  const git = read("src/lib/kb/gitData.ts");
  assert.match(git, /GITHUB_API = "https:\/\/api\.github\.com"/);
  assert.match(git, /redirect: "error"/);
  const hosts = [...git.matchAll(/https?:\/\/[^\s"'`/]+/g)].map((x) => x[0]);
  assert.deepEqual([...new Set(hosts)], ["https://api.github.com"]);
  assert.doesNotMatch(read("src/lib/kb/archiveCli.ts"), /https?:\/\//);
  assert.match(read("scripts/kb/archive.mjs"), /archiveMain/);
});

// M4 T16a: the backfill-prices workflow, checked by parsing the YAML (no GitHub, no secrets).
// Same checks as backfill.workflow.test.mjs: PLT-015 (dispatch only), PLT-076 (concurrency),
// SEC-108 c (approved commit), SEC-110 (no artifacts, no cache), secrets only in env of the plan
// and commit steps, none in the Yahoo fetch step; the Worker may dispatch it, slot disabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { run } from "./prices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/backfill-prices.yml";
const wf = yaml.load(read(FILE));
const backup = yaml.load(read(".github/workflows/backup.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const byName = (n) => steps.find((s) => s.name === n);
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
const FETCH = "Fetch Yahoo prices (no secrets)";
const COMMIT = "Write the month file and move the cursor";

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
  assert.deepEqual(job.concurrency, { group: "backfill-prices", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
});

test("the approved-commit steps are copied exactly from the nightly backup (SEC-108 c)", () => {
  assert.deepEqual(steps.slice(0, 5), backup.jobs.production.steps.slice(0, 5));
  assert.equal(steps[1].run, "node ci-tools/scripts/ci/approved-commit.mjs");
});

test("every action is pinned to a full commit SHA", () => {
  const uses = steps.filter((s) => s.uses).map((s) => s.uses);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, SHA_USES, u);
});

test("secrets appear only in env of the plan and commit steps", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Plan the fetch (read-only)", COMMIT],
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
  assert.ok(!JSON.stringify(plan).includes("DATA_REPO"));
  for (const s of withSecrets) {
    assert.ok(!String(s.run).includes("secrets."));
    assert.equal(s.with, undefined);
  }
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.deepEqual((JSON.stringify(job).match(/secrets\.[A-Z_]+/g) ?? []).sort(), [
    "secrets.DATA_REPO_TOKEN_PROD",
    "secrets.TURSO_MAIN_TOKEN_PROD",
    "secrets.TURSO_MAIN_TOKEN_PROD",
    "secrets.TURSO_MAIN_URL_PROD",
    "secrets.TURSO_MAIN_URL_PROD",
  ]);
});

test("the Yahoo fetch step has no secrets, no env and no database access", () => {
  const f = byName(FETCH);
  assert.equal(f.if, "steps.plan.outputs.fetch == 'true'");
  assert.match(
    f.run,
    /python scripts\/backfill\/fetch_prices\.py --plan plan\.json --output prices\.json/,
  );
  assert.equal(f.env, undefined);
  assert.equal(f.with, undefined);
  const text = JSON.stringify(f);
  assert.ok(!text.includes("secrets.") && !text.includes("TURSO") && !text.includes("DATA_REPO"));
});

test("fetch script is split-aware and unadjusted, and has no database or secret access", () => {
  const py = read("scripts/backfill/fetch_prices.py");
  assert.match(py, /auto_adjust=False/);
  assert.match(py, /actions=True/);
  assert.doesNotMatch(py, /TURSO|DATA_REPO|libsql|secrets\./i);
});

test("steps run in order: plan, fetch, commit; commit only after a successful fetch", () => {
  const i = (n) => steps.findIndex((s) => s.name === n);
  assert.ok(0 < i("Plan the fetch (read-only)") && i("Plan the fetch (read-only)") < i(FETCH));
  assert.ok(i(FETCH) < i(COMMIT));
  assert.equal(
    byName("Plan the fetch (read-only)").run,
    "node scripts/backfill/prices.mjs plan --out plan.json",
  );
  assert.equal(byName(COMMIT).run, "node scripts/backfill/prices.mjs commit --prices prices.json");
  // no `!cancelled()`/`always()`: a failed fetch must not reach the commit step
  assert.equal(byName(COMMIT).if, "steps.plan.outputs.fetch == 'true'");
});

test("no artifact upload, no cache, no expression inside a script (SEC-110)", () => {
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
});

test("the Worker may dispatch this file, but its slot stays disabled", () => {
  const sched = read("worker/src/schedule.ts");
  assert.match(sched, /"backfill-prices\.yml"/);
  const slot = sched.slice(sched.indexOf('id: "backfill-prices"'));
  assert.match(slot, /workflow: "backfill-prices\.yml"/);
  assert.match(slot.slice(0, slot.indexOf("}),")), /enabled: false/);
});

test("the CLI refuses an unknown command and a missing database without printing secrets", async () => {
  const lines = [];
  assert.equal(await run(["nope"], {}, { out: (s) => lines.push(s) }), 1);
  assert.equal(await run(["plan", "--out", "x"], {}, { out: (s) => lines.push(s) }), 1);
  assert.match(lines.join("\n"), /database not configured/);
});

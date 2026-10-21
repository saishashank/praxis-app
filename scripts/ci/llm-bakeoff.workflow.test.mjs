// M6 T15: the LLM bake-off workflow, checked by parsing the YAML (no GitHub, no secrets, no LLM call).
// PLT-015 (dispatch only, never automatic, no Worker slot), release guard, SEC-108 c (approved commit
// copied from arena-close), SEC-110 (no artifacts, no cache), keys and database secrets only in env of
// the one bake-off step, inputs reach the script through env, free models only (LLM-003).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/llm-bakeoff.yml";
const wf = yaml.load(read(FILE));
const close = yaml.load(read(".github/workflows/arena-close.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only; no schedule, push or pull request; no permissions at top level", () => {
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(
    read(FILE),
    /^\s*(schedule|push|pull_request\w*|workflow_run|repository_dispatch):/m,
  );
  const inputs = wf.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["candidates", "checked", "store", "trains"]);
  assert.equal(inputs.candidates.required, true);
  assert.equal(inputs.store.default, false);
});

test("the Worker slot is monthly and runs only once the Owner lists it (M8 T8, D-155)", () => {
  const sched = read("worker/src/schedule.ts");
  const slot = sched.slice(sched.indexOf('id: "llm-bakeoff"'));
  const body = slot.slice(0, slot.indexOf("}),"));
  assert.match(body, /workflow: "llm-bakeoff.yml"/);
  assert.match(body, /monthly: "first-saturday"/);
  assert.match(body, /requiresListing: true/);
});

test("one production job on release, production environment without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "llm-bakeoff", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 180);
});

test("the approved-commit steps and node setup are copied exactly from arena-close", () => {
  assert.deepEqual(steps.slice(0, 5), close.jobs.production.steps.slice(0, 5));
});

test("every action is pinned to a full commit SHA", () => {
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES);
});

test("LLM keys and database secrets appear only in env of the bake-off step, which is last", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Bake-off"],
  );
  const s = withSecrets[0];
  assert.deepEqual(
    Object.keys(s.env)
      .filter((k) => String(s.env[k]).includes("secrets."))
      .sort(),
    [
      "GOOGLE_AI_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
      "TURSO_MAIN_TOKEN",
      "TURSO_MAIN_URL",
    ],
  );
  // The database is reached only when the Owner ticks `store`.
  assert.match(s.env.TURSO_MAIN_URL, /inputs\.store/);
  assert.match(s.env.TURSO_MAIN_TOKEN, /inputs\.store/);
  assert.equal(steps[steps.length - 1], s);
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(JSON.stringify(job).match(/secrets\./g).length, 5);
});

test("dispatch inputs reach the script through env only, quoted; no expression inside a script", () => {
  const s = steps[steps.length - 1];
  assert.equal(
    s.run,
    'node scripts/llm/bakeoff.mjs --candidate "$CANDIDATES" --trains "$TRAINS" --checked "$CHECKED"',
  );
  for (const k of ["CANDIDATES", "TRAINS", "CHECKED"]) {
    assert.match(s.env[k], /^\$\{\{ inputs\.\w+ \}\}$/);
  }
  for (const x of steps) if (x.run) assert.ok(!String(x.run).includes("${{"), x.run);
});

test("no artifact upload, no cache, no step summary file (SEC-110)", () => {
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
  assert.doesNotMatch(read(FILE), /GITHUB_STEP_SUMMARY|--report-out/);
});

test("the CLI script exists and refuses paid OpenRouter models", () => {
  const cli = read("src/lib/llm/bakeoffCli.ts");
  assert.match(cli, /:free/);
  assert.match(read("scripts/llm/bakeoff.mjs"), /bakeoffMain/);
});

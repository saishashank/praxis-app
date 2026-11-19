// M20 A3 (DAT-101, AT-M1; D-1096): the source-report workflow, checked by parsing the YAML (no GitHub, no network).
// workflow_dispatch only (PLT-015), no secret, no environment, no database name, SHA-pinned actions, the dispatch input
// reaching the script through env only, an artefact as the one output (SEC-110: counts, statuses and hashes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { lintWorkflow, UPLOAD_ALWAYS_ALLOWED } from "./workflow-lint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = ".github/workflows/source-report.yml";
const text = readFileSync(path.join(root, FILE), "utf8");
const wf = yaml.load(text);
const job = wf.jobs.report;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only, with one required market choice of IN or US; no schedule, push or pull request", () => {
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  const inputs = wf.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["market"]);
  assert.equal(inputs.market.required, true);
  assert.equal(inputs.market.type, "choice");
  assert.deepEqual(inputs.market.options, ["IN", "US"]);
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(
    text,
    /^\s*(schedule|push|pull_request\w*|workflow_run|repository_dispatch):/m,
  );
});

test("one job, read-only token, no environment, serialised", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["report"]);
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.environment, undefined);
  assert.deepEqual(job.concurrency, { group: "source-report", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 30);
});

test("no secret and no database variable: the file names neither (AT-M1: no database)", () => {
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /TURSO/);
  assert.doesNotMatch(text, /_PROD\b/);
  assert.doesNotMatch(text, /environment:/);
});

test("the market input reaches the script through env only, and PRAXIS_MARKETS_ENABLED carries it", () => {
  const run = job.steps.find(
    (s) => typeof s.run === "string" && s.run.includes("source-report.mjs"),
  );
  assert.ok(run, "the report step");
  assert.doesNotMatch(run.run, /\$\{\{/);
  assert.match(run.run, /--market "\$MARKET_INPUT"/);
  assert.equal(run.env.MARKET_INPUT, "${{ inputs.market }}");
  assert.equal(run.env.PRAXIS_MARKETS_ENABLED, "${{ inputs.market }}");
  assert.deepEqual(Object.keys(run.env).sort(), ["MARKET_INPUT", "PRAXIS_MARKETS_ENABLED"]);
});

test("every action is pinned to a full commit SHA; the only output is the report artefact", () => {
  for (const s of job.steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES, s.uses);
  const up = job.steps.filter((s) => (s.uses ?? "").startsWith("actions/upload-artifact@"));
  assert.equal(up.length, 1);
  assert.match(up[0].with.name, /^source-report-/);
  assert.equal(up[0].with["if-no-files-found"], "error");
  assert.doesNotMatch(text, /actions\/cache|cache:/);
  assert.equal(
    job.steps.some((s) => (s.run ?? "").includes("npm ")),
    false,
    "no dependency install",
  );
});

test("the workflow lint accepts it, and the artefact allowance is for this one job only", () => {
  assert.deepEqual(UPLOAD_ALWAYS_ALLOWED, ["source-report.yml::report"]);
  assert.deepEqual(lintWorkflow("source-report.yml", text), []);
  // the allowance does not extend to a job that holds a secret
  const withSecret = text.replace(
    "          MARKET_INPUT: ${{ inputs.market }}",
    "          MARKET_INPUT: ${{ inputs.market }}\n          X: ${{ secrets.SOME_SECRET }}",
  );
  assert.ok(
    lintWorkflow("source-report.yml", withSecret).some((f) => f.rule === "secret-job-storage"),
  );
  // and a differently named file gets no allowance
  assert.ok(lintWorkflow("other.yml", text).some((f) => f.rule === "artifact-upload"));
});

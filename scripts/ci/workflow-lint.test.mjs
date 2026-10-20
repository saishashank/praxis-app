// M8 T6 (decision 40, AT-05a): workflow lint rules on fixture YAML, plus the real workflows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintDir, lintWorkflow, format } from "./workflow-lint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures/workflow-lint");
const lint = (name, opts) => lintWorkflow(name, readFileSync(path.join(dir, name), "utf8"), opts);
const rules = (name, opts) => [...new Set(lint(name, opts).map((f) => f.rule))].sort();
const SHA = "a".repeat(40);
const ruleList = (fs) => fs.map((f) => f.rule);

test("good fixture: no findings (secrets only in step env, guarded job, failure-only upload)", () => {
  assert.deepEqual(lint("good.yml", { uploadAllowed: ["good.yml::report"] }), []);
});

test("good fixture: an upload that is not on the allow-list is a finding", () => {
  assert.deepEqual(rules("good.yml"), ["artifact-upload"]);
});

test("permissions: missing is a finding", () => {
  assert.deepEqual(rules("bad-no-permissions.yml"), ["permissions-missing"]);
});

test("permissions: write-all and a job-level write are findings", () => {
  assert.deepEqual(ruleList(lint("bad-wide-permissions.yml")), [
    "permissions-wide",
    "permissions-wide",
  ]);
});

test("permissions: top-level contents: read passes, actions: write does not", () => {
  const ok = "on: push\npermissions:\n  contents: read\njobs:\n  a:\n    steps: []\n";
  assert.deepEqual(lintWorkflow("x.yml", ok), []);
  const bad = ok.replace("contents: read", "contents: read\n  actions: write");
  assert.deepEqual(ruleList(lintWorkflow("x.yml", bad)), ["permissions-wide"]);
});

test("pinning: tag, bare docker image and unpinned container are findings", () => {
  const f = lint("bad-unpinned.yml");
  assert.equal(f.length, 3);
  assert.ok(f.every((x) => x.rule === "uses-unpinned"));
  // the pinned setup-node step (step 3) is not reported
  assert.ok(!f.some((x) => x.where.includes("step 3")));
});

test("pinning: 40-hex SHA, digest and local actions pass; 39 hex fails", () => {
  const ok = `on: push\npermissions: {}\njobs:\n  a:\n    container: node@sha256:${"b".repeat(64)}\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: ./.github/actions/x\n      - uses: docker://alpine@sha256:${"c".repeat(64)}\n`;
  assert.deepEqual(lintWorkflow("x.yml", ok), []);
  const short = ok.replace(SHA, "a".repeat(39));
  assert.deepEqual(ruleList(lintWorkflow("x.yml", short)), ["uses-unpinned"]);
});

test("pull_request_target is a finding (also in list and string forms)", () => {
  assert.deepEqual(rules("bad-pr-target.yml"), ["pull-request-target"]);
  for (const on of ["on: pull_request_target", "on: [push, pull_request_target]"]) {
    const t = `${on}\npermissions: {}\njobs:\n  a:\n    steps: []\n`;
    assert.deepEqual(ruleList(lintWorkflow("x.yml", t)), ["pull-request-target"]);
  }
});

test("run text: secrets, inputs and github.event expressions are findings, github.sha is not", () => {
  const f = lint("bad-run-expression.yml");
  assert.deepEqual(ruleList(f.filter((x) => x.rule === "run-expression")), [
    "run-expression",
    "run-expression",
    "run-expression",
  ]);
  assert.deepEqual(
    f.filter((x) => x.rule === "run-expression").map((x) => x.where.split(",")[1].trim()),
    ["step 1", "step 2", "step 3"],
  );
});

test("secrets outside a step env: workflow env, job env, with:, if: and inherit", () => {
  const f = lint("bad-secret-placement.yml");
  assert.ok(f.every((x) => x.rule === "secret-placement"));
  assert.equal(f.length, 5);
});

test("secret-holding jobs: cache, upload-artifact and setup cache: are findings", () => {
  const f = lint("bad-secret-storage.yml", { uploadAllowed: ["bad-secret-storage.yml::a"] });
  assert.deepEqual(ruleList(f), ["secret-job-storage", "secret-job-storage", "secret-job-storage"]);
});

test("an artifact upload must be failure-only even when allowed", () => {
  const t = `on: push\npermissions: {}\njobs:\n  e2e:\n    steps:\n      - uses: actions/upload-artifact@${SHA}\n`;
  assert.deepEqual(ruleList(lintWorkflow("ci.yml", t, { uploadAllowed: ["ci.yml::e2e"] })), [
    "artifact-upload",
  ]);
});

test("fork PRs: unguarded secret jobs in a pull_request workflow fail; guarded and push-only pass", () => {
  const f = lint("bad-fork-secrets.yml");
  assert.deepEqual(
    f.map((x) => `${x.rule} ${x.where}`),
    ["fork-secrets job a", "fork-secrets job b"],
  );
  for (const guard of [
    "github.event_name == 'push'",
    "github.event.pull_request.head.repo.full_name == github.repository",
    "github.event_name != 'pull_request'",
  ]) {
    const t = `on: [push, pull_request]\npermissions: {}\njobs:\n  a:\n    if: ${guard}\n    environment: staging\n    steps: []\n`;
    assert.deepEqual(lintWorkflow("x.yml", t), [], guard);
  }
  const push = "on: push\npermissions: {}\njobs:\n  a:\n    environment: staging\n    steps: []\n";
  assert.deepEqual(lintWorkflow("x.yml", push), []);
});

test("concurrency: a pipeline workflow needs it; top-level or on every secret job is enough", () => {
  assert.deepEqual(rules("bad-no-concurrency.yml", { pipeline: ["bad-no-concurrency.yml"] }), [
    "concurrency-missing",
  ]);
  assert.deepEqual(rules("bad-no-concurrency.yml", { pipeline: [] }), []);
  const top =
    "on: workflow_dispatch\npermissions: {}\nconcurrency:\n  group: g\njobs:\n  a:\n    steps: []\n";
  assert.deepEqual(lintWorkflow("p.yml", top, { pipeline: ["p.yml"] }), []);
  const perJob =
    "on: workflow_dispatch\npermissions: {}\njobs:\n  a:\n    environment: e\n    concurrency:\n      group: g\n    steps: []\n  drill:\n    steps: []\n";
  assert.deepEqual(lintWorkflow("p.yml", perJob, { pipeline: ["p.yml"] }), []);
});

test("schedule: a dispatch-only file with schedule, or one not allow-listed, fails", () => {
  const f = lint("bad-schedule.yml", { scheduled: [] });
  assert.equal(f.filter((x) => x.rule === "schedule-trigger").length, 2);
  const t =
    "on:\n  schedule:\n    - cron: '1 2 * * *'\npermissions: {}\njobs:\n  a:\n    steps: []\n";
  assert.deepEqual(lintWorkflow("nightly.yml", t, { scheduled: ["nightly.yml"] }), []);
  assert.equal(lintWorkflow("other.yml", t, { scheduled: ["nightly.yml"] }).length, 1);
});

test("installs: npm install and pip install without hashes are findings", () => {
  assert.deepEqual(ruleList(lint("bad-installs.yml")), [
    "npm-install",
    "npm-install",
    "pip-hashes",
  ]);
});

test("invalid YAML is a finding, not a crash", () => {
  assert.deepEqual(ruleList(lintWorkflow("x.yml", "name: [unclosed\n  - : :\n")), ["yaml-parse"]);
  assert.deepEqual(ruleList(lintWorkflow("x.yml", "- a\n- b\n")), ["yaml-parse"]);
});

test("findings print file, rule and place only: never a command or a value", () => {
  const t =
    'on: push\npermissions: {}\njobs:\n  a:\n    steps:\n      - run: echo "${{ secrets.TOKEN_VALUE_9 }} s3cr3t"\n';
  const line = format(lintWorkflow("x.yml", t).find((f) => f.rule === "run-expression"));
  assert.match(line, /^x\.yml: \[run-expression\] job a, step 1/);
  assert.ok(!line.includes("TOKEN_VALUE_9") && !line.includes("s3cr3t"));
});

test("the real .github/workflows: no finding of a rule that could leak a secret or admit a fork", () => {
  const { files, findings } = lintDir(path.resolve(here, "../../.github/workflows"));
  assert.ok(files.length >= 20);
  // Pip hashes, the fixtures-job cache and its checkout token and the deploy-job npm cache are
  // known and reported to the Owner (M8 T6 report); everything below must stay at zero.
  const never = new Set([
    "yaml-parse",
    "permissions-missing",
    "permissions-wide",
    "pull-request-target",
    "run-expression",
    "uses-unpinned",
    "fork-secrets",
    "concurrency-missing",
    "schedule-trigger",
    "artifact-upload",
    "npm-install",
  ]);
  assert.deepEqual(findings.filter((f) => never.has(f.rule)).map(format), []);
});

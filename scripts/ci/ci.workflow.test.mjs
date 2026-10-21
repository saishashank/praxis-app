// M8 T17 (decisions 12, 13, 20, 22, 25, 38, 40, 41): the shape of .github/workflows/ci.yml, checked
// by parsing the YAML (no GitHub, no secrets, no network), plus the hashed Python install sets and
// the Stryker dev dependencies it relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { CI_REQUIRED_JOBS } from "./release-gate-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const text = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const wf = yaml.load(text);
const jobs = wf.jobs;
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const steps = (id) => jobs[id].steps;
const runs = (id) => steps(id).map((s) => s.run ?? "");

const JOBS = [
  "app",
  "e2e",
  "secrets",
  "worker",
  "fixtures",
  "python",
  "audit",
  "coverage",
  "checks",
  "release-gate",
];
const GATED = JOBS.filter((j) => j !== "release-gate");

test("the job list is exactly the reviewed one", () => {
  assert.deepEqual(Object.keys(jobs).sort(), [...JOBS].sort());
  for (const id of JOBS) assert.ok(jobs[id]["timeout-minutes"] > 0, `${id}: timeout`);
});

test("triggers and permissions: contents: read on top, only release-gate reads actions", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(wf.on.pull_request.branches, ["main", "release"]);
  assert.deepEqual(wf.permissions, { contents: "read" });
  for (const id of JOBS) {
    if (id === "release-gate") {
      assert.deepEqual(jobs[id].permissions, { actions: "read", contents: "read" });
    } else {
      assert.equal(jobs[id].permissions, undefined, `${id}: inherits contents: read`);
    }
  }
  assert.doesNotMatch(text, /pull_request_target|write-all|: write/);
});

test("secrets: only the fixtures job reads one, only FIXTURES_READ_TOKEN, only as the checkout token", () => {
  const found = {};
  for (const [id, job] of Object.entries(jobs)) {
    for (const m of JSON.stringify(job).matchAll(/secrets\.(\w+)/g)) {
      (found[id] ??= new Set()).add(m[1]);
    }
    assert.equal(JSON.stringify(job.env ?? {}).includes("secrets."), false, `${id}: job env`);
  }
  assert.deepEqual(Object.keys(found), ["fixtures"]);
  assert.deepEqual([...found.fixtures], ["FIXTURES_READ_TOKEN"]);
  const holders = steps("fixtures").filter((s) => JSON.stringify(s).includes("secrets."));
  assert.equal(holders.length, 1);
  assert.match(holders[0].uses, /^actions\/checkout@/);
  assert.match(holders[0].with.token, /^\$\{\{ secrets\.FIXTURES_READ_TOKEN \}\}$/);
  assert.equal(jobs.fixtures.environment.name, "ci-fixtures");
  // a job with an environment and a token never uses a cache (workflow-lint secret-job-storage)
  assert.ok(steps("fixtures").every((s) => !s.with || s.with.cache === undefined));
});

test("every action is pinned to a full SHA; no npm install; every pip install is hashed", () => {
  for (const id of JOBS) {
    for (const s of steps(id)) {
      if (s.uses) assert.match(s.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${id}: ${s.uses}`);
      if (s.run) {
        assert.doesNotMatch(s.run, /npm (install|i)\b/, `${id}: npm ci only`);
        for (const line of s.run.split("\n").filter((l) => /pip3? install/.test(l))) {
          assert.match(line, /--require-hashes/, `${id}: ${line}`);
        }
        assert.doesNotMatch(s.run, /\$\{\{/, `${id}: no expression inside run:`);
      }
    }
  }
});

test("every npm script and script file that ci.yml calls exists", () => {
  for (const id of JOBS) {
    for (const r of runs(id)) {
      for (const m of r.matchAll(/npm run ([\w:.-]+)/g)) {
        assert.ok(pkg.scripts[m[1]], `${id}: npm run ${m[1]}`);
      }
      for (const m of r.matchAll(/node (scripts\/[\w./-]+\.mjs)/g)) {
        assert.ok(readFileSync(path.join(root, m[1])), `${id}: ${m[1]}`);
      }
    }
  }
});

test("package.json has the T17 scripts", () => {
  const want = {
    "test:env-names": "node scripts/ci/env-names.mjs",
    "test:map": "node scripts/ci/test-map.mjs --summary",
    "test:map:update": "node scripts/ci/test-map.mjs --update",
    "test:quarantine": "node scripts/ci/quarantine-check.mjs",
    "test:coverage:worker": "vitest run --root worker --coverage",
    "lint:workflows": "node scripts/ci/workflow-lint.mjs",
    "release-gate": "node scripts/ci/release-gate.mjs",
  };
  for (const [k, v] of Object.entries(want)) assert.equal(pkg.scripts[k], v, k);
  assert.match(pkg.scripts["test:diffcov"], /^node scripts\/ci\/diff-coverage\.mjs --lcov /);
  assert.ok(pkg.scripts["test:config-reference"] && pkg.scripts["test:licences"]);
});

test("audit job: npm audit through audit-summary for the app and the Worker, hashed pip-audit", () => {
  const all = runs("audit").join("\n");
  assert.match(all, /audit-summary\.mjs --label root /);
  assert.match(all, /audit-summary\.mjs --label worker /);
  assert.match(all, /npm audit --omit=dev --json/);
  assert.match(all, /npm --prefix worker audit --omit=dev --json/);
  assert.match(all, /grep -q '"auditReportVersion"'/); // an error report must not pass
  assert.match(all, /pip install --require-hashes -r scripts\/ingest\/requirements-audit\.txt/);
  assert.match(all, /pip-audit --require-hashes --disable-pip --no-deps /);
  assert.ok(steps("audit").every((s) => !s.uses?.startsWith("actions/upload")));
});

test("coverage job: full history, both coverage runs, diff coverage, test map, quarantine", () => {
  const co = steps("coverage");
  assert.deepEqual(jobs.coverage.env, { PRAXIS_COVERAGE_RUN: "1" });
  assert.equal(co[0].with["fetch-depth"], 0);
  const all = runs("coverage").join("\n");
  for (const c of [
    "npm run test:coverage",
    "npm run test:coverage:worker",
    "npm run test:diffcov -- --lcov coverage/lcov.merged.info --base",
    "npm run test:map",
    "npm run test:quarantine",
  ]) {
    assert.ok(all.includes(c), c);
  }
  const diff = co.find((s) => /diffcov/.test(s.run ?? ""));
  assert.deepEqual(Object.keys(diff.env).sort(), ["PR_BASE_SHA", "PUSH_BEFORE_SHA"]);
  assert.match(diff.run, /git merge-base origin\/main HEAD/);
});

test("checks job: workflow lint, env names, configuration reference", () => {
  const all = runs("checks").join("\n");
  for (const c of [
    "npm run lint:workflows",
    "npm run test:env-names",
    "npm run test:config-reference",
  ]) {
    assert.ok(all.includes(c), c);
  }
  assert.ok(runs("app").join("\n").includes("npm run test:licences")); // licence check, normal mode
});

test("release-gate job: PRs into release only, needs every other job, infrastructure mode, no secret", () => {
  const g = jobs["release-gate"];
  assert.match(g.if, /github\.event_name == 'pull_request'/);
  assert.match(g.if, /github\.base_ref == 'release'/);
  assert.match(g.if, /!cancelled\(\)/); // a failed needed job must fail the gate, not skip it
  assert.deepEqual([...g.needs].sort(), [...GATED].sort());
  const gate = g.steps.find((s) => /release-gate\.mjs/.test(s.run ?? ""));
  assert.deepEqual(gate.env, {
    GITHUB_TOKEN: "${{ github.token }}",
    HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
  });
  assert.match(gate.run, /--mode infrastructure /);
  assert.match(gate.run, /--sha "\$HEAD_SHA"/);
  const list = /--ci-jobs (\S+)/.exec(gate.run)[1].split(",");
  assert.deepEqual([...list].sort(), [...GATED].sort());
  for (const j of CI_REQUIRED_JOBS) assert.ok(list.includes(j), `default required job ${j}`);
  const all = g.steps.map((s) => s.run ?? "").join("\n");
  assert.ok(all.includes("node scripts/ci/licence-check.mjs --release"));
  assert.ok(all.includes("node scripts/ci/workflow-lint.mjs --release"));
  assert.ok(text.includes("release switches the --mode below to `full`"));
});

test("the e2e job keeps its readability and Lighthouse steps (T20a, D-153) and the report upload is failure-only", () => {
  const all = runs("e2e").join("\n");
  assert.ok(all.includes("e2e/readability.spec.ts"));
  assert.ok(all.includes("npm run test:lighthouse"));
  const up = steps("e2e").filter((s) => s.uses?.startsWith("actions/upload-artifact"));
  assert.equal(up.length, 1);
  assert.match(up[0].if, /failure\(\)/);
});

test("the Python install sets are fully pinned and hashed", () => {
  for (const f of [
    "scripts/ingest/requirements.txt",
    "scripts/ingest/requirements-dev.txt",
    "scripts/ingest/requirements-audit.txt",
    "scripts/agents/requirements-talib.txt",
  ]) {
    const lines = readFileSync(path.join(root, f), "utf8").split("\n");
    const body = lines.filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("-r "));
    assert.ok(body.length > 0, f);
    let pins = 0;
    for (let i = 0; i < body.length; i++) {
      const l = body[i];
      if (l.startsWith("    --hash=sha256:")) {
        assert.match(l, /^ {4}--hash=sha256:[0-9a-f]{64}( \\)?$/, `${f}: ${l}`);
      } else {
        pins++;
        assert.match(l, /^[A-Za-z0-9._-]+==[0-9][\w.]* \\$/, `${f}: ${l}`);
        assert.match(body[i + 1] ?? "", /^ {4}--hash=sha256:/, `${f}: ${l} has no hash`);
      }
    }
    assert.ok(pins >= 3, f);
  }
  const dev = readFileSync(path.join(root, "scripts/ingest/requirements-dev.txt"), "utf8");
  assert.match(dev, /^-r requirements\.txt$/m);
  assert.match(dev, /^pytest==/m);
  assert.match(
    readFileSync(path.join(root, "scripts/ingest/requirements-audit.txt"), "utf8"),
    /^pip-audit==/m,
  );
});

test("every pip install in every workflow is hashed", () => {
  const dir = path.join(root, ".github/workflows");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yml"))) {
    for (const line of readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (/^\s*(run:\s*)?pip3? install\b/.test(line)) {
        assert.match(line, /--require-hashes/, `${f}: ${line.trim()}`);
      }
    }
  }
});

test("Stryker: exact-pinned dev dependencies only (decision 22, Owner approves)", () => {
  for (const name of ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"]) {
    assert.match(pkg.devDependencies[name], /^\d+\.\d+\.\d+$/, name);
    assert.equal(pkg.dependencies[name], undefined, `${name} must not be a production dependency`);
  }
  assert.equal(
    pkg.devDependencies["@stryker-mutator/core"],
    pkg.devDependencies["@stryker-mutator/vitest-runner"],
  );
});

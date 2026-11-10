// OPS-104 / PLT-080 (D-958): the turso-usage workflow, checked by parsing the YAML (no GitHub, no secrets,
// no network). PLT-015 (dispatch only, no schedule), SEC-108 c (approved commit copied from
// arena-close), SHA-pinned actions, SEC-110 (no artifacts, no cache), and the one rule that matters
// here: the Turso platform token is a production-environment secret referenced in `env:` of ONE step,
// which has no database secret; it never appears on Vercel, in a script body or in a file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { extractJobBlock, readLocked } from "../ci/prod-job-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/turso-usage.yml";
const wf = yaml.load(read(FILE));
const close = yaml.load(read(".github/workflows/arena-close.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
const TOKEN = "TURSO_PLATFORM_TOKEN_USAGE";

test("workflow_dispatch only: no schedule, push or pull request trigger (PLT-015)", () => {
  assert.equal(wf.on, "workflow_dispatch");
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(
    read(FILE),
    /^\s*(schedule|push|pull_request\w*|workflow_run|repository_dispatch):/m,
  );
});

test("one production job on release; no staging job (PRD-046); no deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production"]);
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "turso-usage", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 30);
});

test("the approved-commit steps, node setup and npm ci are copied exactly from arena-close (SEC-108 c)", () => {
  assert.deepEqual(steps.slice(0, 5), close.jobs.production.steps.slice(0, 5));
  assert.equal(steps[1].run, "node ci-tools/scripts/ci/approved-commit.mjs");
});

test("every action is pinned to a full commit SHA; no artifact, no cache", () => {
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES, s.uses);
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
});

test("the platform token is in env of exactly one step, which holds no database secret", () => {
  const holders = steps.filter((s) => JSON.stringify(s).includes(TOKEN));
  assert.equal(holders.length, 1);
  const [s] = holders;
  assert.deepEqual(Object.keys(s.env).sort(), ["TURSO_ORG", TOKEN]);
  assert.equal(s.env[TOKEN], `\${{ secrets.${TOKEN} }}`);
  assert.ok(!JSON.stringify(s).includes("TURSO_MAIN"));
  assert.equal(
    s.run,
    'node scripts/usage/turso-sample.mjs sample --out "$RUNNER_TEMP/usage-sample.json"',
  );
});

test("the database pair is in env of exactly one other step, which holds no platform token", () => {
  const holders = steps.filter((s) => JSON.stringify(s).includes("TURSO_MAIN"));
  assert.equal(holders.length, 1);
  assert.deepEqual(holders[0].env, {
    TURSO_MAIN_URL: "${{ secrets.TURSO_MAIN_URL_PROD }}",
    TURSO_MAIN_TOKEN: "${{ secrets.TURSO_MAIN_TOKEN_PROD }}",
  });
  assert.ok(!JSON.stringify(holders[0]).includes(TOKEN));
});

test("no secret in a `run:` body, an `if:` or the job env; the token name appears nowhere else", () => {
  for (const s of steps) {
    if (s.run) assert.ok(!s.run.includes("${{") && !s.run.includes("secrets."), s.run);
    assert.ok(!String(s.if ?? "").includes("secrets."));
  }
  assert.ok(!JSON.stringify(job.env ?? {}).includes("secrets."));
  // the token is named in this workflow and the script that reads it, nowhere in the app or the Worker
  for (const dir of ["src", "worker/src"]) {
    const walk = (d) =>
      readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`],
      );
    for (const f of walk(dir)) {
      // the SEC-017 secret table names the secret (a name, never a value); nothing else may
      if (f === "src/lib/security/secretStores.ts") continue;
      if (/\.(ts|tsx|mjs|js|json)$/.test(f)) assert.ok(!read(f).includes(TOKEN), f);
    }
  }
  for (const f of ["vercel.json", "worker/wrangler.toml"]) {
    try {
      assert.ok(!read(f).includes(TOKEN), f);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
});

test("the production job is byte-identical to its stored copy (prod-job lock)", () => {
  assert.equal(extractJobBlock(read(FILE), "production"), readLocked("turso-usage"));
});

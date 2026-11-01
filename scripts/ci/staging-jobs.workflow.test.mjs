// M8 T9 (decision 30, 31; AT-28 staging isolation, NFR-040): every pipeline workflow has a `staging`
// job selected by `ref: main` (what the staging Worker dispatches), and its `production` job is
// LOCKED to a stored copy (scripts/ci/fixtures/prod-jobs/). Checked by parsing the YAML and by
// comparing text: no GitHub, no secrets, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  LOCKED_WORKFLOWS,
  extractJobBlock,
  readLocked,
  readProduction,
  workflowPath,
} from "./prod-job-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const text = (name) => readFileSync(workflowPath(name), "utf8");
const load = (name) => yaml.load(text(name));
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;
// Hosts and fetchers staging must never reach or run (NFR-040).
const LIVE_FETCHERS =
  /yahoo_fetch\.py|fetch_prices\.py|asic_fetch\.mjs|fetch-asic\.mjs|pip install|setup-python/;
const BLOCKED_HOSTS = /yahoo|yimg|asx\.com\.au|asxonline|asic\.gov\.au/i;
// Workflows whose staging job mirrors production; the others only print a notice (no staging store).
const FULL = ["ingest-batch1", "arena-signals", "arena-close", "maintenance", "watchdog"];
const NOTICE = [
  "replay",
  "kb-archive",
  "llm-bakeoff",
  "backfill-history",
  "backfill-prices",
  "backfill-index",
  "asx-fetch",
  "diagnose-signals",
];

// GL-07 (O-52): these two carry their own schedule lines (watchdog, Batch-1 fallback).
const SCHEDULED = ["watchdog", "ingest-batch1"];

test("every workflow with a production job is in the locked list, and the lists are complete", () => {
  const withProduction = readdirSync(path.join(root, ".github/workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => f.replace(/\.yml$/, ""))
    .filter((n) => n !== "smoke-test") // the Owner smoke test is not a pipeline workflow (Worker never dispatches it)
    .filter((n) => load(n)?.jobs?.production !== undefined);
  assert.deepEqual([...withProduction].sort(), [...LOCKED_WORKFLOWS].sort());
  assert.deepEqual([...FULL, ...NOTICE, "backup"].sort(), [...LOCKED_WORKFLOWS].sort());
});

for (const name of LOCKED_WORKFLOWS) {
  const wf = load(name);
  const staging = wf.jobs.staging;
  const job = JSON.stringify(staging);
  const stagingText = extractJobBlock(text(name), "staging");

  test(`${name}: the production job is byte-identical to its stored copy`, () => {
    assert.equal(readProduction(name), readLocked(name));
    assert.ok(wf.jobs.production && staging);
  });

  test(`${name}: trigger stays workflow_dispatch only, plus schedule for the GL-07 files; no push or pull request`, () => {
    assert.deepEqual(wf.permissions, {});
    const pattern = SCHEDULED.includes(name)
      ? /^s*(push|pull_requestw*|workflow_run|repository_dispatch):/m
      : /^s*(schedule|push|pull_requestw*|workflow_run|repository_dispatch):/m;
    assert.doesNotMatch(text(name), pattern);
  });

  test(`${name}: staging job shape (main only, environment staging, minimal permissions)`, () => {
    assert.equal(staging.if, "github.ref == 'refs/heads/main'");
    assert.deepEqual(staging.environment, { name: "staging", deployment: false });
    assert.ok(
      JSON.stringify(staging.permissions) === "{}" ||
        JSON.stringify(staging.permissions) === '{"contents":"read"}',
      "permissions are {} or contents: read only",
    );
    assert.deepEqual(staging.concurrency, {
      group: `${name}-staging`,
      "cancel-in-progress": false,
    });
    assert.notEqual(staging.concurrency.group, wf.jobs.production.concurrency.group);
    assert.equal(staging["runs-on"], "ubuntu-latest");
    assert.ok(staging["timeout-minutes"] > 0 && staging["timeout-minutes"] <= 150);
    assert.equal(staging.env?.PRAXIS_ENV, "staging");
    assert.doesNotMatch(stagingText, /refs\/heads\/release|approved-commit|deployments:/);
    assert.ok(!stagingText.includes("production"), "no production word in the staging job");
  });

  test(`${name}: staging uses only staging secrets (and the read-only fixtures token), pinned actions, no secret in a script`, () => {
    const refs = job.match(/secrets\.[A-Z0-9_]+/g) ?? [];
    for (const r of refs) assert.match(r, /^secrets\.([A-Z0-9_]+_STAGING|FIXTURES_READ_TOKEN)$/, r);
    assert.ok(!/_PROD\b|DATA_REPO_TOKEN|BACKUP_PRIVATE_KEY|TURSO_PLATFORM_TOKEN_TEMP/.test(job));
    for (const s of staging.steps) {
      if (s.uses) assert.match(s.uses, SHA_USES, s.uses);
      if (s.run) assert.ok(!String(s.run).includes("${{") && !String(s.run).includes("secrets."));
      assert.ok(!String(s.if ?? "").includes("secrets."));
      if (JSON.stringify(s).includes("secrets.")) {
        // secrets live only in `env:` of a run step, or in `with:` of a checkout of the fixtures repo
        const where = Object.keys(s).filter((k) => JSON.stringify(s[k]).includes("secrets."));
        assert.ok(
          where.every((k) => k === "env" || (k === "with" && s.uses)),
          where.join(),
        );
      }
    }
    assert.ok(!JSON.stringify(staging.env ?? {}).includes("secrets."));
    assert.doesNotMatch(stagingText, /upload-artifact|download-artifact|actions\/cache|cache:/);
  });

  test(`${name}: no ASX or Yahoo host and no live fetcher can run in the staging job (NFR-040)`, () => {
    assert.doesNotMatch(
      stagingText.replace(/#[^\n]*/g, ""),
      LIVE_FETCHERS,
      "no live fetcher in a staging step",
    );
    assert.doesNotMatch(
      JSON.stringify(staging.steps),
      BLOCKED_HOSTS,
      "no ASX/Yahoo/ASIC host named in a staging step",
    );
  });
}

test("notice-only staging jobs reference no secret, check out nothing and run no repository script", () => {
  for (const name of NOTICE) {
    const s = load(name).jobs.staging;
    assert.deepEqual(s.permissions, {});
    assert.equal(s.steps.length, 1);
    assert.match(s.steps[0].run, /^echo "[a-z-]+ has no staging variant/);
    assert.equal(s.steps[0].uses, undefined);
    assert.ok(!JSON.stringify(s).includes("secrets."));
  }
});

test("mirrored staging jobs only run scripts the production job runs (plus the recorded-day script)", () => {
  const cmds = (j) => (j.steps ?? []).map((x) => x.run).filter(Boolean);
  for (const name of FULL) {
    const wf = load(name);
    const prod = new Set(cmds(wf.jobs.production));
    for (const c of cmds(wf.jobs.staging)) {
      if (c.startsWith("node scripts/ingest/recorded_day.mjs")) continue;
      assert.ok(prod.has(c), `${name}: ${c}`);
    }
  }
});

test("backup staging runs only the synthetic drill: no secret, no data repo", () => {
  const s = load("backup").jobs.staging;
  assert.deepEqual(
    s.steps.filter((x) => x.run).map((x) => x.run),
    ["npm ci", "node scripts/backup/drill.mjs"],
  );
  assert.ok(!JSON.stringify(s).includes("secrets."));
  assert.deepEqual(Object.keys(load("backup").jobs), ["production", "drill", "staging"]);
});

test("ingest-batch1 staging reads the recorded day instead of fetching (decision 31)", () => {
  const wf = load("ingest-batch1");
  const s = wf.jobs.staging.steps;
  const names = s.map((x) => x.name ?? x.uses ?? x.run);
  const plan = s.findIndex((x) => x.id === "plan");
  const fixtures = s.findIndex((x) => x.name === "Check out the private fixtures repo (read-only)");
  const recorded = s.findIndex((x) =>
    String(x.run).startsWith("node scripts/ingest/recorded_day.mjs"),
  );
  const ingest = s.findIndex((x) => x.name === "Ingest batch 1");
  assert.ok(
    plan > 0 && plan < fixtures && fixtures < recorded && recorded < ingest,
    names.join("|"),
  );
  assert.equal(s[fixtures].with.repository, "${{ github.repository }}-fixtures");
  assert.equal(s[fixtures].with.token, "${{ secrets.FIXTURES_READ_TOKEN }}");
  assert.equal(s[fixtures].with["persist-credentials"], false);
  assert.equal(
    s[recorded].run,
    "node scripts/ingest/recorded_day.mjs --request request.json --fixtures fixtures --output bars.json --index-output index.json --short-output short.json",
  );
  assert.equal(s[recorded].env, undefined, "the recorded-day step has no secrets");
  assert.equal(s[recorded].if, "steps.plan.outputs.fetch == 'true'");
  // the database pair is staging's, only on the two database steps
  for (const i of [plan, ingest]) {
    assert.equal(s[i].env.TURSO_MAIN_URL, "${{ secrets.TURSO_MAIN_URL_STAGING }}");
    assert.equal(s[i].env.TURSO_MAIN_TOKEN, "${{ secrets.TURSO_MAIN_TOKEN_STAGING }}");
  }
  assert.equal(s[ingest].env.COMMIT_SHA, "${{ github.sha }}");
  assert.match(s[ingest].if, /^\$\{\{ !cancelled\(\) && steps\.plan\.outcome == 'success' \}\}$/);
  assert.equal(wf.jobs.staging.steps.filter((x) => x.env && "YAHOO_CHUNK_SIZE" in x.env).length, 0);
});

test("watchdog: the production job gets one additive step that fails while a temporary restore secret is present", () => {
  const wf = load("watchdog");
  const steps = wf.jobs.production.steps;
  const last = steps[steps.length - 1];
  assert.equal(last.name, "Fail while a temporary restore secret is present");
  assert.equal(last.if, "${{ always() }}");
  assert.deepEqual(last.env, {
    BACKUP_PRIVATE_KEY: "${{ secrets.BACKUP_PRIVATE_KEY }}",
    TURSO_PLATFORM_TOKEN_TEMP: "${{ secrets.TURSO_PLATFORM_TOKEN_TEMP }}",
  });
  assert.ok(!last.run.includes("${{") && !last.run.includes("secrets."));
  // it tests emptiness only and never prints a value
  assert.match(last.run, /\[ -n "\$BACKUP_PRIVATE_KEY" \]/);
  assert.match(last.run, /\[ -n "\$TURSO_PLATFORM_TOKEN_TEMP" \]/);
  assert.doesNotMatch(last.run, /echo[^\n]*\$\{?(BACKUP_PRIVATE_KEY|TURSO_PLATFORM_TOKEN_TEMP)/);
  assert.match(last.run, /exit 1/);
  // the watchdog step itself and all earlier steps are unchanged in kind: it is the only new step
  assert.equal(steps.length, 7);
  // staging has no such secret
  assert.ok(!JSON.stringify(wf.jobs.staging).includes("BACKUP_PRIVATE_KEY"));
});

// Behavioural check of the shell body: run it with and without the variables set.
test("watchdog guard step: shell body exits 1 with a secret present and 0 without, and prints no value", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = load("watchdog").jobs.production.steps.at(-1).run;
  const sh = spawnSync("bash", ["--version"]);
  if (sh.status !== 0) return; // no bash on this machine
  const exec = (env) =>
    spawnSync("bash", ["-c", run], {
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: "/dev/null", ...env },
      encoding: "utf8",
    });
  const clean = exec({});
  assert.equal(clean.status, 0);
  for (const name of ["BACKUP_PRIVATE_KEY", "TURSO_PLATFORM_TOKEN_TEMP"]) {
    const bad = exec({ [name]: "SENTINEL-VALUE-123" });
    assert.equal(bad.status, 1, name);
    assert.ok(!bad.stdout.includes("SENTINEL") && !bad.stderr.includes("SENTINEL"));
    assert.ok(bad.stdout.includes("temporary restore secret still present"));
  }
});

test("arena-signals: production and staging pass the Resend variables to the batch 3 step (D-154)", () => {
  const wf = load("arena-signals");
  for (const [jobName, suffix] of [
    ["production", "PROD"],
    ["staging", "STAGING"],
  ]) {
    const step = wf.jobs[jobName].steps.find((x) => x.name === "Decide the session");
    assert.equal(step.env.EMAIL_PROVIDER, "resend");
    assert.equal(step.env.RESEND_API_KEY, `\${{ secrets.RESEND_API_KEY_${suffix} }}`);
    assert.equal(step.env.OWNER_EMAIL, `\${{ secrets.OWNER_EMAIL_${suffix} }}`);
    assert.equal(step.env.PII_HASH_KEY, `\${{ secrets.PII_HASH_KEY_${suffix} }}`);
    assert.equal(step.env.TURSO_MAIN_URL, `\${{ secrets.TURSO_MAIN_URL_${suffix} }}`);
  }
  assert.equal(
    wf.jobs.production.steps.find((x) => x.name === "Decide the session").env.PRAXIS_ENV,
    "production",
  );
  assert.equal(wf.jobs.staging.env.PRAXIS_ENV, "staging");
});

test("the staging Worker dispatches ref main, which the staging jobs select", () => {
  const d = read("worker/src/dispatch.ts");
  assert.match(d, /staging"\) return "main"/);
});

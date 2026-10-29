// M2 T6: the ingest-batch1 workflow, checked by parsing the YAML (no GitHub, no secrets).
// Covers PLT-015 (dispatch only), PLT-076 (concurrency), SEC-108 c (approved commit, same steps as
// the nightly backup), SEC-110 (no artifacts, no cache) and "secrets only in env of the steps that
// need them; the Python fetch step has none".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { cronLines } from "../time/genWatchdogCron.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const load = (f) => yaml.load(read(f));
const wf = load(".github/workflows/ingest-batch1.yml");
const backup = load(".github/workflows/backup.yml");
const ci = load(".github/workflows/ci.yml");
const job = wf.jobs.production;
const steps = job.steps;
const byName = (n) => steps.find((s) => s.name === n);
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("Worker dispatch plus the GL-07 fallback schedule at 18:15 Melbourne (both DST offsets)", () => {
  assert.equal(wf.name, "Ingest batch 1 (AU EOD)");
  assert.deepEqual(Object.keys(wf.on), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(
    wf.on.schedule.map((s) => s.cron),
    cronLines(["18:15"]),
  );
  assert.deepEqual(cronLines(["18:15"]), ["15 7 * * *", "15 8 * * *"]);
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(read(".github/workflows/ingest-batch1.yml"), /^s*(push|pull_requestw*):/m);
});

test("the fallback gate skips the other DST line and cannot double-ingest (completion marker)", () => {
  const g = wf.jobs.gate;
  assert.doesNotMatch(JSON.stringify(g), /secrets./);
  assert.equal(
    g.steps.find((x) => x.id === "gate").run,
    "node scripts/time/scheduleGate.mjs 18:15",
  );
  assert.equal(job.needs, "gate");
  assert.equal(job.if, "github.ref == 'refs/heads/release' && needs.gate.outputs.run == 'true'");
  // the script's own "done" check (run record batch1:AU:<date>) is what stops a second ingest
  assert.match(read("src/lib/data/pipeline/batch1-core.mjs"), /a.kind === "done"/);
  assert.deepEqual(job.concurrency, { group: "ingest-batch1", "cancel-in-progress": false });
});

test("one production job on release, environment production without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["gate", "production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  assert.ok(job.if.startsWith("github.ref == 'refs/heads/release'"));
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "ingest-batch1", "cancel-in-progress": false });
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60);
});

test("the approved-commit steps are copied exactly from the nightly backup (SEC-108 c)", () => {
  const b = backup.jobs.production.steps;
  assert.deepEqual(steps.slice(0, 5), b.slice(0, 5));
  assert.equal(steps[1].run, "node ci-tools/scripts/ci/approved-commit.mjs");
  assert.equal(steps[2].with.ref, "${{ steps.approved.outputs.sha }}");
  assert.deepEqual(backup.jobs.production.environment, job.environment);
  assert.deepEqual(backup.jobs.production.permissions, job.permissions);
});

test("every action is pinned to a full commit SHA; setup-python matches ci.yml", () => {
  const uses = steps.filter((s) => s.uses).map((s) => s.uses);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, SHA_USES, u);
  const py = steps.find((s) => String(s.uses).startsWith("actions/setup-python@"));
  const ciPy = Object.values(ci.jobs)
    .flatMap((j) => j.steps ?? [])
    .find((s) => String(s.uses).startsWith("actions/setup-python@"));
  assert.equal(py.uses, ciPy.uses);
  assert.equal(py.with["python-version"], ciPy.with["python-version"]);
});

test("secrets appear only in env of the two database steps, only the prod Turso pair", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Plan the fetch (read-only)", "Ingest batch 1"],
  );
  for (const s of withSecrets) {
    assert.deepEqual(
      Object.keys(s.env).filter((k) => String(s.env[k]).includes("secrets.")),
      ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN"],
    );
    assert.equal(s.env.TURSO_MAIN_URL, "${{ secrets.TURSO_MAIN_URL_PROD }}");
    assert.equal(s.env.TURSO_MAIN_TOKEN, "${{ secrets.TURSO_MAIN_TOKEN_PROD }}");
    // never in a script, a condition or an action input
    assert.ok(!String(s.run).includes("secrets."));
    assert.ok(!String(s.if ?? "").includes("secrets."));
    assert.equal(s.with, undefined);
  }
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(JSON.stringify(job).match(/secrets\./g).length, 4);
});

test("the Python fetch step has no secrets and only the throttle values from the plan step", () => {
  const f = byName("Fetch bars (no secrets)");
  assert.equal(f.if, "steps.plan.outputs.fetch == 'true'");
  assert.equal(
    f.run,
    "python scripts/ingest/yahoo_fetch.py --request request.json --output bars.json --index-output index.json --actions-output actions.json",
  );
  assert.deepEqual(f.env, {
    YAHOO_CHUNK_SIZE: "${{ steps.plan.outputs.chunk_size }}",
    YAHOO_MIN_GAP_S: "${{ steps.plan.outputs.min_gap_s }}",
  });
  assert.ok(!JSON.stringify(f).includes("secrets."));
  assert.ok(!JSON.stringify(f).includes("TURSO"));
  const install = byName("Install the fetcher (pinned)");
  assert.equal(
    install.run,
    "pip install --no-cache-dir --require-hashes -r scripts/ingest/requirements.txt",
  );
  // M8 T17: the install set is hashed (SEC-107); the direct requirement stays an exact pin.
  const req = read("scripts/ingest/requirements.txt");
  assert.match(req, /^yfinance==\d+\.\d+\.\d+ \\\r?$/m);
  assert.match(req, /--hash=sha256:[0-9a-f]{64}/);
});

test("the ASIC fetch step has no secrets and runs between the fetch and the ingest (M4 T3)", () => {
  const f = byName("Fetch ASIC short positions (no secrets)");
  assert.equal(
    f.run,
    "node scripts/ingest/asic_fetch.mjs --request request.json --output short.json",
  );
  assert.equal(f.env, undefined);
  assert.ok(!JSON.stringify(f).includes("secrets.") && !JSON.stringify(f).includes("TURSO"));
  const i = steps.indexOf(f);
  assert.ok(steps.indexOf(byName("Fetch bars (no secrets)")) < i);
  assert.ok(i < steps.findIndex((x) => x.name === "Ingest batch 1"));
});

test("steps run in order: plan, fetch, ingest; ingest also records a failed or skipped fetch", () => {
  const names = steps.map((s) => s.name ?? s.uses ?? s.run);
  const plan = steps.findIndex((s) => s.id === "plan");
  const fetch = steps.findIndex((s) => s.name === "Fetch bars (no secrets)");
  const ingest = steps.findIndex((s) => s.name === "Ingest batch 1");
  assert.ok(0 < plan && plan < fetch && fetch < ingest, names.join(" | "));
  assert.equal(steps[plan].run, "node scripts/ingest/batch1.mjs prepare --request request.json");
  assert.equal(
    steps[ingest].run,
    "node scripts/ingest/batch1.mjs run --bars bars.json --index index.json --short short.json --actions actions.json",
  );
  assert.match(
    steps[ingest].if,
    /^\$\{\{ !cancelled\(\) && steps\.plan\.outcome == 'success' \}\}$/,
  );
  assert.equal(steps[ingest].env.COMMIT_SHA, "${{ steps.approved.outputs.sha }}");
  assert.ok(steps[ingest].env && !("YAHOO_CHUNK_SIZE" in steps[ingest].env));
});

test("no artifact upload, no cache, no expression inside a script (SEC-110)", () => {
  const text = read(".github/workflows/ingest-batch1.yml");
  assert.doesNotMatch(text, /upload-artifact|download-artifact|actions\/cache|cache:/);
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
});

test("the Worker may dispatch this file and the slot for it is enabled", () => {
  const sched = read("worker/src/schedule.ts");
  assert.match(sched, /"ingest-batch1\.yml"/);
  const slot = sched.slice(
    sched.indexOf('id: "ingest-batch1"'),
    sched.indexOf('id: "decision-cutoff"'),
  );
  assert.match(slot, /workflow: "ingest-batch1\.yml"/);
  assert.match(slot, /enabled: true/);
});

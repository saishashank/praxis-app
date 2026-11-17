// M22 L4 (D-1412): the model keys of .github/workflows/arena-signals.yml, checked by parsing the YAML (no GitHub, no secrets).
// They sit in the `env:` of the one signals step of the production job (the step that already holds the database pair), from
// the production environment, and nowhere else in the file: not in the staging job, not in the approved-commit steps, not in a
// script. The production job itself is also held to its stored copy by staging-jobs.workflow.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, SHA_USES } from "./workflow-checks.mjs";

const w = load("arena-signals");
const prod = w.wf.jobs.production;
const KEYS = ["GOOGLE_AI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY"];

test("still dispatch-only on release, in the production environment without a deployment record", () => {
  assert.deepEqual(Object.keys(w.wf.on), ["workflow_dispatch"]);
  assert.deepEqual(w.wf.permissions, {});
  assert.equal(prod.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(prod.environment, { name: "production", deployment: false });
  assert.doesNotMatch(w.text, /^\s*(schedule|push|pull_request\w*|workflow_run):/m);
});

test("the three model keys are in the env of the signals step only, from the production environment", () => {
  const holders = prod.steps.filter((s) => s.env && KEYS.some((k) => k in s.env));
  assert.equal(holders.length, 1);
  const step = holders[0];
  assert.equal(step.name, "Decide the session");
  assert.equal(
    step.run,
    'node scripts/arena/signals.mjs ${MARKET_INPUT:+--market "$MARKET_INPUT"}',
  );
  for (const k of KEYS) assert.equal(step.env[k], `\${{ secrets.${k} }}`, k);
  assert.equal(step, prod.steps[prod.steps.length - 1], "the signals step is last");
  assert.equal(prod.env, undefined, "no job-level env");
});

test("no other secret-carrying step and no model key in the staging job, the top level or a run script", () => {
  for (const s of prod.steps.slice(0, -1)) {
    const text = JSON.stringify(s);
    for (const k of KEYS) assert.ok(!text.includes(k), `${s.name ?? s.uses ?? s.run}: ${k}`);
  }
  assert.ok(!JSON.stringify(w.wf.jobs.staging).match(/GROQ|GOOGLE_AI|OPENROUTER/));
  assert.equal(w.wf.env, undefined);
  for (const s of prod.steps) if (s.run) assert.doesNotMatch(s.run, /\$\{\{|\bsecrets\b|_API_KEY/);
});

test("the keys are read as secrets by name only (no value, no other model-provider name)", () => {
  const names = [...w.text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const k of KEYS) assert.ok(names.includes(k), k);
  assert.doesNotMatch(w.text, /CF_WORKERS_AI_TOKEN|CF_ACCOUNT_ID/); // D-1512: Workers AI stays unwired
  for (const s of prod.steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES);
});

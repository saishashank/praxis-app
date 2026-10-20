// M5 T12: the watchdog workflow and the cron generator, checked without GitHub or secrets.
// Covers PLT-015 (dispatch only, no schedule), SEC-108 c (approved commit, same steps as the other
// production workflows), pinned action SHAs, "secrets only in env of the one run step", SEC-110
// (no artifacts, no cache), the generated dual-UTC lines (PLT-019) and that the file contains no
// enabled schedule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  cronLines,
  cronLinesFor,
  renderSchedule,
  slotForSchedule,
} from "../time/genWatchdogCron.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/watchdog.yml";
const wf = yaml.load(read(FILE));
const maintenance = yaml.load(read(".github/workflows/maintenance.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only: no schedule, push or pull request trigger (PLT-015, decision 11)", () => {
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  assert.equal(wf.on.schedule, undefined);
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(read(FILE), /^\s*(schedule|push|pull_request\w*):/m);
  assert.doesNotMatch(read(FILE), /^\s*-\s*cron:/m);
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs), ["slot", "deliberate_failure"]);
  assert.deepEqual(wf.on.workflow_dispatch.inputs.slot.options, ["manual", "2040", "2150"]);
});

test("one production job on release, environment production without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "watchdog", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 30);
});

test("approved-commit steps and node setup are copied from the other production workflows", () => {
  assert.deepEqual(steps.slice(0, 4), maintenance.jobs.production.steps.slice(0, 4));
  assert.equal(steps[1].run, "node ci-tools/scripts/ci/approved-commit.mjs");
  assert.equal(steps[2].with.ref, "${{ steps.approved.outputs.sha }}");
  assert.deepEqual(maintenance.jobs.production.environment, job.environment);
});

test("every action is pinned to a full commit SHA", () => {
  const uses = steps.filter((s) => s.uses).map((s) => s.uses);
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, SHA_USES, u);
});

test("secrets appear only in env of the last step, the Watchdog run step", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Watchdog", "Fail while a temporary restore secret is present"], // M8 T9: the second is the additive guard step
  );
  const s = withSecrets[0];
  assert.equal(s.run, "node scripts/watchdog/run.mjs");
  assert.equal(s, steps[steps.length - 2]); // the guard step (M8 T9) follows it
  assert.ok(!String(s.run).includes("secrets.") && !String(s.run).includes("${{"));
  assert.equal(s.with, undefined);
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  const secretEnv = Object.fromEntries(
    Object.entries(s.env).filter(([, v]) => String(v).includes("secrets.")),
  );
  assert.deepEqual(secretEnv, {
    TURSO_MAIN_URL: "${{ secrets.TURSO_MAIN_URL_PROD }}",
    TURSO_MAIN_TOKEN: "${{ secrets.TURSO_MAIN_TOKEN_PROD }}",
    RESEND_API_KEY: "${{ secrets.RESEND_API_KEY_PROD }}",
    OWNER_EMAIL: "${{ secrets.OWNER_EMAIL_PROD }}",
    PII_HASH_KEY: "${{ secrets.PII_HASH_KEY_PROD }}",
    APP_BASE_URL: "${{ secrets.APP_BASE_URL_PROD }}",
    ACTIONS_HMAC_SECRET: "${{ secrets.ACTIONS_HMAC_SECRET_PROD }}",
  });
  assert.equal(JSON.stringify(job).match(/secrets\./g).length, 9); // + BACKUP_PRIVATE_KEY, TURSO_PLATFORM_TOKEN_TEMP
  assert.equal(s.env.PRAXIS_ENV, "production");
  assert.equal(s.env.EMAIL_PROVIDER, "resend");
});

test("install runs before the secret step; no expression inside any script (SEC-110)", () => {
  const install = steps.findIndex((s) => s.run === "npm ci");
  const last = steps.findIndex((s) => s.name === "Watchdog");
  assert.ok(install > 0 && install < last);
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
});

test("no artifact upload and no cache", () => {
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
});

test("the cron generator prints both UTC lines per Melbourne target (AEDT and AEST)", () => {
  assert.deepEqual(cronLinesFor("20:40"), ["40 9 * * *", "40 10 * * *"]);
  assert.deepEqual(cronLinesFor("21:50"), ["50 10 * * *", "50 11 * * *"]);
  assert.deepEqual(cronLines(), ["40 9 * * *", "40 10 * * *", "50 10 * * *", "50 11 * * *"]);
  assert.equal(
    renderSchedule(),
    [
      "  schedule:",
      '    - cron: "40 9 * * *"',
      '    - cron: "40 10 * * *"',
      '    - cron: "50 10 * * *"',
      '    - cron: "50 11 * * *"',
    ].join("\n"),
  );
  assert.throws(() => cronLinesFor("25:00"));
});

test("PLT-019 guard: the line of the wrong regime maps to no slot", () => {
  const summer = Date.parse("2026-11-10T09:40:30Z"); // AEDT
  const winter = Date.parse("2026-06-10T09:40:30Z"); // AEST
  assert.equal(slotForSchedule("40 9 * * *", summer), "2040");
  assert.equal(slotForSchedule("40 10 * * *", summer), null);
  assert.equal(slotForSchedule("40 10 * * *", winter), "2040");
  assert.equal(slotForSchedule("40 9 * * *", winter), null);
  assert.equal(slotForSchedule("50 10 * * *", summer), "2150");
  assert.equal(slotForSchedule("50 11 * * *", winter), "2150");
  assert.equal(slotForSchedule("50 11 * * *", summer), null);
});

test("DST edges: the switch days still map the right line to the right slot", () => {
  // 2026-10-04 AEDT starts (02:00 -> 03:00); 2027-04-04 AEST starts (03:00 -> 02:00).
  assert.equal(slotForSchedule("40 10 * * *", Date.parse("2026-10-03T10:40:00Z")), "2040");
  assert.equal(slotForSchedule("40 9 * * *", Date.parse("2026-10-04T09:40:00Z")), "2040");
  assert.equal(slotForSchedule("40 9 * * *", Date.parse("2027-04-03T09:40:00Z")), "2040");
  assert.equal(slotForSchedule("40 10 * * *", Date.parse("2027-04-04T10:40:00Z")), "2040");
});

test("the Worker may dispatch this file only if its slots stay disabled (T12 worker edit is separate)", () => {
  const sched = read("worker/src/schedule.ts");
  // Not edited by this task: if the slots exist they must be disabled.
  const i = sched.indexOf('"watchdog.yml"');
  if (i >= 0)
    assert.match(
      sched.slice(i, i + 400),
      /enabled: false|requiresListing: true/ /* M8 T8 (D-155): a go-live slot runs only once the Owner lists it */,
    );
});

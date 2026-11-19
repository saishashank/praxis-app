// OPS-105 (D-962; PLT-015): the restore-dry-run workflow, checked by parsing the YAML. It is one of the few
// SCHEDULED files (first day of January, April, July and October) and is NOT a production job: no
// environment, no secret of any kind, no approved-commit step, no network beyond `npm ci`, local target
// only, a throwaway key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { SCHEDULED_WORKFLOWS } from "../ci/workflow-lint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/restore-dry-run.yml";
const src = read(FILE);
const wf = yaml.load(src);
const job = wf.jobs["dry-run"];
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("scheduled on the first day of each quarter, one UTC line, plus dispatch; on the allow-list", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(wf.on.schedule.length, 1);
  const [min, hour, dom, month, dow] = wf.on.schedule[0].cron.split(" ");
  assert.equal(dom, "1");
  assert.equal(month, "1,4,7,10");
  assert.equal(dow, "*");
  assert.ok(/^\d+$/.test(min) && /^\d+$/.test(hour));
  assert.ok(SCHEDULED_WORKFLOWS.includes("restore-dry-run.yml"));
  assert.doesNotMatch(src, /^\s*(push|pull_request\w*|workflow_run|repository_dispatch):/m);
});

test("not a production job: no environment, no secret, no approved-commit step, minimal permissions", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["dry-run"]);
  assert.equal(job.environment, undefined);
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(job.permissions, { contents: "read" });
  const code = src.replace(/#[^\n]*/g, ""); // the header comment names what is absent
  assert.doesNotMatch(
    code,
    /secrets\.|vars\.|approved-commit|deployments:|TURSO_PLATFORM|BACKUP_PRIVATE_KEY/,
  );
  assert.deepEqual(job.concurrency, { group: "restore-dry-run", "cancel-in-progress": false });
  assert.doesNotMatch(src, /upload-artifact|download-artifact|actions\/cache|cache:/);
});

test("every action is pinned to a full commit SHA", () => {
  for (const s of job.steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES, s.uses);
});

test("the drill runs into local files with the throwaway key and nothing else", () => {
  const drill = job.steps.find((s) => s.run === "node scripts/restore/drill-turso.mjs run");
  assert.ok(drill);
  assert.deepEqual(drill.env, {
    MODE: "drill",
    KEY_MODE: "throwaway",
    TARGETS: "both",
    TARGET: "local",
    RUNNER_TEMP: "${{ runner.temp }}",
  });
  for (const s of job.steps) {
    if (s.run) assert.ok(!s.run.includes("${{"), s.run);
  }
});

// M4 T16: the replay workflow, checked by parsing the YAML (no GitHub, no secrets), plus the history
// reader with a fake fetch. PLT-015 (dispatch only), PLT-076, SEC-108 c (approved commit copied from
// arena-close), SEC-110 (no artifacts, no cache), secrets only in env of the one replay step, the mode
// input is a choice and reaches the script through env, the Worker slot is disabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { downloadHistory } from "./history.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(root, f), "utf8");
const FILE = ".github/workflows/replay.yml";
const wf = yaml.load(read(FILE));
const close = yaml.load(read(".github/workflows/arena-close.yml"));
const job = wf.jobs.production;
const steps = job.steps;
const SHA_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

test("workflow_dispatch only, with a choice input `mode`; no schedule, push or pull request", () => {
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  const mode = wf.on.workflow_dispatch.inputs.mode;
  assert.equal(mode.type, "choice");
  assert.deepEqual(mode.options, ["light", "full", "evidence", "null", "injected", "learning"]);
  assert.equal(mode.default, "light");
  assert.deepEqual(wf.permissions, {});
  assert.doesNotMatch(read(FILE), /^\s*(schedule|push|pull_request\w*):/m);
});

test("one production job on release, production environment without a deployment record", () => {
  assert.deepEqual(Object.keys(wf.jobs), ["production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  assert.equal(job.if, "github.ref == 'refs/heads/release'");
  assert.deepEqual(job.environment, { name: "production", deployment: false });
  assert.deepEqual(job.permissions, { contents: "read", deployments: "read" });
  assert.deepEqual(job.concurrency, { group: "replay", "cancel-in-progress": false });
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 180);
});

test("the approved-commit steps and node setup are copied exactly from arena-close", () => {
  assert.deepEqual(steps.slice(0, 5), close.jobs.production.steps.slice(0, 5));
});

test("every action is pinned to a full commit SHA", () => {
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, SHA_USES);
});

test("secrets appear only in env of the replay step, which is last; the mode goes through env", () => {
  const withSecrets = steps.filter((s) => JSON.stringify(s).includes("secrets."));
  assert.deepEqual(
    withSecrets.map((s) => s.name),
    ["Replay"],
  );
  const s = withSecrets[0];
  assert.deepEqual(
    Object.keys(s.env)
      .filter((k) => String(s.env[k]).includes("secrets."))
      .sort(),
    ["DATA_REPO_TOKEN", "TURSO_MAIN_TOKEN", "TURSO_MAIN_URL"],
  );
  assert.equal(s.env.DATA_REPO, "${{ github.repository }}-data");
  assert.equal(s.run, 'node scripts/replay/run.mjs --mode "$REPLAY_MODE"');
  assert.match(s.env.REPLAY_MODE, /inputs\.mode/);
  assert.equal(steps[steps.length - 1], s);
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(JSON.stringify(job).match(/secrets\./g).length, 3);
});

test("mode learning (M6 T12): still dispatch-only, same single secrets step, slot still disabled", () => {
  const mode = wf.on.workflow_dispatch.inputs.mode;
  assert.ok(mode.options.includes("learning"));
  // no new trigger, no new job, no new step: the mode reaches the script through the same env variable
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(wf.jobs), ["production", "staging"]); // M8 T9: the staging job is covered by staging-jobs.workflow.test.mjs
  const run = steps[steps.length - 1];
  assert.equal(run.run, 'node scripts/replay/run.mjs --mode "$REPLAY_MODE"');
  assert.equal(JSON.stringify(job).match(/secrets./g).length, 3);
  // the CLI accepts the mode the workflow offers
  assert.match(read("scripts/replay/run.mjs"), /light|full|null|injected|evidence|learning/);
  // the Worker still has no Saturday dispatch of the replay: its slot stays disabled
  const sched = read("worker/src/schedule.ts");
  const slot = sched.slice(sched.indexOf('id: "replay"'));
  assert.match(slot.slice(0, slot.indexOf("}),")), /enabled: false/);
});

test("no artifact upload, no cache, no expression inside a script (SEC-110)", () => {
  assert.doesNotMatch(read(FILE), /upload-artifact|download-artifact|actions\/cache|cache:/);
  for (const s of steps) if (s.run) assert.ok(!String(s.run).includes("${{"), s.run);
});

test("the Worker may dispatch the file but its slot is disabled", () => {
  const sched = read("worker/src/schedule.ts");
  assert.match(sched, /"replay\.yml"/);
  const slot = sched.slice(sched.indexOf('id: "replay"'));
  const body = slot.slice(0, slot.indexOf("}),"));
  assert.match(body, /workflow: "replay\.yml"/);
  assert.match(body, /enabled: false/);
});

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    const u = String(url);
    if (u.includes("/releases?per_page")) {
      return new Response(
        JSON.stringify([
          {
            tag_name: "history-yahoo_prices-2026",
            assets: [{ id: 7, name: "yahoo_prices-2026-03.jsonl.gz", state: "uploaded" }],
          },
          {
            tag_name: "replay-2026-10",
            assets: [{ id: 8, name: "replay-x.jsonl.gz", state: "uploaded" }],
          },
        ]),
        { status: 200 },
      );
    }
    if (u.endsWith("/assets/7")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/x" },
      });
    }
    if (u.startsWith("https://objects.githubusercontent.com/"))
      return new Response(new Uint8Array([1, 2, 3]));
    return new Response("no", { status: 404 });
  };
}

test("history reader: only history releases, token never sent to the storage host", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-hist-"));
  try {
    const calls = [];
    const r = await downloadHistory({
      repo: "o/praxis-app-data",
      token: "tok",
      dir,
      fetchImpl: fakeFetch(calls),
    });
    assert.deepEqual(r, { files: 1, bytes: 3 });
    assert.deepEqual(readdirSync(dir), ["yahoo_prices-2026-03.jsonl.gz"]);
    for (const c of calls) {
      if (c.url.startsWith("https://api.github.com/")) assert.equal(c.auth, "Bearer tok");
      else assert.equal(c.auth, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history reader refuses a redirect to a foreign host and a non-data repo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-hist-"));
  try {
    const f = async (url) => {
      const u = String(url);
      if (u.includes("/releases?")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "history-a-2026",
              assets: [{ id: 1, name: "a-2026-01.jsonl.gz", state: "uploaded" }],
            },
          ]),
        );
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/x" },
      });
    };
    await assert.rejects(
      downloadHistory({ repo: "o/praxis-app-data", token: "t", dir, fetchImpl: f }),
      /asset_host/,
    );
    await assert.rejects(
      downloadHistory({ repo: "o/praxis-app", token: "t", dir }),
      /misconfigured/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

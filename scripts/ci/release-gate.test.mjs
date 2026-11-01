// M8 T6: the release-gate CLI against a fake GitHub client. No network, no real token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateError, createClient, localChecks, main, parseArgs } from "./release-gate.mjs";
import { CI_REQUIRED_JOBS, STEP } from "./release-gate-core.mjs";
import { leaks } from "./logContent.mjs";

const SHA = "1".repeat(40);
const OTHER = "9".repeat(40);
const TOKEN = "ghs_FAKETOKENVALUE0123456789abcdef";
const REPO = "praxis-owner/praxis-app";
const NOW = Date.parse("2026-11-20T12:00:00Z");
const D = 86_400_000;
const H = 3_600_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const env = (over = {}) => ({
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: REPO,
  GITHUB_RUN_ID: "500",
  ...over,
});
const S = (name, conclusion = "success") => ({ name, conclusion });
// GL-09: the fixtures job carries its strict step by default.
const J = (
  name,
  conclusion = "success",
  steps = name === "fixtures" ? [S(STEP.fixturesStrict)] : [],
) => ({
  name,
  conclusion,
  steps,
});
const R = (id, sha, created, conclusion = "success") => ({
  id,
  head_sha: sha,
  created_at: created,
  conclusion,
});

// A GitHub with everything green. Keys are the API paths the CLI is expected to request.
function world(patch = {}) {
  const w = {
    [`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=20`]: {
      workflow_runs: [R(500, SHA, ago(H))],
    },
    [`/repos/${REPO}/actions/runs/500/jobs?per_page=100`]: {
      jobs: CI_REQUIRED_JOBS.map((n) => J(n)),
    },
    [`/repos/${REPO}/commits/${SHA}`]: { commit: { committer: { date: ago(3 * D) } } },
    [`/repos/${REPO}/actions/workflows/staging-e2e-day.yml/runs?per_page=30&head_sha=${SHA}&status=completed`]:
      { workflow_runs: [R(600, SHA, ago(D))] },
    "/repos/praxis-owner/praxis-app/actions/runs/600/jobs?per_page=100": {
      jobs: [J("staging", "success", [S(STEP.e2eDeadlines), S(STEP.e2eStaging)])],
    },
    [`/repos/${REPO}/actions/workflows/nightly.yml/runs?per_page=30&status=completed`]: {
      workflow_runs: [R(701, OTHER, ago(2 * H)), R(702, OTHER, ago(D)), R(703, OTHER, ago(2 * D))],
    },
    [`/repos/${REPO}/actions/workflows/zap-baseline.yml/runs?per_page=30&event=workflow_dispatch&status=completed`]:
      { workflow_runs: [R(800, OTHER, ago(2 * D))] },
    "/repos/praxis-owner/praxis-app/actions/runs/800/jobs?per_page=100": {
      jobs: [J("staging", "success", [S(STEP.zapScan)])],
    },
    [`/repos/${REPO}/actions/workflows/restore-drill.yml/runs?per_page=30&status=completed`]: {
      workflow_runs: [R(900, OTHER, ago(5 * D)), R(901, OTHER, ago(9 * D), "failure")],
    },
    "/repos/praxis-owner/praxis-app/actions/runs/900/jobs?per_page=100": {
      jobs: [J("restore", "success", [S(STEP.drill, "skipped")])],
    },
    "/repos/praxis-owner/praxis-app/actions/runs/901/jobs?per_page=100": {
      jobs: [J("restore", "failure", [S(STEP.drill)])],
    },
    ...patch,
  };
  for (const id of [701, 702, 703]) {
    w[`/repos/praxis-owner/praxis-app/actions/runs/${id}/jobs?per_page=100`] = {
      jobs: [J("staging")],
    };
  }
  return w;
}

function fakeClient(w) {
  const client = {
    calls: [],
    async getJson(p) {
      client.calls.push(p);
      if (!(p in w)) throw new GateError("GitHub API returned HTTP 404");
      const v = w[p];
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return client;
}
const okLocal = (over = {}) => ({
  licence: async () => ({ failures: 0, pending: 0 }),
  quarantine: async () => 0,
  exceptions: async () => ({ audit: 0, zap: 0 }),
  ...over,
});

async function exec(argv, { w = world(), local = okLocal(), e = env(), summary = false } = {}) {
  const lines = [];
  const client = fakeClient(w);
  const e2 = { ...e };
  let file;
  if (summary) {
    file = join(mkdtempSync(join(tmpdir(), "rg-")), "summary.md");
    writeFileSync(file, "");
    e2.GITHUB_STEP_SUMMARY = file;
  }
  const code = await main(argv, e2, {
    client,
    local,
    out: (s) => lines.push(s),
    now: () => NOW,
  });
  return {
    code,
    text: lines.join("\n"),
    client,
    summary: file ? readFileSync(file, "utf8") : "",
  };
}
const FULL = ["--mode", "full", "--sha", SHA];

test("full mode, everything green: exit 0, a table on stdout and in the job summary", async () => {
  const r = await exec(FULL, { summary: true });
  assert.equal(r.code, 0);
  assert.match(r.text, /### Release gate: PASS \(full mode\)/);
  assert.match(r.summary, /### Release gate: PASS/);
  assert.match(r.text, /\| A restore drill and a later green verify-removed run/);
  assert.equal(r.summary.trim(), r.text.trim());
});

test("each missing piece of GitHub evidence fails the gate with exit 1", async () => {
  const drop = (key) => {
    const w = world();
    delete w[key];
    return w;
  };
  const cases = {
    ci: world({
      [`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=20`]: {
        workflow_runs: [],
      },
    }),
    e2e: world({
      [`/repos/${REPO}/actions/workflows/staging-e2e-day.yml/runs?per_page=30&head_sha=${SHA}&status=completed`]:
        { workflow_runs: [] },
    }),
    nightly: world({
      [`/repos/${REPO}/actions/workflows/nightly.yml/runs?per_page=30&status=completed`]: {
        workflow_runs: [],
      },
    }),
    zap: drop(
      `/repos/${REPO}/actions/workflows/zap-baseline.yml/runs?per_page=30&event=workflow_dispatch&status=completed`,
    ),
    drill: world({
      [`/repos/${REPO}/actions/workflows/restore-drill.yml/runs?per_page=30&status=completed`]: {
        workflow_runs: [],
      },
    }),
  };
  for (const [name, w] of Object.entries(cases)) {
    const r = await exec(FULL, { w });
    assert.equal(r.code, 1, name);
    assert.match(r.text, /Release gate: FAIL/, name);
  }
});

test("the CI run of THIS workflow run is preferred, and its job results are used", async () => {
  const key = `/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=20`;
  const w = world({
    [key]: {
      workflow_runs: [R(499, SHA, ago(3 * H)), R(500, SHA, ago(H)), R(501, SHA, ago(2 * H))],
    },
    [`/repos/${REPO}/actions/runs/501/jobs?per_page=100`]: {
      jobs: CI_REQUIRED_JOBS.map((n) => J(n, "failure")),
    },
  });
  assert.equal((await exec(FULL, { w })).code, 0); // run 500 is this run (GITHUB_RUN_ID)
  const w2 = world({
    [key]: { workflow_runs: [R(501, SHA, ago(2 * H)), R(499, SHA, ago(3 * H))] },
    [`/repos/${REPO}/actions/runs/501/jobs?per_page=100`]: {
      jobs: CI_REQUIRED_JOBS.map((n) => J(n, "failure")),
    },
  });
  // not this run: the newest run for the commit (501) is read and is red
  assert.equal((await exec(FULL, { w: w2, e: env({ GITHUB_RUN_ID: "1" }) })).code, 1);
});

test("local checks: a pending licence, an expired quarantine entry and an expired exception each fail", async () => {
  for (const [local, label] of [
    [okLocal({ licence: async () => ({ failures: 16, pending: 16 }) }), /Licence|licence/],
    [okLocal({ quarantine: async () => 2 }), /quarantine/],
    [okLocal({ exceptions: async () => ({ audit: 1, zap: 0 }) }), /exceptions/],
    [okLocal({ licence: async () => Promise.reject(new Error("boom")) }), /did not run/],
  ]) {
    const r = await exec(FULL, { local });
    assert.equal(r.code, 1);
    assert.match(r.text, label);
  }
});

test("infrastructure mode: no staging evidence is read, and the table says so", async () => {
  const w = world();
  for (const k of Object.keys(w))
    if (!k.includes("ci.yml") && !k.includes("/runs/500/")) delete w[k];
  const r = await exec(["--mode", "infrastructure", "--sha", SHA], { w });
  assert.equal(r.code, 0);
  assert.match(r.text, /\(infrastructure mode\)/);
  assert.match(r.text, /Infrastructure gate \(first release/);
  assert.ok(r.client.calls.every((p) => p.includes("ci.yml") || p.includes("/runs/500/")));
  // sign-off present: refused even though everything else is green
  const s = await exec(["--mode", "infrastructure", "--sha", SHA, "--signoff-exists"], { w });
  assert.equal(s.code, 1);
  assert.match(s.text, /only the full gate applies/);
});

test("--real-key-since: a build-phase drill before the date no longer counts", async () => {
  const r = await exec([...FULL, "--real-key-since", "2026-11-18"]);
  assert.equal(r.code, 1);
  assert.match(r.text, /real-key restore drill/);
  assert.equal((await exec([...FULL, "--real-key-since", "2026-11-01"])).code, 0);
});

test("--ci-jobs replaces the required CI job list", async () => {
  const r = await exec([...FULL, "--ci-jobs", `${CI_REQUIRED_JOBS.join(",")},extra-job`]);
  assert.equal(r.code, 1);
  assert.match(r.text, /extra-job \(not found\)/);
});

test("arguments: the mode is required and there is no default; bad values exit 2 without a request", async () => {
  for (const argv of [
    [],
    ["--sha", SHA],
    ["--mode", "skip", "--sha", SHA],
    ["--mode", "full"],
    ["--mode", "full", "--sha", "abc"],
    ["--mode", "full", "--sha", SHA, "--real-key-since", "yesterday"],
    ["--mode", "full", "--sha", SHA, "--ci-jobs", "a b"],
    ["--mode", "full", "--sha", SHA, "--bogus"],
  ]) {
    const r = await exec(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.client.calls.length, 0);
    assert.match(r.text, /^release-gate: /);
  }
  assert.ok(parseArgs(FULL).error === undefined);
});

test("missing or malformed GitHub context exits 2", async () => {
  assert.equal((await exec(FULL, { e: env({ GITHUB_REPOSITORY: "../etc" }) })).code, 2);
  assert.equal((await exec(FULL, { e: env({ GITHUB_REPOSITORY: undefined }) })).code, 2);
  const lines = [];
  const code = await main(
    FULL,
    { GITHUB_REPOSITORY: REPO },
    { out: (s) => lines.push(s), local: okLocal() },
  );
  assert.equal(code, 2);
  assert.match(lines.join(""), /GITHUB_TOKEN/);
  assert.ok(!lines.join("").includes(TOKEN));
});

test("API failures fail the gate closed with plain reasons, never exit 0", async () => {
  const w = world();
  for (const k of Object.keys(w))
    if (k.includes("nightly.yml")) w[k] = new GateError("GitHub API returned HTTP 500");
  const r = await exec(FULL, { w });
  assert.equal(r.code, 1);
  assert.match(r.text, /Nightly suite/);
  const down = await exec(FULL, { w: {} });
  assert.equal(down.code, 1);
});

test("the token never appears in stdout or the job summary (success, failure, API errors)", async () => {
  const bad = world();
  for (const k of Object.keys(bad))
    if (k.includes("zap-baseline")) bad[k] = new Error(`HTTP 500 Bearer ${TOKEN}`);
  for (const w of [world(), bad, {}]) {
    const r = await exec(FULL, { w, summary: true });
    assert.ok(!r.text.includes(TOKEN) && !r.summary.includes(TOKEN));
    assert.deepEqual(leaks(r.text, [TOKEN, SHA]), []);
  }
});

test("createClient: the token goes only in the Authorization header, to the configured API host", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const c = createClient(
    { GITHUB_TOKEN: TOKEN, GITHUB_API_URL: "https://api.example.test/" },
    fetchImpl,
  );
  assert.deepEqual(await c.getJson("/repos/a/b/x?y=1"), { ok: true });
  assert.equal(seen[0].url, "https://api.example.test/repos/a/b/x?y=1");
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!seen[0].url.includes(TOKEN));
  assert.equal(seen[0].init.method, undefined); // GET only
});

test("createClient errors carry a status or a fixed sentence, never the token or the body", async () => {
  const c500 = createClient(env(), async () => ({
    status: 500,
    json: async () => ({ message: TOKEN }),
  }));
  await assert.rejects(
    c500.getJson("/x"),
    (e) => e instanceof GateError && e.message === "GitHub API returned HTTP 500",
  );
  const cDown = createClient(env(), async () => {
    throw new TypeError(`fetch failed Bearer ${TOKEN}`);
  });
  await assert.rejects(
    cDown.getJson("/x"),
    (e) => e.message === "the GitHub API could not be reached" && !e.message.includes(TOKEN),
  );
});

test("localChecks: quarantine and exception files are read and checked against the date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-local-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "tests"));
  mkdirSync(join(dir, "scripts/ci"), { recursive: true });
  writeFileSync(join(dir, "tests/quarantine.json"), JSON.stringify({ quarantined: [] }));
  writeFileSync(join(dir, "scripts/ci/audit-exceptions.json"), JSON.stringify({ exceptions: [] }));
  writeFileSync(
    join(dir, "scripts/ci/zap-exceptions.json"),
    JSON.stringify({
      exceptions: [
        {
          rule: "10038",
          reason: "accepted for a test",
          added: "2026-01-01",
          expires: "2026-01-10",
        },
      ],
    }),
  );
  const l = localChecks(dir);
  assert.equal(await l.quarantine("2026-11-20"), 0);
  assert.deepEqual(await l.exceptions("2026-11-20"), { audit: 0, zap: 1 }); // expired
  const expired = JSON.stringify({
    quarantined: [
      {
        test: "tests/x.test.ts::a",
        reason: "r",
        owner: "o",
        added: "2026-11-01",
        expires: "2026-11-02",
      },
    ],
  });
  writeFileSync(join(dir, "tests/quarantine.json"), expired);
  assert.ok((await l.quarantine("2026-11-20")) >= 1);
});

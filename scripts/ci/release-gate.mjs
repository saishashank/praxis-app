// Release gate CLI (M8 T6; docs/M8_design.md 2.7, decision 25; TST-112). Reads the GitHub Actions
// results for ONE commit, runs the pure core (release-gate-core.mjs) and prints a pass/fail table
// to stdout and to the job summary. Exit 0 = the commit may be released, 1 = it may not, 2 = the
// gate itself could not run.
//
//   node scripts/ci/release-gate.mjs --mode full|infrastructure --sha <40-hex>
//        [--real-key-since YYYY-MM-DD] [--signoff-exists] [--ci-jobs app,e2e,...]
//
//   --mode is REQUIRED (no default). "infrastructure" is the first M8 release only (data-only mode,
//   BLD-024); it is refused with --signoff-exists. --real-key-since switches the restore-drill
//   condition to real-key mode (only drills created on or after that date count).
//   --sha: on a pull_request run pass the PR head commit (github.event.pull_request.head.sha), not
//   GITHUB_SHA (the merge commit), through an env variable.
//
// Credentials: ONLY `github.token` (actions: read, contents: read) from GITHUB_TOKEN. It is sent
// only as the Authorization header to GITHUB_API_URL (default https://api.github.com); it is never
// printed, logged, written to the summary or put into an error text. The gate has no other secret.
//
// The `release-gate` job needs `npm ci` first (licence-check reads the installed packages) and a
// checkout. It does not run the checks the other CI jobs run; it reads their results.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReleaseGate, renderGate } from "./release-gate-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEOUT_MS = 30_000; // threshold-ok: request timeout in ms
const RUNS_PER_LIST = 30; // threshold-ok: how many past runs of one workflow are read
const MAX_JOB_READS = 40; // threshold-ok: cap on per-run job reads per workflow

/** Fixed-text failure: the message never carries the token, a URL or a response body. */
export class GateError extends Error {}

/** The only network client: GET JSON from the Actions API with the job token. */
export function createClient(env, fetchImpl = fetch) {
  const base = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  return {
    async getJson(apiPath) {
      let res;
      try {
        res = await fetchImpl(`${base}${apiPath}`, {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new GateError("the GitHub API could not be reached");
      }
      if (res.status !== 200) throw new GateError(`GitHub API returned HTTP ${res.status}`);
      return res.json();
    },
  };
}

export function parseArgs(argv) {
  const o = { mode: null, sha: null, realKeySince: null, signoffExists: false, ciJobs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") o.mode = argv[++i] ?? null;
    else if (a === "--sha") o.sha = argv[++i] ?? null;
    else if (a === "--real-key-since") o.realKeySince = argv[++i] ?? null;
    else if (a === "--ci-jobs") o.ciJobs = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--signoff-exists") o.signoffExists = true;
    else return { error: "unknown option" };
  }
  if (o.mode !== "full" && o.mode !== "infrastructure") {
    return { error: "--mode full|infrastructure is required (there is no default)" };
  }
  if (!o.sha || !SHA.test(o.sha)) return { error: "--sha must be a 40-hex commit id" };
  if (o.realKeySince !== null && !DATE.test(o.realKeySince)) {
    return { error: "--real-key-since must be YYYY-MM-DD" };
  }
  if (o.ciJobs !== null && !o.ciJobs.every((j) => /^[\w.-]+$/.test(j))) {
    return { error: "--ci-jobs must be a comma-separated list of job names" };
  }
  return o;
}

const toRun = (r, jobs) => ({
  headSha: r.head_sha,
  createdAt: r.created_at,
  conclusion: r.conclusion ?? null,
  jobs,
});
const toJobs = (j) =>
  (j?.jobs ?? []).map((x) => ({
    name: x.name,
    conclusion: x.conclusion ?? null,
    steps: (x.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion ?? null })),
  }));

async function runsOf(client, repo, file, query, { keep, jobsFor } = {}) {
  const list = await client.getJson(
    `/repos/${repo}/actions/workflows/${file}/runs?per_page=${RUNS_PER_LIST}${query}`,
  );
  const runs = [];
  let reads = 0;
  for (const r of list?.workflow_runs ?? []) {
    if (keep && !keep(r)) continue;
    let jobs = [];
    if (reads < MAX_JOB_READS && (!jobsFor || jobsFor(r))) {
      jobs = toJobs(await client.getJson(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`));
      reads += 1;
    }
    runs.push(toRun(r, jobs));
  }
  return runs;
}

/** Local checks, injectable for tests. Each returns plain counts. */
export function localChecks(root = ROOT) {
  return {
    async licence() {
      const { run } = await import("./licence-check.mjs");
      const r = run({ root, release: true });
      return { failures: r.failures.length, pending: r.pending.length };
    },
    async quarantine(today) {
      const { checkQuarantine } = await import("./quarantine-check.mjs");
      const file = path.join(root, "tests/quarantine.json");
      const data = JSON.parse(readFileSync(file, "utf8"));
      return checkQuarantine(data, { today, root, exists: existsSync }).length;
    },
    async exceptions(today) {
      const { checkExceptions } = await import("./exceptions-core.mjs");
      const read = (f) => JSON.parse(readFileSync(path.join(root, "scripts/ci", f), "utf8"));
      const audit = checkExceptions(read("audit-exceptions.json"), {
        today,
        keyFields: ["package"],
      }).problems.length;
      const zap = checkExceptions(read("zap-exceptions.json"), {
        today,
        keyFields: ["rule"],
        keyPattern: { rule: /^\d{1,7}$/ },
      }).problems.length;
      return { audit, zap };
    },
  };
}

async function settle(fn) {
  try {
    return await fn();
  } catch {
    return null; // the core turns an unreadable fact into a plain failure
  }
}

/**
 * Gathers the facts and evaluates the gate.
 * @returns {Promise<import("./release-gate-core.d.mts").GateResult>}
 */
export async function gather({ opts, repo, client, local, now, runId }) {
  const nowIso = new Date(now).toISOString();
  const today = nowIso.slice(0, 10);
  const full = opts.mode === "full";

  // CI run on the commit: this run if it is for the commit, else the newest run for it.
  const ci = await settle(async () => {
    const list = await client.getJson(
      `/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${opts.sha}&per_page=20`,
    );
    const runs = (list?.workflow_runs ?? []).filter((r) => r.head_sha === opts.sha);
    runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const pick = runs.find((r) => runId && String(r.id) === String(runId)) ?? runs[0];
    if (!pick) return null;
    return toJobs(await client.getJson(`/repos/${repo}/actions/runs/${pick.id}/jobs?per_page=100`));
  });

  const licence = await settle(() => local.licence());
  const quarantineFindings = await settle(() => local.quarantine(today));
  const ex = await settle(() => local.exceptions(today));

  const input = {
    mode: opts.mode,
    now: nowIso,
    sha: opts.sha,
    signoffExists: opts.signoffExists,
    realKeySince: opts.realKeySince ? `${opts.realKeySince}T00:00:00Z` : null,
    ci,
    ciRequiredJobs: opts.ciJobs ?? undefined,
    licence,
    quarantineFindings,
    auditExceptionProblems: ex ? ex.audit : null,
    zapExceptionProblems: ex ? ex.zap : null,
  };

  if (full) {
    input.commitDate = await settle(async () => {
      const c = await client.getJson(`/repos/${repo}/commits/${opts.sha}`);
      return c?.commit?.committer?.date ?? null;
    });
    const dayMs = 86_400_000; // threshold-ok: ms per day
    input.stagingE2eDay =
      (await settle(() =>
        runsOf(client, repo, "staging-e2e-day.yml", `&head_sha=${opts.sha}&status=completed`),
      )) ?? [];
    input.nightly =
      (await settle(() => runsOf(client, repo, "nightly.yml", "&status=completed"))) ?? [];
    input.zapStaging =
      (await settle(() =>
        runsOf(client, repo, "zap-baseline.yml", "&event=workflow_dispatch&status=completed"),
      )) ?? [];
    input.restoreDrill =
      (await settle(() =>
        runsOf(client, repo, "restore-drill.yml", "&status=completed", {
          jobsFor: (r) => now - Date.parse(r.created_at) <= 120 * dayMs, // threshold-ok: DRILL_MAX_DAYS
        }),
      )) ?? [];
  }
  return evaluateReleaseGate(input);
}

/** @returns {Promise<number>} exit code */
export async function main(
  argv,
  env = process.env,
  { client, local = localChecks(), out = (s) => console.log(s), now = () => Date.now() } = {},
) {
  const opts = parseArgs(argv);
  if (opts.error) {
    out(`release-gate: ${opts.error}`);
    return 2;
  }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !REPO.test(repo)) {
    out("release-gate: GITHUB_REPOSITORY is missing or malformed");
    return 2;
  }
  if (!client && !env.GITHUB_TOKEN) {
    out("release-gate: GITHUB_TOKEN (github.token) is not available");
    return 2;
  }
  const api = client ?? createClient(env);
  let result;
  try {
    result = await gather({
      opts,
      repo,
      client: api,
      local,
      now: now(),
      runId: env.GITHUB_RUN_ID,
    });
  } catch {
    out("release-gate: the gate could not be evaluated");
    return 2;
  }
  const table = renderGate(result);
  out(table);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`);
    } catch {
      out("release-gate: the job summary could not be written");
    }
  }
  return result.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

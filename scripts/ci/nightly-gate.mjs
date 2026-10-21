// Nightly gate and green-streak counter for .github/workflows/nightly.yml (M8 T12;
// docs/M8_design.md 2.8 "Nightly full suite", decision 21; TST-132, AT-31).
//   gate:   a scheduled night runs only if `main` has a commit newer than the last green run of the
//           nightly staging job ("only on days with merged changes"); a dispatch always runs.
//   streak: AT-31 needs three consecutive green nightly runs on staging with no red run between. A
//           night skipped for "no change" neither counts nor breaks the streak; the run list holds
//           such nights as successful workflow runs, so the staging JOB of each run is what is read.
//   node scripts/ci/nightly-gate.mjs gate               writes run=true|false to $GITHUB_OUTPUT
//   node scripts/ci/nightly-gate.mjs streak <result>    result = this run's staging outcome
//                                                       (success|failure|cancelled|skipped)
// Only github.token (actions: read, contents: read) is used, against GITHUB_API_URL. Output is
// counts and fixed words: no URL, SHA or name.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REQUIRED_GREENS = 3; // threshold-ok: decision 21, three consecutive green nights
const JOB_NAME = "staging";
const LOOKBACK_RUNS = 20; // threshold-ok: how many past runs are read

/** Pure: should this run do the work? lastGreenAt / mainCommittedAt are ISO strings or null. */
export function shouldRun({ event, lastGreenAt, mainCommittedAt }) {
  if (event !== "schedule") return { run: true, reason: "dispatch or other trigger" };
  if (!mainCommittedAt) return { run: false, reason: "main has no readable commit date" };
  if (!lastGreenAt) return { run: true, reason: "no green nightly yet" };
  return Date.parse(mainCommittedAt) > Date.parse(lastGreenAt)
    ? { run: true, reason: "main moved since the last green night" }
    : { run: false, reason: "no change on main since the last green night" };
}

/**
 * Pure: the streak. `runs` = past completed runs newest first, each { createdAt, stagingResult }
 * where stagingResult is "success", "failure", "cancelled", "skipped" or null (job absent).
 * `current` = this run's staging result, counted first when known.
 */
export function streakOf(runs, current = null) {
  const results = [current, ...runs.map((r) => r.stagingResult)];
  let greens = 0;
  for (const r of results) {
    if (r === null || r === "skipped") continue; // not run: neither green nor red
    if (r === "success") greens += 1;
    else return { greens, broken: true };
  }
  return { greens, broken: false };
}

async function api(path, env, fetchImpl) {
  const base = env.GITHUB_API_URL || "https://api.github.com";
  const res = await fetchImpl(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000), // threshold-ok: request timeout in ms
  });
  if (!res.ok) throw new Error("api");
  return res.json();
}

async function pastRuns(env, fetchImpl, excludeId) {
  const repo = env.GITHUB_REPOSITORY;
  const list = await api(
    `/repos/${repo}/actions/workflows/nightly.yml/runs?status=completed&per_page=${LOOKBACK_RUNS}`,
    env,
    fetchImpl,
  );
  const runs = [];
  for (const r of list.workflow_runs ?? []) {
    if (String(r.id) === String(excludeId)) continue;
    const jobs = await api(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=30`, env, fetchImpl);
    const job = (jobs.jobs ?? []).find((j) => j.name === JOB_NAME);
    runs.push({
      createdAt: r.created_at,
      stagingResult: job ? (job.conclusion ?? null) : null,
    });
  }
  return runs;
}

function setOutput(env, name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** @returns {Promise<number>} exit code */
export async function main(argv, env = process.env, fetchImpl = fetch, out = console.log) {
  const [mode, arg] = argv;
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    out("the GitHub context is not available");
    return 2;
  }
  try {
    const runs = await pastRuns(env, fetchImpl, env.GITHUB_RUN_ID);
    if (mode === "gate") {
      const lastGreen = runs.find((r) => r.stagingResult === "success");
      const head = await api(`/repos/${env.GITHUB_REPOSITORY}/commits/main`, env, fetchImpl);
      const d = shouldRun({
        event: env.GITHUB_EVENT_NAME,
        lastGreenAt: lastGreen?.createdAt ?? null,
        mainCommittedAt: head?.commit?.committer?.date ?? null,
      });
      setOutput(env, "run", d.run ? "true" : "false");
      out(`nightly: ${d.run ? "running" : "skipping"} (${d.reason})`);
      return 0;
    }
    if (mode === "streak") {
      const known = ["success", "failure", "cancelled", "skipped"];
      const s = streakOf(runs, known.includes(arg) ? arg : null);
      const line = `Nightly green streak on staging: ${s.greens} of ${REQUIRED_GREENS}${s.broken ? " (a red run ended the count)" : ""}`;
      out(line);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${line}\n`);
      return 0;
    }
    out("usage: nightly-gate.mjs gate | streak <result>");
    return 2;
  } catch {
    out("the GitHub run history could not be read");
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

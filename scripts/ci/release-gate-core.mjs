// Release gate core (M8 T6; docs/M8_design.md 2.7, decision 25; TST-112, TST-106, TST-108, TST-132,
// D-153, D-155, D-158). PURE: no file, network, clock or environment access. Everything it needs is
// passed in as plain facts, so the same function serves the `release-gate` check in CI
// (scripts/ci/release-gate.mjs) and the production sign-off page.
//
// It decides whether ONE commit may be released. A missing or unreadable fact FAILS its condition
// with a plain sentence; nothing is assumed green. The result holds no token, URL, SHA or
// secret: only condition ids, fixed labels, counts, ages and workflow job names (fixed file text).
//
// MODES (decision 25, explicit and never defaulted):
//   "full"            PR gate + staging E2E day + nightly + ZAP on staging + restore drill (TST-112
//                     "Full release gate"). Required from the second release and for the go-live
//                     switch.
//   "infrastructure"  the first M8 release (data-only, BLD-024): the staging workflows added in M8
//                     cannot run before they are on the default branch (TST-115), so only the PR
//                     gate and the local checks (licence, quarantine, exceptions) are required; the
//                     four staging conditions are listed as "not required". It is refused once a
//                     go-live sign-off exists (`signoffExists`): from then on only "full" releases.

export const MODES = /** @type {const} */ (["full", "infrastructure"]);

// threshold-ok: calendar and count limits fixed by the spec / decisions, not tunable rule values.
export const NIGHTLY_GREENS = 3; // decision 21
export const NIGHTLY_MAX_HOURS = 24; // decision 21, TST-132
export const ZAP_MAX_DAYS = 7; // staging ZAP scan must be this fresh
export const DRILL_MAX_DAYS = 120; // TST-112, TST-108, D-155

/** CI jobs of ci.yml that must have succeeded on the commit (the PR gate, M7 and M8 checks). */
// V1-I15 / D-796: the default equals the ci.yml release-gate `needs` list (a test pins the two together).
export const CI_REQUIRED_JOBS = [
  "app",
  "e2e",
  "secrets",
  "worker",
  "fixtures",
  "python",
  "audit",
  "coverage",
  "checks",
];

/** Step names the gate reads (workflow text; a rename must be mirrored here and in the tests). */
export const STEP = {
  e2eDeadlines: "PLT-073 deadline check",
  e2eStaging: "Staging end-to-end checks (viewer test identity)",
  zapScan: "Scan staging as the viewer test identity",
  drill: "Drill or restore",
  // GL-09: the strict step of the ci.yml fixtures job (release PRs only): real fixtures checked out,
  // no fixture-backed test skipped. A skipped step is NOT a pass here.
  fixturesStrict: "Release PR fixtures strict check (checked out, none skipped)",
};
export const JOB = { stagingE2eDay: "staging", nightly: "staging", zap: "staging" };

const HOUR_MS = 3_600_000; // threshold-ok: ms per hour
const DAY_MS = 86_400_000; // threshold-ok: ms per day

const ok = (id, label, reason) => ({ id, label, required: true, status: "pass", reason });
const fail = (id, label, reason) => ({ id, label, required: true, status: "fail", reason });
const notRequired = (id, label, reason) => ({
  id,
  label,
  required: false,
  status: "not-required",
  reason,
});

const time = (s) => {
  const t = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? null : t;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (a) => (Array.isArray(a) ? a : []);
const jobOf = (run, name) => list(run?.jobs).find((j) => j?.name === name);
const stepOf = (job, name) => list(job?.steps).find((s) => s?.name === name);
const newestFirst = (runs) =>
  [...list(runs)].sort((a, b) => (time(b?.createdAt) ?? 0) - (time(a?.createdAt) ?? 0));
const daysAgo = (now, t) => Math.floor((now - t) / DAY_MS);

// 1. PR gate on the commit.
function ciCondition(input) {
  const label = "CI is green on this commit";
  const id = "ci";
  const required = list(input.ciRequiredJobs).length ? input.ciRequiredJobs : CI_REQUIRED_JOBS;
  const jobs = input.ci;
  if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
    return fail(id, label, "no CI run was found for this commit; push it and wait for CI");
  }
  const bad = [];
  for (const name of required) {
    const j = jobs.find((x) => x?.name === name);
    if (!j) bad.push(`${name} (not found)`);
    else if (j.conclusion === "success") {
      // GL-09: the soft PR-time path lets the fixtures job pass with only a warning; a release
      // must have run the strict step (it fails on a failed checkout or any skipped test).
      if (name === "fixtures" && stepOf(j, STEP.fixturesStrict)?.conclusion !== "success") {
        const c = stepOf(j, STEP.fixturesStrict)?.conclusion ?? "missing";
        bad.push(
          `fixtures (passed with fixtures skipped or unchecked: strict step ${c}; the private fixtures repo must be checked out and no fixture test skipped)`,
        );
      }
      continue;
    } else if (j.conclusion === null || j.conclusion === undefined)
      bad.push(`${name} (still running)`);
    else bad.push(`${name} (${j.conclusion})`);
  }
  return bad.length
    ? fail(id, label, `these CI jobs are not green: ${bad.join(", ")}`)
    : ok(id, label, `all ${required.length} required CI jobs succeeded`);
}

// 2. licence-check --release.
function licenceCondition(input) {
  const id = "licence";
  const label = "No licence entry is pending Owner approval";
  const l = input.licence;
  if (!l || typeof l.failures !== "number" || typeof l.pending !== "number") {
    return fail(id, label, "the licence check did not run");
  }
  if (l.failures > 0 || l.pending > 0) {
    return fail(
      id,
      label,
      `licence-check --release: ${plural(l.failures, "package")} outside the allow-list or awaiting Owner approval (${l.pending} pending); the Owner approves or removes them`,
    );
  }
  return ok(id, label, "licence-check --release passed");
}

// 3. quarantine record.
function quarantineCondition(input) {
  const id = "quarantine";
  const label = "No expired or malformed quarantine entry";
  if (typeof input.quarantineFindings !== "number") {
    return fail(id, label, "tests/quarantine.json could not be checked");
  }
  return input.quarantineFindings > 0
    ? fail(
        id,
        label,
        `${plural(input.quarantineFindings, "quarantine finding")} (expired or malformed); fix the test or renew the entry`,
      )
    : ok(id, label, "the quarantine record is valid and nothing has expired");
}

// 4. audit and ZAP exception files.
function exceptionsCondition(input) {
  const id = "exceptions";
  const label = "Audit and ZAP exceptions are valid and not expired";
  const a = input.auditExceptionProblems;
  const z = input.zapExceptionProblems;
  if (typeof a !== "number" || typeof z !== "number") {
    return fail(id, label, "the audit or ZAP exception file could not be checked");
  }
  if (a > 0 || z > 0) {
    const parts = [];
    if (a > 0) parts.push(`audit-exceptions.json has ${plural(a, "problem")}`);
    if (z > 0) parts.push(`zap-exceptions.json has ${plural(z, "problem")}`);
    return fail(id, label, `${parts.join("; ")} (expired, malformed or too long-lived)`);
  }
  return ok(id, label, "both exception files are valid and unexpired");
}

// 5. staging E2E day on this SHA.
function e2eDayCondition(input, sha) {
  const id = "staging-e2e-day";
  const label = "Staging E2E day is green on this commit";
  const runs = newestFirst(input.stagingE2eDay).filter((r) => r?.headSha === sha);
  if (runs.length === 0) {
    return fail(id, label, "no Staging E2E day run exists for this commit; dispatch it on main");
  }
  for (const r of runs) {
    const job = jobOf(r, JOB.stagingE2eDay);
    if (
      r.conclusion === "success" &&
      job?.conclusion === "success" &&
      stepOf(job, STEP.e2eDeadlines)?.conclusion === "success" &&
      stepOf(job, STEP.e2eStaging)?.conclusion === "success"
    ) {
      return ok(id, label, "a green run covers every PLT-073 step and the staging E2E checks");
    }
  }
  return fail(
    id,
    label,
    "the Staging E2E day run for this commit is not green (a PLT-073 step was late or missing, or the staging checks failed); fix and dispatch it again",
  );
}

// 6. nightly: three consecutive greens, and one inside 24 h that ran after the commit existed.
function nightlyCondition(input, now) {
  const id = "nightly";
  const label = `Nightly suite: ${NIGHTLY_GREENS} green nights in a row, one within ${NIGHTLY_MAX_HOURS} h`;
  const runs = newestFirst(input.nightly).filter((r) => (time(r?.createdAt) ?? Infinity) <= now);
  let greens = 0;
  let broken = false;
  for (const r of runs) {
    const c = jobOf(r, JOB.nightly)?.conclusion ?? null;
    if (c === null || c === "skipped") continue; // not run: neither green nor red
    if (c === "success") greens += 1;
    else {
      broken = true;
      break;
    }
  }
  const problems = [];
  if (greens < NIGHTLY_GREENS) {
    problems.push(
      `${greens} of ${NIGHTLY_GREENS} consecutive green nights${broken ? " (a red night ended the count)" : ""}`,
    );
  }
  const commitAt = time(input.commitDate);
  const fresh = runs.find((r) => {
    const t = time(r?.createdAt);
    return (
      t !== null &&
      now - t <= NIGHTLY_MAX_HOURS * HOUR_MS &&
      jobOf(r, JOB.nightly)?.conclusion === "success" &&
      commitAt !== null &&
      t >= commitAt
    );
  });
  if (!fresh) {
    problems.push(
      commitAt === null
        ? `the commit date is unknown, so no night can be shown to be newer than it`
        : `no green night in the last ${NIGHTLY_MAX_HOURS} hours that started after this commit; dispatch Nightly`,
    );
  }
  return problems.length
    ? fail(id, label, problems.join("; "))
    : ok(
        id,
        label,
        `${greens} green nights in a row; the newest ran within ${NIGHTLY_MAX_HOURS} h`,
      );
}

// 7. ZAP baseline on staging.
function zapCondition(input, now) {
  const id = "zap-staging";
  const label = `ZAP baseline on staging is green within ${ZAP_MAX_DAYS} days`;
  const runs = newestFirst(input.zapStaging);
  const recent = runs.filter((r) => {
    const t = time(r?.createdAt);
    return t !== null && t <= now && now - t <= ZAP_MAX_DAYS * DAY_MS;
  });
  for (const r of recent) {
    const job = jobOf(r, JOB.zap);
    if (r.conclusion === "success" && job?.conclusion === "success") {
      const auth = stepOf(job, STEP.zapScan)?.conclusion === "success";
      return ok(
        id,
        label,
        auth
          ? "green staging scan; authenticated: yes"
          : "green staging scan; authenticated: no (the report states authenticated pages were not scanned, TST-112)",
      );
    }
  }
  return fail(
    id,
    label,
    runs.length === 0
      ? "no ZAP baseline run on staging was found; dispatch ZAP baseline on main"
      : recent.length === 0
        ? `the newest ZAP staging run is older than ${ZAP_MAX_DAYS} days; dispatch it again`
        : "the ZAP staging run in the last days is not green (a high finding or an expired exception)",
  );
}

// 8. restore drill + later green verify-removed (D-155).
function drillCondition(input, now) {
  const id = "restore-drill";
  const label = `A restore drill and a later green verify-removed run, within ${DRILL_MAX_DAYS} days`;
  const since = time(input.realKeySince);
  const inWindow = newestFirst(input.restoreDrill).filter((r) => {
    const t = time(r?.createdAt);
    return t !== null && t <= now && now - t <= DRILL_MAX_DAYS * DAY_MS;
  });
  const isDrill = (r) => {
    const s = stepOf(jobOf(r, "restore"), STEP.drill);
    return s?.conclusion === "success";
  };
  const isVerified = (r) => {
    const job = jobOf(r, "restore");
    return (
      r.conclusion === "success" &&
      job?.conclusion === "success" &&
      stepOf(job, STEP.drill)?.conclusion === "skipped"
    );
  };
  const drills = inWindow
    .filter(isDrill)
    .filter((r) => since === null || time(r.createdAt) >= since);
  const mode = since === null ? "build-phase drills count" : "real-key drills only";
  if (drills.length === 0) {
    return fail(
      id,
      label,
      since === null
        ? `no restore drill run completed in the last ${DRILL_MAX_DAYS} days; dispatch Restore drill (mode drill)`
        : `no real-key restore drill completed since the sign-off baseline within ${DRILL_MAX_DAYS} days; run the real-key drill (OPS-040)`,
    );
  }
  // Only the NEWEST drill counts: a newer drill without a later verify-removed run means the
  // temporary secrets may still exist (the drill's last step fails while they do).
  const d = drills[0];
  const dt = time(d.createdAt);
  if (inWindow.some((v) => isVerified(v) && (time(v.createdAt) ?? 0) >= dt)) {
    return ok(
      id,
      label,
      `newest drill ${daysAgo(now, dt)} day(s) ago and a later green verify-removed run (${mode})`,
    );
  }
  return fail(
    id,
    label,
    "the drill has no later green verify-removed run; delete the temporary secrets, then dispatch Restore drill with mode verify-removed",
  );
}

/**
 * @param {import("./release-gate-core.d.mts").GateInput} input
 * @returns {import("./release-gate-core.d.mts").GateResult}
 */
export function evaluateReleaseGate(input) {
  const now = time(input?.now);
  const sha = typeof input?.sha === "string" ? input.sha : "";
  const mode = input?.mode;
  if (!MODES.includes(mode)) {
    return {
      mode: "invalid",
      pass: false,
      conditions: [
        fail(
          "mode",
          "Gate mode is stated",
          'the mode must be "full" or "infrastructure"; it has no default',
        ),
      ],
    };
  }
  if (now === null || !/^[0-9a-f]{40}$/.test(sha)) {
    return {
      mode,
      pass: false,
      conditions: [
        fail(
          "input",
          "Gate input is complete",
          "the time or the 40-hex commit id is missing or malformed",
        ),
      ],
    };
  }

  const conditions = [];
  if (mode === "infrastructure") {
    if (input.signoffExists === true) {
      conditions.push(
        fail(
          "mode",
          "Infrastructure gate is allowed",
          "a go-live sign-off exists, so only the full gate applies (decision 25)",
        ),
      );
    } else {
      conditions.push(
        ok(
          "mode",
          "Infrastructure gate is allowed",
          "first release under the infrastructure gate (data-only mode, BLD-024); the full gate starts with the second release and the go-live switch",
        ),
      );
    }
  } else {
    conditions.push(ok("mode", "Gate mode", "full release gate (TST-112)"));
  }

  conditions.push(
    ciCondition(input),
    licenceCondition(input),
    quarantineCondition(input),
    exceptionsCondition(input),
  );

  if (mode === "full") {
    conditions.push(
      e2eDayCondition(input, sha),
      nightlyCondition(input, now),
      zapCondition(input, now),
      drillCondition(input, now),
    );
  } else {
    const why = "not required under the infrastructure gate (first release, decision 25)";
    conditions.push(
      notRequired("staging-e2e-day", "Staging E2E day is green on this commit", why),
      notRequired("nightly", "Nightly suite is green", why),
      notRequired("zap-staging", "ZAP baseline on staging is green", why),
      notRequired("restore-drill", "Restore drill and verify-removed run", why),
    );
  }
  return { mode, pass: conditions.every((c) => c.status !== "fail"), conditions };
}

/** Markdown table for the job summary and the sign-off page. No token, URL or SHA in it. */
export function renderGate(result) {
  const word = { pass: "PASS", fail: "FAIL", "not-required": "n/a" };
  const lines = [`### Release gate: ${result.pass ? "PASS" : "FAIL"} (${result.mode} mode)`, ""];
  if (result.mode === "infrastructure") {
    lines.push(
      "> Infrastructure gate (first release, data-only mode): the staging conditions are not required. The full gate applies from the second release and for the go-live switch.",
      "",
    );
  }
  lines.push("| Condition | Result | Reason |", "| --- | --- | --- |");
  for (const c of result.conditions) {
    lines.push(`| ${c.label} | ${word[c.status]} | ${c.reason.replaceAll("|", "/")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

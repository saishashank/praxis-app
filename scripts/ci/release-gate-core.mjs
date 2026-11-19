// Release gate core (M8 T6; docs/M8_design.md 2.7, decision 25; TST-112, TST-106, TST-108, TST-132,
// D-153, D-155, D-158). PURE: no file, network, clock or environment access. Everything it needs is
// passed in as plain facts, so the same function serves the `release-gate` check in CI
// (scripts/ci/release-gate.mjs) and the production sign-off page.
//
// It decides whether ONE commit may be released. A missing or unreadable fact FAILS its condition
// with a plain sentence; nothing is assumed green. The result holds no token, URL, SHA or
// secret: only condition ids, fixed labels, counts, ages and workflow job names (fixed file text).
//
// M18 OPS-107 / D-964: there is no staging environment. The three conditions that used to read staging
// workflow runs are re-homed onto CI: `recorded-day` (the CI job `recorded-day` of the run on the
// commit), `ci-streak` (the three newest completed push CI runs on the head branch are green and the
// newest is the commit) and `zap-local` (the authenticated ZAP scan of the local build, on the commit).
// No condition is waivable (WAIVABLE is empty; the D-860 machinery stays, dormant).
//
// MODES (decision 25, explicit and never defaulted):
//   "full"            PR gate + recorded day + CI streak + ZAP on the local build + restore drill
//                     (TST-112 "Full release gate"). Required from the second release and for the
//                     go-live switch.
//   "infrastructure"  the first M8 release (data-only, BLD-024): only the PR gate and the local
//                     checks (licence, quarantine, exceptions) are required; the four other
//                     conditions are listed as "not required". It is refused once a go-live sign-off
//                     exists (`signoffExists`): from then on only "full" releases.

export const MODES = /** @type {const} */ (["full", "infrastructure"]);

// threshold-ok: calendar and count limits fixed by the spec / decisions, not tunable rule values.
export const STREAK_GREENS = 3; // AT-31 "three greens in a row", re-homed onto push CI runs (D-964)
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
  // ci.yml job `recorded-day` (D-965): the PLT-073 deadline check on the simulated clock, and the final
  // network assertion (no request left the machine, every process wrote its guard marker).
  recordedDeadlines: "PLT-073 deadline check (simulated clock)",
  recordedNetwork: "Network assertion (no market-data host reached, every guard installed)",
  // zap-baseline.yml job `local`: the authenticated scan (TST-113 re-homed, D-964).
  zapScan: "Scan the local build as the viewer test identity",
  drill: "Drill or restore",
  // GL-09: the strict step of the ci.yml fixtures job (release PRs only): real fixtures checked out,
  // no fixture-backed test skipped. A skipped step is NOT a pass here.
  fixturesStrict: "Release PR fixtures strict check (checked out, none skipped)",
};
export const JOB = { recordedDay: "recorded-day", zap: "local" };

// D-860 / D-964: Owner waivers (docs/release/waivers.json). The machinery is kept but DORMANT: no
// condition is waivable any more (the staging-e2e-day waiver closed with the condition), so every
// entry is ignored and the condition is judged normally. A waiver would last at most 14 days.
export const WAIVABLE = /** @type {string[]} */ ([]);
export const MAX_WAIVER_DAYS = 14; // threshold-ok: calendar limit fixed by D-860, not a tunable rule value
const WAIVER_TEXT_MAX = 600; // threshold-ok: length cap on Owner-written waiver prose

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

// 5. the recorded day: the CI job `recorded-day` of the run on this commit (D-964, D-965).
function recordedDayCondition(input) {
  const id = "recorded-day";
  const label = "The recorded day is green in CI on this commit";
  const jobs = input.ci;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return fail(id, label, "no CI run was found for this commit; push it and wait for CI");
  }
  const j = jobs.find((x) => x?.name === JOB.recordedDay);
  if (!j) {
    return fail(
      id,
      label,
      `the ${JOB.recordedDay} job is not in the CI run for this commit (a fork pull request or an old workflow); push the commit to the repository and wait for CI`,
    );
  }
  if (j.conclusion === null || j.conclusion === undefined) {
    return fail(id, label, `the ${JOB.recordedDay} job is still running`);
  }
  if (j.conclusion === "skipped") {
    return fail(
      id,
      label,
      `the ${JOB.recordedDay} job was skipped (it needs the fixtures token and does not run on fork pull requests); a skipped day is not a pass`,
    );
  }
  if (j.conclusion !== "success") {
    return fail(
      id,
      label,
      `the ${JOB.recordedDay} job did not succeed (${j.conclusion}); a PLT-073 step was late or missing, the walk failed, or a process reached a market-data host`,
    );
  }
  // A green job whose two closing steps did not succeed (renamed, skipped) is not trusted.
  const missing = [STEP.recordedDeadlines, STEP.recordedNetwork].filter(
    (n) => stepOf(j, n)?.conclusion !== "success",
  );
  if (missing.length) {
    return fail(
      id,
      label,
      `the ${JOB.recordedDay} job is green but its closing step "${missing[0]}" did not succeed (missing or skipped)`,
    );
  }
  return ok(
    id,
    label,
    "the recorded day ran green: every PLT-073 deadline met on the simulated clock and no request reached a market-data host",
  );
}

// 6. CI streak: the three newest completed push runs on the head branch are green, newest = commit.
// A run cancelled by a newer push (concurrency) or skipped is "not run": neither green nor red.
function ciStreakCondition(input, sha, now) {
  const id = "ci-streak";
  const label = `CI streak: the ${STREAK_GREENS} newest push runs on the branch are green and the newest is this commit`;
  if (!Array.isArray(input.ciStreak)) {
    return fail(
      id,
      label,
      "the push CI runs of the head branch could not be read (branch unknown or the API failed)",
    );
  }
  const runs = newestFirst(input.ciStreak).filter(
    (r) =>
      (time(r?.createdAt) ?? Infinity) <= now &&
      r?.conclusion !== null &&
      r?.conclusion !== undefined &&
      r.conclusion !== "cancelled" &&
      r.conclusion !== "skipped",
  );
  if (runs.length === 0) {
    return fail(
      id,
      label,
      "no completed push CI run was found on the head branch; push and wait for CI",
    );
  }
  if (runs[0].headSha !== sha) {
    return fail(
      id,
      label,
      "the newest completed push CI run on the branch is not on this commit; wait for CI to finish on it",
    );
  }
  let greens = 0;
  let broken = false;
  for (const r of runs.slice(0, STREAK_GREENS)) {
    if (r.conclusion === "success") greens += 1;
    else {
      broken = true;
      break;
    }
  }
  return greens < STREAK_GREENS
    ? fail(
        id,
        label,
        `${greens} of ${STREAK_GREENS} consecutive green push runs${broken ? " (a red run ended the count)" : " (fewer runs exist)"}`,
      )
    : ok(id, label, `${STREAK_GREENS} green push runs in a row, the newest on this commit`);
}

// 7. ZAP baseline on the local build, on this commit, authenticated (TST-113 re-homed, D-964).
function zapCondition(input, sha) {
  const id = "zap-local";
  const label = "ZAP baseline on the local build is green on this commit, authenticated";
  const runs = newestFirst(input.zapLocal).filter((r) => r?.headSha === sha);
  if (runs.length === 0) {
    return fail(
      id,
      label,
      "no ZAP baseline run exists for this commit; push it and wait for ZAP baseline",
    );
  }
  let unauth = false;
  for (const r of runs) {
    const job = jobOf(r, JOB.zap);
    if (r.conclusion === "success" && job?.conclusion === "success") {
      if (stepOf(job, STEP.zapScan)?.conclusion === "success") {
        return ok(id, label, "green scan of the local build; authenticated: yes");
      }
      unauth = true;
    }
  }
  return fail(
    id,
    label,
    unauth
      ? "the ZAP scan was green but not authenticated (the viewer test identity step did not succeed); authenticated pages must be scanned"
      : "the ZAP baseline run for this commit is not green (a high finding or an expired exception)",
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayNumber(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t / DAY_MS;
}
const prose = (v) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= WAIVER_TEXT_MAX && !v.includes("://"); // a URL pasted into Owner prose must not reach a log

/**
 * Keeps only the valid waivers. Fail closed: a malformed, expired, future-dated, over-long,
 * non-Owner or non-allow-listed entry is dropped (and counted), never half-applied.
 * @returns {{ valid: any[], ignored: number }}
 */
export function validateWaivers(raw, today, allow = WAIVABLE) {
  const t = dayNumber(today);
  const valid = [];
  let ignored = 0;
  if (raw === undefined || raw === null) return { valid, ignored };
  if (!Array.isArray(raw) || t === null) {
    return { valid, ignored: Array.isArray(raw) ? raw.length : 1 };
  }
  for (const w of raw) {
    const from = dayNumber(w?.decidedOn);
    const to = dayNumber(w?.expires);
    const good =
      w &&
      typeof w === "object" &&
      allow.includes(w.condition) &&
      w.decidedBy === "Owner" &&
      prose(w.reason) &&
      prose(w.followUp) &&
      from !== null &&
      to !== null &&
      from <= t &&
      to >= t &&
      to - from <= MAX_WAIVER_DAYS;
    if (good) valid.push(w);
    else ignored += 1;
  }
  return { valid, ignored };
}

/** Turns a FAILED waivable condition into "waived" when a valid waiver names it. */
function applyWaivers(conditions, input, nowMs) {
  const today =
    typeof input.today === "string" ? input.today : new Date(nowMs).toISOString().slice(0, 10);
  const { valid, ignored } = validateWaivers(input.waivers, today);
  const waived = [];
  const out = conditions.map((c) => {
    if (c.status !== "fail" || !WAIVABLE.includes(c.id)) return c;
    const w = valid.find((x) => x.condition === c.id);
    if (!w) return c;
    waived.push({
      id: c.id,
      label: c.label,
      decidedOn: w.decidedOn,
      expires: w.expires,
      reason: w.reason,
      followUp: w.followUp,
      wouldHaveFailedBecause: c.reason,
    });
    return {
      id: c.id,
      label: c.label,
      required: true,
      status: "waived",
      reason: `waived by the Owner on ${w.decidedOn} until ${w.expires}: ${w.reason}`,
    };
  });
  return { conditions: out, waived, ignoredWaivers: ignored };
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
      recordedDayCondition(input),
      ciStreakCondition(input, sha, now),
      zapCondition(input, sha),
      drillCondition(input, now),
    );
  } else {
    const why = "not required under the infrastructure gate (first release, decision 25)";
    conditions.push(
      notRequired("recorded-day", "The recorded day is green in CI on this commit", why),
      notRequired("ci-streak", "CI streak is green", why),
      notRequired("zap-local", "ZAP baseline on the local build is green", why),
      notRequired("restore-drill", "Restore drill and verify-removed run", why),
    );
  }
  const w = applyWaivers(conditions, input, now);
  return {
    mode,
    pass: w.conditions.every((c) => c.status !== "fail"),
    conditions: w.conditions,
    waived: w.waived,
    ignoredWaivers: w.ignoredWaivers,
  };
}

/** Markdown table for the job summary and the sign-off page. No token, URL or SHA in it. */
export function renderGate(result) {
  const word = { pass: "PASS", fail: "FAIL", "not-required": "n/a", waived: "WAIVED" };
  const waived = Array.isArray(result.waived) ? result.waived : [];
  const extra = waived.length ? `, ${plural(waived.length, "condition")} waived by the Owner` : "";
  const lines = [
    `### Release gate: ${result.pass ? "PASS" : "FAIL"} (${result.mode} mode${extra})`,
    "",
  ];
  if (result.mode === "infrastructure") {
    lines.push(
      "> Infrastructure gate (first release, data-only mode): the recorded-day, CI-streak and ZAP conditions are not required. The full gate applies from the second release and for the go-live switch.",
      "",
    );
  }
  lines.push("| Condition | Result | Reason |", "| --- | --- | --- |");
  for (const c of result.conditions) {
    lines.push(`| ${c.label} | ${word[c.status]} | ${c.reason.replaceAll("|", "/")} |`);
  }
  lines.push("");
  if (waived.length) {
    lines.push("**Waived by the Owner (this is not a pass):**", "");
    for (const w of waived) {
      lines.push(
        `- ${w.label}: waived on ${w.decidedOn}, ends ${w.expires}. Reason: ${w.reason.replaceAll("|", "/")} Next step: ${w.followUp.replaceAll("|", "/")}`,
      );
    }
    lines.push("");
  }
  if (result.ignoredWaivers > 0) {
    const n = result.ignoredWaivers;
    lines.push(
      `${plural(n, "waiver")} in docs/release/waivers.json ${n === 1 ? "was" : "were"} ignored (expired, invalid or not allowed).`,
      "",
    );
  }
  return lines.join("\n");
}

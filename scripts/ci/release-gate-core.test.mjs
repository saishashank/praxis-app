// M8 T6 (decision 25, TST-112, D-153, D-155): every release-gate condition fails on its own, all
// present passes, the modes are explicit, and the output holds no token or SHA.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CI_REQUIRED_JOBS,
  DRILL_MAX_DAYS,
  NIGHTLY_GREENS,
  STEP,
  ZAP_MAX_DAYS,
  evaluateReleaseGate,
  renderGate,
} from "./release-gate-core.mjs";

const SHA = "1".repeat(40);
const NOW = Date.parse("2026-11-20T12:00:00Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;
const D = 86_400_000;

const step = (name, conclusion = "success") => ({ name, conclusion });
// GL-09: the fixtures job carries its strict step by default (a release PR ran it).
const job = (
  name,
  conclusion = "success",
  steps = name === "fixtures" ? [step(STEP.fixturesStrict)] : [],
) => ({
  name,
  conclusion,
  steps,
});
const run = (createdAgo, jobs, over = {}) => ({
  headSha: SHA,
  createdAt: iso(createdAgo),
  conclusion: "success",
  jobs,
  ...over,
});

function goodInput(over = {}) {
  return {
    mode: "full",
    now: new Date(NOW).toISOString(),
    sha: SHA,
    commitDate: iso(3 * D),
    ci: CI_REQUIRED_JOBS.map((n) => job(n)),
    licence: { failures: 0, pending: 0 },
    quarantineFindings: 0,
    auditExceptionProblems: 0,
    zapExceptionProblems: 0,
    stagingE2eDay: [
      run(D, [job("staging", "success", [step(STEP.e2eDeadlines), step(STEP.e2eStaging)])]),
    ],
    nightly: [0, 1, 2].map((i) =>
      run(2 * H + i * D, [job("staging")], { headSha: "9".repeat(40) }),
    ),
    zapStaging: [run(2 * D, [job("staging", "success", [step(STEP.zapScan)])])],
    restoreDrill: [
      run(10 * D, [job("restore", "success", [step(STEP.drill, "skipped")])]),
      run(12 * D, [job("restore", "failure", [step(STEP.drill, "success")])], {
        conclusion: "failure",
      }),
    ],
    ...over,
  };
}

const byId = (r) => Object.fromEntries(r.conditions.map((c) => [c.id, c]));
const failing = (r) => r.conditions.filter((c) => c.status === "fail").map((c) => c.id);

test("all conditions present: the gate passes (full mode)", () => {
  const r = evaluateReleaseGate(goodInput());
  assert.equal(r.pass, true);
  assert.deepEqual(failing(r), []);
  assert.deepEqual(
    r.conditions.map((c) => c.id),
    [
      "mode",
      "ci",
      "licence",
      "quarantine",
      "exceptions",
      "staging-e2e-day",
      "nightly",
      "zap-staging",
      "restore-drill",
    ],
  );
});

// Each case removes exactly one condition and expects exactly that one to fail.
const CASES = [
  ["ci: no run for the commit", { ci: null }, "ci", /no CI run/],
  [
    "ci: one required job failed",
    { ci: CI_REQUIRED_JOBS.map((n) => job(n, n === "worker" ? "failure" : "success")) },
    "ci",
    /worker \(failure\)/,
  ],
  [
    "ci: a required job is missing",
    { ci: CI_REQUIRED_JOBS.filter((n) => n !== "python").map((n) => job(n)) },
    "ci",
    /python \(not found\)/,
  ],
  [
    "ci: a required job is skipped",
    { ci: CI_REQUIRED_JOBS.map((n) => job(n, n === "e2e" ? "skipped" : "success")) },
    "ci",
    /e2e \(skipped\)/,
  ],
  [
    "ci: a required job is still running",
    { ci: CI_REQUIRED_JOBS.map((n) => job(n, n === "app" ? null : "success")) },
    "ci",
    /app \(still running\)/,
  ],
  [
    "ci: fixtures passed with a warning only (checkout failed, strict step skipped or failed)",
    {
      ci: CI_REQUIRED_JOBS.map((n) =>
        job(n, "success", n === "fixtures" ? [step(STEP.fixturesStrict, "skipped")] : undefined),
      ),
    },
    "ci",
    /fixtures (passed with fixtures skipped or unchecked: strict step skipped/,
  ],
  [
    "ci: fixtures job has no strict step at all (old workflow)",
    {
      ci: CI_REQUIRED_JOBS.map((n) => job(n, "success", n === "fixtures" ? [] : undefined)),
    },
    "ci",
    /strict step missing/,
  ],
  [
    "ci: fixtures strict step failed",
    {
      ci: CI_REQUIRED_JOBS.map((n) =>
        job(n, "success", n === "fixtures" ? [step(STEP.fixturesStrict, "failure")] : undefined),
      ),
    },
    "ci",
    /strict step failure/,
  ],
  [
    "licence: pending Owner approval (D-153)",
    { licence: { failures: 16, pending: 16 } },
    "licence",
    /16 pending/,
  ],
  ["licence: check did not run", { licence: null }, "licence", /did not run/],
  ["quarantine: an expired entry", { quarantineFindings: 1 }, "quarantine", /1 quarantine finding/],
  [
    "quarantine: file unreadable",
    { quarantineFindings: null },
    "quarantine",
    /could not be checked/,
  ],
  [
    "exceptions: audit exception expired",
    { auditExceptionProblems: 2 },
    "exceptions",
    /audit-exceptions\.json has 2 problems/,
  ],
  [
    "exceptions: ZAP exception expired",
    { zapExceptionProblems: 1 },
    "exceptions",
    /zap-exceptions\.json has 1 problem /,
  ],
  [
    "exceptions: file unreadable",
    { zapExceptionProblems: null },
    "exceptions",
    /could not be checked/,
  ],
  ["e2e day: no run", { stagingE2eDay: [] }, "staging-e2e-day", /no Staging E2E day run/],
  [
    "e2e day: run is on another commit",
    { stagingE2eDay: goodInput().stagingE2eDay.map((r) => ({ ...r, headSha: "2".repeat(40) })) },
    "staging-e2e-day",
    /no Staging E2E day run/,
  ],
  [
    "e2e day: PLT-073 check step failed",
    {
      stagingE2eDay: [
        run(
          D,
          [job("staging", "failure", [step(STEP.e2eDeadlines, "failure"), step(STEP.e2eStaging)])],
          { conclusion: "failure" },
        ),
      ],
    },
    "staging-e2e-day",
    /not green/,
  ],
  [
    "e2e day: PLT-073 step missing from the run",
    { stagingE2eDay: [run(D, [job("staging", "success", [step(STEP.e2eStaging)])])] },
    "staging-e2e-day",
    /not green/,
  ],
  [
    "nightly: only two green nights",
    { nightly: goodInput().nightly.slice(0, 2) },
    "nightly",
    /2 of 3 consecutive/,
  ],
  [
    "nightly: a red night between the greens",
    {
      nightly: [
        run(2 * H, [job("staging")]),
        run(D, [job("staging", "failure")], { conclusion: "failure" }),
        run(2 * D, [job("staging")]),
        run(3 * D, [job("staging")]),
      ],
    },
    "nightly",
    /1 of 3 consecutive green nights \(a red night ended the count\)/,
  ],
  [
    "nightly: three greens but none within 24 h",
    { nightly: [0, 1, 2].map((i) => run(30 * H + i * D, [job("staging")])) },
    "nightly",
    /no green night in the last 24 hours/,
  ],
  [
    "nightly: the fresh night started before the commit existed",
    { commitDate: iso(30 * 60_000) },
    "nightly",
    /after this commit/,
  ],
  ["nightly: commit date unknown", { commitDate: null }, "nightly", /commit date is unknown/],
  ["zap: no staging run", { zapStaging: [] }, "zap-staging", /no ZAP baseline run on staging/],
  [
    "zap: run older than the limit",
    {
      zapStaging: [run((ZAP_MAX_DAYS + 1) * D, [job("staging", "success", [step(STEP.zapScan)])])],
    },
    "zap-staging",
    /older than 7 days/,
  ],
  [
    "zap: newest run failed",
    {
      zapStaging: [
        run(D, [job("staging", "failure", [step(STEP.zapScan)])], { conclusion: "failure" }),
      ],
    },
    "zap-staging",
    /not green/,
  ],
  ["drill: no run at all", { restoreDrill: [] }, "restore-drill", /no restore drill run completed/],
  [
    "drill: drill is older than 120 days",
    {
      restoreDrill: [
        run((DRILL_MAX_DAYS + 1) * D, [job("restore", "success", [step(STEP.drill, "skipped")])]),
        run((DRILL_MAX_DAYS + 3) * D, [job("restore", "failure", [step(STEP.drill)])], {
          conclusion: "failure",
        }),
      ],
    },
    "restore-drill",
    /no restore drill run completed/,
  ],
  [
    "drill: drill ran but no verify-removed run follows (D-155)",
    {
      restoreDrill: [
        run(12 * D, [job("restore", "failure", [step(STEP.drill)])], { conclusion: "failure" }),
      ],
    },
    "restore-drill",
    /no later green verify-removed/,
  ],
  [
    "drill: the verify-removed run came BEFORE the drill",
    {
      restoreDrill: [
        run(2 * D, [job("restore", "failure", [step(STEP.drill)])], { conclusion: "failure" }),
        run(12 * D, [job("restore", "success", [step(STEP.drill, "skipped")])]),
      ],
    },
    "restore-drill",
    /no later green verify-removed/,
  ],
  [
    "drill: verify-removed run is red (the temporary secrets still exist)",
    {
      restoreDrill: [
        run(2 * D, [job("restore", "failure", [step(STEP.drill, "skipped")])], {
          conclusion: "failure",
        }),
        run(12 * D, [job("restore", "failure", [step(STEP.drill)])], { conclusion: "failure" }),
      ],
    },
    "restore-drill",
    /no later green verify-removed/,
  ],
];

for (const [name, over, id, reason] of CASES) {
  test(`missing condition fails on its own: ${name}`, () => {
    const r = evaluateReleaseGate(goodInput(over));
    assert.equal(r.pass, false);
    assert.deepEqual(failing(r), [id]);
    assert.match(r.conditions.find((c) => c.id === id).reason, reason);
  });
}

test("drill: only the NEWEST drill counts; a newer drill without verify-removed fails", () => {
  const r = evaluateReleaseGate(
    goodInput({
      restoreDrill: [
        run(D, [job("restore", "failure", [step(STEP.drill)])], { conclusion: "failure" }),
        run(10 * D, [job("restore", "success", [step(STEP.drill, "skipped")])]),
        run(12 * D, [job("restore", "failure", [step(STEP.drill)])], { conclusion: "failure" }),
      ],
    }),
  );
  assert.deepEqual(failing(r), ["restore-drill"]);
  assert.match(r.conditions.at(-1).reason, /no later green verify-removed/);
});

test("drill, real-key mode: a build-phase drill before the baseline date does not count", () => {
  const since = iso(5 * D);
  const r = evaluateReleaseGate(goodInput({ realKeySince: since }));
  assert.deepEqual(failing(r), ["restore-drill"]);
  assert.match(r.conditions.at(-1).reason, /real-key restore drill/);
  const ok = evaluateReleaseGate(
    goodInput({
      realKeySince: since,
      restoreDrill: [
        run(D, [job("restore", "success", [step(STEP.drill, "skipped")])]),
        run(3 * D, [job("restore", "failure", [step(STEP.drill)])], { conclusion: "failure" }),
      ],
    }),
  );
  assert.equal(ok.pass, true);
});

test("zap: an unauthenticated green scan passes and says so (TST-112)", () => {
  const r = evaluateReleaseGate(
    goodInput({ zapStaging: [run(D, [job("staging", "success", [])])] }),
  );
  assert.equal(r.pass, true);
  assert.match(byId(r)["zap-staging"].reason, /authenticated: no/);
  assert.match(byId(evaluateReleaseGate(goodInput()))["zap-staging"].reason, /authenticated: yes/);
});

test("nightly: skipped nights ('no change on main') neither count nor break the streak", () => {
  const r = evaluateReleaseGate(
    goodInput({
      nightly: [
        run(2 * H, [job("staging")]),
        run(D, [job("staging", "skipped")]),
        run(2 * D, [job("staging")]),
        run(3 * D, []),
        run(4 * D, [job("staging")]),
      ],
    }),
  );
  assert.equal(r.pass, true);
  assert.equal(NIGHTLY_GREENS, 3);
});

test("several failures are all listed, each with its own plain reason", () => {
  const r = evaluateReleaseGate(
    goodInput({ ci: null, licence: { failures: 1, pending: 1 }, nightly: [], zapStaging: [] }),
  );
  assert.deepEqual(failing(r), ["ci", "licence", "nightly", "zap-staging"]);
  assert.ok(r.conditions.every((c) => typeof c.reason === "string" && c.reason.length > 10));
});

test("infrastructure mode (first release): staging conditions are explicitly not required", () => {
  const r = evaluateReleaseGate(
    goodInput({
      mode: "infrastructure",
      stagingE2eDay: [],
      nightly: [],
      zapStaging: [],
      restoreDrill: [],
    }),
  );
  assert.equal(r.pass, true);
  const c = byId(r);
  for (const id of ["staging-e2e-day", "nightly", "zap-staging", "restore-drill"]) {
    assert.equal(c[id].status, "not-required");
    assert.equal(c[id].required, false);
    assert.match(c[id].reason, /infrastructure gate/);
  }
  assert.match(c.mode.reason, /first release/);
  assert.match(renderGate(r), /Infrastructure gate \(first release/);
});

test("infrastructure mode still enforces CI, licence, quarantine and exceptions", () => {
  for (const [over, id] of [
    [{ ci: null }, "ci"],
    [{ licence: { failures: 1, pending: 1 } }, "licence"],
    [{ quarantineFindings: 1 }, "quarantine"],
    [{ auditExceptionProblems: 1 }, "exceptions"],
  ]) {
    const r = evaluateReleaseGate(goodInput({ mode: "infrastructure", ...over }));
    assert.deepEqual(failing(r), [id]);
  }
});

test("infrastructure mode is refused once a go-live sign-off exists", () => {
  const r = evaluateReleaseGate(goodInput({ mode: "infrastructure", signoffExists: true }));
  assert.equal(r.pass, false);
  assert.deepEqual(failing(r), ["mode"]);
  assert.match(r.conditions[0].reason, /only the full gate applies/);
  // full mode with a sign-off is fine
  assert.equal(evaluateReleaseGate(goodInput({ signoffExists: true })).pass, true);
});

test("the mode has no default: missing or unknown fails closed", () => {
  for (const mode of [undefined, null, "", "Full", "skip", "none"]) {
    const r = evaluateReleaseGate(goodInput({ mode }));
    assert.equal(r.pass, false);
    assert.equal(r.mode, "invalid");
  }
});

test("malformed time or commit id fails closed", () => {
  for (const over of [
    { now: "yesterday" },
    { sha: "abc" },
    { sha: undefined },
    { now: undefined },
  ]) {
    assert.equal(evaluateReleaseGate(goodInput(over)).pass, false);
  }
  assert.equal(evaluateReleaseGate(undefined).pass, false);
});

test("the final CI job list can be overridden, and a job outside it is not required", () => {
  const ci = [...CI_REQUIRED_JOBS.map((n) => job(n)), job("coverage", "failure")];
  assert.equal(evaluateReleaseGate(goodInput({ ci })).pass, true);
  const r = evaluateReleaseGate(
    goodInput({ ci, ciRequiredJobs: [...CI_REQUIRED_JOBS, "coverage"] }),
  );
  assert.deepEqual(failing(r), ["ci"]);
  assert.match(r.conditions.find((c) => c.id === "ci").reason, /coverage \(failure\)/);
});

test("future-dated runs are ignored (clock skew cannot satisfy a window)", () => {
  const future = (r) => ({ ...r, createdAt: new Date(NOW + D).toISOString() });
  const r = evaluateReleaseGate(
    goodInput({
      zapStaging: goodInput().zapStaging.map(future),
      nightly: goodInput().nightly.map(future),
    }),
  );
  assert.deepEqual(failing(r), ["nightly", "zap-staging"]);
});

test("output holds no token, URL or commit id, whatever the inputs contain", () => {
  const TOKEN = "ghs_TOKENVALUE0123456789";
  const hostile = goodInput({
    ci: CI_REQUIRED_JOBS.map((n) => job(n, "failure")),
    licence: { failures: 3, pending: 3 },
  });
  // job names come from workflow text; a token-like value in a run field is never copied out
  hostile.nightly = [
    { ...hostile.nightly[0], headSha: TOKEN, token: TOKEN, url: "https://x.test/a" },
  ];
  const text =
    JSON.stringify(evaluateReleaseGate(hostile)) + renderGate(evaluateReleaseGate(hostile));
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(SHA));
  assert.ok(!/https?:\/\//.test(text));
});

test("renderGate: a pass/fail table with one row per condition and no pipe breakage", () => {
  const r = evaluateReleaseGate(goodInput({ ci: null }));
  const md = renderGate(r);
  assert.match(md, /^### Release gate: FAIL \(full mode\)/);
  assert.equal(
    md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---")).length,
    1 + r.conditions.length,
  );
  assert.match(md, /\| CI is green on this commit \| FAIL \|/);
});

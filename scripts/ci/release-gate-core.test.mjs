// M8 T6 (decision 25, TST-112, D-153, D-155): every release-gate condition fails on its own, all
// present passes, the modes are explicit, and the output holds no token or SHA.
// M18 OPS-107 / D-964 (AT-84): staging is retired. The gate reads the CI job `recorded-day`, the
// three newest push CI runs of the branch (`ci-streak`) and the authenticated local ZAP run
// (`zap-local`); nothing is waivable.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CI_REQUIRED_JOBS,
  DRILL_MAX_DAYS,
  JOB,
  MAX_WAIVER_DAYS,
  STEP,
  STREAK_GREENS,
  WAIVABLE,
  validateWaivers,
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

const recordedJob = (conclusion = "success", steps) =>
  job(
    JOB.recordedDay,
    conclusion,
    steps ?? [step(STEP.recordedDeadlines), step(STEP.recordedNetwork)],
  );
const BRANCH_SHA = "9".repeat(40);
// three green push runs of the branch, the newest on the commit under test
const streak = () => [
  run(2 * H, [], { headSha: SHA }),
  run(D, [], { headSha: BRANCH_SHA }),
  run(2 * D, [], { headSha: BRANCH_SHA }),
];

function goodInput(over = {}) {
  return {
    mode: "full",
    now: new Date(NOW).toISOString(),
    sha: SHA,
    commitDate: iso(3 * D),
    ci: [...CI_REQUIRED_JOBS.map((n) => job(n)), recordedJob()],
    licence: { failures: 0, pending: 0 },
    quarantineFindings: 0,
    auditExceptionProblems: 0,
    zapExceptionProblems: 0,
    ciStreak: streak(),
    zapLocal: [run(D, [job("local", "success", [step(STEP.zapScan)])])],
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
      "recorded-day",
      "ci-streak",
      "zap-local",
      "restore-drill",
    ],
  );
});

// Each case removes exactly one condition and expects exactly that one to fail.
const CASES = [
  ["ci: no run for the commit", { ci: null }, "ci", /no CI run/, ["recorded-day"]],
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
    /fixtures \(passed with fixtures skipped or unchecked: strict step skipped/,
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
  // recorded-day (D-964): a job of the CI run on the commit
  ["recorded day: no CI run at all", { ci: null }, "recorded-day", /no CI run was found/, ["ci"]],
  [
    "recorded day: the job is not in the CI run (fork PR or old workflow)",
    { ci: CI_REQUIRED_JOBS.map((n) => job(n)) },
    "recorded-day",
    /recorded-day job is not in the CI run/,
  ],
  [
    "recorded day: the job was skipped (a skipped day is not a pass)",
    { ci: [...CI_REQUIRED_JOBS.map((n) => job(n)), recordedJob("skipped")] },
    "recorded-day",
    /was skipped.*not a pass/,
  ],
  [
    "recorded day: the job is still running",
    { ci: [...CI_REQUIRED_JOBS.map((n) => job(n)), recordedJob(null)] },
    "recorded-day",
    /still running/,
  ],
  [
    "recorded day: the job is red",
    { ci: [...CI_REQUIRED_JOBS.map((n) => job(n)), recordedJob("failure")] },
    "recorded-day",
    /did not succeed \(failure\)/,
  ],
  [
    "recorded day: green job but the PLT-073 step is missing",
    {
      ci: [
        ...CI_REQUIRED_JOBS.map((n) => job(n)),
        recordedJob("success", [step(STEP.recordedNetwork)]),
      ],
    },
    "recorded-day",
    /closing step "PLT-073 deadline check/,
  ],
  [
    "recorded day: green job but the network assertion was skipped",
    {
      ci: [
        ...CI_REQUIRED_JOBS.map((n) => job(n)),
        recordedJob("success", [
          step(STEP.recordedDeadlines),
          step(STEP.recordedNetwork, "skipped"),
        ]),
      ],
    },
    "recorded-day",
    /closing step "Network assertion/,
  ],
  // ci-streak (D-964): the AT-31 "three greens in a row" without a schedule
  ["streak: the facts could not be read", { ciStreak: null }, "ci-streak", /could not be read/],
  ["streak: no push run at all", { ciStreak: [] }, "ci-streak", /no completed push CI run/],
  [
    "streak: only two green runs exist",
    { ciStreak: streak().slice(0, 2) },
    "ci-streak",
    /2 of 3 consecutive green push runs \(fewer runs exist\)/,
  ],
  [
    "streak: a red run between the greens",
    {
      ciStreak: [
        run(2 * H, [], { headSha: SHA }),
        run(D, [], { headSha: BRANCH_SHA, conclusion: "failure" }),
        run(2 * D, [], { headSha: BRANCH_SHA }),
        run(3 * D, [], { headSha: BRANCH_SHA }),
      ],
    },
    "ci-streak",
    /1 of 3 consecutive green push runs \(a red run ended the count\)/,
  ],
  [
    "streak: the newest completed run is on another commit",
    { ciStreak: streak().map((r, i) => (i === 0 ? { ...r, headSha: BRANCH_SHA } : r)) },
    "ci-streak",
    /not on this commit/,
  ],
  [
    "streak: the newest run on this commit is red",
    { ciStreak: streak().map((r, i) => (i === 0 ? { ...r, conclusion: "failure" } : r)) },
    "ci-streak",
    /0 of 3 consecutive green push runs \(a red run ended the count\)/,
  ],
  [
    "zap: no run on the commit",
    { zapLocal: [] },
    "zap-local",
    /no ZAP baseline run exists for this commit/,
  ],
  [
    "zap: the run is on another commit",
    { zapLocal: goodInput().zapLocal.map((r) => ({ ...r, headSha: BRANCH_SHA })) },
    "zap-local",
    /no ZAP baseline run exists for this commit/,
  ],
  [
    "zap: the local job is red",
    {
      zapLocal: [
        run(D, [job("local", "failure", [step(STEP.zapScan)])], { conclusion: "failure" }),
      ],
    },
    "zap-local",
    /not green/,
  ],
  [
    "zap: green but unauthenticated (the identity step did not succeed)",
    { zapLocal: [run(D, [job("local", "success", [step(STEP.zapScan, "skipped")])])] },
    "zap-local",
    /not authenticated/,
  ],
  [
    "zap: a green job of the OLD staging name does not count",
    { zapLocal: [run(D, [job("staging", "success", [step(STEP.zapScan)])])] },
    "zap-local",
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

for (const [name, over0, id, reason, also = []] of CASES) {
  // the `ci` cases keep the recorded-day job, so only the condition under test fails
  const over =
    id === "ci" && Array.isArray(over0.ci) ? { ...over0, ci: [...over0.ci, recordedJob()] } : over0;
  test(`missing condition fails on its own: ${name}`, () => {
    const r = evaluateReleaseGate(goodInput(over));
    assert.equal(r.pass, false);
    assert.deepEqual([...failing(r)].sort(), [...also, id].sort());
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

test("zap: a green authenticated scan says so", () => {
  const r = evaluateReleaseGate(goodInput());
  assert.match(byId(r)["zap-local"].reason, /authenticated: yes/);
});

test("zap: a later red re-run does not hide an earlier green authenticated run on the same commit", () => {
  const r = evaluateReleaseGate(
    goodInput({
      zapLocal: [
        run(H, [job("local", "failure", [step(STEP.zapScan)])], { conclusion: "failure" }),
        run(D, [job("local", "success", [step(STEP.zapScan)])]),
      ],
    }),
  );
  assert.equal(r.pass, true);
});

test("streak: cancelled and skipped runs neither count nor break it (concurrency cancels older pushes)", () => {
  const r = evaluateReleaseGate(
    goodInput({
      ciStreak: [
        run(H, [], { headSha: SHA }),
        run(2 * H, [], { headSha: BRANCH_SHA, conclusion: "cancelled" }),
        run(D, [], { headSha: BRANCH_SHA, conclusion: "skipped" }),
        run(2 * D, [], { headSha: BRANCH_SHA }),
        run(3 * D, [], { headSha: BRANCH_SHA }),
      ],
    }),
  );
  assert.equal(r.pass, true);
  assert.equal(STREAK_GREENS, 3);
});

test("streak: runs still in progress and future-dated runs are ignored", () => {
  const r = evaluateReleaseGate(
    goodInput({
      ciStreak: [
        run(-D, [], { headSha: BRANCH_SHA }), // future (clock skew)
        { ...run(H, [], { headSha: BRANCH_SHA }), conclusion: null }, // still running
        ...streak(),
      ],
    }),
  );
  assert.equal(r.pass, true);
  // a cancelled run on the commit leaves an older commit as the newest counted run
  const c = evaluateReleaseGate(
    goodInput({
      ciStreak: [
        { ...run(H, [], { headSha: SHA }), conclusion: "cancelled" },
        ...streak().slice(1),
      ],
    }),
  );
  assert.deepEqual(failing(c), ["ci-streak"]);
});

test("the gate no longer reads staging facts: stale input fields change nothing", () => {
  const r = evaluateReleaseGate(
    goodInput({ stagingE2eDay: [], nightly: [], zapStaging: [], ciStreak: streak() }),
  );
  assert.equal(r.pass, true);
  assert.ok(r.conditions.every((c) => !/staging|nightly/i.test(c.id + c.label + c.reason)));
});

test("several failures are all listed, each with its own plain reason", () => {
  const r = evaluateReleaseGate(
    goodInput({ ci: null, licence: { failures: 1, pending: 1 }, ciStreak: [], zapLocal: [] }),
  );
  assert.deepEqual(failing(r), ["ci", "licence", "recorded-day", "ci-streak", "zap-local"]);
  assert.ok(r.conditions.every((c) => typeof c.reason === "string" && c.reason.length > 10));
});

test("infrastructure mode (first release): the recorded-day conditions are explicitly not required", () => {
  const r = evaluateReleaseGate(
    goodInput({
      mode: "infrastructure",
      ci: CI_REQUIRED_JOBS.map((n) => job(n)),
      ciStreak: [],
      zapLocal: [],
      restoreDrill: [],
    }),
  );
  assert.equal(r.pass, true);
  const c = byId(r);
  for (const id of ["recorded-day", "ci-streak", "zap-local", "restore-drill"]) {
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
  const ci = [...CI_REQUIRED_JOBS.map((n) => job(n)), recordedJob(), job("extra-job", "failure")];
  assert.equal(evaluateReleaseGate(goodInput({ ci })).pass, true);
  const r = evaluateReleaseGate(
    goodInput({ ci, ciRequiredJobs: [...CI_REQUIRED_JOBS, "extra-job"] }),
  );
  assert.deepEqual(failing(r), ["ci"]);
  assert.match(r.conditions.find((c) => c.id === "ci").reason, /extra-job \(failure\)/);
});

test("future-dated runs are ignored (clock skew cannot satisfy the streak or the drill window)", () => {
  const future = (r) => ({ ...r, createdAt: new Date(NOW + D).toISOString() });
  const r = evaluateReleaseGate(
    goodInput({
      ciStreak: goodInput().ciStreak.map(future),
      restoreDrill: goodInput().restoreDrill.map(future),
    }),
  );
  assert.deepEqual(failing(r), ["ci-streak", "restore-drill"]);
});

test("output holds no token, URL or commit id, whatever the inputs contain", () => {
  const TOKEN = "ghs_TOKENVALUE0123456789";
  const hostile = goodInput({
    ci: CI_REQUIRED_JOBS.map((n) => job(n, "failure")),
    licence: { failures: 3, pending: 3 },
  });
  // job names come from workflow text; a token-like value in a run field is never copied out
  hostile.ciStreak = [
    { ...hostile.ciStreak[0], headSha: TOKEN, token: TOKEN, url: "https://x.test/a" },
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

// D-860 / D-964: the waiver machinery is kept but DORMANT: nothing is waivable. NOW is 2026-11-20.
const WAIVER = {
  condition: "recorded-day",
  reason: "the recorded day cannot run yet; the Owner releases on the other gates",
  decidedBy: "Owner",
  decidedOn: "2026-11-18",
  expires: "2026-11-25",
  followUp: "fix the recorded day",
};
const noDay = { ci: CI_REQUIRED_JOBS.map((n) => job(n)) };

test("waivers: no condition is waivable (D-964), the old staging waiver is gone", () => {
  assert.deepEqual(WAIVABLE, []);
  assert.equal(MAX_WAIVER_DAYS, 14);
});

test("waivers: a well-formed Owner waiver for any condition is ignored and the condition still fails", () => {
  for (const condition of [
    "recorded-day",
    "ci-streak",
    "zap-local",
    "ci",
    "restore-drill",
    "staging-e2e-day",
    "nightly",
    "zap-staging",
  ]) {
    const r = evaluateReleaseGate(goodInput({ ...noDay, waivers: [{ ...WAIVER, condition }] }));
    assert.equal(r.pass, false, condition);
    assert.deepEqual(r.waived, [], condition);
    assert.equal(r.ignoredWaivers, 1, condition);
    assert.equal(byId(r)["recorded-day"].status, "fail", condition);
  }
});

test("waivers: the summary says an ignored waiver was ignored", () => {
  const text = renderGate(evaluateReleaseGate(goodInput({ ...noDay, waivers: [WAIVER] })));
  assert.match(text, /### Release gate: FAIL/);
  assert.match(text, /1 waiver in docs\/release\/waivers\.json was ignored/);
  assert.doesNotMatch(text, /Waived by the Owner/);
});

test("waivers: malformed shapes are ignored without a throw", () => {
  for (const w of [{}, "x", 5, [null], ["recorded-day"]]) {
    const r = evaluateReleaseGate(goodInput({ ...noDay, waivers: w }));
    assert.equal(r.pass, false);
    assert.deepEqual(r.waived, []);
  }
});

test("waivers: the retained validation (dormant machinery) still rejects bad entries when an allow-list is passed", () => {
  const allow = ["recorded-day"];
  const today = "2026-11-20";
  assert.equal(validateWaivers([WAIVER], today, allow).valid.length, 1);
  const bad = [
    { ...WAIVER, decidedOn: "2026-11-01", expires: "2026-11-19" }, // expired
    { ...WAIVER, decidedOn: "2026-11-10", expires: "2026-11-25" }, // 15 days
    { ...WAIVER, decidedOn: "2026-11-21", expires: "2026-11-25" }, // future decision
    { ...WAIVER, decidedBy: "Claude" },
    { ...WAIVER, reason: "see https://example.com/x" },
    { ...WAIVER, condition: "made-up" },
    null,
  ];
  for (const w of bad) assert.equal(validateWaivers([w], today, allow).valid.length, 0);
  // and with the real (empty) allow-list the good one is rejected too
  assert.equal(validateWaivers([WAIVER], today).valid.length, 0);
  assert.equal(validateWaivers([WAIVER], today).ignored, 1);
});

test("docs/release/waivers.json keeps its file shape with an empty list (D-964)", async () => {
  const { readFileSync } = await import("node:fs");
  const url = new URL("../../docs/release/waivers.json", import.meta.url);
  const file = JSON.parse(readFileSync(url, "utf8"));
  assert.ok(Array.isArray(file.waivers));
  assert.deepEqual(file.waivers, []);
  assert.match(file._comment, /no condition is waivable/i);
  for (const w of file.waivers) {
    assert.ok(WAIVABLE.includes(w.condition));
  }
});

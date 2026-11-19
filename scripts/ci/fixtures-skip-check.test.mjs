// GL-09: a release PR fails when fixtures were not checked out or any fixture test was skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFixtureReport } from "./fixtures-skip-check.mjs";

const good = {
  numTotalTests: 4,
  numPassedTests: 4,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
};

test("all tests ran with the fixtures checked out: ok", () => {
  assert.equal(checkFixtureReport(good, "success").ok, true);
});

test("a failed or skipped checkout fails even when the report looks green", () => {
  for (const o of ["failure", "skipped", "cancelled", "", undefined]) {
    assert.equal(checkFixtureReport(good, o).ok, false, String(o));
  }
});

test("skipped, todo, failed, empty or unreadable reports fail", () => {
  assert.match(
    checkFixtureReport({ ...good, numPassedTests: 3, numPendingTests: 1 }, "success").reason,
    /skipped/,
  );
  assert.equal(checkFixtureReport({ ...good, numTodoTests: 1 }, "success").ok, false);
  assert.match(
    checkFixtureReport({ ...good, numPassedTests: 3, numFailedTests: 1 }, "success").reason,
    /failed/,
  );
  assert.equal(
    checkFixtureReport({ ...good, numTotalTests: 0, numPassedTests: 0 }, "success").ok,
    false,
  );
  assert.equal(checkFixtureReport(null, "success").ok, false);
  assert.equal(checkFixtureReport({ numTotalTests: 2 }, "success").ok, false);
});

// D-1846: the ASX test may be skipped (no ASX recordings while the ASX Worker is off); nothing else may.
const ASX = ["real fixtures: ASX", "every recorded response gives a result or a typed error"];
const YAHOO = ["real fixtures: Yahoo", "every recorded chunk is accounted for row by row"];
const withTests = (tests) => ({
  numTotalTests: tests.length,
  numPassedTests: tests.filter((t) => t[2] === "passed").length,
  numFailedTests: tests.filter((t) => t[2] === "failed").length,
  numPendingTests: tests.filter((t) => t[2] === "skipped" || t[2] === "pending").length,
  numTodoTests: tests.filter((t) => t[2] === "todo").length,
  testResults: [
    {
      assertionResults: tests.map(([suite, title, status]) => ({
        ancestorTitles: [suite],
        title,
        status,
      })),
    },
  ],
});

test("the release-PR report of 2026-11-19 (Yahoo ran, ASX skipped) passes as exempt", () => {
  const res = checkFixtureReport(
    withTests([
      [...YAHOO, "passed"],
      [...ASX, "skipped"],
    ]),
    "success",
  );
  assert.equal(res.ok, true, res.reason);
  assert.match(res.reason, /exempt \(D-1846\)/);
});

test("a skip that is not exempt still fails, even next to the exempt one", () => {
  const res = checkFixtureReport(
    withTests([
      [...YAHOO, "skipped"],
      ["real fixtures: Yahoo", "another", "passed"],
      [...ASX, "skipped"],
    ]),
    "success",
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /record the missing fixtures/);
});

test("the exemption does not excuse a failure, a todo, an empty run or a bad checkout", () => {
  assert.equal(
    checkFixtureReport(
      withTests([
        [...YAHOO, "failed"],
        [...ASX, "skipped"],
      ]),
      "success",
    ).ok,
    false,
  );
  assert.equal(
    checkFixtureReport(
      withTests([
        [...YAHOO, "todo"],
        [...ASX, "skipped"],
      ]),
      "success",
    ).ok,
    false,
  );
  assert.equal(checkFixtureReport(withTests([[...ASX, "skipped"]]), "success").ok, false);
  assert.equal(
    checkFixtureReport(
      withTests([
        [...YAHOO, "passed"],
        [...ASX, "skipped"],
      ]),
      "failure",
    ).ok,
    false,
  );
});

test("counts that disagree with the per-test list fail closed", () => {
  const r = withTests([
    [...YAHOO, "passed"],
    [...ASX, "skipped"],
  ]);
  r.numPendingTests = 2;
  assert.equal(checkFixtureReport(r, "success").ok, false);
});

test("when the exempt test runs, the log says the exemption can be removed", () => {
  const res = checkFixtureReport(
    withTests([
      [...YAHOO, "passed"],
      [...ASX, "passed"],
    ]),
    "success",
  );
  assert.equal(res.ok, true);
  assert.match(res.reason, /remove them from SKIP_EXEMPT/);
});

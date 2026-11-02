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

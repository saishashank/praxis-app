// GL-09 (M8.1; D-207 item 9): on a pull request into `release` the fixtures job must have RUN its
// fixture-backed tests. The soft PR-time path (checkout failure only warns, tests skip) is kept for
// every other event; this check is the strict step the release gate reads.
//   node scripts/ci/fixtures-skip-check.mjs <vitest-json-report>
//   env: FIXTURES_CHECKOUT_OUTCOME (steps.<checkout>.outcome: success | failure | skipped | cancelled)
// Fails (exit 1) when the fixtures checkout did not succeed, when the report is missing or
// unreadable, when no test ran, or when any test was skipped, todo or failed. The log carries counts
// only, never fixture content.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {unknown} report parsed vitest `--reporter=json` output
 * @param {string | undefined} checkoutOutcome
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkFixtureReport(report, checkoutOutcome) {
  if (checkoutOutcome !== "success") {
    return {
      ok: false,
      reason: `the private fixtures repo was not checked out (outcome: ${checkoutOutcome || "unknown"}); a release PR needs the real fixtures`,
    };
  }
  const r = /** @type {Record<string, unknown> | null} */ (
    report && typeof report === "object" ? report : null
  );
  const n = (k) => (r && typeof r[k] === "number" ? /** @type {number} */ (r[k]) : null);
  const total = n("numTotalTests");
  const passed = n("numPassedTests");
  const failed = n("numFailedTests");
  const skipped = n("numPendingTests");
  const todo = n("numTodoTests");
  if (total === null || passed === null || failed === null || skipped === null || todo === null) {
    return { ok: false, reason: "the vitest report has no test counts" };
  }
  if (total === 0 || passed === 0) {
    return { ok: false, reason: `no fixture-backed test ran (total ${total}, passed ${passed})` };
  }
  if (skipped > 0 || todo > 0) {
    return {
      ok: false,
      reason: `${skipped} fixture-backed test(s) skipped and ${todo} todo on a release PR; record the missing fixtures`,
    };
  }
  if (failed > 0) return { ok: false, reason: `${failed} fixture-backed test(s) failed` };
  return { ok: true, reason: `${passed} fixture-backed tests ran, none skipped` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let report = null;
  try {
    report = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8"));
  } catch {
    report = null;
  }
  const res = checkFixtureReport(report, process.env.FIXTURES_CHECKOUT_OUTCOME);
  console.log(`fixtures-skip-check: ${res.ok ? "ok" : "failed"} (${res.reason})`);
  process.exit(res.ok ? 0 : 1);
}

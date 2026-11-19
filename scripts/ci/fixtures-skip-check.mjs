// GL-09 (M8.1; D-207 item 9): on a pull request into `release` the fixtures job must have RUN its
// fixture-backed tests. The soft PR-time path (checkout failure only warns, tests skip) is kept for
// every other event; this check is the strict step the release gate reads.
//   node scripts/ci/fixtures-skip-check.mjs <vitest-json-report>
//   env: FIXTURES_CHECKOUT_OUTCOME (steps.<checkout>.outcome: success | failure | skipped | cancelled)
// Fails (exit 1) when the fixtures checkout did not succeed, when the report is missing or
// unreadable, when no test ran, or when any test was skipped, todo or failed. The log carries counts
// only, never fixture content.
//
// D-1846: a skip is allowed only for a test named in SKIP_EXEMPT, each with the reason no recording
// can exist yet. Any other skip still fails. When an exempt test runs, the log says the exemption can go.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Fixture tests that may be skipped on a release PR, keyed by suite > test, with why. */
export const SKIP_EXEMPT = Object.freeze({
  "real fixtures: ASX > every recorded response gives a result or a typed error":
    "D-1846: no ASX response recordings exist; the ASX Worker is off (ASX_LIVE=0 since 2026-11-02, blocked by ASX) and ASX data arrives only through the GitHub asx-fetch job",
});

/**
 * Names (suite > test) of the skipped or todo tests in a vitest JSON report; null when the report
 * has no per-test results.
 * @param {Record<string, unknown> | null} r
 * @param {(s: string) => boolean} match
 * @returns {string[] | null}
 */
function testsWithStatus(r, match) {
  const files = r && Array.isArray(r.testResults) ? r.testResults : null;
  if (!files) return null;
  const out = [];
  for (const f of files) {
    const list = f && Array.isArray(f.assertionResults) ? f.assertionResults : [];
    for (const a of list) {
      if (!a || !match(String(a.status))) continue;
      const anc = Array.isArray(a.ancestorTitles) ? a.ancestorTitles : [];
      out.push([...anc, a.title].join(" > "));
    }
  }
  return out;
}

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
  if (failed > 0) return { ok: false, reason: `${failed} fixture-backed test(s) failed` };
  const ranExempt = (testsWithStatus(r, (s) => s === "passed") ?? []).filter(
    (t) => t in SKIP_EXEMPT,
  );
  const note = ranExempt.length
    ? `; ${ranExempt.length} exempt test(s) now run, remove them from SKIP_EXEMPT`
    : "";
  if (skipped > 0 || todo > 0) {
    const notRun = testsWithStatus(r, (s) => s !== "passed" && s !== "failed");
    const unexempt = notRun === null ? null : notRun.filter((t) => !(t in SKIP_EXEMPT));
    if (unexempt === null || unexempt.length > 0 || notRun.length !== skipped + todo) {
      return {
        ok: false,
        reason: `${skipped} fixture-backed test(s) skipped and ${todo} todo on a release PR; record the missing fixtures`,
      };
    }
    return {
      ok: true,
      reason: `${passed} fixture-backed tests ran; ${notRun.length} skipped, all exempt (D-1846)${note}`,
    };
  }
  return { ok: true, reason: `${passed} fixture-backed tests ran, none skipped${note}` };
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

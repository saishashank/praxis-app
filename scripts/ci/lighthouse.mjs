// AT-26 / NFR-010 Lighthouse gate (M7 design section 4.4, decision 59). Entry point for
// `npm run test:lighthouse`: it runs e2e/lighthouse.spec.ts with the POPULATED seed, which signs in as
// the Owner, opens the local production build in Chromium and audits Home (`/`) with Lighthouse's
// default mobile preset (3 runs, median).
//   FAIL: performance score < 80, or First Contentful Paint >= 2 s
//   WARN: Largest Contentful Paint >= 2.5 s, or Cumulative Layout Shift >= 0.1
// The pure threshold logic is exported and unit-tested; the runner needs no secret.
// Usage: node scripts/ci/lighthouse.mjs
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const THRESHOLDS = {
  performanceMin: 80,
  fcpMaxMs: 2000,
  lcpWarnMs: 2500,
  clsWarn: 0.1,
};

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pull the numbers we gate on out of one Lighthouse result (lhr). */
export function metricsOf(lhr) {
  return {
    performance: Math.round((lhr.categories?.performance?.score ?? 0) * 100),
    fcpMs: lhr.audits?.["first-contentful-paint"]?.numericValue ?? Infinity,
    lcpMs: lhr.audits?.["largest-contentful-paint"]?.numericValue ?? Infinity,
    cls: lhr.audits?.["cumulative-layout-shift"]?.numericValue ?? Infinity,
  };
}

/** Median of each metric over several runs. */
export function medianMetrics(runs) {
  return {
    performance: median(runs.map((r) => r.performance)),
    fcpMs: median(runs.map((r) => r.fcpMs)),
    lcpMs: median(runs.map((r) => r.lcpMs)),
    cls: median(runs.map((r) => r.cls)),
  };
}

/** { failures, warnings } for a metrics object. */
export function evaluate(m, t = THRESHOLDS) {
  const failures = [];
  const warnings = [];
  if (m.performance < t.performanceMin) {
    failures.push(`performance ${m.performance} is below ${t.performanceMin}`);
  }
  if (!(m.fcpMs < t.fcpMaxMs)) {
    failures.push(`FCP ${Math.round(m.fcpMs)} ms is not under ${t.fcpMaxMs} ms`);
  }
  if (!(m.lcpMs < t.lcpWarnMs)) {
    warnings.push(`LCP ${Math.round(m.lcpMs)} ms is not under ${t.lcpWarnMs} ms`);
  }
  if (!(m.cls < t.clsWarn)) warnings.push(`CLS ${m.cls.toFixed(3)} is not under ${t.clsWarn}`);
  return { failures, warnings };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const r = spawnSync("npx playwright test e2e/lighthouse.spec.ts --project=desktop", {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, E2E_SCENARIO: "populated", LIGHTHOUSE: "1" },
  });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

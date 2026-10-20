import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, median, medianMetrics, metricsOf } from "./lighthouse.mjs";

const GOOD = { performance: 95, fcpMs: 900, lcpMs: 1500, cls: 0.01 };

test("median of odd and even lists", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("good metrics pass without warnings", () => {
  assert.deepEqual(evaluate(GOOD), { failures: [], warnings: [] });
});

test("performance below 80 and FCP at 2 s fail", () => {
  assert.equal(evaluate({ ...GOOD, performance: 79 }).failures.length, 1);
  assert.equal(evaluate({ ...GOOD, performance: 80 }).failures.length, 0);
  assert.equal(evaluate({ ...GOOD, fcpMs: 2000 }).failures.length, 1);
  assert.equal(evaluate({ ...GOOD, fcpMs: 1999 }).failures.length, 0);
});

test("LCP and CLS only warn", () => {
  const r = evaluate({ ...GOOD, lcpMs: 2600, cls: 0.2 });
  assert.deepEqual(r.failures, []);
  assert.equal(r.warnings.length, 2);
});

test("a missing metric counts as failing / warning", () => {
  const m = metricsOf({ categories: {}, audits: {} });
  const r = evaluate(m);
  assert.equal(r.failures.length, 2);
  assert.equal(r.warnings.length, 2);
});

test("metricsOf reads a Lighthouse result and medianMetrics takes the middle run", () => {
  const lhr = (score, fcp) => ({
    categories: { performance: { score } },
    audits: {
      "first-contentful-paint": { numericValue: fcp },
      "largest-contentful-paint": { numericValue: 2000 },
      "cumulative-layout-shift": { numericValue: 0 },
    },
  });
  const runs = [lhr(0.9, 1000), lhr(0.5, 3000), lhr(0.85, 1200)].map(metricsOf);
  assert.equal(runs[0].performance, 90);
  const m = medianMetrics(runs);
  assert.equal(m.performance, 85);
  assert.equal(m.fcpMs, 1200);
});

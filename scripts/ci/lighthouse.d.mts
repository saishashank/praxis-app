export type Metrics = { performance: number; fcpMs: number; lcpMs: number; cls: number };
export const THRESHOLDS: {
  performanceMin: number;
  fcpMaxMs: number;
  lcpWarnMs: number;
  clsWarn: number;
};
export function median(xs: number[]): number;
export function metricsOf(lhr: unknown): Metrics;
export function medianMetrics(runs: Metrics[]): Metrics;
export function evaluate(m: Metrics): { failures: string[]; warnings: string[] };

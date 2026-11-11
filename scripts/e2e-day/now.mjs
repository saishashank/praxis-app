// The simulated clock flag `--now <ISO instant>` of the recorded-day scripts (M18 OPS-107 / D-965).
// batch1.mjs, close-books.mjs and signals.mjs take it so the recorded day runs "at" 17:30, 17:50 and
// 18:10 Melbourne on a simulated date whatever the real time is. It is REFUSED unless
// PRAXIS_ENV=recorded, so no production job can ever run on a made-up clock. The simulated clock keeps
// ticking (start + real time elapsed), so a script that waits (`--wait-minutes`) still ends.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {() => number} [realNow]
 * @returns {{ argv: string[], nowMs: (() => number) | undefined, error: string | null }}
 */
export function parseNow(argv, env, realNow = () => Date.now()) {
  const i = argv.indexOf("--now");
  if (i < 0) return { argv, nowMs: undefined, error: null };
  const rest = [...argv.slice(0, i), ...argv.slice(i + 2)];
  if (env.PRAXIS_ENV !== "recorded") {
    return {
      argv: rest,
      nowMs: undefined,
      error: "--now is only accepted when PRAXIS_ENV=recorded",
    };
  }
  const raw = argv[i + 1];
  const t = typeof raw === "string" && INSTANT.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(t)) {
    return { argv: rest, nowMs: undefined, error: "--now must be an ISO instant with a zone" };
  }
  const started = realNow();
  return { argv: rest, nowMs: () => t + (realNow() - started), error: null };
}

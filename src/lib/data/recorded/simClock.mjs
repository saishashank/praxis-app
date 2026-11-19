// Simulated clock for the app process of the CI recorded day (M18 OPS-107 / D-965). The route handlers
// read `Date.now()` and `new Date()` directly, so the recorded day moves the whole process to the
// simulated instant: a Proxy over the real Date class that adds a fixed offset. Time keeps flowing
// (instant = simulated start + wall-clock time elapsed). Installed by src/instrumentation.ts ONLY when
// PRAXIS_ENV=recorded and PRAXIS_SIM_NOW is a valid ISO instant; no other environment can reach it.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** @param {Record<string, string | undefined>} env @returns {number | null} epoch ms or null */
export function simNowFromEnv(env) {
  if (env.PRAXIS_ENV !== "recorded") return null;
  const raw = env.PRAXIS_SIM_NOW;
  const t = typeof raw === "string" && INSTANT.test(raw) ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * Replace `target.Date` with a Date whose "now" is `simNowMs` plus the wall-clock time elapsed since this call.
 * Dates built from arguments are unchanged. Returns an undo function.
 * @param {number} simNowMs @param {{ Date: DateConstructor }} [target]
 */
export function installSimClock(simNowMs, target = globalThis) {
  const RealDate = target.Date;
  const offset = simNowMs - RealDate.now();
  const now = () => RealDate.now() + offset;
  const SimDate = new Proxy(RealDate, {
    construct(t, args, newTarget) {
      return Reflect.construct(t, args.length === 0 ? [now()] : args, newTarget);
    },
    apply() {
      return new RealDate(now()).toString();
    },
    get(t, prop, receiver) {
      if (prop === "now") return now;
      return Reflect.get(t, prop, receiver);
    },
  });
  target.Date = SimDate;
  return () => {
    target.Date = RealDate;
  };
}

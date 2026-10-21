// Deterministic synthetic ZZ data for the E2E scenarios (M7 design section 5). Pure: the same
// (scenario, now) always gives the same rows. Codes are ZZ-prefixed, so no real security, price or
// vendor data is ever involved (HYG-MARKET: no price-bar CSV is committed, the bars are generated).
export const SCENARIOS = ["empty", "populated", "stale"];
export const MARKET = "AU";
export const ZZ_COUNT = 24;
export const BAR_DAYS = 60;
// Job intervals in hours; the stale scenario's last run is older than twice this.
export const JOB_INTERVAL_HOURS = { "ingest-bars": 24, "sentinel-poll": 1 };

/** Small seeded PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const zzCode = (i) =>
  "ZZ" + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Last BAR_DAYS weekdays up to and including the weekday on or before `now`, oldest first. */
export function tradingDays(nowIso, count = BAR_DAYS) {
  const out = [];
  let t = Date.parse(nowIso);
  while (out.length < count) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(day(t));
    t -= 86_400_000;
  }
  return out.reverse();
}

/**
 * Rows for one scenario. `empty` is production-like data-only: nothing. `populated` has fresh runs.
 * `stale` has the same data but its last runs are older than 2x their interval.
 */
export function buildScenario(scenario, nowIso) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
  if (scenario === "empty") return { instruments: [], bars: [], markers: [], runs: [] };
  const rand = rng(20261020);
  const days = tradingDays(nowIso);
  const last = days[days.length - 1];
  const instruments = [];
  const bars = [];
  for (let i = 0; i < ZZ_COUNT; i++) {
    const code = zzCode(i);
    let px = 5 + rand() * 45;
    for (const d of days) {
      const o = px;
      const c = Math.max(0.5, o * (1 + (rand() - 0.5) * 0.04));
      const h = Math.max(o, c) * (1 + rand() * 0.01);
      const l = Math.min(o, c) * (1 - rand() * 0.01);
      bars.push({
        code,
        d,
        o: +o.toFixed(3),
        h: +h.toFixed(3),
        l: +l.toFixed(3),
        c: +c.toFixed(3),
        volume: Math.floor(50_000 + rand() * 950_000),
      });
      px = c;
    }
    instruments.push({
      code,
      name: `ZZ Synthetic ${i + 1} Ltd`,
      listed_on: days[0],
      last_price: bars[bars.length - 1].c,
      last_price_d: last,
    });
  }
  // Fresh: finished a few minutes ago. Stale: finished more than 2x the interval ago.
  const ageHours = (job) => (scenario === "stale" ? JOB_INTERVAL_HOURS[job] * 2 + 3 : 0.25);
  const runs = Object.keys(JOB_INTERVAL_HOURS).map((job, i) => {
    const ended = new Date(Date.parse(nowIso) - ageHours(job) * 3_600_000);
    return {
      job,
      key: `${job}:${MARKET}:${ended.toISOString().slice(0, 13)}:e2e`,
      started_at: new Date(ended.getTime() - 60_000).toISOString(),
      ended_at: ended.toISOString(),
      items_processed: ZZ_COUNT * (i + 1),
    };
  });
  const markers = [{ d: last, at: runs[0].ended_at }];
  return { instruments, bars, markers, runs };
}

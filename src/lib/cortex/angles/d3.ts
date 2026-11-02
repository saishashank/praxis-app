// D3 Events and announcements: registry entries (M15 C1c; angles_D3.md; CTX-011, CTX-043, CTX-051).
// Every D3 angle reads the ASX announcement archive, which has no free history (CTX-051), so each
// carries `needsData` and resolves to `candidate` offline; the registry then never calls its compute.
// Where the file defines the value from the event facts the live feed already records (AGT-020
// polarity, day-0 AR and volume ratio, director and holder notices) a pure compute is kept so the
// forward-measured passport (staging, CTX-051) and the live app share one implementation (D-278).
// Every compute reads only `view.events(code, t)`: rows whose announcement was published by the
// cut-off, with day 0 <= sessions[t]. D-329 (D-315 for event angles): no event inside the window is
// a known 0, not a gap; undefined is kept for an event whose day-0 fact (AR, volume ratio) is missing.
import type { EventRow } from "../pit/types";
import type { AngleDef, AsOfView } from "./types";

export const ANNOUNCEMENT_ARCHIVE = "announcement archive (CTX-051)";

/** Largest i <= t with sessions[i] <= d; -1 when d is before the first session. */
export function sessionIndexAtOrBefore(sessions: readonly string[], t: number, d: string): number {
  let lo = 0;
  let hi = t + 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid]! <= d) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Sessions from day 0 of `e` to sessions[t] (0 = day 0 is tonight); day 0 is always a session. */
export function eventAge(view: AsOfView, t: number, e: EventRow): number {
  return t - sessionIndexAtOrBefore(view.sessions, t, e.day0);
}

/**
 * Events with day 0 inside the last `window` sessions (age 0..window-1), newest first; ties on day 0
 * break on the row id so the order is the same bytes every night.
 */
export function eventsWithin(
  view: AsOfView,
  code: string,
  t: number,
  window: number,
): readonly (EventRow & { readonly age: number })[] {
  return view
    .events(code, t)
    .map((e) => ({ ...e, age: eventAge(view, t, e) }))
    .filter((e) => e.age < window)
    .sort((a, b) => a.age - b.age || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function rationalToFloat(r: { readonly num: bigint; readonly den: bigint }): number {
  return Number(r.num) / Number(r.den); // money-float-ok: a statistic, never money
}

export function clip1(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

function latest(
  view: AsOfView,
  code: string,
  t: number,
  window: number,
): (EventRow & { readonly age: number }) | undefined {
  return eventsWithin(view, code, t, window)[0];
}

const DIRECTOR_BUY = 0.5;
const DIRECTOR_SELL = -0.25; // P-08-3: sales look like loss avoidance, half the old weight
const HOLDER_STEP = 0.25;

export const D3_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D3-01",
    version: 1,
    domain: 3,
    title: "Announcement category and polarity (refines AGT-020)",
    definition:
      "Polarity in {-1, 0, +1} of the latest announcement with day 0 inside event_window sessions, from the AGT-020 category table under the CTX-043 same-sign day-0 AR rule (keyword without the price reaction = 0 and `claimed`); placements and rights at a discount >= d are -1 on day 0; no event in the window = 0.",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement", "bar_au", "index_au"],
    grid: { discount_pct: [10, 5, 15, 20, 25], event_window: [20] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "forward-only from the M8.1 staging deploy (CTX-051); untimed backfill rows count as occurrences only",
      "the discount rule needs the raising text (DAT-122): not in the event fact, so the compute keeps the AGT-020 polarity of the row",
    ],
    existing: ["AGT-020", "CTX-043", "CTX-044", "src/lib/agents/events.ts"],
    compute: (view, code, t, grid) => {
      const e = latest(view, code, t, grid.event_window!);
      return e === undefined ? 0 : e.polarity;
    },
  },
  {
    id: "A-D3-02",
    version: 1,
    domain: 3,
    title: "Price-sensitive flag as materiality weight",
    definition:
      "Weight 1 when the latest announcement inside event_window sessions carries the ASX price-sensitive flag, else w_lo; applied to the event magnitude only, no sign; no event in the window = 0; a missing flag is unknown, never 0.",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement"],
    grid: { w_lo: [0.25, 0, 0.5], event_window: [20] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: ["the flag is used as first seen (no reclassification after publication)"],
    existing: ["AGT-011", "AGT-020"],
    compute: (view, code, t, grid) => {
      const e = latest(view, code, t, grid.event_window!);
      return e === undefined ? 0 : e.priceSensitive ? 1 : grid.w_lo!;
    },
  },
  {
    id: "A-D3-03",
    version: 1,
    domain: 3,
    title: "Day-0 abnormal return as a price-based surprise (refines AGT-020 AR)",
    definition:
      "clip(AR0 / theta, -1, 1) of the latest announcement inside event_window sessions, AR0 = the day-0 close-to-close return minus the benchmark return (ARN-020 day 0); no event in the window = 0; undefined when the event's day 0 has no bar.",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 1,
    inputs: ["announcement", "bar_au", "index_au"],
    grid: { theta: [0.04, 0.03, 0.05, 0.06], event_window: [20] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "untimed rows: day 0 = announcement date + 1 session (CTX-010); they never calibrate entries (CTX-051)",
      "no ASX post-earnings-drift study in the folder (N6): every drift window is uncalibrated",
    ],
    existing: ["AGT-020", "ARN-020", "src/lib/agents/events.ts"],
    compute: (view, code, t, grid) => {
      const e = latest(view, code, t, grid.event_window!);
      if (e === undefined) return 0;
      if (e.ar === null) return undefined;
      return clip1(rationalToFloat(e.ar) / grid.theta!);
    },
  },
  {
    id: "A-D3-04",
    version: 1,
    domain: 3,
    title: "Day-0 volume shock",
    definition:
      "sign(AR0) x min(VR0, cap) / cap of the latest announcement inside event_window sessions, VR0 = day-0 volume over the mean of the prior 20 sessions (AGT-030); no event in the window = 0; undefined when the event's day 0 has no bar.",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 21,
    inputs: ["announcement", "bar_au", "index_au"],
    grid: { cap: [3, 2, 4, 5], event_window: [20] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "iter_10 rejected a volume-confirmation prior (C-01): a challenger, never a prior",
    ],
    existing: ["AGT-030", "CTX-043"],
    compute: (view, code, t, grid) => {
      const e = latest(view, code, t, grid.event_window!);
      if (e === undefined) return 0;
      if (e.ar === null || e.volRatio === null) return undefined;
      const ar = rationalToFloat(e.ar);
      const sign = ar > 0 ? 1 : ar < 0 ? -1 : 0;
      const shock = Math.min(rationalToFloat(e.volRatio), grid.cap!) / grid.cap!;
      const v = sign * shock;
      return v === 0 ? 0 : v;
    },
  },
  {
    id: "A-D3-05",
    version: 1,
    domain: 3,
    title: "Drift versus reversal expectation by category",
    definition:
      "Prior table (not fitted) of expected direction and holding window per category: results and guidance up drift 20 sessions, guidance down negative drift, contract win positive drift, takeover capped at the offer, exchange query reverses, placements drop then recover; each cell is a charged trial and the table only sets the expected sign.",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement", "bar_au", "index_au"],
    grid: { window: [20, 40, 60] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: ["prior strength is calibrated on replay of the forward archive only"],
    existing: ["AGT-020", "CTX-016", "P-06-4"],
  },
  {
    id: "A-D3-06",
    version: 1,
    domain: 3,
    title: "Announcement clustering and frequency",
    definition:
      "n20 = distinct events (one per group key) with day 0 inside window sessions; a cluster when n20 >= 3 with at least two categories; a multiplier on the event magnitude, not a sign.",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement", "sector_map"],
    grid: { window: [20], cluster_min: [3] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: ["the sector cluster share needs the point-in-time sector map (D-271)"],
    existing: ["P-08-4"],
    compute: (view, code, t, grid) => {
      const rows = eventsWithin(view, code, t, grid.window!);
      return new Set(rows.map((e) => e.groupKey)).size;
    },
  },
  {
    id: "A-D3-07",
    version: 1,
    domain: 3,
    title: "Release timing: after close versus intraday",
    definition:
      "Bucket pre-open / intraday / after-close / untimed from published_at against the session hours; after-close moves the reaction session to the next one (AR(+1)); untimed backfill rows are excluded from timing calibration.",
    kind: "score",
    cluster: "event",
    orientation: 1,
    horizonSessions: 1,
    warmupSessions: 0,
    inputs: ["announcement", "calendar"],
    grid: {},
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: ["most backfilled rows carry assumed times (DAT-001, DAT-125): untimed bucket"],
    existing: ["ARN-020", "DAT-001", "OI-46"],
  },
  {
    id: "A-D3-08",
    version: 1,
    domain: 3,
    title: "LLM-grounded tone score (validated text feature)",
    definition:
      "Enumerated tone {negative, neutral, positive} with a cited span (CTX-040) mapped to {-1, 0, +1} only once the CTX-040 entry conditions hold (|AR0| >= 2 % sector-adjusted, paraphrase test, golden set >= 500 items); shadow-only until then; an unlabelled announcement is undefined, never neutral.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement"],
    grid: {},
    needsData: "announcement archive (CTX-051) and the Owner-labelled golden set (CTX-040)",
    historyFields: ["every prompt variant is a charged trial (CTX-031)"],
    existing: ["CTX-040", "AGT-011a", "LLM-072", "src/lib/llm/textLabels.ts"],
  },
  {
    id: "A-D3-09",
    version: 1,
    domain: 3,
    title: "Director and substantial-holder flow (refines AGT-105)",
    definition:
      "Sum over notices with day 0 inside window sessions of +0.5 per director purchase, -0.25 per director sale (P-08-3), +0.25 / -0.25 per substantial-holder increase / decrease, clipped to [-1, 1] (no notice in the window = 0); publication time only; a PDF backlog over two days is unknown, not 0.",
    kind: "score",
    cluster: "sentiment",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: 0,
    inputs: ["announcement"],
    grid: { window: [30], sale_weight: [-0.25, -0.5] },
    needsData: ANNOUNCEMENT_ARCHIVE,
    historyFields: [
      "the late-notice flag (> 5 business days after the trade) needs the trade date from the PDF (DAT-122)",
    ],
    existing: ["AGT-105", "P-08-3"],
    compute: (view, code, t, grid) => {
      const rows = eventsWithin(view, code, t, grid.window!).filter(
        (e) => e.category === "director_trade" || e.category === "substantial_holder",
      );
      if (rows.length === 0) return 0;
      let s = 0;
      for (const e of rows) {
        if (e.polarity === 0) continue;
        if (e.category === "director_trade")
          s += e.polarity > 0 ? DIRECTOR_BUY : (grid.sale_weight ?? DIRECTOR_SELL);
        else s += e.polarity > 0 ? HOLDER_STEP : -HOLDER_STEP;
      }
      const v = clip1(s);
      return v === 0 ? 0 : v;
    },
  },
  {
    id: "A-D3-10",
    version: 1,
    domain: 3,
    title: "Scheduled events as timing risk (results, ex-dividend, index review)",
    definition:
      "Sessions to the next scheduled event of the code (prior-year same-quarter results +-5 sessions, announced ex-dividend date, index review) bucketed {0-5, 6-20, > 20, unknown}; a gate flag when one lies inside horizon H, never a score.",
    kind: "gate",
    cluster: "calendar",
    orientation: 1,
    horizonSessions: 0,
    warmupSessions: 0,
    inputs: ["announcement", "corp_action", "index_change", "calendar"],
    grid: { horizon: [20] },
    needsData: "announcement archive (CTX-051) and a forward results-date calendar (DAT-125)",
    historyFields: ["prior-year results dates need the Appendix 4C/4D/4E history: forward-only"],
    existing: ["CTX-013 step 8", "CTX-024", "DAT-220", "G08_event_state"],
  },
];

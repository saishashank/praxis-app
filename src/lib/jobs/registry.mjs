// The ONE registry of scheduled jobs that the Owner can also start by hand ("Run now"; D-840..D-849).
// Plain ESM + JSDoc with a .d.mts twin so the Next app (Ops page, Owner action), the Cloudflare Worker
// (worker/src/runNow.ts, relative import) and the tests all use the same file. No imports, no clock,
// no database.
//
// HOW IT IS USED
//  - The Worker slot table (worker/src/schedule.ts) stays the source of WHEN and HOW a slot runs. This
//    registry is checked against it by tests/jobs/registry.test.ts: every slot id is here, every
//    dispatchable workflow belongs to a job here, and kind, time, route, workflow, trading-day rule and
//    listing rule agree. A scheduled slot or workflow added without an entry here fails that test.
//  - src/lib/golive/slots.ts derives GO_LIVE_SLOTS (the Owner list of which jobs may run) from here.
//  - The Ops page lists the runnable jobs from here; the Owner action `requestRunNow` accepts only an
//    id that is `runNow: true` here; the Worker runs a request only for such an id.
//  - Adding a job later: one entry here plus its normal Worker slot (docs/runbooks/run-now.md).
//
// FIELDS
//  id          the Worker slot id (the unit the clock, the listing and the audit log already use)
//  label       plain-words name shown to the Owner
//  kind        "workflow" (GitHub workflow dispatch) | "route" (signed POST to an app route) |
//              "worker-internal" (runs inside the Worker; never started by hand)
//  schedule    plain-words schedule, Melbourne time
//  time        first start of the day, "HH:MM" (Melbourne; same clock as the Worker table)
//  days        "daily" | "trading" (trading days only) | "first-saturday"
//  safety      "always-on"  runs whatever the Owner list says (backup, maintenance, ingest, ASX fetch)
//              "go-live"    runs by hand only when the Owner has listed it (same rule as the schedule)
//              "internal"   never started by hand
//  dateBackDays  0 = takes no date; N = the Owner may pick a day from N days ago up to today
//  maxPerHour  at most this many manual requests for the job in one hour (default 6; D-851)
//  note        optional plain-words warning shown in the confirm sheet (cost, or what a repeat does)
//  runNow      the Owner may start it by hand
//  workflow / route   the file or app path the Worker table uses for this job (checked by tests)
//  ownerOnly   always true: only the Owner can request a run

/** @typedef {"workflow" | "route" | "worker-internal"} JobKind */
/** @typedef {"always-on" | "go-live" | "internal"} JobSafety */
/** @typedef {"daily" | "trading" | "first-saturday"} JobDays */
/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} label
 * @property {JobKind} kind
 * @property {string} schedule
 * @property {string} time
 * @property {JobDays} days
 * @property {JobSafety} safety
 * @property {number} dateBackDays
 * @property {number} maxPerHour
 * @property {string} [note]
 * @property {boolean} runNow
 * @property {true} ownerOnly
 * @property {string} [workflow]
 * @property {string} [route]
 */

/** The default per-job hourly cap of manual requests (D-843, D-851). */
export const DEFAULT_MAX_PER_HOUR = 6;

/**
 * @param {Omit<Job, "ownerOnly" | "runNow" | "dateBackDays" | "maxPerHour"> & {dateBackDays?: number, maxPerHour?: number, runNow?: boolean}} j
 * @returns {Job}
 */
const job = (j) => ({
  dateBackDays: 0,
  maxPerHour: DEFAULT_MAX_PER_HOUR,
  runNow: j.safety !== "internal",
  ...j,
  ownerOnly: true,
});

/**
 * Go-live jobs come first, in the order of the Owner list (time of day from 07:00, after-midnight
 * last); then the jobs that always run; then the jobs that run inside the Worker.
 * @type {readonly Job[]}
 */
export const JOBS = [
  job({
    id: "alert-flush",
    label: "Alert flush (urgent batch and missing alerts)",
    kind: "route",
    route: "/api/internal/alert-flush",
    schedule: "Trading days, every 2 minutes from 07:01 to 20:59 (only when an alert is due)",
    time: "07:01",
    days: "trading",
    safety: "go-live",
  }),
  job({
    id: "morning",
    label: "Morning email",
    kind: "route",
    route: "/api/internal/morning",
    schedule: "Every day at 08:00",
    time: "08:00",
    days: "daily",
    safety: "go-live",
  }),
  job({
    id: "pre-open",
    label: "Pre-open re-check, attempt 1",
    kind: "route",
    route: "/api/internal/preopen",
    schedule: "Trading days at 09:54",
    time: "09:54",
    days: "trading",
    safety: "go-live",
  }),
  job({
    id: "pre-open-retry",
    label: "Pre-open re-check, attempt 2",
    kind: "route",
    route: "/api/internal/preopen",
    schedule: "Trading days at 09:58, only after attempt 1 failed",
    time: "09:58",
    days: "trading",
    safety: "go-live",
  }),
  job({
    id: "llm-bakeoff",
    label: "Monthly model bake-off (first Saturday)",
    kind: "workflow",
    workflow: "llm-bakeoff.yml",
    schedule: "First Saturday of the month at 10:00",
    time: "10:00",
    days: "first-saturday",
    safety: "go-live",
    maxPerHour: 1,
    note: "Each run spends model budget. The job has no check of its own for a repeat.",
  }),
  job({
    id: "quote-poll",
    label: "Pick alerts: delayed quotes every 5 minutes to 16:00",
    kind: "route",
    route: "/api/internal/pick-alerts",
    schedule: "Trading days, every 5 minutes from 10:00 to 16:00",
    time: "10:00",
    days: "trading",
    safety: "go-live",
  }),
  job({
    id: "intraday-scan",
    label: "Intraday watch scan every 30 minutes to 15:32",
    kind: "route",
    route: "/api/internal/intraday-scan",
    schedule: "Trading days, every 30 minutes from 10:32 to 15:32",
    time: "10:32",
    days: "trading",
    safety: "go-live",
  }),
  job({
    id: "arena-close",
    label: "Arena close",
    kind: "workflow",
    workflow: "arena-close.yml",
    schedule: "Trading days at 17:50",
    time: "17:50",
    days: "trading",
    safety: "go-live",
    note: "A day that is already closed is skipped by the job itself.",
  }),
  job({
    id: "arena-signals",
    label: "Arena signals",
    kind: "workflow",
    workflow: "arena-signals.yml",
    schedule: "Trading days at 18:10",
    time: "18:10",
    days: "trading",
    safety: "go-live",
    note: "A day that already has its signals is skipped by the job itself.",
  }),
  job({
    id: "evening-review",
    label: "Evening review",
    kind: "route",
    route: "/api/internal/evening-review",
    schedule: "Every day at 20:00",
    time: "20:00",
    days: "daily",
    safety: "go-live",
    dateBackDays: 1,
  }),
  job({
    id: "watchdog-2040",
    label: "Watchdog check, 20:40",
    kind: "workflow",
    workflow: "watchdog.yml",
    schedule: "Every day at 20:40",
    time: "20:40",
    days: "daily",
    safety: "go-live",
  }),
  job({
    id: "evening-review-late",
    label: "Evening review, late run",
    kind: "route",
    route: "/api/internal/evening-review",
    schedule: "Every day at 21:00",
    time: "21:00",
    days: "daily",
    safety: "go-live",
    dateBackDays: 1,
  }),
  job({
    id: "watchdog-2150",
    label: "Watchdog check, 21:50",
    kind: "workflow",
    workflow: "watchdog.yml",
    schedule: "Every day at 21:50",
    time: "21:50",
    days: "daily",
    safety: "go-live",
  }),
  job({
    id: "kb-archive",
    label: "Knowledge-base archive",
    kind: "workflow",
    workflow: "kb-archive.yml",
    schedule: "Every day at 22:15",
    time: "22:15",
    days: "daily",
    safety: "go-live",
  }),
  job({
    id: "backfill-history",
    label: "History backfill",
    kind: "workflow",
    workflow: "backfill-history.yml",
    schedule: "Every day at 23:30",
    time: "23:30",
    days: "daily",
    safety: "go-live",
  }),
  job({
    id: "backfill-prices",
    label: "Price backfill",
    kind: "workflow",
    workflow: "backfill-prices.yml",
    schedule: "Every day at 23:45",
    time: "23:45",
    days: "daily",
    safety: "go-live",
  }),
  job({
    id: "replay",
    label: "Replay",
    kind: "workflow",
    workflow: "replay.yml",
    schedule: "Every day at 00:15",
    time: "00:15",
    days: "daily",
    safety: "go-live",
  }),
  // ---- jobs that run whatever the Owner list says -----------------------------------------------
  job({
    id: "asx-fetch",
    label: "ASX fetch (announcements and listed companies)",
    kind: "workflow",
    workflow: "asx-fetch.yml",
    schedule: "Trading days at 08:00",
    time: "08:00",
    days: "trading",
    safety: "always-on",
  }),
  job({
    id: "ingest-batch1",
    label: "Nightly data ingest (batch 1)",
    kind: "workflow",
    workflow: "ingest-batch1.yml",
    schedule: "Every day at 17:30",
    time: "17:30",
    days: "daily",
    safety: "always-on",
  }),
  job({
    id: "decision-cutoff",
    label: "Decision cut-off ASX fetch",
    kind: "workflow",
    workflow: "asx-fetch.yml",
    schedule: "Trading days at 18:10",
    time: "18:10",
    days: "trading",
    safety: "always-on",
  }),
  job({
    id: "maintenance",
    label: "Nightly maintenance",
    kind: "workflow",
    workflow: "maintenance.yml",
    schedule: "Every day at 22:30",
    time: "22:30",
    days: "daily",
    safety: "always-on",
  }),
  job({
    id: "backup",
    label: "Nightly backup",
    kind: "workflow",
    workflow: "backup.yml",
    schedule: "Every day at 23:00",
    time: "23:00",
    days: "daily",
    safety: "always-on",
  }),
  // ---- jobs that run inside the Worker (never started by hand) ----------------------------------
  job({
    id: "asx-poll",
    label: "ASX announcement poll",
    kind: "worker-internal",
    schedule: "Trading days, every 4 minutes from 07:00 to 19:30",
    time: "07:00",
    days: "trading",
    safety: "internal",
  }),
  job({
    id: "universe",
    label: "Listed companies import",
    kind: "worker-internal",
    schedule: "Trading days at 07:30",
    time: "07:30",
    days: "trading",
    safety: "internal",
  }),
  job({
    id: "late-sweep",
    label: "Late sweep",
    kind: "worker-internal",
    schedule: "Trading days at 19:35",
    time: "19:35",
    days: "trading",
    safety: "internal",
  }),
  job({
    id: "marker-check",
    label: "Completion marker check",
    kind: "worker-internal",
    schedule: "Trading days at 19:50",
    time: "19:50",
    days: "trading",
    safety: "internal",
  }),
];

/** Runnable jobs only (the Ops page and the Owner action). */
export const RUNNABLE_JOBS = JOBS.filter((j) => j.runNow);

/** @param {unknown} id @returns {Job | undefined} */
export function findJob(id) {
  return typeof id === "string" ? JOBS.find((j) => j.id === id) : undefined;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @param {unknown} s */
function realDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.toISOString().slice(0, 10) === s;
}

/** @param {string} d @param {number} n */
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * Per-job parameter schema, the ONE definition shared by the Owner action and the Worker.
 * A job without a date takes no parameters at all (an unknown key is refused, not ignored). A job
 * with `dateBackDays` N takes an optional `d` (YYYY-MM-DD) from N days ago up to today; none means
 * today. Returns the canonical params (what is stored) or null.
 * @param {Job} j
 * @param {unknown} raw  a plain object, or undefined/null for "no parameters"
 * @param {string} today  the Melbourne date, YYYY-MM-DD
 * @returns {{ d?: string } | null}
 */
export function validateParams(j, raw, today) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = /** @type {Record<string, unknown>} */ (raw);
  if (Object.keys(rec).some((k) => k !== "d")) return null;
  const d = rec.d;
  if (d === undefined || d === null || d === "") return j.dateBackDays > 0 ? { d: today } : {};
  if (j.dateBackDays === 0) return null;
  if (!realDate(d) || !realDate(today)) return null;
  const ds = /** @type {string} */ (d);
  if (ds > today || ds < addDays(today, -j.dateBackDays)) return null;
  return { d: ds };
}

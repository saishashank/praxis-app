# Run now: start a scheduled job by hand

D-840 to D-849. The Owner can start any scheduled job at once from the Ops page ("Run a job now"). The normal schedule does not change. This page is for the builder and the Owner.

## What the Owner sees

Ops page, section "Run a job now". Each job shows its name, its schedule (Melbourne time), the last scheduled start the Worker recorded, and the result of the last manual request. "Run now" opens a sheet; jobs that take a date (Evening review, Evening review late run) show a date picker (today, or yesterday). "Confirm run now" writes a request. The Worker picks it up within a minute and the page shows the outcome after a reload.

## How it works

1. `requestRunNowAction` (Owner only) calls `requestRunNow` (`src/lib/jobs/runNow.ts`): Owner check, job id and parameters checked against the registry, confirm, one audit event first, then one row in `run_now_request` (status `pending`). At most one waiting request per job; at most 6 per job and 30 in all per hour.
2. The Worker (`worker/src/runNow.ts`, called from the per-minute tick) expires requests older than 30 minutes, reads up to 3 pending requests, claims each (`pending` to `dispatched`, a conditional write, so a request runs once), and runs it through the same function the schedule uses: `dispatchWorkflow` for workflow jobs, `postSigned` for route jobs. It then records `done` or `refused` with a short result.
3. Result words: `started: HTTP 204` (workflow accepted), `ran: HTTP 200` (route answered), `failed: <reason>` (status `done`), `refused: <reason>`, `expired: ...`.

## Safety gates a manual run keeps

Only the time window is bypassed. Everything else still applies, and a "no" is recorded as `refused: <reason>`:

| Gate | Refusal |
| --- | --- |
| Job must be `runNow` in the registry and an enabled slot in the Worker table | `unknown job`, `not available` |
| Dispatch kill switch `dispatch_enabled` | `dispatch is off` |
| Owner list `slots_enabled` for go-live jobs (no list, not listed, or unreadable list) | `not listed` |
| Market mode (market-bound jobs) | `market is off` |
| Trading day for the date it runs for (a weekday with no calendar row is not a trading day) | `not a trading day` |
| Alert flush only when an alert is due; pre-open attempt 2 only if attempt 1 did not work | `nothing is due`, `attempt 1 already worked` |
| Workflow inputs a job needs (monthly bake-off candidates) | `inputs missing` |
| The job's own guards and idempotency (workflow concurrency key, close-books previous-session guard, evening review one-per-day) | the job itself does nothing the second time |

A manual run never writes the schedule's own `slot:<id>:<date>` state, so it does not stop the scheduled run and the scheduled run does not stop it.

Workflows take no date input: they work out "today" themselves. Only route jobs with `dateBackDays` in the registry take a date.

## Stuck or missing

- Request stays `pending`: the Worker is not ticking, or `dispatch_enabled` is not set up (check System Health). After 30 minutes it becomes `expired`.
- Request shows `dispatched` for 30 minutes: the Worker crashed after claiming. It becomes `expired: no result was recorded` and is NOT run again; request again.
- Read the audit log for `jobs.run_now_requested` (and `_failed`) to see who asked and when.

## How to add a job (V3, V4 and later)

1. Add the normal Worker slot in `worker/src/schedule.ts` (and its workflow to `DISPATCHABLE_WORKFLOWS`, or its signed route under `src/app/api/internal/`).
2. Add ONE entry to `JOBS` in `src/lib/jobs/registry.mjs`: `id` (the slot id), `label` (plain words), `kind`, `schedule` text (Melbourne time), `time`, `days`, `safety` (`go-live` if the slot has `requiresListing`, `always-on` if it runs whatever the list says, `internal` if the Worker runs it itself), `dateBackDays` (0 unless the route takes a date), and the `workflow` or `route`. Put go-live jobs in time-of-day order among the go-live jobs. The Owner list (`GO_LIVE_SLOTS`) and the Ops page follow from the registry.
3. Run `npx vitest run tests/jobs/registry.test.ts`. It fails when a slot or dispatchable workflow has no entry, or when kind, time, route, workflow, trading-day, monthly or listing rule disagree with the Worker table, or when a workflow or route file is missing.
4. A job with new parameters: extend `validateParams` in the registry (one schema, used by the Owner action and the Worker) and add cases to `tests/jobs/registry.test.ts`. The request table stores parameters as JSON (`params_json`), so no migration is needed.
5. Run `node scripts/architecture/generate.mjs` and add a decision to `docs/M13L_design.md` if the job changes what a manual run may do.

Nothing else needs to change: the action, the table, the Worker runner and the page work for any registry job.

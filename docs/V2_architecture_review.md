# V2 architecture review (V1 core and V2 delta)

End-to-end architecture review by Fable, requested by the Owner on 2026-11-01 ("review both R1 and R2 completely to find any improvements or architectural issues"), run on local `build` after every V2 milestone was built (HEAD bf4942b). Two read-only passes: Part 1 the V1 core and platform, Part 2 the V2 delta and its integration with V1.

| Part | Blocking | Should-fix | Improvement |
|---|---|---|---|
| 1 V1 core | 1 (V1-B1) | 15 | 15 |
| 2 V2 delta | 2 (V2-B1, V2-B2) | 9 | 11 |

Blocking items are fixed on `build` before the V2 PR (fix commits and decisions D-661 onward are listed in the PR description). Should-fix and Improvement items are listed in the PR for the Owner to schedule; none blocks go-live on its own.

---

# Part 1: V1 core and platform

Reviewer: Fable (architect). Scope: the V1 core and platform end to end — money path, data integrity, security, reliability/ops, architecture/maintainability — as it stands on local `build`. Read-only; no code changed. Sources: spec v1 (ch. 02, 04, 05, 06, 10, 11), AGENT_PLAN §4, `docs/architecture/architecture.json` + `spec_map.yaml`, `docs/M*_design.md` / exit evidence, `docs/07_decision_log.md`, and the code under `src/lib/**`, `worker/src`, `db/migrations`, `scripts/**`, `.github/workflows`. All paths below are relative to `D:\Projects\Praxis\praxis-app\` unless stated.

## Summary

The money path is in good shape: integer micro-AUD everywhere, one rounding per quantity on exact rationals, a double-entry ledger whose transactions net to zero by construction, positions derived from fills, NAV recomputed and reconciled nightly, append-only engine tables with trigger guards, and byte-identical replay serialisation. Security is fail-closed throughout (gate, HMAC + nonce, masking, audit chain). The migration runner, backup dump and restore, point-in-time (`known_at` / `first_ingested_at`) guards and the Worker's claim-before-dispatch pattern are solid.

The one Blocking item is a *chain*, not a single bug: the nightly close-the-books job has no "previous session closed" guard, and the Worker never re-dispatches a GitHub workflow that was accepted but then failed. One lost night therefore makes the next night fill the previous session's orders a day late at the wrong open and skip a session of intraday stops — wrong money, silent until the Owner notices. The guard is a small change; the re-dispatch is medium.

The Should-fix list is dominated by three themes: (a) things that are *by design* fail-safe but have no recovery path (frozen cohorts, pending emails, P0 retry), (b) time bombs (calendar ends 2027-12-31 and a missing row is treated as a trading day), and (c) spec items marked [VERIFY] that went live with `verified = false` and nothing gating them. Improvements are ranked by value for a one-person operator: fewer, better-aggregated alerts; one health table; small hygiene items.

Counts: **Blocking 1 · Should-fix 15 · Improvement 15** (31 findings).

---

## Blocking

### V1-B1 — A lost nightly close is not detected by the next night: orders fill one session late at the wrong price and a session of stops is skipped
**Evidence**
- `src/lib/arena/closeBooks.ts:1361-1380` — `closeBooksDay` preconditions are: `hasSuccess(arena-2a:<market>:<d>)`, market mode, trading day, completion marker for `d`. There is **no** check that the previous trading session's `arena-2a` key has a `success` (or `skipped`) run record (grep `hasSuccess|priorD` in the file: only the same-day key, line 1366).
- `closeBooks.ts:601-611` — `fillPending` selects `arena_order … status='pending' AND decided_d < ?` and fills them against `ctx.data.bar(code, ctx.d)` (line 621), i.e. *today's* bar, whatever the decided date. `isStops` (line 819-845) evaluates only `ctx.d`'s bar.
- `worker/src/clock.ts:277-282` — the clock re-dispatches only when the slot state is `failed` (dispatch HTTP ≠ 204) or a stale `claimed`; `dispatched` is final for the day, and the clock reads only `worker_state`, never `run_record`. `worker/src/dispatch.ts:56` — 204 means "accepted", not "ran". `docs/M2_design.md:83` (PLT-076) states the opposite intent ("re-dispatches … when there is neither a success nor a running record").
- `.github/workflows/arena-close.yml:21` — `on: workflow_dispatch` only; no `schedule:` fallback (unlike `ingest-batch1.yml:24-26`).
- Detection: `src/lib/health/jobs.ts:67-120` marks arena jobs stale only after 2× interval; OPS-011 "critical job failing twice" never fires because the run record for the lost night does not exist at all.

**Failure scenario (concrete).** Night D: the Worker dispatches `arena-close.yml` at 17:50, GitHub accepts (204), the runner is lost / `npm ci` flakes / Turso 5xx mid-run → the job ends red, no `arena-2a:AU:D` success. Nothing retries. Night D+1: `closeBooksDay(D+1)` passes every precondition, `fillPending` fills the orders decided on D−1 at **D+1's open** (spec ARN-020: they must fill at D's open), `isStops` never sees D's low (a stop hit on D is missed; the position is carried a session longer), settlement dates are computed from the wrong `fill.d`, and `nav_daily` for D is never written (append-only, so a later manual run of D after D+1 cannot repair the series cleanly). The Owner's first signal is a "stale" tile a day or two later.

**Impact.** Wrong fills, wrong stops, broken NAV series for every active cohort of that market — exactly the ARN-02x/05x money maths AGENT_PLAN §4 calls high-risk. Probability is "one bad GitHub night", which over a year is not low.

**Fix.**
1. (S) In `closeBooksDay`, before `startRun`: if `previousTradingDay(d)` has neither a `success` nor a `skipped` `arena-2a` run record, **refuse** with `recordSkip(db, opts, "previous_session_not_closed")`, write a P1 incident, and let `batch2b` (which already waits on 2a, `src/lib/agents/batch2b.ts:1664`) skip too. Add the mirror rule to `batch2b` for its own previous key. One test per rule.
2. (M) Worker: in `decide()` for `dispatched` states inside the catch-up window, read the day's `run_record` for the slot's job and re-dispatch when there is neither `success` nor `running` and the last dispatch is older than N minutes (bounded by `MAX_ATTEMPTS`); the workflows' own `hasSuccess` guards make a duplicate a no-op. Alternatively add a `schedule:` + `scheduleGate.mjs` fallback to `arena-close.yml`/`arena-signals.yml` as `ingest-batch1.yml` has.
3. (S) Owner runbook line: "a missed `arena-2a` night is replayed by dispatching the workflow with the missed date *before* the next session's close; never after."

**Effort:** S (guard) + M (re-dispatch). The guard alone removes the wrong-money outcome and must land before the V2 PR; the re-dispatch can follow.

---

## Should-fix

### V1-S1 — A cohort with one fatal invariant verdict is frozen forever with no recovery path
**Evidence** `closeBooks.ts:1182-1232` `activityOf` → `frozen = COUNT(nav_daily WHERE invariants_ok = 0) > 0`; `closeCohortDay:1235` returns `{state:"frozen"}` and runs no phase. `nav_daily` is append-only (`db/migrations/main/0007_arena.sql` guards), so the verdict cannot be corrected. No `unfreeze` exists (grep across `src/lib/learning/arenaControl.ts`, `src/lib/arena/cohort*.ts`, `src/app`). The runbook (spec 11 §S1) says "pause affected market", not how to resume a cohort. Twin restart (ARN-053) is not triggered for a frozen cohort.
**Impact** One transient fatal (e.g. a bad vendor bar that trips `nav_equity_reconcile`) permanently removes an execution from the arena, its twin keeps running unpaired, and the run reports `degraded` every night. Fail-safe, but an outage of that execution until someone edits the DB by hand.
**Fix** Owner action "resume cohort" that writes a `cohort_event kind='invariants_cleared'` row (audited) which `activityOf` honours (`bad` counted only after the last clearing event); or allow a compensating `nav_daily` row (`reversal` kind) per D-069 decision 13. Record the ops step. **Effort** M.

### V1-S2 — Spec [VERIFY] figures went live with `verified = false` and nothing gates them
**Evidence** `src/lib/arena/costs.ts:5-6, 86` (every profile `verified:false`, comment "the Arena stays data_only until then"); `src/lib/money/tick.ts:17` `TICK_TABLE_VERIFIED = false`; `src/lib/arena/slippage.ts:34` `SLIPPAGE_BUCKETS_VERIFIED = false`; `src/lib/arena/sizing.ts:28` min parcel "Not Owner-approved yet". No reader of these flags outside the modules and tests (grep). The go-live checklist `src/lib/golive/checklist.ts` has no item for ARN-031/032/024 approval; `worker/src/schedule.ts:261-263` still describes the slot as "OFF until the Owner approves the [VERIFY] items".
**Impact** Live P/L, leaderboards and VAL-110 results rest on unverified brokerage, tick, slippage and parcel constants; the code's own stated safeguard (data-only until approved) is not enforced.
**Fix** Either record the Owner's approval as D-nnn and flip the flags (new `cost_profile` rows at version 2 per D-070), or add a go-live checklist item "cost/tick/slippage/parcel figures approved" that `signoff.ts` requires. **Effort** S.

### V1-S3 — Trading calendar ends 2027-12-31; a missing row is treated as a trading day; no draft job, no horizon alarm
**Evidence** `db/migrations/main/0005_au_calendar_seed.sql:2`, `0013_au_calendar_history.sql:2` (2019-01-01..2027-12-31). `src/lib/data/calendar.ts:168-170`, `worker/src/clock.ts:447`, `worker/src/routes.ts:276`, `src/lib/heartbeat/checks.ts:82`, `src/lib/data/pipeline/rules.mjs:85` — five copies of `tradingDay = !weekend && kind !== "holiday"`. `calendar.ts:164` `calendarCovers()` has no callers. No workflow drafts next year (DAT-160 requires it by 1 Nov); `src/lib/health/summary.ts:101-114` lists only years with rows. 2026 rows are `confirmed = 0`.
**Impact** From 2028-01-03 every public holiday is a session: batch 1 fetches nothing, close-books fills/marks on stale bars, phantom sessions in NAV and TTD. Also any accidental gap in the seed today behaves the same way.
**Fix** (a) heartbeat S2 when `MAX(d) < today + 60d`; (b) market-bound slots and `closeBooksDay` require a calendar row (any kind) for `d`, else skip `calendar_missing`; (c) a yearly job that inserts next year's unconfirmed rows. **Effort** M.

### V1-S4 — Audit hash chain is never verified (NFR-023 unimplemented)
**Evidence** `src/lib/db/audit.ts:105-125` `verifyAuditChain` has no non-test caller. Spec 10 NFR-023: "the nightly watchdog verifies the chain and alerts on a break". **Impact** Tamper evidence for Owner/user actions (ROL-104) exists but is never read. **Fix** Call it from heartbeat-evening or the watchdog; incident on a break; store the verified head in `health_snapshot`. **Effort** S.

### V1-S5 — Production-size restore is one unbounded write batch; drill never runs at production size; DAT-142 pruning not implemented
**Evidence** `scripts/backup/core.mjs:424-437` one `db.batch(stmts,"write")` with one INSERT per row for all tables; D-202 records that one read of `price_bar` (~490k rows) already failed and paging was added only on the dump side (`core.mjs:284-303`). `scripts/restore/README.md:112` admits the script "fails closed" on large DBs. `scripts/restore/synthetic.mjs` drill data is tiny; `restore-drill.yml` real-key mode is Owner-dispatched only. No `DELETE FROM price_bar` anywhere (DAT-142 "500 sessions in Turso").
**Impact** OPS-040 / NFR-004 RTO ≤ 4 h may be unachievable for the main DB. **Fix** Chunked restore inside `db.transaction("write")`; monthly real-key drill on the latest production dump; implement DAT-142 pruning (the `price_bar_prune_only` trigger at `0004_au_data.sql:129-133` already allows it). **Effort** M.

### V1-S6 — Foreign-key enforcement is undefined and the restore order would break if it were on
**Evidence** No `PRAGMA foreign_keys` anywhere (`src/lib/db/client.ts:11-21`). Auth schema declares FKs (`db/migrations/auth/0003..0006`); restore inserts tables in `sqlite_master ORDER BY name` (`core.mjs:235`), so `alert_user_state`/`annotation` precede `app_user`. Not covered by the drill (seeds only `app_user`). **Impact** Either decorative FKs (orphans possible) or a restore that fails on the first child row — unverified. **Fix** Decide (D-nnn) and either explicitly `OFF` or `ON` + parent-first order / `defer_foreign_keys`; add child rows to the drill fixture. **Effort** S/M.

### V1-S7 — Code reuse / relisting merges two companies into one price history
**Evidence** `src/lib/data/universe/apply.mjs:12-13` reactivates a delisted code by clearing `delisted_on`; `instrument` is `UNIQUE(market, code)` (`0004_au_data.sql:59-70`) and `price_bar`, `universe_snapshot`, `corporate_action` key on `(market, code)`. Lookback readers are code-keyed (`src/lib/arena/marketData.ts:92-116`, `src/lib/agents/candidates.ts:313-321`). ARN-082 requires code reuse to be detected and histories split.
**Impact** ADV, tiers, indicators and corporate-action lookups of a relisted code use the old entity's bars; DAT-130 "kept forever with reason" is lost. **Fix** New `instrument` row on reactivation after a gap; readers stop at `listed_on`; tighten `instrument_guard_update` so `delisted_on` cannot return to NULL. **Effort** M.

### V1-S8 — Morning route reports a `pending` brief/reminder as success; the single-shot slot never retries
**Evidence** `src/lib/email/send.ts:436-447` (after two retryable provider outcomes the row stays `claimed`/`pending`); `src/lib/email/brief.ts:131-137`, `reminder.ts:71-77` map `pending` → `failed`; `src/lib/health/morningRoute.ts:21-27` answers 200; `worker/src/routes.ts:182-184, 328-335` → state `dispatched`, single-shot. The `reserved_reminder` slot stays claimed all day (`caps.ts:40`). **Impact** Two transient Resend 5xx at 08:00 lose the day's brief and reminder. **Fix** Return 503 on `pending` so the Worker retries (max 3), or give `morning` an `everyMin` pattern like `evening-review`. **Effort** S.

### V1-S9 — A first-of-window P0 that ends `pending` is never retried
**Evidence** `src/lib/alerts/deliver.ts:416-419` (no window → in-request `sendSingleP0`); `deliver.ts:393` FINAL excludes `pending` and schedules no flush; `alert_flush_due` is written only by `scheduleFlush` (`deliver.ts:337-349`, `flush.ts:163-225`); `flush.ts:107-116` drops P0s older than 30 min. **Impact** The spec's "immediate" P0 (AGT-115/EML-020) is silently lost under brief Resend degradation. **Fix** On `pending`, `scheduleFlush(ctx, now + RETRY_DUE_MS)`; in `sentinel-ingest/route.ts:36-41` catch, prime `alert_flush_due = now`. **Effort** S.

### V1-S10 — Email double-send after a crash between provider acceptance and the `sent` write relies solely on Resend's Idempotency-Key
**Evidence** `src/lib/email/send.ts:410-423` (send → `logAttempt accepted` → `UPDATE sent`); `send.ts:221-239` `reclaim()` takes over stale `claimed` rows and re-sends without consulting `email_attempt`; `src/lib/email/resend.ts:6-7` "[VERIFY at build] Resend honours Idempotency-Key for 24 h" never closed. **Fix** In `reclaim()`, if an `accepted` attempt exists for the key, finalise as `sent` and return `duplicate`. Record the Resend behaviour as a decision. **Effort** S.

### V1-S11 — Turso quota meters only see self-reported job rows; the Worker's traffic and the nonce store are invisible; nonce store runs DDL per call
**Evidence** `src/lib/usage/meters.ts:137-183` sums `run_record.rows_*`; `worker/src/clock.ts`/`routes.ts`/`asx/slots.ts` reads and `src/lib/security/replay.ts:24-44` (`CREATE TABLE IF NOT EXISTS` + `DELETE` + `INSERT` on **every** signed call; TODO at line 13 says the table should move to a migration) are not metered; `src/lib/incidents/detectors.ts:57-89` `quota_high`/`degrade_mode` depend on the meters. **Impact** PLT-051 90/95 % alerts cannot fire for the dominant read traffic; quota exhaustion surfaces as hard `DbError`s. **Fix** Pull Turso platform usage daily into a `usage_snapshot`; move `request_nonce` into migration 0023 and drop the per-call DDL. **Effort** M.

### V1-S12 — SEC-014 export and read rate limits are configured but never enforced
**Evidence** Spec 10 l.77 (exports ≤ 5/h, reads ≤ 60/min per user). `src/lib/http/limits.ts:21-35` and `src/lib/config/keys.ts:1666-1671` carry `exports_per_hour_user`; the only `rateLimit()` callers are `gate.ts:131` (sign-in/IP) and `gate.ts:175` (writes/user). GET routes (`src/app/api/market/search`, `market/[code]/overview:15`, `news/[id]:14`, `blueprint/export:15`) have no bucket. **Fix** `read:<uid>` 60/min bucket for authenticated GET `/api/*` and `export:<uid>` for `Content-Disposition` routes in `gate.ts`. **Effort** S–M.

### V1-S13 — Two signed internal routes are missing from the proxy's machine-route list; nothing ties the list to the filesystem
**Evidence** `src/lib/http/gate.ts:34-50` lists 11 `/api/internal/*` + 3 cron paths; `src/app/api/internal/intraday-scan/route.ts` and `pick-alerts/route.ts` are HMAC handlers absent from it; `gate.ts:118-120, 143-152` therefore refuse the Worker (no Origin, no cookie). `tests/http/gate.test.ts:109-119` hard-codes the same 11. **Impact** Fails closed (the two V2 routes cannot be reached), but the inverse drift — a session route added to `MACHINE_ROUTES` — would silently drop CSRF+auth with no failing test. **Fix** Add both routes; add a test that walks `src/app/api/internal|cron` and asserts each is in `MACHINE_ROUTES` and imports a signed handler (and every other `/api` route does not). **Effort** S.

### V1-S14 — SEC-016 deterministic display-text check could not be located
**Evidence** Spec 10 l.79 requires every LLM text and third-party headline to pass a no-model display-text check (URLs, domains, e-mail addresses). Found: safe links (`src/lib/http/safeLink.ts`), HTML escaping (`email/templates/core.ts:67-74`), React escaping, prompt-side filters (`llm/injection.ts`, `datamark.ts`), enum-only LLM outputs (`llm/textLabels.ts`). Nothing strips/neutralises a domain or address *inside* headline text before display or email. **Impact** A crafted ASX headline ("Visit praxis-login.example to re-verify") is shown verbatim — the phishing-by-text SEC-016 targets. **Fix** One pure `displayText(s)` in `src/lib/view` applied in news/cards/alerts loaders and email templates, with the SEC-016 examples as tests; or record where the existing check lives. **Effort** S–M.

### V1-S15 — Held position with a missing bar is silently marked at the last close
**Evidence** `closeBooks.ts:1076-1099` `markOf`: non-halted code, `bar === null` → `closeMicro = last` with no flag; only halted codes get `suspensionMark`. The DAT-127 halt proxy (zero volume / no price) is applied to pending *buys* at pre-open, not to marks. **Impact** A vendor gap for a held code produces a stale NAV and a stop that is never tested that session, indistinguishable from a real close. **Fix** Return `Mark.stale = true`, count it in `nav_daily_pos` (or app_log warn) and a non-fatal invariant `stale_mark`; after 2 sessions treat as halted. **Effort** S.

---

## Improvement (value/effort ranked)

### V1-I1 — One "last 7 nights per slot" table and the missing jobs in `JOBS`
`src/lib/health/jobs.ts:20-129` lacks `maintenance`, `kb-archive`, `replay`, `asx-fetch`, `backfill-prices`, `llm-bakeoff`, `worker-route`, `worker-reenable`, `decision-cutoff` although `latestPerJob` returns them; slot states and `DayTimelineCheck` live in separate blocks (`src/app/(app)/health/page.tsx:494-501`). Nightly maintenance (retention/PII hashing) silently not running is a privacy risk. **Fix** add the jobs; one table from `evaluateDay`. **Effort** S. **Value** high for a one-person operator.

### V1-I2 — Watchdog/heartbeat paging is noisy and double-counted
`src/lib/watchdog/script.ts:271-294` sends one S2-layout email per slot per day with no incident row (bypasses `notifyIncident`, never escalates); `watchdog.yml` is both scheduled and Worker-dispatched (up to 4 GitHub failure mails/day); Worker `asx_block_trip` (`worker/src/asx/token.ts:290-296`) and heartbeat `asx_trip` open two rows; Vercel `heartbeat-evening` 11:10 UTC is 22:10 AEDT but 21:10 AEST so the 21:50 check sees same-night incidents only in winter. **Fix** route through `notifyIncident` with stable kinds; one trigger per workflow; DST-aware heartbeat time. **Effort** M.

### V1-I3 — Five copies of "is this a trading day" and three HMAC signers
`tradingDay` (see V1-S3) and the canonical string `${timestamp}.${nonce}.${rawBody}` in `src/lib/security/hmac.ts:36-38`, `scripts/smoke/sign.mjs:9`, `worker/src/selfcheck.ts:122`. **Fix** one shared pure module per concern (`src/lib/data/calendarCore.ts` consumed by the Worker via the existing `.mjs` bridge; one `sign.mjs` imported by all three); when touched, add `${method}\n${path}\n` to the HMAC message (D-029 amendment) and bump the known-answer test. **Effort** M.

### V1-I4 — Dead or divergent code: `adjusted.ts`, `calendarCovers`
`src/lib/data/adjusted.ts` (`adjustedBars`/`effectiveFactors`) has no callers outside tests and defaults to no `knownBy` bound (look-ahead if ever used); `calendar.ts:164` `calendarCovers` unused. **Fix** delete or make `knownBy` mandatory; record that `adjustment_factor` is reconstruction-only. **Effort** S.

### V1-I5 — Migration "down" policy undocumented
`src/lib/db/migrate-core.mjs:143-158` implements `migrateDown`; `scripts/db/migrate.mjs` exposes only up; D-030 is ambiguous. **Fix** one-line decision ("down sections are TST-125 only; production is forward-only"). **Effort** S.

### V1-I6 — Auth DB export runs without `intMode: "bigint"`; auth backup verified by counts only
`src/lib/backup/exportHandler.ts:91` uses the shared client (number mode throws above 2^53); `scripts/backup/run.mjs:127-134` persists counts, not per-table sha256, for the auth side. **Fix** dedicated bigint client; return the hash header and persist it. **Effort** S.

### V1-I7 — Heartbeat/watchdog idempotency drops the day on a DB blip
`src/lib/heartbeat/handler.ts:138-146` writes `final:false` and 200; Vercel Hobby cron fires once/day so nothing re-runs. **Fix** have the Worker's morning slot re-POST when the day's record is non-final. **Effort** S.

### V1-I8 — Worker tick runs every runner serially; worst minute can exceed 60 s
`worker/src/index.ts:25-85`; at 10:30 `quote-poll` + `intraday-scan` (28 s each) + DB round-trips. Correctness holds (idempotent, claimed), latency/budget concern only. **Fix** `Promise.all` for independent route posts or stagger `intraday-scan` to :35. **Effort** S.

### V1-I9 — Test-identity "not production" is inferred from the absence of other secrets
`src/lib/auth/testIdentity.ts:29-33` (enabled when `TEST_IDENTITY_SECRET` valid AND no `BACKUP_PUBLIC_KEY` AND no `OWNER_RECOVERY_EMAIL`); same inference in `workerReport/handler.ts:35-37`, `watchdog/handler.ts:36-38`. Three independent mistakes are needed; prod self-check asserts 404. **Fix** add the positive `PRAXIS_ENV === "staging"` signal. **Effort** S.

### V1-I10 — `trustHost: true` and un-pinned Auth.js cookie options
`src/lib/auth/config.ts:21`; no `cookies:` block (defaults are PLT-033-compliant only implicitly); `APP_BASE_URL` already exists (`gate.ts:77-85`). **Fix** set `AUTH_URL` from `APP_BASE_URL`, drop `trustHost`, pin cookie flags and assert them in `tests/http/headers.test.ts`. **Effort** S.

### V1-I11 — Sign-in rate limit and audit IP trust the first `x-forwarded-for` entry
`src/lib/auth/audit.ts:12-16`. Safe on Vercel (overwrites XFF); brittle behind any other proxy. **Fix** document the assumption; prefer `x-vercel-forwarded-for`. **Effort** S.

### V1-I12 — Client-bundle secret-scan list is hand-maintained
`scripts/ci/bundle-secret-scan.mjs:9-21` lacks `WORKER_HMAC_SECRET`, `BACKUP_*`, `DATA_REPO_TOKEN*`, `FIXTURES_READ_TOKEN`, `GITHUB_DISPATCH_TOKEN`, `CLOUDFLARE_API_TOKEN*`, `VERCEL_TOKEN*` though `src/lib/security/secretStores.ts:780-782` `allNames()` enumerates them. **Fix** derive the list from `allNames()`. **Effort** S.

### V1-I13 — Break-glass recovery sign-in proceeds when the alert e-mail fails
`src/lib/auth/allowlist.ts:107-141` (only `auth.recovery_alert_failed` is audited; session still issued). **Fix** fail closed, or surface `auth.recovery_signin` rows on Health "attention". **Effort** S.

### V1-I14 — "Every Owner-only writer audits" is a process rule, not a test
Verified audit-first in config, calendar, controls, go-live, learning, arena control, users, blueprint, test-identity (`src/lib/config/admin.ts:254-301`, `data/calendarAdmin.ts:108-132`, `data/controls.ts:48-62`, `golive/signoff.ts:106-115`, …). **Fix** a static test that every exported function reached from an `"admin"`-gated action/route calls `audit`/`auditTx`/`audited` or is allow-listed with a reason. **Effort** S.

### V1-I15 — CI/local gate asymmetries worth writing down
`npm test` runs ~7.7k vitest cases + 72 `node --test` script suites in the `app` job (15 min timeout, `ci.yml:22`); the real-fixture tests run only in the `fixtures` job; mutation (`mutation.yml`, weekly, `release` only), ZAP (staging only), restore drill (real-key, Owner-dispatched) and the CI-minutes re-measure (TST-132, `docs/M4_exit_evidence.md:81` "not done") do not run on PRs. Timing-sensitive tests exist in ~30 files (`useFakeTimers`/`Date.now`); `tests/quarantine.json` is empty. `release-gate-core.mjs:29` `CI_REQUIRED_JOBS` omits `audit`, `coverage`, `checks` (ci.yml passes them explicitly, fine, but the default is weaker than the workflow). **Fix** a short "what runs where" table in `docs/test-map.md`; make `CI_REQUIRED_JOBS` match `ci.yml`. **Effort** S.

---

## What is solid

- **Money primitives** (`src/lib/money/*`): bigint micro-AUD, exact rationals, one `roundHalfAwayFromZero` per quantity; `toMicroFromVendor` goes through the shortest decimal string with the float32 exception (D-172) and rejects anything else; adverse tick rounding with band re-rounding (`tick.ts:225-247`); D-184 floor at the lowest grid price.
- **Fills / costs / sizing** (`arena/fills.ts`, `costs.ts`, `slippage.ts`, `sizing.ts`): ARN-021 gap-open vs level rule, initial stop from the actual fill, `selectExit` worse-outcome rule, P0–P5b as data with one rounding, no-iteration ARN-024a sizing, Cortex limit entries additive and persisted under the 0007 CHECK (D-307).
- **Ledger / NAV / invariants**: debit-positive double entry netting to zero per txn (`ledger.ts:106-122`), average-cost replay that never drifts, T+2 settlement from the calendar, positions derived from fills with ex-date re-basing first (`nav.ts:51-81`), NAV identity in one place and reconciled nightly (`invariants.ts` `checkCohortBooks`), canonical serialisation for ARN-102 byte-identical replay, append-only engine tables with trigger guards (`0007_arena.sql`, re-created intact across 0016/0018/0019/0020 rewrites). Reads tolerate both `intMode` modes (`ledgerWriter.ts:40-43`); the nightly CLI opens the client with `intMode:"bigint"` (`arena/cli.ts:67`).
- **Close-books orchestration**: every stage idempotent and resumable (`postUnposted`, `settleDue`, deterministic txn ids), stale `running` superseded, workflow `concurrency` group, batch 2b waits on 2a of the same session; sleeve financing per calendar day / 365 (FIX-042) with loss cap and close-out level exact; corporate actions as-of `known_at` (GL-02) with payload parsing that never touches floats.
- **Data integrity**: contiguous checksummed migrations applied in one write batch each (`migrate-core.mjs`), `.gitattributes` LF normalisation; `price_bar` first-seen immutable + prune-only; backup enumerates `sqlite_master` (nothing can be forgotten), one read transaction, paged, per-table counts + sha256, restore refuses a non-empty target and re-dumps to compare; age X25519 with the private key never on the server; drill replays a check cohort (`cohortCheck.mjs`). Point-in-time: `known_at`, `first_ingested_at`, `loaded_at` filters in live and replay; `marketData.ts` throws `LookAheadError` on a future date. DST gap/overlap handled explicitly (`calendar.ts:30-37,125-141`; `worker/src/localtime.ts:31-37`), early closes carried as rows.
- **Security**: every server action and page calls `requireUser` first; role/status/session_version re-read per request; ROL-101a owner pin; fail-masked server-side masking with oracle-free 404s; `safeCallbackUrl`; HMAC with 64-hex secrets, ±300 s, `timingSafeEqual`, nonce claimed only after a valid signature, store failure → 503; proxy same-origin check for every non-machine write; CSP with per-request nonce + `strict-dynamic`, HSTS, `frame-ancestors 'none'`; DB-backed rate limits that fail closed; all actions SHA-pinned, `permissions: {}` at top level, no `pull_request_target`, environment-scoped secrets, approved-commit gate for production jobs; SEC-110 clean (no data/fixture paths, Owner e-mail or names in `src/`, `public/`, `worker/src`); prompt-injection filter + datamarking + enum-only LLM outputs.
- **Reliability**: conditional claim before dispatch with per-date keys (a stale lock can never block the next night), pre-open 09:54/09:58/10:00 rule with `not_rechecked` + P1, evening-review retry pattern with the watchdog claiming the same key, email claim-before-send carrying all cap conditions in one INSERT, Owner-only recipient guard, incident dedup per kind with single S1 escalation, ASX politeness (single CAS grant, 720/day, kill switch), LLM budget enforced pre-call with rules-only fallback.

---

# Part 2: V2 delta

_Fable, 2026-11-01 (Melbourne time). Read-only review of local `build` at bf4942b (M8.1, M14, M15, M16, M17, M11-lite, M13-lite; M12 deferred). Companion to `docs/V2_architecture_review.part-v1.md` (V1 core); V1 findings are not repeated unless their severity reads differently from the V2 side. Residuals already listed in the milestone exit-evidence documents are not re-reported unless understated._

## Summary

The V2 delta is well isolated from the V1 money path: the Cortex stage only writes `cortex_*` rows while every family is `shadow` (and every family is, D-380/D-446/D-461), the steelman and the expert stages are proven outside the decision path by complement-of-allowlist replay hashes plus static write scans with self-tests, the picks phase and the steelman follow batch 3 from their own bundles and cannot change the night's exit code, and the intraday stream writes four tables of its own with append-only triggers. The schema changes (0015–0022) are additive, append-only guarded, and the one live-table rebuild (0020 `email_message`) has a parity test. Owner-only surfaces (Blueprint, expert queue) fail closed.

Two things block the V2 go-live as built. First, the two new Worker slots cannot reach their routes: `/api/internal/pick-alerts` and `/api/internal/intraday-scan` are missing from the proxy's machine-route list, so every signed POST is refused with 403 before the handler runs, and because recurring route slots record no failure, nothing in System Health would say so — the whole of M17 (O-74) would be silently dead in production. (part-v1 lists this as V1-S13 "fails closed"; from the V2 side it is an outage of a delivered feature.) Second, the intraday stream's pre-registered test is re-run every evening and the stream state is flipped `shadow`/`allowed` from each night's result, which is not what VAL-118 pre-registers (one look, then a new charged trial per quarter); the ledger cell records only the first look, so the state the Owner sees can disagree with the recorded result.

The Should-fix list is about operability and time bombs: the CTX-053/CTX-082 evaluator has no caller in the app (a family can leave shadow only through an Owner-run offline import, so live shadow evidence never counts), `cortex_feature_daily` grows by one row per code per night with no prune path at all, a V1 rollback deploy would fail its build step on the migrated database, the delayed-quote budget starves the buy-price alerts late in the day (D-502 is understated), the two review documents are not on the hygiene allowlist (the next push goes red), and a slow quote host can kill the 30-second route after the budget was reserved.

Counts: **Blocking 2 · Should-fix 9 · Improvement 11** (22 findings).

---

## Blocking

### V2-B1 — Both M17 Worker slots are refused by the proxy; the failure is invisible
**Evidence** `src/lib/http/gate.ts:34-50` (`MACHINE_ROUTES`: 11 `/api/internal/*` + 3 cron paths; neither `/api/internal/pick-alerts` nor `/api/internal/intraday-scan`), `gate.ts:114-120` (a write that is not a machine route and has no same-origin `Origin`/`Referer` → 403 "forbidden"; a Worker `fetch` sends neither, `worker/src/routes.ts:174-177`). Slots: `worker/src/schedule.ts:475-506` (`quote-poll` every 5 min 10:00–16:00, `intraday-scan` every 30 min 10:30–15:30, both `runner: "route"`). Silence: `worker/src/routes.ts:326` `if (a.key === null) continue;` — a recurring route slot (no claim key) writes no `worker_state`, no `run_record`, no incident on failure; the only trace is a Worker `console.log`. The M17 health lines (`src/lib/intraday/run.ts:267-292`) say "off", "narrowed", "stopped", "paused" — never "no poll ran today". `tests/security/at60OrderBoundary.test.ts:46,92,122` names the route files for the boundary only; `tests/http/gate.test.ts` hard-codes the 11 V1 paths. The M17 e2e was not run and `build` has not reached staging (M17 exit §4 items 7–9), which is why this was never seen.
**Impact** After the Owner accepts `yahoo_delayed` and lists both slots, every tick posts, gets 403, and nothing arms, polls, scans, e-mails or measures. "My alerts" stays empty, the Evening Review says "0 hit, 0 cleared", and the VAL-118 sample never grows. O-74 is delivered on paper only, and the Owner would conclude the feature is quiet, not broken.
**Fix** (1) Add both paths to `MACHINE_ROUTES`. (2) Replace the hand-kept set with a test that walks `src/app/api/internal/*/route.ts` and `src/app/api/cron/*` and asserts each is listed and imports a signed/cron handler, and that no other `/api` route is listed (as V1-S13 proposes). (3) For recurring route slots write one `run_record` `failed` row per (slot, date) on the first failure of the day and a System Health line "Pick-alert poll / intraday scan: no successful run today" from `quote_run` (see V2-S3). (4) Run the M17 e2e against staging before the PR.
**Effort** S (1–2), S (3), S (4).

### V2-B2 — The intraday-stream pre-registered test is re-run every night and the stream state follows the latest look, not the recorded one
**Evidence** `src/lib/review/routeHandler.ts:139-145` calls `evaluateIntradayStream` on every Evening Review run. `src/lib/intraday/evaluator.ts:110-131`: `pass = sampleMet && lowerPpm > 0` is recomputed from all candidates every call; `target = current === "live-tested" ? current : pass ? "allowed" : "shadow"`; `writeStreamState` writes whenever `target` differs from the stored state. The ledger cell takes a result once (`cell.resultAt === null`, lines 122-131) — but the state is not tied to it: a first look that fails is recorded as failed, and any later night whose bootstrap bound happens to exceed 0 sets `allowed`; the night after can set `shadow` again. Spec: ch. 19 VAL-118 ("pre-registered hypothesis … sample ≥ 60 candidates and ≥ 60 sessions … Pass → the Owner may approve … fail → the stream stays shadow and the thresholds may be re-tuned once per quarter as a new pre-registered trial (ARN-085 trial budget)"); O-74 ("shadow-only until a pre-registered test passes"); CTX-002/O-43 (looks are charged). Design D-391 says the evaluator "moves only shadow ↔ allowed", which is the nightly re-test by construction.
**Impact** A sequential test with an unbounded number of looks and no boundary: at the pre-registered 90 % one-sided level, re-testing nightly for a year drives the chance of a spurious `allowed` far above 10 %, and the section explainer, the Blueprint Cortex view and the e-mail wording ("Unvalidated") change on the strength of it. Nothing trades on the state in V2, so no money moves; but the state the Owner is asked to approve against (VAL-118 "Owner may approve … in the next release") can contradict the one recorded, charged result in `cortex_ledger_cell`. It is a spec/Owner-decision violation in the one place V2 promises statistical discipline for a new stream.
**Fix** Bind the state to the ledger: set `allowed` only when the cell's recorded result (first look at `sampleMet`) passed; after a failed look keep `shadow` and refuse further looks until a new cell (new `lineage_id` suffix, charged to the ARN-085 budget) is logged by an Owner action no more than once a quarter. Keep computing and showing the running estimate as "descriptive, not a test". Add a test: failed first look + later passing night → state stays `shadow`.
**Effort** S.

---

## Should-fix

### V2-S1 — CTX-053 / CTX-082 are never re-evaluated in the app; live shadow sessions cannot move a family
**Evidence** `src/lib/cortex/status.ts:116-166` `recordFamilyStatus` ("the only writer that may say `allowed`") has no caller in `src/` or `scripts/` other than its definition; the only writers of `family_status` are `scripts/cortex/import.mjs:816-825` (set_by `evaluator`/`import` from the offline artefact) and the Owner kill. `cortex_statement.n_eff_live` (M15 design §schema) is written at import with the "live-tested pending (n_eff_live = 0)" template and nothing advances it. Spec CTX-053: allowed "on out-of-fold development data **plus live shadow sessions**"; CTX-082 live-tested needs `LIVE_TESTED_MIN_NEFF` 150 live setups (`statusRules.mjs:21`). D-380 ("the Cortex keeps writing shadow decisions so live evidence accumulates") promises exactly the path that does not exist.
**Impact** The shadow decisions and `cortex_outcome` rows accumulate but feed no decision. Leaving shadow requires the Owner to re-run the private offline pipeline (O1–O8) and the import, which D-380 forbids as "further searching". So, as built, no Cortex family can ever trade, and the "time to n_eff_live 100/150" projections on the statements are projections of a counter nobody increments. Not wrong money; a spec promise with no mechanism.
**Fix** A weekly stage (after `rankIc`, before `experts`) that pools the development cells with live `cortex_outcome` rows per family, calls `recordFamilyStatus` with the CTX-053 decision, updates `n_eff_live` on the statement (append a new statement row, CTX-072 keeps the text template-only), and logs each look as a charged ledger cell (one look per family per quarter, D-380-compatible). Until built, say so on the Cortex page ("re-evaluated only by an Owner-run calibration").
**Effort** M.

### V2-S2 — `cortex_feature_daily` grows by one row per code per night and can never be pruned
**Evidence** `db/migrations/main/0019_cortex.sql:41-58`: one row per (market, d, code) with `features_json` + `flags_json`, `no_update` and an unconditional `no_delete` trigger (contrast `price_bar` / `email_message` "prune-only beyond retention" triggers). `src/lib/cortex/stage.ts:1022-1045` `featureRowsOf` writes every code in `out.features` (the family universes U1–U3, `stage.ts:127-134`, i.e. most of the listed market), every trading night (D-293). No DAT-142 storage series names the table; `scripts/db/migrate.mjs` has no `down`.
**Impact** Roughly 1,500–2,000 rows × 1–3 KB per night ≈ 1 GB per year on the Turso main database (5 GB plan), on top of `cortex_decision`, `input_manifest` and the V1 tables. When `storage_warn_gb` trips, DAT-142 (O-55) can prune `price_bar` oldest-first but not this table; the only way out is a migration that drops the trigger. The nightly backup (`scripts/backup`) and the restore drill size grow with it (V1-S5).
**Fix** Replace `cortex_feature_daily_no_delete` with a prune-only-beyond-retention trigger (e.g. 400 days, like `email_attempt`), add the table to the maintenance prune and to the storage meter, and keep the per-night `active_set_hash` + `manifest_id` so a replay can regenerate features from bars (they are deterministic by D-278). Record the expected growth in the M15 design.
**Effort** S.

### V2-S3 — Recurring route slots fail silently (no run record, no incident, no health line)
**Evidence** `worker/src/routes.ts:326-350`: `run_record` and `worker_state` are written only for claimed single-shot actions (`a.key !== null`); `quote-poll` and `intraday-scan` are `everyMin` slots with `key === null`. Health: `src/lib/intraday/run.ts:267-292` has no "last successful run" line; `src/lib/health/*.ts` has no pick-alert line (grep "Pick alerts|quote_run" → none).
**Impact** Any sustained failure (proxy 403 as in V2-B1, HMAC secret drift, Vercel 5xx, DNS) leaves both features quiet for the day with nothing in System Health, the Morning Brief or an incident. The Owner learns from an empty "My alerts".
**Fix** One `run_record` `failed` per (slot, date) on the first failure (INSERT OR IGNORE on the concurrency key), cleared by a later success; a health line from `quote_run` ("Pick-alert poll: last run 11:45" / "no run today after 10:05 on a trading day") in `intradayScanHealth` and a sibling for the poll. ~40 lines plus two tests.
**Effort** S.

### V2-S4 — Rollback to V1 is not operable: a V1 build fails its migration step on the migrated database; no down tooling; no written procedure
**Evidence** `package.json` `"build": "node scripts/db/migrate.mjs --if-vercel && next build"`; `src/lib/db/migrate-core.mjs:107-115` throws `applied migration N has no file` when the database holds a version the checked-out tree lacks. A V1 (`main`/`release`) redeploy that goes through a build — any hotfix — therefore fails on a database at 0022. `scripts/db/migrate.mjs` has no `down` command (V1-I5 noted the policy gap; V2 adds eight migrations and one table rebuild, `0020:234-293`, whose down path deletes every `pick_*` e-mail row and attempt). `docs/owner-guide/M8_go_live.md` and `operations.md` have no V2 rollback section.
**Impact** The CLAUDE.md promise "the live V1 keeps running from `main`/`release` until the Owner merges" holds only as long as V1 is never rebuilt after the production migration. Vercel "instant rollback" (no build) works; a V1 hotfix does not; the Worker and the GitHub workflows on `main` keep working because V1 never reads the new tables.
**Fix** (1) In `migrateUp`, treat applied versions beyond the tree's last file as "newer schema, leave alone" (warn, do not throw) when every known version's checksum matches — V1 code is forward-compatible with the additive V2 schema. (2) Add `migrate.mjs --down <version>` (the files already carry `-- +down`) and test it on a file DB from 0022 to 0014 against the 0020 parity test. (3) Write the procedure in `operations.md`: instant rollback first; schema stays; what the 0020 down path deletes.
**Effort** S (1), M (2), S (3).

### V2-S5 — The delayed-quote budget starves the buy-price alerts late in the day (D-502 is understated)
**Evidence** `worker/src/schedule.ts:475-489` `quote-poll` every 5 min 10:00–16:00 = 73 ticks. `src/lib/alerts/pick/poll.ts:150-185`: each tick plans armed picks, then every watch-listed code, then every held code, cut at `intraday_codes_max` (150, `keys.ts:846`), and reserves that count in `quote_run` before fetching. `src/lib/data/quotes/budget.ts:6-8,19-25`: 2,000 requests per day, narrow to armed-only at 80 % (1,600), stop at 95 % (1,900) — shared with the scan (up to 40 × 11 = 440, `keys.ts:1235`).
**Impact** With 10 armed picks, 20 watch-listed and 10 held codes (40 per tick) the poll alone reaches 1,600 after 40 ticks (13:20), narrows to armed-only, and reaches 1,900 after another 30 ticks (15:50); with the scan's 440 in the same pool the stop lands around 15:00. The Owner's buy-price alerts — the feature O-74 asked for — are the ones that stop for the last hour, while the watchlist refresh that spent the budget is a UXN-048 convenience. The M17 review called this "open for the Owner, cap holds"; the cap does hold, but the stated feature does not.
**Fix** Poll armed picks every tick and watch/held codes every third tick (15 min; UXN-048 allows `intraday_refresh_min` up to 15), or give the poll two sub-budgets (armed first, uncapped within the day; watch/held from the remainder) so narrowing never removes an armed pick. Make the scan's reservation count what it fetched, not `allowed`, when it returns early (`run.ts` reserves `allowed` at the claim).
**Effort** S.

### V2-S6 — The two review documents are not on the repo-hygiene allowlist; the next push is red
**Evidence** `scripts/ci/repo-hygiene.mjs:100-108`: every `docs/<sub>` path not covered by `allow.docs` is `HYG-PRIVATE`; `scripts/ci/repo-hygiene.allow.json` lists the milestone files up to `docs/M17_exit_evidence.md` and `M13L_exit_evidence.md` (D-658) but not `docs/V2_architecture_review.part-v1.md` nor this file. M11L's own final review hit the same gate (finding 3, D-589).
**Impact** `npm run test:hygiene` and the CI job fail on the first push after the review lands; the unattended resume task then loops on a red gate.
**Fix** Add both paths (or a `docs/V2_architecture_review.` prefix) to `allow.docs` in the same commit that adds this file.
**Effort** S.

### V2-S7 — A slow quote host can kill the route after the budget was reserved; the tick is lost and counted
**Evidence** `src/app/api/internal/pick-alerts/route.ts:11` and `intraday-scan/route.ts:12` `maxDuration = 30`. `src/lib/data/quotes/fetch.ts:11-13`: concurrency 4, 250 ms spacing, **20 s per call** budget; no whole-run deadline. `src/lib/intraday/run.ts:189-195` and `poll.ts` step 6 claim `quote_run` with `requests = allowed` **before** fetching (D-442). 150 codes at 4 × 250 ms is ~9 s nominal; four stalled calls are 20 s; a host answering in 3–5 s per call takes the poll past 30 s.
**Impact** Vercel terminates the function; the claim row stands (the slot is `already_done` on any retry), the day's budget is charged for requests never made, and no `pick_alert` transition, mail or candidate is written — silently (V2-S3).
**Fix** Pass a run deadline (e.g. 22 s from route start) into `fetchDelayedQuotes`; stop planning new codes past it; write `quote_run.requests` from the actual count in the final update row (the table is append-only: add a `+done` row, as `+paused` does). Prefer the batched `v7/finance/quote?symbols=` endpoint if the licence note allows it (one request for up to ~100 codes), which also fixes V2-S5.
**Effort** S.

### V2-S8 — The intraday stream lineage is measured against the market, and candidates are selected on the raw move; both deviations are recorded but the pre-registered text and the UI must say so before the sample starts
**Evidence** Spec AGT-141 (b) "sector-adjusted return", VAL-117 "excess return over its sector index"; built: `src/lib/intraday/scan.ts:319` `sectorAdjPpm: null` (D-445 raw move vs max(`intraday_move_min_pct`, 1.5 × sd60)), `src/lib/intraday/measure.ts:10` `BENCH_INDEX_CODE = "AXJO"` (D-462). `evaluator.ts` `HYPOTHESIS_TEXT` says "total-return index" — consistent with the build, not with ch. 19. The M17 exit lists D-462 for the Owner but not D-445.
**Impact** Not a bug; an unapproved spec change on the pre-registered hypothesis. If the Owner later wants the sector basis, the first 60 candidates were measured on another and the lineage must be re-logged (and charged).
**Fix** Put both deviations in the V2 PR's decision list for an explicit tick, amend ch. 19 AGT-141/VAL-117 wording ("market index until a sector series exists, DAT-235"), and show "vs market, not sector" in the section explainer (the alerts report already says "beyond the market").
**Effort** S.

### V2-S9 — The Owner's V2 go-live steps live in seven exit-evidence documents; the go-live page and `checklist.ts` know nothing of V2
**Evidence** `src/lib/golive/checklist.ts:10-41` (seven V1 items only), `src/lib/golive/signoff.ts` (no V2 item), `docs/owner-guide/M8_go_live.md` (V1). V2 steps are in M8.1 §4, M14 §4, M15 §5, M16 §4, M17 §4, M11L §6, M13L §8: staging migrations in order, `scripts/cortex/import.mjs`, `scripts/experts/import.mjs --dry-run` then live, the 23 red-flag texts and `fits.json` review, `yahoo_delayed` acceptance + two slot listings, `SOURCE_HOSTS` additions, hygiene entries, the R6 model, the D-481 budget, D-371/D-443/D-462 approvals, CTX-052 warm-up, e2e for M17/M13L, remote CI. Ordering matters (0022 before the experts import; 0020 before listing the slots; the Cortex import after 0020 per M15 §5).
**Impact** A one-person operator working from seven lists in the right order, with no page that records what is done, on a PR whose description is the only index.
**Fix** One `docs/owner-guide/V2_go_live.md` in execution order with the "done" column, generated from the exit documents, and link it from the PR; optionally a second `GoLiveItem` block in `checklist.ts` ("V2 steps") gated like the V1 one.
**Effort** S.

---

## Improvement (value/effort ranked)

### V2-I1 — Offset `intraday-scan` from the `quote-poll` minutes
**Evidence** `schedule.ts:475-506`: `quote-poll` fires at every multiple of 5 from 10:00; `intraday-scan` at :30 multiples from 10:30 — both are due at 10:30, 11:00 … 15:30. `routes.ts` posts due slots sequentially in one tick and awaits each (each route may run up to 30 s). V1-I8 already notes the serial tick.
**Fix** Start the scan at 10:33 (or 10:32, even minute away from the ASX poll). One line plus `tests/golive/slots.test.ts`. **Effort** S.

### V2-I2 — Make `picks_max_per_family` unable to re-introduce the cap O-76 removed
**Evidence** O-76 "no per-family and no per-sector cap"; `src/lib/picks/generate.ts:271-283` still applies `picksMaxPerFamily`; `keys.ts:527` default 10 with range 1–10, Owner-editable. The default satisfies O-76; one Settings edit silently reinstates the cap with no UI word for it.
**Fix** Either remove the loop and the key (one migration-free config delete) or label the key "O-76: 10 = no cap" in the Settings row. **Effort** S.

### V2-I3 — Resolve the `[VERIFY at build]` on the quote endpoint and record the alternative
**Evidence** `src/lib/data/quotes/fetch.ts:15-16` `/** [VERIFY at build] same chart endpoint as scripts/fixtures/record-day.mjs. */`; the whole of O-74 depends on one unofficial host (D-398); a 429 pauses both routes for `quote_pause_cooldown_min`. `docs/source-licence-register.md` should carry the request pattern and a named fallback (the ASX delayed quote page is scrape-only and not $0-safe; the licence register should say "none" explicitly if that is the case).
**Effort** S.

### V2-I4 — Health line for Worker route posts per slot per day
Covered by V2-S3's fix; listed here because it also serves the V1 route slots (preopen, review, morning) whose failures are visible only through their own idempotency keys. **Effort** S.

### V2-I5 — One index of the V2 decisions
**Evidence** `docs/07_decision_log.md` ends at D-252 (D-657); D-253…D-660 live in seven design documents, with gaps and local numbering (D-380, D-446, D-461 in M15; D-479, D-500–502 in M17; D-480–D-589 in M11L; D-510–D-659 in M13L). The PR description is to list "every open item … for the Owner to review at merge time" (CLAUDE.md §4).
**Fix** A script that greps `- **D-nnn**` across `docs/M*_design.md` into `docs/07_decision_log.md` (append-only section "V2, generated") and fails on a duplicate id; run it in `test:architecture`. **Effort** S.

### V2-I6 — The pick-alert poll should not count the arming step as a quote run
**Evidence** `poll.ts` step 1 arms (no request), then claims `quote_run` with `requests = allowed` even when every planned code is missing (empty plan). A day with no armed picks and an empty watchlist still writes 73 rows. Harmless; noise in `quote_run` and in the budget meter. **Fix** skip the claim when `planned.length === 0`. **Effort** S.

### V2-I7 — The 0016 "NULL `known_at` = always known" rule should be bounded by date
**Evidence** `0016_known_at.sql` comment "NO backfill … existing rows stay NULL, which the readers treat as 'known since before this column existed'"; `src/lib/arena/corpActions.ts:67`. Any row inserted with NULL `known_at` by a later writer (a fixture loader, an import script, a bug) is treated as known at all times — the GL-02 look-ahead guard is off for that row.
**Fix** A CHECK on insert after the migration date (`known_at IS NOT NULL OR confirmed_at < '2026-10-29'`) or a BEFORE INSERT trigger; one test. **Effort** S.

### V2-I8 — Expert names: add the static guard the design promises for e-mail and KB
**Evidence** M13L residual 9 (named real people in the private database; red flags with source and date; licence `unchecked`); `tests/security/expertBoundary.test.ts` proves writes and imports; `kbDocs.ts` keeps names out of the mirrored documents by construction. No test asserts that `src/lib/email/**` and `src/lib/kb/**` never import `experts/*` or read `expert`/`expert_red_flag`.
**Fix** Two describe blocks in `expertBoundary.test.ts` (import guard + SQL table scan) over `src/lib/email`, `src/lib/kb`, `src/lib/review`. **Effort** S.

### V2-I9 — `cortex_stage_minutes` (20) sits inside the 40-minute `arena-signals` job with the picks and the LLM steelman after it
**Evidence** `batch2b.ts:1834-1876` time box; `.github/workflows/arena-signals.yml:31,89` `timeout-minutes: 40`; the job also waits for batch 2a (≤ 4 min), runs batch 3, picks, then the steelman with its LLM calls (LLM-074 reservation, D-507 resume). A GitHub timeout kills the steelman mid-night (D-507 resumes; night counters lost, M11L residual 3) but also the picks if the Cortex ran to its box.
**Fix** Raise the job timeout to 60 or lower the Cortex default to 15; add the elapsed time per phase to the run record so the Owner sees the margin. **Effort** S.

### V2-I10 — The M14 lesson alpha pool default (0.1) and the O-43 "family-wise 0.05" read differently on the Cortex page
**Evidence** `keys.ts:538` `l2_alpha_w0` 0.1 (VAL-116, the lesson pool; spec ch. 15 l.49); `statusRules.mjs` `STRICT_LEVEL = 0.05` (CTX-002 / O-43 for lineages). Both are per spec; the glossary and the Cortex page's disclosure line name only the 0.05.
**Fix** One sentence on the Cortex page: lessons are tested from a separate 0.1 pool (VAL-116), lineages family-wise at 0.05 (O-43). **Effort** S.

### V2-I11 — `tradingDay` in the Worker route tick treats a missing calendar row as a trading day
**Evidence** `worker/src/routes.ts:236` `tradingDay: !isWeekend(local) && calKind !== "holiday"`. V1-S3 covers the calendar horizon; the V2 route slots (`tradingDaysOnly: true`) inherit it: past 2027-12-31 the quote routes will post on every weekday and be refused inside the route (`non_trading_day` from `sessionTimes`), at the cost of a signed request per minute slot. Harmless today; listed so the V1-S3 fix includes the Worker.
**Effort** S (with V1-S3).

---

## What is solid

- **Decision-path isolation.** The Cortex stage is time-boxed and caught (`batch2b.ts:1794-1876`); with every family `shadow` it writes `cortex_*` rows only (D-280) and the v1 replay hash is unchanged (AT-43/AT-50). The picks and the steelman run from their own bundles after batch 3; a steelman failure cannot change the exit code (`scripts/arena/signals.mjs:32-43`). The weekly learning runs `experts` last and wrapped (`learningMode.ts:168-180`), and the stage itself never throws (`weeklyStage.ts:48-56`). The Evening Review wraps the intraday outcome, measurement and evaluator in their own try/catch (`routeHandler.ts:133-145`).
- **Boundaries proven, not asserted.** AT-32 and AT-41 hash the complement of a small allowlist of the stage's own tables (D-586, D-642); static write-allowlist scans with self-tests refuse interpolated table names and lower-case keywords (D-583/D-584/D-651); reverse import guards name every reader; `text_label`/`label_validation` are kept out of arena/agents/picks (D-587). The one path from an expert cluster to trading is `createChallenger` with +1 charged trial and the weekly cap (`proposals.ts:126-200`). The Cortex does not read `intraday_candidate` (AGT-144 is a read-after-run in `outcome.ts`, D-399).
- **Statistics discipline where it was designed.** Ledger cells logged before results with a once-only result write; the CTX-053 rules are one plain-data module shared by the import and the app (`statusRules.mjs`) with a parity test to `economicGate`; the M15 report states the negative result first and the Owner's own process notes (D-461); M13-lite screens on the dev split with an FDR of 0.1 and 3 of 60 fits; MinBTL conservative N; placebo/random-angle nulls run.
- **Schema.** Additive migrations, append-only triggers on every new table, `email_message` rebuilt with a byte-parity test (D-500), `0016` no-backfill with NULL semantics stated, `corporate_action` single-step `known_at` trigger. `parseSlotsEnabled` accepts unknown ids (`clock.ts:176-192`), so a V1 Worker with a V2 slot list does not go "malformed" — the Worker side of a rollback is safe.
- **Security of the new surfaces.** Blueprint: pinned-Owner guard first on page and both routes, proxy marks + `next.config` rewrite to an absent path (indistinguishable 404), `outputFileTracingIncludes` for `architecture.json`, no-store/noindex, no nav link; the RSC residual is stated and asserted. Steelman LLM text is bounded (≤ 4 points, 400 chars), stripped of URLs, codes, instructions, certainty words and the injection phrase list (`claims.ts:41-76`), and masked for non-Owners. Pick e-mails are template-only, escaped in one place (`templates/core.ts`), Owner-recipient only, P0 slots untouched, claim-before-send with the batch-prefix rule (D-479). Expert names never reach KB documents or any public file; red flags carry source and date only.
- **Honesty in the UI.** "Not enough history yet" fails closed on a missing slope bound (`chance.ts:41-45`); "Unrated", "Unvalidated", "delayed" everywhere; no number for a shadow family; the 55 % floor is dormant until a family is allowed (`floor.ts`).

## Go-live checklist gaps (in execution order; items with "confirm" were not verified here)

1. **Fix V2-B1 before anything else**, then run the M17 e2e (`e2e/picks-sections.spec.ts`) and the M13L e2e (`e2e/m13l-experts.spec.ts`) against staging; neither has run.
2. **Hygiene allowlist** entries for both review documents (V2-S6) before the push; then remote CI (gitleaks history, Linux jobs) — `build` has not been pushed since M14.
3. **Staging migrations 0015 → 0022 in order**; check the 0020 `email_message` rebuild (D-443) and the AT-42 staging row (M8.1 §4, M14 §4).
4. **Cortex import** (`scripts/cortex/import.mjs <artefact>`) after 0020; confirm every family lands `shadow` (`families allowed 0`) in the import summary.
5. **Experts import** after 0022: `--dry-run`, review the 23 red-flag texts and `fits.json`, then live; add regulator/paper hosts to `SOURCE_HOSTS` (D-631).
6. **Quote source**: accept `yahoo_delayed` in Settings → Data sources (D-398, licence note O-26 extended), resolve the `[VERIFY at build]` on the endpoint (V2-I3), then list `quote-poll` and `intraday-scan` on the go-live block — after V2-B1 and V2-S5.
7. **Decide the poll cadence** (V2-S5) and the stream-state rule (V2-B2) before the first candidate is measured; both change what the first 60 candidates mean.
8. **R6 model**: run the bake-off, assign in the roster; until then the steelman reads "not available tonight" (D-480). Review `llm_daily_budget_total` 240,000 vs Groq's 200K per model per day (D-481).
9. **Approvals to tick in the PR**: D-371 (ch. 18 wording), D-445 and D-462 (V2-S8), D-443, D-490 (benchmark basis wording on `/picks`), the AT-39 go-live gate wording (D-527), D-510 deferred set.
10. **Rollback procedure** written and tried once on staging (V2-S4): instant rollback, schema stays, what a V1 rebuild needs.
11. **Storage**: add `cortex_feature_daily` to the storage meter and decide retention (V2-S2) before the first month of nightly shadow rows.
12. **Confirm** (not verified here): DAT-236 two alternative free universe sources in the licence register (O-53); the DAT-232 split-day frequency measurement on staging (M14 §4); the draw.io desktop open check (D-369); CTX-052 organ warm-up started in staging (AT-50 clause 2).
13. **One go-live page** for all of the above (V2-S9).

# M18 exit evidence: live-risk fixes, ops and test debt (V3)

Design: `docs/M18_design.md`. Requirements: `docs/M18_requirements.md`. Each section below is filled by the task that owns it; a section that is still a placeholder is not yet evidence.

## §1 OPS-110 Production picks 0 since 26 October

Verdict (D-951): by design, not a live bug. Before the D-861 code went live there were no buy signals at all; from 3 November the candidate shortlist existed but the first blocking gate was `no_history` (no closed ledger history, so no scenario to score a candidate against). The D-920 shortlist went live at `4517e52` on 10 November and the first night with it published picks again.

| Night (Melbourne date) | Candidates | Picks | First blocking gate | What is known |
|---|---|---|---|---|
| 26, 27, 28, 29, 30 Oct 2026 | not recorded | 0 | none: the D-861 code was not live, so no buy signal was produced | production nights without buy signals |
| 2 Nov | not recorded | not recorded | not recorded | not recorded |
| 3 Nov | 12 | 0 | `no_history` | 12 candidates, no closed ledger history, so no scenario to score them against |
| 4, 5 Nov | not recorded | 0 | very likely `no_history` (same cause as 3 Nov; not proven per night) | not proven per night |
| 6, 9 Nov | not recorded | not recorded | not recorded | not recorded |
| 10 Nov | not recorded | 0 | very likely `no_history` (not proven per night) | D-920 shortlist went live at `4517e52` on this day |
| 11 Nov | 2 | published = 13 | none | run 42977574979, "Arena signals and orders (batch 2b)", success; log line below |

Cells marked "not recorded" were not captured by a run record we hold; none is estimated. U1 size, family status, `holdout_look` and ledger-row counts per night are likewise not recorded for these nights; the only per-night facts we hold are those in the table.

Log line of 11 November 2026:

```
arena-picks AU 2026-11-11: published=13 candidates=2 bought=0 missed=0 closed=0 open=0 checked=0 withdrawn=0 shortlist=5
```

Close condition: met. Picks are published again (`published=13`, shortlist 5 on the first night of the D-920 shortlist).

The plain-words line for a night with candidates and no picks (OPS-110 task 1, commit `6b57a35`, D-941, D-951) is proven by DOM and loader assertions, with no screenshot:

- `tests/picks/noPicks.test.ts`: "first blocking reason" ("names the first missing piece"; "counts reasons and treats a candidate that passes the basics as profile rules"), "the plain-words line" ("explains missing history without a stock, a run time or a code"; "says so when no strategy fired, singular signal, unreadable shortlist"), "a night with candidates but no history publishes nothing and says why" ("returns the reason, stores it with the night and reads it back").
- `tests/home/homeBranches.test.tsx`: "daySentence" > "says why there are no picks when the night stored a reason (OPS-110), else the first-run line".
- `tests/picks/cli.test.ts` and `tests/picks/isolation.test.ts` (the night record and the money-path isolation guard).

No money-path defect was found, so no `fix/*` branch and no AT-32 replay hash were needed for §1.

## §2 Streams and tasks

Integration base `63d6868`; the five streams were merged into `build` (merge commits `28c0cb6` B, `8663c3e` C, `6baa587` A, `9bf0e10` D, `080d96a` E), then the cortex mobile fix (`056ec53`) and the integration commit `b0685ca`. Task commits are listed oldest first within each stream. Decisions: D-951…D-979 in `docs/M18_design.md`, D-980…D-989 recorded at integration in the same file.

| Stream | Task | What | Commit | Tests |
|---|---|---|---|---|
| A | A1 OPS-110 | plain-words "No picks tonight" line, M18 requirements extract | 6b57a35 | `tests/picks/noPicks.test.ts`, `tests/home/homeBranches.test.tsx`, `tests/picks/cli.test.ts`, `tests/picks/isolation.test.ts` |
| A | A2 OPS-109 b | watchdog fixture run (missing heartbeat: one incident, exit 1, de-duplicated) | 21cf8d3 | `scripts/watchdog/run.test.mjs` |
| A | A3 OPS-109 c | quote budget line, starvation check, S2 `quote_starvation` (D-971); follow-up: a same-time re-fetch moves only `fetched_at` | c8b6bb4, ba65369 | `tests/alerts/starvation.test.ts`, `tests/alerts/pollBudget.test.ts`, `tests/health/summary.test.ts` |
| A | A4 OPS-106 | 2b recheck after a late 2a, `late_2a`, `calendar-draft` and `turso-usage` Worker slots, gap table (D-953) | 61e4012 | `worker/test/recheck2b.test.ts`, `worker/test/schedule.test.ts`, `scripts/arena/signals.test.mjs`, `tests/agents/batch3.test.ts` |
| B | B2 OPS-109 a | CLI pin lint (`npx vercel`/`wrangler` versions exact) | f2a1f28 | `scripts/ci/workflow-lint.test.mjs` |
| B | B1 SEC-115 | HMAC v2 signs method, path and body hash; every signer and verifier moves together (D-957) | 72281bd | `tests/security/hmac.test.ts`, `scripts/smoke/stage2.test.mjs`, `tests/auth/testIdentity.test.ts`, `scripts/e2e/test-login.test.mjs`, `worker/test/selfcheck.test.ts`, `worker/test/sentinel.test.ts`, `worker/test/universe.test.ts`, `worker/test/routes.test.ts` |
| B | B3 ARN-123 | new pick settlements credit in-window dividends, stored with `outcome_basis` (D-956) | 83cd01d | `tests/picks/dividendOutcome.test.ts`, `tests/acceptance/v2/at35.test.ts`, `tests/db/0032_m18_outcome_basis.test.ts` |
| C | C1/C2 | `0031_m18_ops` migration and the M18 keys | db5c8d6 | `tests/config/m18Keys.test.ts`, `tests/db/0031_m18_ops.test.ts` |
| C | C3 OPS-104 a/b/c | Turso usage metering against the free plan and the 20 % line | ed92d08 | `tests/usage/tursoMeters.test.ts`, `tests/usage/meters.test.ts`, `scripts/usage/turso-sample.test.mjs`, `scripts/usage/turso-usage.workflow.test.mjs` |
| C | C4 OPS-104 d/e | no `OFFSET` anywhere; nightly row-by-market invariant | c93fa49 | `tests/security/noOffsetPaging.test.ts`, `tests/ui/loaders/newsPaging.test.ts`, `tests/ui/loaders/reviewsPaging.test.ts`, `tests/maintenance/rowsByMarket.test.ts`, `tests/maintenance/retention.test.ts` |
| C | C5 OPS-103 | yearly trading-calendar draft job and escalations | 9039ab7 | `tests/calendar/draftJob.test.ts`, `scripts/calendar/calendar-draft.workflow.test.mjs` |
| C | C6 OPS-105, PLT-080 | scheduled restore dry run, drill record, Turso plan guard | e21f795 | `scripts/restore/dryRun.test.mjs`, `scripts/restore/restore-dry-run.workflow.test.mjs`, `tests/health/restoreReminder.test.ts`, `tests/health/tursoPlan.test.ts`, `tests/security/tursoFreePlan.test.ts` |
| D | D1 OPS-107 | staging retired in the release gate (D-964) | 51a7906 | `scripts/ci/release-gate-core.test.mjs`, `scripts/ci/release-gate.test.mjs`, `scripts/ci/nightly.workflow.test.mjs`, `scripts/ci/staging-e2e-day.workflow.test.mjs`, `scripts/ci/zap-run.test.mjs`, `scripts/ci/zap-baseline.workflow.test.mjs` |
| D | D2 OPS-107 | recorded-day CI job (D-965); coverage of the instrumentation hook | f443296, 34846e1 | `scripts/e2e-day/recorded-day.test.mjs`, `scripts/e2e-day/now.test.mjs`, `scripts/ci/e2e-day-check.test.mjs`, `tests/data/hostGuard.test.ts`, `tests/shell/instrumentation.test.ts`, `scripts/ci/ci.workflow.test.mjs` |
| D | D3 TST-134 | every e2e spec runs in CI, in exactly one lane (D-966) | 3d24778 | `scripts/ci/e2e-listing.test.mjs` |
| D | D4 OPS-108, TST-138 | rotate-secrets runbook, recorded-day docs, V3 home column in the test map | a32ad34, f02ecf8 | `scripts/ci/test-map.test.mjs`, `tests/test-map.baseline.json` |
| E | E1 | migration `0033_m18_data` | 3e5bb3d | `tests/db/0033_m18_data.test.ts` |
| E | E2 DAT-251 a, DAT-252 | request causes, backoff, `code_history` delisting, Wikidata fallback (off until enabled), `splitFrequency` scenario, data-feed lines | 2eb0a7f | `scripts/asx/fetch.causes.test.mjs`, `scripts/asx/ingest.test.mjs`, `scripts/asx/fallback.test.mjs`, `tests/data/splitFrequency.test.ts`, `tests/health/dataLines.test.ts` |
| E | E3 DAT-251 b/c, DAT-253 | `news_assess_per_run` cap, RBA/ABS fetchers (off unless `MACRO_FETCH`), ASIC and SSRN hosts | 93a1131 | `tests/sentinel/cap.test.ts`, `scripts/macro/macro.test.mjs`, `tests/http/safeLink.test.ts`, `scripts/ci/licence-register.dat253.test.mjs`, `scripts/ingest/batch1.workflow.test.mjs` |
| E | E4 OPS-111 | measured-token reservation, resumed night counters, `critic_unavailable` row, error counter, bundle-break test, generated reader list, hash policy, masked health line, card walk | 7cba5fb | `tests/llm/measuredReservation.test.ts`, `tests/steelman/m18Residuals.test.ts`, `scripts/arena/signals.steelmanBreak.test.mjs`, `tests/security/steelmanBoundary.test.ts`, `scripts/ci/steelman-readers.test.mjs`, `tests/health/steelman.test.ts`, `tests/ui/steelmanCard.test.tsx`, `tests/docs/replayHashPolicy.test.ts`, `e2e/m11l-steelman.spec.ts` |
| E | E5 OPS-112 | weekly close needs the horizon bar or is marked `early`, AT-41 weekly run, refused reason, registered hosts | d77b467 | `tests/experts/calls.test.ts`, `tests/acceptance/v2/at41Replay.test.ts`, `tests/health/experts.test.ts`, `tests/ui/expertsPages.test.tsx`, `e2e/m13l-experts.spec.ts` |
| E | E6 TST-135, AT-39, AT-59 | six named e2e seed states, AT-39 clauses against `src/lib/kb/fetchRules.ts`, draw.io parse test | 0c2c9d4 | `tests/e2e/states.test.ts`, `tests/kb/fetchClauses.test.ts`, `tests/blueprint/drawio.test.ts` |
| E | E7 TST-136 | timing tests without retries (work-unit budgets, wall-clock variants, static no-retry test); explicit per-test limits | 475ac85, 574fafd | `tests/static/noRetry.test.ts`, `tests/timing/cohortReplay.wall.test.ts`, `worker/timing/m5Slots.wall.test.ts`, `worker/test/m5Slots.test.ts`, `tests/replay/cohortReplay.test.ts`, `tests/cortex/look.test.ts` |
| E | E8 TST-137, TST-139 | Owner-run checks (spot check, bake-off review, guide page), market matrix harness with the AU profile | 7c5a437 | `scripts/cortex/golden-spot-check.test.mjs`, `scripts/llm/bakeoff-review.test.mjs`, `tests/market/profiles.test.ts` |
| integration | gate fixes and follow-ups | suite fixes after merging B and C, migration renumbering, job registry slots, gate fixes 1 to 3, test-map baseline, cortex phone-width fix, D-069 scan mark | 85b1ac5, 4c65f06, c7552ae, c3ad1bd, 90171b5, 9da8543, 8ee3a79, 73ed784, b0685ca | the suites above |

## §3 Money-path gap table (OPS-106, D-952, AT-84)

The V3 spec names D-666, D-683/D-684, D-699 and R4-I3 without listing the gaps; the gaps were read from the decision log (`docs/M13L_design.md`) and two further accepted gaps on the money path were added (D-502/D-694, D-655). Every row has a verdict and a test or a detection; none is silent. "Closed" means the gap no longer exists; "re-accepted" means it stays by decision and the named detection tells the Owner when it happens.

| # | Gap | Decision | Verdict | Test or detection |
|---|---|---|---|---|
| 1 | A 2a that closes after the 18:10 2b slot leaves that night's 2b `skipped (no_2a_success)`. | D-666 | **Closed** by D-953 (stream A, task A4). The `arena-signals` slot has a recheck (`worker/src/schedule.ts`): from 18:25 to 18:40 Sydney a 2b that has not closed its night is dispatched again **once**, and only when 2a has a success/degraded record. `RECHECK_CLOSED_SQL` (`worker/src/clock.ts`) no longer counts a `no_2a_success` skip as closed. After 18:40 `signals.mjs` records the night as `degraded` with reason `late_2a` instead of a skip; batch 3 does not run on it. Scheduling only: no fill, order or decision changes, 2b's inputs are unchanged (AT-32 identity). | Test: `worker/test/recheck2b.test.ts` (18:12 with 2a running: no dispatch; 2a success at 18:31: exactly one re-dispatch and none on later ticks; 18:41: none; two racing ticks: one; other 2b outcomes never re-dispatched). `scripts/arena/signals.test.mjs` (18:30 and 18:40: skipped `no_2a_success`, exit 1; 18:41: `degraded` `late_2a`, exit 1, no review job). `tests/agents/batch3.test.ts` (a `late_2a` night is not reviewable). Detection if it still happens: the red `arena-signals` run (exit 1) and the degraded run record read by System Health and the Evening Review. |
| 2 | A held code with no price bar is marked at the last close (`Mark.stale`). | D-683, D-684 | **Re-accepted.** No price is invented; the mark stays at the last real close. | Detection: a `stale_mark` warn per code per day, one S2 `stale_mark` incident after `STALE_MARK_ALERT_SESSIONS` sessions in a row (`src/lib/arena/closeBooks.ts`), listed under open S2 incidents on System Health. Test: `tests/arena/cohortRecovery.test.ts` ("flags the stale mark, never invents a price, and opens one incident after the bounded run"). |
| 3 | The morning retry can reach the route inside the 60 s `RETRY_GAP` and burn one of the Worker's three attempts. | D-699 | **Re-accepted.** The third attempt succeeds in practice (the Worker retries on the next minute, three attempts in all, within the window). | Detection: `routeLines` (D-773) on System Health lists every failed post of a recurring route slot (`src/lib/health/routePosts.ts`). Tests: `tests/health/routePosts.test.ts`; `worker/test/m5Slots.test.ts` ("morning retries a failed post on the next minute, three attempts in all, within the window"). |
| 4 | A capped arena catch-up (R4-I3) writes a `catch_up_capped` skipped record, never closes a night, and the rest waits for the next dispatch. | D-833, D-834, D-835 | **Re-accepted as already detected.** | Detection: the `catch_up_capped` record, the red run and the attention line "Catch-up capped: n closed, m still to close. Dispatch Arena close again." on the `arena-close` row of System Health. Tests: `tests/health/summary.test.ts` ("R4-I3: capped arena catch-up on the jobs view"); `tests/arena/closeGap.test.ts` ("a catch_up_capped record never counts as closing a session"); `worker/test/recheck.test.ts` ("a catch_up_capped skipped record does not close the night: dispatch again"). |
| 5 | Quote-budget starvation: a held position's delayed price can go stale because the poll's budget is spent on armed picks first. | D-502, D-694 | **Closed** by OPS-109 c (stream A, task A3, D-971): the poll records `skipped` and the plan make-up per slot, System Health shows "Quotes HH:MM: used n, skipped m (armed a, watch w, held h)", and a pure check raises S2 `quote_starvation` once a day when a held code has had no fresh quote for 30 minutes inside session hours on a trading day. | Tests: `tests/alerts/starvation.test.ts` (fresh, 29, 30 and 31 minutes, no quote, weekend, outside hours); `tests/alerts/pollBudget.test.ts` ("quote budget: skipped, plan and the System Health line", "quote starvation incident"); `tests/health/summary.test.ts` ("the per-slot quote budget line"). Detection: the S2 incident and the Quotes lines. |
| 6 | A weekly horizon close can run one bar early (`closed_horizon`) when the horizon bar is not yet ingested. | D-655 | **Closed** by OPS-112 (1) (stream E, task E5, D-978): the weekly close requires the horizon session's bar when `d` equals the horizon session, else marks the outcome `early`. | Tests: `tests/experts/calls.test.ts` ("on the horizon session a missing bar waits; once the bar exists the call closes on it, not early"; "on a later run the bar is still missing: the call closes on its last bar and is marked early"; "calls closed on their own horizon bar, by target, by stop or with no bars are never early"); `tests/db/0033_m18_data.test.ts` ("expert_call_outcome.early defaults to 0 and is NOT NULL"). Detection: the `early` flag on the settled outcome. See also §5 (OPS-112 row 1). |

Notes for the reviewer (Fable, F task):

- Row 1 is the only change to Worker dispatch timing on the money path. The recheck reuses the existing claim/CAS in `worker_state` (one claim per attempt), so two ticks never dispatch the same attempt twice; `once` is enforced from the stored dispatch time (a dispatch made at or after 18:25 was itself the recheck), so no new table or run record is needed.
- The `needsKeyPrefix` condition reads `status IN ('success','degraded')` for `arena-2a:AU:<date>`, the same predicate as batch 2b's own `closedOk`, so a re-dispatched 2b can never land on `no_2a_success` again.
- A replay (`--replay`) never records `late_2a`: replays keep the skip, as before.

## §4 Ops and metering (OPS-103…OPS-105, PLT-080, D-958…D-963)

**[VERIFY] results for the Turso platform API (D-958), read from docs.turso.tech on 2026-11-11:**

- `GET https://api.turso.tech/v1/organizations/{slug}/usage` returns the organization's usage for the period (rows read, rows written, storage).
- `GET https://api.turso.tech/v1/organizations/{slug}` returns the organization, including `plan_id` (the plan name for the PLT-080 guard).
- Both are free to call; the token is a platform token, held only as a GitHub production-environment secret (`TURSO_PLATFORM_TOKEN_USAGE`) and used by one step of `turso-usage.yml`. The app holds no platform token. Whether Turso offers a read-only platform token was not established; the token's reach is wider than read-only until it is.
- Free plan figures (turso.tech/pricing, read 2026-11-11): 5 GB storage, 500 M rows read, 10 M rows written. The 20 % line is therefore 100 M reads and 2 M writes a month (the keys `turso_reads_ceiling_month` and `turso_writes_ceiling_month` default to those values; `tests/config/m18Keys.test.ts`).

**First `usage_sample` row.** No `usage_sample` row exists yet in production: the Owner has not added `TURSO_PLATFORM_TOKEN_USAGE`. Until then the job (and `sample` without the secret, which exits 0) writes `source = 'unavailable'` with no figures, the Usage page shows the labelled estimate and the plan reads "unknown". Row shape (`db/migrations/main/0031_m18_ops.sql`): `sampled_at` (key), `rows_read_month`, `rows_written_month`, `storage_bytes`, `plan_name`, `source` in (`platform`, `unavailable`); an `unavailable` row carries no figures by CHECK; the table refuses update (trigger).

| Item | Evidence |
|---|---|
| Sample parser, token never printed, no request without a token | `scripts/usage/turso-sample.test.mjs` ("sample: a platform row when both calls answer; the token goes only to api.turso.tech"; "sample: no token or no organization is 'unavailable' without any request"; "the log line never carries the token, the organization or a URL"; "store writes one usage_sample row to the database") |
| Meter levels, 15 % notice and 20 % ceiling | `tests/usage/tursoMeters.test.ts` ("notice and alert at the notice share of the ceiling, degrade at the ceiling"; "uses the platform figure against 20 % of the free plan and shows our count beside it"; "with no sample, an unavailable sample or an old one the meter is the labelled estimate") |
| Production workflow shape (approved-commit, no deployment, secret only in a step `env:`) | `scripts/usage/turso-usage.workflow.test.mjs`, `scripts/ci/staging-jobs.workflow.test.mjs` |
| Calendar draft job clock fixture (D-961) | `tests/calendar/draftJob.test.ts` for each market in `CALENDAR_MARKETS`: "2027-11-01: drafts next year as provisional rows, once, and writes a run record"; "2027-11-01: the Owner item is raised with the plain line, and it is not an incident"; "2027-12-01 unconfirmed: S2 calendar_unconfirmed"; "2028-01-01 unconfirmed: the provisional rows are in use, flagged, with an S2 incident"; "never touches a year that already has rows, and refuses past years" |
| Restore dry run (D-962) | `scripts/restore/dryRun.test.mjs` ("dry run: both databases restore from synthetic backups, the cohort replays, the files are removed"; "dry run from a backup folder: the real-key path reads local files, nothing leaves the machine"; "a damaged key or an empty folder fails closed and leaves nothing behind"; "record: one run_record row per successful run"); quarterly reminder `tests/health/restoreReminder.test.ts`; workflow `scripts/restore/restore-dry-run.workflow.test.mjs`. Log content: names and counts only |
| Plan guard (PLT-080, D-963) | `tests/health/tursoPlan.test.ts` ("the deadline is 1 December 2026"; "after 1 December a plan that is not Free is a red item with the plan name"), `tests/security/tursoFreePlan.test.ts` (no paid-feature use in `src`, `scripts`, `worker/src`) |
| No `OFFSET` (D-959), keyset paging | `tests/security/noOffsetPaging.test.ts` (empty allow-list, planted-query self-test); `tests/ui/loaders/newsPaging.test.ts` ("walks every page forwards, identical to the OFFSET pages"; "never repeats or skips an item when timestamps tie"); `tests/ui/loaders/reviewsPaging.test.ts`; retention boundary `tests/maintenance/retention.test.ts` |
| Nightly row-by-market invariant (D-960) | `tests/maintenance/rowsByMarket.test.ts` ("a planted foreign-market row alarms (S2) on an indexed table and on an unindexed one"; "runs inside the nightly maintenance route and a clean night stays a success"). Expected scan: k + 1 index seeks per indexed table (k = enabled markets), one GROUP BY scan for the few tables without a market-leading index (comment `rows-ok:` in `src/lib/maintenance/rowsByMarket.ts`). A measured night on production is not recorded yet |

Measured row scan of the nightly invariant and of the keyset pages on production: **not recorded** (needs the first production nights after deploy); the figures above are the stated expectation, not a measurement. The Usage page figure on the exit day is also not recorded, since no platform sample exists.

## §5 Residuals

### OPS-111 M11L residuals (D-977)

| # | Residual | Verdict | Reason | Test or detection |
|---|---|---|---|---|
| 1 | R6 rules-only | Re-accepted → LLM-077 (M22) | belongs to the model wiring in M22 | none in M18 |
| 2 | LLM-074 measured token counts replace the estimate | **Closed** (E4) | the router records the provider's returned counts per call; the reservation is the trailing measured mean per role with the estimate as the floor | `tests/llm/measuredReservation.test.ts` ("the estimate is the floor; a larger measured need (two calls) raises it"; "records the provider's returned counts, and a measured need above the estimate stops the call") |
| 3 | Partial persist: night counters on resume | **Closed** (E4) | `steelmanNight` resumes counters from the written `steelman_card` rows | `tests/steelman/m18Residuals.test.ts` (3): "a crash before the night row, then a re-run: the row equals an uninterrupted run (all points hidden)" |
| 4 | `critic_unavailable` call row | **Closed** (E4) | a `llm_call` row with provider `none` | `tests/steelman/m18Residuals.test.ts` (4): "one row per subject, no tokens, outcome critic_unavailable" |
| 5 | A test breaks the bundle build | **Closed** (E4, A4 file) | the bundle build fails, the run exits 0 and is `degraded` | `scripts/arena/signals.steelmanBreak.test.mjs` ("a steelman bundle that fails to build gives exit 0, one degraded line, and changes nothing") |
| 6 | Unexpected errors get their own count and text | **Closed** (E4) | `not_written_error` counter; "an unexpected error stopped this note" | `tests/steelman/m18Residuals.test.ts` (6); `tests/ui/steelmanCard.test.tsx` ("an unexpected error is not blamed on a missing model (OPS-111 (6), D-977)"); `tests/db/0033_m18_data.test.ts` |
| 7 | Card wording | Re-accepted → UXN-323 (M21) | UX wording pass is M21 | none in M18 |
| 8 | Editor/Viewer card e2e | **Closed** (E4) | rich-lane walk | `e2e/m11l-steelman.spec.ts` ("owner: two lists, evidence chips jump to the cited rows, caption says AI-written"; the per-role `/review` and card tests); the spec is listed in its lane by `scripts/ci/e2e-listing.test.mjs`. Not run on this machine |
| 9 | Reader-file guard gains a generated list | **Closed** (E4, D-985) | list generated from the import graph | `tests/security/steelmanBoundary.test.ts`, `scripts/ci/steelman-readers.test.mjs`, `tests/security/steelman-readers.json` |
| 10 | Reflections | Re-accepted → AGT-146 (M22) | belongs to M22 | none in M18 |
| 11 | AT-32 runs the bundle path once in CI | **Closed** | the recorded-day job runs the bundle path (D-965); `at32Steelman` keeps the in-process hash | `scripts/e2e-day/recorded-day.test.mjs` (plan runs 2b with the steelman bundle); CI job `recorded-day` |
| 12 | Wall-clock columns documented in the hash policy | **Closed** (E4) | `docs/runbooks/replay-hash-policy.md` names the three dropped columns | `tests/docs/replayHashPolicy.test.ts` ("the test drops three columns"; "the page names each dropped column in its table row and nothing else as dropped") |
| 13 | Masked health line carries no code, name or date | **Closed** (E4) | masking asserted | `tests/health/steelman.test.ts` ("every shape reads as fixed words and counts: no code, name or date"; "the scan itself catches a code, a name and a date (self-test)") |

### OPS-112 M13L residuals (D-978)

| # | Residual | Verdict | Reason | Test or detection |
|---|---|---|---|---|
| 1 | Horizon close waits for the bar or marks "early" | **Closed** (E5) | needs the horizon session's bar when `d` equals the horizon session, else `early` | `tests/experts/calls.test.ts` (three cases, see §3 row 6); `tests/db/0033_m18_data.test.ts` |
| 2 | Expert document links for registered hosts, text otherwise | **Closed** by D-975 | three registered hosts, tested | `tests/http/safeLink.test.ts` ("are asx.com.au, asic.gov.au and ssrn.com"; "an off-list host is refused, including look-alikes"); `tests/ui/expertsPages.test.tsx` ("the Owner sees an ASIC and an SSRN link as links and a look-alike host as text (D-975)") |
| 3 | AT-41 weekly-run hash with eligible clusters | **Closed** (E5) | fixture hash | `tests/acceptance/v2/at41Replay.test.ts` ("hashes equal; the expert side was not empty (c)"; "a second run of the weekly steps moves nothing, and the hash holds") |
| 4 | Merge gate runs the security tests of both sides | **Closed** | `tests/security/*` run in the `app` and `recorded-day` jobs on the merged tree by construction | `docs/runbooks/gates.md` ("Merged-tree security tests (D-978 item 4)"); CI |
| 5 | `m13l-experts.spec.ts` runs | **Closed** by the rich lane (D-966) | listed in exactly one lane | `scripts/ci/e2e-listing.test.mjs`; `e2e/m13l-experts.spec.ts`. Not run on this machine |
| 6 | Health line date masking | **Closed** (E5) | ISO-week masking asserted | `tests/health/experts.test.ts` ("turns the screening date into an ISO week in both the field and the text") |
| 7 | Refused proposal rows show their reason | **Closed** (E5) | loader and page | `tests/ui/expertsPages.test.tsx` ("a refused proposal row shows its reason text on the page and in the loader") |
| 8 | Calls | Re-accepted → KB-084 (M22) | belongs to M22 | none in M18 |
| 9 | Licence status | Re-accepted → KB-083 (M22) | red flags stay source and date only (already tested) | none new in M18 |
| 10 | Hash policy as OPS-111 (12) | **Closed** | one page for both | `tests/docs/replayHashPolicy.test.ts` |

## §6 Data and ARN-123 (DAT-251…DAT-253, ARN-123)

**DAT-251 a, ASX request failures (D-972, D-981…D-983).** Planted failures are classified per request as `not_found`, `rate_limited`, `server_error`, `network` or `parse` (`scripts/asx/fetch.causes.test.mjs`: "planted 404 / 429 / 500 / parse / network are classified per request"); 401 and 403 are `server_error`, never `not_found`; a parse failure records the body's SHA-256 only; a 429 widens the gap by `Retry-After` then doubling; an 8-minute run budget stops the history loop. Three consecutive `not_found` runs mark a code `delisted` and drop it from the history list, one answer in between resets the count (`scripts/asx/ingest.test.mjs`). The target of fewer than 10 failures per run is measured after merge (§9).

**DAT-251 b, news cap (D-954, D-984).** The key `sentinel_max_items_per_run` is renamed `news_assess_per_run` (default 40, bounds 20 to 200; migration `0031_m18_ops.sql`); the effective per-call cap is the minimum of the key, the LLM headroom and the Turso cap (40 at `notice` or worse); the unassessed count is a System Health line. Proof: `tests/sentinel/cap.test.ts` ("is Owner-editable, default 40, bounds 20 to 200, and the old key is gone"; "a sample at the notice share (15 % of the plan) caps a raised key back to 40"), `tests/config/m18Keys.test.ts`, `tests/health/dataLines.test.ts` (news line: counts only).

**DAT-251 c, RBA and ABS (D-973).** Fixture parse: `scripts/macro/macro.test.mjs` ("the RBA F1 fixture: only the allowlisted series, empty cells skipped, 400-day window"; "the ABS fixture: SDMX-CSV rows in any order, bad periods dropped, sorted by day"; "the RBA run writes rows once, sends If-Modified-Since next time, and a repeat writes nothing"). Ships **off**: the Friday step of `ingest-batch1.yml` runs only when the repository variable `MACRO_FETCH` is set (`scripts/ingest/batch1.workflow.test.mjs`).

**DAT-252 fallback and split-day frequency (D-974, D-980).** The Wikidata fallback fires only on the third consecutive failed run (counting the current one) and only when the `wikidata_asx` register row is enabled: `scripts/asx/fallback.test.mjs` ("two failed runs (stored 1 plus this one): no request to Wikidata"; "third failed run but the register row is disabled: no request"; "third failed run with the row enabled: exactly one request, CSV accepted"). The register row is seeded `disabled`. Split-day frequency: the read-only `splitFrequency` diagnose scenario is built and tested (`tests/data/splitFrequency.test.ts`, hand table), but the **production figures were not produced yet**: they need the Owner to dispatch `diagnose-signals` with `scenario=splitFrequency` (§9). Not recorded.

**DAT-253 source hosts (D-975).** `SOURCE_HOSTS` is `asx.com.au`, `asic.gov.au`, `ssrn.com` (`tests/http/safeLink.test.ts`); register rows `asic_documents` and `ssrn_papers` are seeded `pending` with unverified terms (`tests/db/0033_m18_data.test.ts`: "the DAT-253 register rows are pending, logged"; `scripts/ci/licence-register.dat253.test.mjs`). M18 stores no document text.

**ARN-123 dividends in pick tracking (D-956).** Discrepancy found: before D-956 the picks track record was price only (`track.ts` net = qty × exit − brokerage − cost), while the market benchmark is total return (D-490) and the books credit dividends, so "vs market" was biased against the pick. Fix, for new settlements only: `close()` credits confirmed cash and special dividends going ex after the fill session and on or before the exit session, with the quantity re-based after a split, and records `outcome_basis` (`price_only` for existing rows, `total_return` for new ones; migration `0032_m18_outcome_basis`). Closed rows are never rewritten (trigger; `tests/db/0032_m18_outcome_basis.test.ts`: "a row reads price_only until a settlement writes total_return; a closed row never changes"). The labels follow the row, so the track record shows two labels for a while. Proof: `tests/picks/dividendOutcome.test.ts` ("0.50 ex on the second held session lifts net by qty x 0.50 to the micro"; "the same run without the credit flag is price only and byte-identical to before"; the ex-date edge cases; the split case) and `tests/acceptance/v2/at35.test.ts` (clause c).

## §7 Acceptance

Reports: `docs/test-reports/AT-83.md`, `AT-84.md`, `AT-85.md`, `AT-81.md`, and the appended clause (c) in `AT-35.md`. A report states a result only where it was observed; "see CI run on the PR head" means the result belongs to the CI run on the head commit of the V3 PR, not to this document.

| Test | Result here | Report |
|---|---|---|
| AT-83 live-risk and ops | automated clauses written and mapped; local run recorded in the report; smoke stage 2 after deploy is the Owner's | `docs/test-reports/AT-83.md` |
| AT-84 staging retired, recorded day, gap table | gate and workflow tests written; recorded-day job: see CI run on the PR head | `docs/test-reports/AT-84.md` |
| AT-85 test debt | listing, states, AT-39, timing, test map, scripts, AU matrix; IN/US clause is M19 | `docs/test-reports/AT-85.md` |
| AT-81 (M18 part) | classification, delisting, cap, RBA/ABS fixtures, fallback, off-list host | `docs/test-reports/AT-81.md` |
| AT-35 (c) | dividend credited on the pick side; `price_only` rows unchanged | `docs/test-reports/AT-35.md` |
| AT-32 identity | existing report re-run: see CI run on the PR head (recorded-day job runs the bundle path) | `docs/test-reports/AT-32.md` |
| AT-26 re-run | the a11y, mobile, Lighthouse and keyboard lanes run in the CI e2e lanes (D3): see CI run on the PR head. (s11) is an **Owner-executed** manual check; precondition: the deploy of the PR head to production | `docs/test-reports/AT-26.md` |
| AT-30 re-run | **Owner-executed**. Preconditions recorded: rotate-secrets runbook written (`docs/runbooks/rotate-secrets.md`), restore dry run automated (`scripts/restore/dryRun.test.mjs`), release gate re-homed to CI (D-964); each is "ready", nothing is signed off | `docs/test-reports/AT-30.md` |

CI: the latest `build` CI runs known when this was written are 43019668103 (head `056ec53`) and the run on `b0685ca` (in progress). The result for the final head is "see CI run on the PR head"; check it with `gh run list` after the push, since a local pass is not a CI pass.

## §8 Constraints

| Constraint | Evidence (2026-11-11, `b0685ca`, Windows build machine) |
|---|---|
| Turso FREE plan, at most 20 % | keyset paging, bounded aggregates, 20 % ceilings in the keys; the Usage page figure on the exit day is not recorded (no platform sample yet, §4) |
| Zero `OFFSET` | `git grep -nE "\bOFFSET\s+(\?\|[0-9]+)" -- src scripts` prints nothing (exit 1); `tests/security/noOffsetPaging.test.ts` |
| Hygiene | `npm run -s test:hygiene`: "repo-hygiene: OK (no data-like files, private paths or personal data)" |
| Decision index | `node scripts/ci/decision-index.mjs --check`: exit 0 after regeneration for D-951…D-989 |
| Config reference | `npm run -s test:config-reference`: exit 0 |
| Production markets | AU only (`markets_enabled = ["AU"]`); `tests/market/profiles.test.ts` ("production runs AU in full and nothing else") |
| ASX Worker | `ASX_LIVE` off (blocked by ASX since 2026-11-02); ASX data only through the GitHub `asx-fetch` job |
| No staging | retired (D-964); no `PRAXIS_ENV=staging` path added; recorded-day uses `PRAXIS_ENV=recorded` |
| Market literals | no `IN`, `US`, `Asia/Kolkata` or `America/New_York` added outside the AU profile fixtures (M19 owns the profile); checked: `git diff 63d6868 b0685ca -- src scripts worker/src .github` has no added line matching them |
| Cost | $0: no new provider, plan or paid API |
| gitleaks | runs in CI: see CI run on the PR head |

## §9 Owner steps for the PR

1. Add the repository secret `TURSO_PLATFORM_TOKEN_USAGE` in the production environment (D-958); until then the meter is the labelled estimate.
2. Downgrade Turso to the Free plan before 1 December 2026 (PLT-080).
3. Rotate secrets and revoke the PAT (OPS-108; `docs/runbooks/rotate-secrets.md`).
4. Run smoke stage 2 after the deploy (SEC-115, HMAC v2); Vercel and the Worker must deploy together, or a v1-signed Worker call between the two deploys is refused (401).
5. Set the repository variable `MACRO_FETCH` after accepting the RBA and ABS terms (D-973).
6. Enable the `wikidata_asx` register row if the Owner accepts the risk (D-974).
7. ASIC and SSRN register rows stay `pending`; their terms are unverified (D-975).
8. Do the golden-set spot check and the bake-off review (TST-137; `docs/owner-guide/owner_checks.md`).
9. Optionally list the new slots `calendar-draft` and `turso-usage` on the go-live list.
10. Measure ASX failures over the first five production runs (target: fewer than 10 per run; D-972).
11. Dispatch `diagnose-signals` with `scenario=splitFrequency` and paste the figures into §6.
12. Run the AT-26 (s11) manual check and the AT-30 sign-off; do the quarterly real-key restore drill when due (OPS-105).

## §10 BUILD_SETUP

BUILD_SETUP §9 "V3 current milestone" and "V3 last step done / next step" are in another repository and are updated by the orchestrator (M18 done; next: M19 requirements extract).

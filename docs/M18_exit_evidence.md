# M18 exit evidence: live-risk fixes, ops and test debt (V3)

Design: `docs/M18_design.md`. Requirements: `docs/M18_requirements.md`. Each section below is filled by the task that owns it; a section that is still a placeholder is not yet evidence.

## §1 OPS-110 Production picks 0 since 26 October

_Placeholder: the night-by-night table (U1 size, candidates, first failing gate with its CTX-013 label, family status, `holdout_look` and ledger-row counts) is written by task 1 (D-951)._

## §3 Money-path gap table (OPS-106, D-952, AT-84)

The V3 spec names D-666, D-683/D-684, D-699 and R4-I3 without listing the gaps; the gaps were read from the decision log (`docs/M13L_design.md`) and two further accepted gaps on the money path were added (D-502/D-694, D-655). Every row has a verdict and a test or a detection; none is silent. "Closed" means the gap no longer exists; "re-accepted" means it stays by decision and the named detection tells the Owner when it happens.

| # | Gap | Decision | Verdict | Test or detection |
|---|---|---|---|---|
| 1 | A 2a that closes after the 18:10 2b slot leaves that night's 2b `skipped (no_2a_success)`. | D-666 | **Closed** by D-953 (stream A, task A4). The `arena-signals` slot has a recheck (`worker/src/schedule.ts`): from 18:25 to 18:40 Sydney a 2b that has not closed its night is dispatched again **once**, and only when 2a has a success/degraded record. `RECHECK_CLOSED_SQL` (`worker/src/clock.ts`) no longer counts a `no_2a_success` skip as closed. After 18:40 `signals.mjs` records the night as `degraded` with reason `late_2a` instead of a skip; batch 3 does not run on it. Scheduling only: no fill, order or decision changes, 2b's inputs are unchanged (AT-32 identity). | Test: `worker/test/recheck2b.test.ts` (18:12 with 2a running: no dispatch; 2a success at 18:31: exactly one re-dispatch and none on later ticks; 18:41: none; two racing ticks: one; other 2b outcomes never re-dispatched). `scripts/arena/signals.test.mjs` (18:30 and 18:40: skipped `no_2a_success`, exit 1; 18:41: `degraded` `late_2a`, exit 1, no review job). `tests/agents/batch3.test.ts` (a `late_2a` night is not reviewable). Detection if it still happens: the red `arena-signals` run (exit 1) and the degraded run record read by System Health and the Evening Review. |
| 2 | A held code with no price bar is marked at the last close (`Mark.stale`). | D-683, D-684 | **Re-accepted.** No price is invented; the mark stays at the last real close. | Detection: a `stale_mark` warn per code per day, one S2 `stale_mark` incident after `STALE_MARK_ALERT_SESSIONS` sessions in a row (`src/lib/arena/closeBooks.ts`), listed under open S2 incidents on System Health. Test: `tests/arena/cohortRecovery.test.ts` ("flags the stale mark, never invents a price, and opens one incident after the bounded run"). |
| 3 | The morning retry can reach the route inside the 60 s `RETRY_GAP` and burn one of the Worker's three attempts. | D-699 | **Re-accepted.** The third attempt succeeds in practice (the Worker retries on the next minute, three attempts in all, within the window). | Detection: `routeLines` (D-773) on System Health lists every failed post of a recurring route slot (`src/lib/health/routePosts.ts`). Tests: `tests/health/routePosts.test.ts`; `worker/test/m5Slots.test.ts` ("morning retries a failed post on the next minute, three attempts in all, within the window"). |
| 4 | A capped arena catch-up (R4-I3) writes a `catch_up_capped` skipped record, never closes a night, and the rest waits for the next dispatch. | D-833, D-834, D-835 | **Re-accepted as already detected.** | Detection: the `catch_up_capped` record, the red run and the attention line "Catch-up capped: n closed, m still to close. Dispatch Arena close again." on the `arena-close` row of System Health. Tests: `tests/health/summary.test.ts` ("R4-I3: capped arena catch-up on the jobs view"); `tests/arena/closeGap.test.ts` ("a catch_up_capped record never counts as closing a session"); `worker/test/recheck.test.ts` ("a catch_up_capped skipped record does not close the night: dispatch again"). |
| 5 | Quote-budget starvation: a held position's delayed price can go stale because the poll's budget is spent on armed picks first. | D-502, D-694 | **Closed** by OPS-109 c (stream A, task A3, D-971): the poll records `skipped` and the plan make-up per slot, System Health shows "Quotes HH:MM: used n, skipped m (armed a, watch w, held h)", and a pure check raises S2 `quote_starvation` once a day when a held code has had no fresh quote for 30 minutes inside session hours on a trading day. | Tests: `tests/alerts/starvation.test.ts` (fresh, 29, 30 and 31 minutes, no quote, weekend, outside hours); `tests/alerts/pollBudget.test.ts` ("quote budget: skipped, plan and the System Health line", "quote starvation incident"); `tests/health/summary.test.ts` ("the per-slot quote budget line"). Detection: the S2 incident and the Quotes lines. |
| 6 | A weekly horizon close can run one bar early (`closed_horizon`) when the horizon bar is not yet ingested. | D-655 | **Closed** by OPS-112 (1) (stream E, task E5, D-978): the weekly close requires the horizon session's bar when `d` equals the horizon session, else marks the outcome `early`. | Test and detection are written by task E5 (`tests/experts/*.test.ts`, evidence §5 row 1); this row is completed when E5 merges. |

Notes for the reviewer (Fable, F task):

- Row 1 is the only change to Worker dispatch timing on the money path. The recheck reuses the existing claim/CAS in `worker_state` (one claim per attempt), so two ticks never dispatch the same attempt twice; `once` is enforced from the stored dispatch time (a dispatch made at or after 18:25 was itself the recheck), so no new table or run record is needed.
- The `needsKeyPrefix` condition reads `status IN ('success','degraded')` for `arena-2a:AU:<date>`, the same predicate as batch 2b's own `closedOk`, so a re-dispatched 2b can never land on `no_2a_success` again.
- A replay (`--replay`) never records `late_2a`: replays keep the skip, as before.

## §5 Residuals

_Placeholder: OPS-111 and OPS-112 tables are written by streams E (D-977, D-978)._

## §6 ARN-123 dividends in pick tracking

_Placeholder: written by the ARN-123 task (D-956)._

# M3 exit evidence (AT-10, AT-11, AT-12, AT-13)

Status date: 2026-10-11. Branch `build`. Source rows: [spec/14_system_acceptance.md](../spec/14_system_acceptance.md) section 14.1. Test files are listed in [test-map.md](test-map.md). Requirements: [M3_requirements.md](M3_requirements.md). Design: [M3_design.md](M3_design.md).

Overall: the practice-engine code (batch 2a, "close the books") is built and passes its local tests. The staging run (TST-115) is **pending**. M3 exit is **met locally, not yet on staging**.

## Commits

| Commit | Task | Decision |
|---|---|---|
| 0de1bac | M3 requirements extract | |
| 90a439f | M3 design | D-069 |
| 65b417a | T1 + T4 money library, migration 0007 | D-070 |
| 40beafa | T2 + T3 cost profiles, slippage, TST-101 table | D-071 |
| 9a92784 | T5 sizing and fills | D-072 |
| 53fea29 | T6 ledger, settlement, NAV | D-073 |
| a4dfaea | T7 corporate-action cash effects | D-074 |
| 5237ed4 | T8 sleeve engine | D-075 |
| b268a02 | T9 executions, cohorts, terminal states | D-076 |
| 8327a40 | T10 batch 2a orchestrator, workflow, replay | D-077 |
| (uncommitted) | T11 acceptance tests, test map, this page | |

CI status: the local gate passes (format, lint, typecheck, tests, hygiene). Remote CI for the T11 change has not run, because nothing is committed or pushed yet.

## Test counts

`tests/arena/acceptance.test.ts` adds 7 acceptance tests (about 7 s). Full suite totals are in the T11 gate report.

## AT checklist

- **AT-10 All TST-101 cases pass exactly: met locally.** 43 of 43 cases in `tests/fixtures/arena/tst101_public.json` run in `tests/arena/tst101.test.ts`; none deferred. Completeness check in `acceptance.test.ts` ("AT-10"). The full private table runs only in the `fixtures` CI job.
- **AT-11 25 executions and controls start with A$600; golden paths reach each terminal state; effective N matches the fixture: met locally.** `cohort.test.ts` (253 cohorts, all A$600, balanced seed entries), `terminal.test.ts` (target, bust, stalled (a) and (b), timeout), `acceptance.test.ts` ("AT-11"). C1 uses a placeholder ETF code and C2/C3 do not choose entries yet (M4).
- **AT-12 Property tests and a 3-year golden replay show no invariant violation: met locally.** `ledgerProperty.test.ts` (random sequences, 1,000 days), `replay.test.ts` (780 sessions, every stored day passes ARN-101, all four terminal states occur), short replay in `acceptance.test.ts`.
- **AT-13 Two replays give byte-identical trade lists and NAV series: met locally.** `replay.test.ts` (3 years, recorded digest), `acceptance.test.ts` (60 sessions), `ledgerProperty.test.ts`.

## Decisions

D-069 (design), D-070 (money, migration 0007), D-071 (costs, slippage, table rulings), D-072 (sizing, fills), D-073 (ledger), D-074 (corporate actions), D-075 (sleeve), D-076 (cohorts, terminal states), D-077 (batch 2a, stage order). All are in [07_decision_log.md](07_decision_log.md).

## Open / pending

- (a) **TST-115 staging run with recorded data is PENDING.** Staging is deployed only from `main` at the next review point. Migration 0007 is not applied anywhere yet.
- (b) **Owner [VERIFY] approvals before `full` mode:** A$500 parcel; P0 to P5b cost tables; tick table; 9 % financing; sleeve cost profile; brokerage-beyond-margin ruling; `c1_etf_code`; stall and timeout key bounds.
- (c) **Spec amendments to record:** ch.13 / ARN-060 2a/2b/3 split and stage order (D-077); ch.05 financing divisor of 365 (D-069 item 8).
- (d) **M4 items:** batch 2b and 3, signals, C2 entry selection, order rescaling across ex-dates (`order_qty_stale`).
- (e) Worker slot `arena-close` is disabled.
- (f) M2 follow-up still open: ASX by-date backfill.

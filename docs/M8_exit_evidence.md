# M8 exit evidence (AT-28, AT-29, AT-30, AT-31 and all previous)

Status date: 2026-10-21. Branch `build` (worktree branch `m8-t18`). Source rows: [spec/14_system_acceptance.md](../spec/14_system_acceptance.md) section 14.4. Test files are listed in [test-map.md](test-map.md) (M8 rows); one report per acceptance test is in [test-reports/](test-reports/). Requirements: [M8_requirements.md](M8_requirements.md). Design: [M8_design.md](M8_design.md). Owner script: [owner-guide/M8_go_live.md](owner-guide/M8_go_live.md). Hand-off: [m8-handoff.md](m8-handoff.md).

Overall: M8 is **met locally for every agent row**. The staging pipeline, the staging end-to-end day tooling, the security tests, the restore drill, the go-live controls, the release gate, the test-suite completeness tools, the configuration reference, the licence register, the README and the Owner guide are built and pass their local unit, component, script and workflow tests on synthetic data. The rows that need the Owner, staging or production are **pending**, not faked: no staging day has run, no secret was rotated, no real-key restore drill was run, no sign-off was recorded, and migrations main 0007 to 0012 and auth 0004 to 0006 are applied nowhere. M8 exit is **met locally, not yet on staging or in production**. Production stays `data_only` until the Owner signs off (BLD-030).

## Commits

Range `2c73036^..HEAD`. The M7 T20 commits (c4df16f, 4ea7510, 4a83769, 8c9966c) ran in parallel with the first M8 groups and are the M8 task T1 carry-in. Each group was integrated and passed the full gate on `build` before it was pushed. Decision-log rows D-152 to D-161 are in [07_decision_log.md](07_decision_log.md).

| Commit | Task | Decision |
|---|---|---|
| 2c73036 | M8 requirements extract | |
| da3ad32 | M8 design and architect decisions (49, all option A) | D-152 |
| fc40fd0 | T2 configuration reference and [VERIFY] registry | |
| c4df16f, 4ea7510, 4a83769 | T1 / M7 T20a, T20b: licence, bundle-budget, readability and Lighthouse checks; first-load JS inside the budgets; pending licences block only the release | D-153 |
| 494962f | Regenerate About notices after installing the locked dev dependencies | |
| 33b063e | T4 security tests; stored announcement URLs checked (`safeSourceUrl`) | D-154 |
| 003bc04 | T5 carried code items (D-102, D-105, D-147, KB-051, LLM-042) | D-154 |
| a523121 | group 2 integration of T4 and T5; bake-off card on Usage, incident email env for batch 3 | D-154 |
| 791bd7f | Tests: 30 s hook limit; hygiene-safe URLs in the display-text test | |
| d8635ab | T7 restore-drill workflow and scripts | D-155 |
| 9e4087c, 99e422f | T8 Worker slot switches, workflow re-enable, bake-off slot; the slot list gates only go-live slots | D-155 |
| b859da7 | T9 staging jobs in the pipeline workflows, recorded-day source | D-155 |
| c4b85dc | M7 complete; M8 T7 to T9 integrated | D-155, D-156 |
| 8c9966c | M7 T20c plain-English wording (UXN-030) and AT-25 to AT-27 suites | D-156 |
| 532ab30 | Tests: go-live slots are listed-only since T8 | D-155 |
| a1a217d, 1a9b1f1 | T10 `ensureCohorts` and its real-night test | D-157 |
| ccfd010, 7625315 | T11 go-live controls; email cannot be switched off while a market is `full` | D-157 |
| 317b8c3 | D-157 (T10, T11) | D-157 |
| 0284d2f | T15 README, `.env.example` audit, env-names check | |
| b4d9f67 | T16 test-report skeletons AT-01 to AT-31 | |
| eafb5c9, 198c35e | T12 deadline checker, staging E2E day, ZAP, nightly and mutation workflows; local ZAP waits for a pinned digest | D-158 |
| 5787b35, dea1354 | T3 test map, diff coverage, coverage floors, quarantine (TST-131: back in the suite within 2 days) | |
| d5f2ba2 | group 3 and 4 integration: migration count tests at v12, health stub, CI-only names ignored by env-names | |
| a3675c3 | T13 Owner go-live guide, secret-store table, rotation page | D-159 |
| 4439e44 | T14 source-licence register | D-159 |
| da7e807 | T13 and T14 integrated; test identity in the GitHub staging environment | D-159 |
| 649afa1, b777ded | Watchdog Worker slots at 20:40 and 21:50, listed-only | D-160 |
| 683de16, 7f166f5 | T6 workflow lint, log-content tests, release-gate core and CLI | D-161 |
| fc331fa | T17 CI wiring: final job list, Stryker dev dependencies, hashed `requirements-audit.txt` | D-162 |
| b67aa06 | T18 exit evidence, hand-off note, minutes table, test reports | D-163 |

## Test counts

Last full runs recorded in the decision log (D-161) and used here; not re-run for this note (the machine was shared with the CI-wiring builder):

- Vitest (`npx vitest run`): **6,276 passed**.
- Script tests (`npm run test:smoke`, node:test): **585** at D-161; run again for this note after adding the 4 minutes-table tests: 590 tests, 589 passed, 0 failed, 1 `todo` (the ZAP image digest is still the all-zero placeholder, on purpose until the Owner pins it).
- Route coverage (`npm run test:routes`): **83** routes and actions, all listed and tested.
- Test-map check (`node scripts/ci/test-map.mjs`): 489 baseline IDs, 514 current IDs, green; the baseline file was not changed by this task.
- Playwright was not run for this note. The M7 numbers stay as recorded in [M7_exit_evidence.md](M7_exit_evidence.md) (populated 188 passed, empty 196 passed, flaky ones passed on retry under memory pressure); the new `e2e/security-headers.spec.ts` and `e2e-staging/staging.spec.ts` run in CI and on staging.
- Final CI job list on `build`: `app`, `e2e`, `secrets`, `worker`, `fixtures`, `python` (hashed install), `audit` (npm audit app and worker, pip-audit), `coverage` (floors, worker floors, diff coverage, test map, quarantine), `checks` (workflow lint, env names, config reference), and `release-gate` (pull requests into `release` only, infrastructure mode); the first green CI run on `build` with these jobs is recorded by the next session
- Coverage floors (80 % overall, 90 % on money, statistics, rule interpreter, auth and roles, Worker scheduling): enforced in `vitest.config.mts` and `worker/vitest.config.mts`; current coverage figures: the `coverage` job runs on Linux CI; the local Windows runs could not finish (timeouts and a native worker crash), so the first CI result is the evidence

### CI minutes table (decision 49, BLD-023, TST-132)

Built by `node scripts/ci/minutes-table.mjs` from a read-only `gh api repos/<owner>/<repo>/actions/runs --paginate` answer (run on 2026-10-21 on the orchestrator's machine; no workflow, no new token; the answer was not stored). Wall-clock minutes per workflow, completed runs from 2026-10-08 to 2026-10-21. Jobs that run in parallel are not added up and billing rounds each job up, so billed minutes can be higher. Standard-runner minutes on the public code repository are free (O-29), so there is no hard monthly cap; the table is information only (BLD-023). A refresh after T17 and after the staging proof is part of the hand-off.

| Workflow | Runs | Success | Failure | Other | Minutes (wall) | Average | Longest | Share |
|---|---|---|---|---|---|---|---|---|
| CI | 111 | 92 | 15 | 4 | 511.8 | 4.6 | 18.1 | 90.8 % |
| Deploy production | 4 | 3 | 1 | 0 | 26.7 | 6.7 | 19.8 | 4.7 % |
| Credential smoke test (stage 1) | 6 | 2 | 4 | 0 | 5.1 | 0.9 | 2.6 | 0.9 % |
| Deploy staging | 4 | 3 | 1 | 0 | 5.0 | 1.2 | 1.7 | 0.9 % |
| CodeQL | 2 | 2 | 0 | 0 | 3.7 | 1.9 | 1.9 | 0.7 % |
| Push on release | 3 | 3 | 0 | 0 | 3.4 | 1.1 | 1.9 | 0.6 % |
| Scheduled | 2 | 2 | 0 | 0 | 2.5 | 1.2 | 1.8 | 0.4 % |
| PR #12 | 1 | 1 | 0 | 0 | 1.4 | 1.4 | 1.4 | 0.2 % |
| Validate Environment Secrets | 4 | 0 | 4 | 0 | 0.9 | 0.2 | 0.3 | 0.2 % |
| PR #10 | 1 | 1 | 0 | 0 | 0.9 | 0.9 | 0.9 | 0.2 % |
| PR #7 | 1 | 1 | 0 | 0 | 0.7 | 0.7 | 0.7 | 0.1 % |
| PR #6 | 1 | 1 | 0 | 0 | 0.7 | 0.7 | 0.7 | 0.1 % |
| CodeQL Setup | 1 | 1 | 0 | 0 | 0.6 | 0.6 | 0.6 | 0.1 % |
| ZAP baseline | 3 | 0 | 0 | 3 | 0.3 | 0.1 | 0.3 | 0.1 % |
| M0 failure-email test | 1 | 0 | 1 | 0 | 0.1 | 0.1 | 0.1 | 0.0 % |
| **Total** | 145 | | | | 563.7 | | | |

"ZAP baseline" shows "Other" (skipped) for all three runs: the local scan is gated on `ZAP_IMAGE_PINNED`, which the Owner has not set (D-158). The new M8 workflows have not run yet on the remote.

## AT checklist

- **AT-28 Staging end-to-end day: met locally, staging runs pending.** Evidenced locally: the deadline checker (`src/lib/runs/deadlines.ts`, `scripts/e2e-day/check.mjs`) reports every PLT-073 step as on time, late, missing or not due for a normal day, an early-close date and both daylight-saving dates; its start-time table is cross-checked against spec ch.13 and the Worker slot times; `ensureCohorts` opens the 253 first cohorts at A$600 on an empty database, idempotently and only in `full` mode (D-157); the staging job exists in each of 11 pipeline workflows with no ASX, Yahoo or ASIC host and only staging secrets, and every production job equals its stored copy (D-155); the recorded-day reader and re-dating mapper pass their property tests. **Pending (Owner):** the full recorded day on staging, the cold-start day on a fresh empty staging database, and the recorded fixtures day itself (the fixtures repo must hold one AU day in the layout of decision 31). Report: [test-reports/AT-28.md](test-reports/AT-28.md).
- **AT-29 Security baseline: met locally, ZAP and settings pending.** Evidenced locally: every gated write route and all 34 server actions refuse 10 bad-origin variants with 403; every GET and HEAD leaves both databases unchanged; a failing rate-limit store gives 503 and no write; malformed, oversized and wrong-typed input gives a 4xx and no write; stored announcement URLs reach `href` only through `safeSourceUrl` (a real gap found and fixed, D-154); the header set is tested in unit and in `e2e/security-headers.spec.ts`; ZAP and audit summary scripts print rule, risk and count only; the workflow lint (AT-05a) finds nothing outstanding except the two recorded deploy-file exceptions (D-161). **Pending:** the local ZAP scan (needs the Owner to pin the image digest and set `ZAP_IMAGE_PINNED`), the authenticated staging ZAP scan, the CI audit result `audit` job: production tree 0 findings; 5 dev-only high findings (braces chain, no fixed release) are listed exceptions expiring 2026-11-20 (D-162, Owner to confirm); the local ZAP scan waits for the pinned image (D-158), and the dated GitHub settings (CodeQL, Dependabot alerts, secret scanning, push protection). Report: [test-reports/AT-29.md](test-reports/AT-29.md).
- **AT-30 Rotation, drill, walkthrough, sign-off: tooling met locally, every Owner step pending.** Evidenced locally: the secret table equals SEC-017, `.env.example`, every `secrets.X` in the workflows and the 17 expiry names (D-159); the restore-drill workflow and scripts pass against a fake Turso Platform API (throwaway databases always deleted, decrypt and verify in memory first, check-cohort NAV identical, last step fails while the temporary secrets exist, `verify-removed` follows, D-155); the go-live sign-off table (migration main 0012) is append-only, `full` is refused in production without a sign-off row or with email off, and `/ops/go-live` is Owner-only, audit-first and typed-phrase protected (D-157); the release gate fails closed (D-161). **Pending (Owner):** PAT revocation and bot removal, rotation of every secret in the guide's order, smoke tests, the first real-key restore drill, the $0 check over 10 providers, the production walkthrough with the AT-26 keyboard and screen-reader check, backup codes, the in-app sign-off, and the switch-on order. Report: [test-reports/AT-30.md](test-reports/AT-30.md).
- **AT-31 Test-suite completeness: met locally, three CI facts pending.** Evidenced locally: the generated test map and its baseline (no ID loses its last test), the diff-coverage gate on fixtures, the coverage floors, the quarantine check (2 days), the mutation summary and the nightly gate scripts, and the route list equal to the tested-route list (83/83). **Pending (T17 and the Owner):** the Stryker score on the money and statistics modules no usable score yet: with vitest-runner 10.0.0 and Vitest 5.0.3 every mutant ran 0 tests (score 0.00, not meaningful); mutation evidence is pending a runner fix (D-162), the pushed sample branch that must show a red run on the diff gate local branch `m8-sample-diffcov` (3 untested lines, 4 untested branches): `test:diffcov` fails with 0.0 % lines and 0.0 % branches covered, exit 1; not pushed (D-162), and three consecutive green nightly staging runs. Report: [test-reports/AT-31.md](test-reports/AT-31.md).
- **All previous (AT-01 to AT-27): met locally as recorded in M1 to M7; each report now states its home environment (TST-115) and the Owner or staging rows.** The CI-proven parts are re-stated from the current suite in every report. The staging re-run (AT-02 roles and masking with staging identities, AT-04 build-phase drill, AT-07 to AT-27 staging rows) waits for the release that applies the migrations; the production parts (AT-03 stages 1 and 2 and the full-history scan after rotation, AT-05b pre-registered test incident, AT-18 Part A, AT-20 forced watchdog run, AT-21) wait for the sign-off sitting; the Owner-executed parts (AT-01 Google matrix, AT-05 and AT-20 inbox checks, the AT-26 manual check) are in the guide. All reports: [test-reports/](test-reports/).

## Decisions

D-152 (design, 49 decisions), D-153 (quality checks, bundle budget, pending licences), D-154 (security tests, carried code items), D-155 (restore drill, Worker slots, staging pipeline), D-156 (acceptance suites and readability), D-157 (`ensureCohorts`, go-live controls), D-158 (deadline checker, staging E2E, ZAP, nightly, mutation), D-159 (secret table, Owner guide, licence register), D-160 (watchdog Worker slots), D-161 (workflow lint, log-content tests, release gate), all in [07_decision_log.md](07_decision_log.md). T17 and T18 rows: D-162 and the T18 row written by the orchestrator.

## Open / pending

- (a) **Owner actions** (nothing below is faked or done; the full step-by-step is [owner-guide/M8_go_live.md](owner-guide/M8_go_live.md), the order is in [m8-handoff.md](m8-handoff.md)):
  - **Licences (UXN-019):** 16 production packages are `approvedBy: "pending"` in `scripts/ci/licence-exceptions.json` (14 optional `sharp` platform packages with an LGPL-3.0 component, `tslib` 0BSD, `caniuse-lite` CC-BY-4.0). Approve each or have the `sharp` packages removed; `licence-check --release` and so the release gate stay closed until then (D-153). Also approve the M7 dependencies (`lightweight-charts`, `@radix-ui/react-dialog`, `@radix-ui/react-popover`, `server-only`, dev-only `lighthouse`).
  - **Stryker:** approve `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` (Apache-2.0, dev-only, decision 22); the weekly `mutation.yml` fails with a plain message until they are installed (D-158).
  - **ZAP:** review and pin the ZAP release image digest and set the repository variable `ZAP_IMAGE_PINNED` to `true`; until then the local scan is skipped (green) on every push (D-158).
  - **Staging secret name:** confirm `TEST_IDENTITY_SECRET_STAGING` in the GitHub `staging` environment (same value as Vercel staging, D-159).
  - **Deploy-file exceptions:** the two Owner-only deploy files (`deploy-staging.yml`, `deploy-production.yml`) use `cache: npm` in a secret-holding job; the exception is recorded as pending and fails only the release gate (D-161). Decide: accept with a dated reason, or ask for the cache to be removed in a fix PR.
  - **Fixtures recorded day:** the private fixtures repo must hold one recorded AU trading day in the layout `recorded/au/<date>/{bars,index,short,announcements,corporate_actions}.json` and a golden set of at least 50 items; the staging environment needs the read-only fixtures token (f-r) (D-155, M8 design 7 item 9).
  - **Design decisions to confirm:** 6 (public generic rotation checklist), **10 (changed: the bake-off cannot run on staging because staging has no LLM keys; it runs on production, and a result with no model passing is valid, D-159)**, 22 (StrykerJS dev dependency), 34 (the sign-off is copied into the decision log in a later session with a short-lived PAT), 42 (one possible "Build complete: go-live fixes" PR).
  - **Carried approvals (M3 to M7):** the [VERIFY] Owner rows (A$500 parcel, cost tables, tick table, 9 % financing, sleeve profile, brokerage ruling, `c1_etf_code`, key bounds); O-26 Yahoo, `^AXJO`, continuous-trading end, ARN-011 list; the UXN-284 deviations and label texts; the DAT-124 reading; the Lane-A list and promotion reading; whether the KB archive may use the data-repo token; review of the changed `ci.yml` and the new workflows (`restore-drill`, `staging-e2e-day`, `zap-baseline`, `nightly`, `mutation`) at the review point.
  - **ASX decision (O-23)**, the DAT-125 backfill and AT-17 position, the GitHub settings (CodeQL, Dependabot alerts, secret scanning, push protection, branch protection, Vercel Deployment Protection), and every P3 to P7 step in the guide (staging day, rollback rehearsal, build-phase drill, bake-off, AT-01, AT-05 and AT-20 inbox, forced watchdog test, PAT revocation, rotation, real-key drill, $0 check, walkthrough, sign-off, switches).
- `ingest-batch1.yml` and `backfill-prices.yml` production jobs now run `pip install --require-hashes`, and `talib-reference.yml` installs from a hashed file; the hashes were taken from PyPI metadata (no local pip) and are proven by the CI `python` job, which installs the same set on Linux; Owner reviews these changed workflow files at the review point (D-162)
- (b) **Migrations main 0007 to 0012 and auth 0004 to 0006 are not applied anywhere.** They reach staging and production at the review point that merges the "Build complete:" PR (D-022). Main 0012 (`go_live_signoff`) is the only one added in M8.
- (c) **Known limits accepted for go-live (decision 43).** Each is listed in its decision and has an honest label in the app; only D-147 could leak data to a non-owner and it is fixed in M8 (D-154):
  - D-113: arena trades exclude dividends; legacy trades are final with net NULL; corporate-action exits use the stored proceeds.
  - D-121: holdout dates beyond the data end are weekday estimates; `rollAfterPromotion` runs only inside the weekly learning run.
  - D-122: the Conservative and Balanced picks filters are constants without ch.15 keys; Balanced is empty until attribution history exists; pick tracking ignores corporate actions and dividends; `beatsLuck` is a Wilson-bound draft.
  - D-123 and D-124: no A6 notes, twin, filter or cost comparison pairs; holdout confirmations that fall due are listed, not run weekly; the lesson Critic runs nightly only; ARN-075 has no definition.
  - D-138, D-141, D-144, D-145, D-148: no hourly health data (no per-segment sparkline); a Control Room refresh reads about 550 rows; attention reasons 3 to 5 are badges, not counted; no market cap, P/E, yield or delayed intraday prices; no per-strategy holders on news items; `times_in` has no display effect while only AU exists.
  - D-155: the restore-drill check cohort is a seeded buy-and-hold replay over restored bars, not the batch 2a/2b engine; re-dating treats weekdays as sessions (a holiday inside a multi-day catch-up is not skipped); staging email stays on the mock provider unless `EMAIL_LIVE=1` is set for AT-28.
  - D-158: no TST-127 visual comparison in the nightly run (no comparison spec yet); the LCP on Home (about 2.8 s) is over the 2.5 s warning line (D-153, recorded, not a failure).
  - D-159: `PII_HASH_KEY` has no in-app expiry reminder (the guide sets a calendar reminder); the bake-off runs on production.
  - M4 limits (family, agent and replay engine): see [M4_exit_evidence.md](M4_exit_evidence.md) section "Open / pending".
- (d) **Spec amendments for the Owner (decision 47).** The agent never edits `spec/`; the Owner's private copy is the authority and `spec/` here mirrors it:
  - ARN-060 order: corporate actions run before fills, a deviation from the literal list (the 2a/2b/3 split, D-077);
  - financing divisor 365 per calendar day (D-069);
  - ARN-075 has no definition (D-123);
  - the BLD-030 reading of decision 3: `ensureCohorts` opens the first cohorts on the sign-off evening, not "already created at M8 exit" (D-157);
  - the "Build complete: go-live fixes" round of decision 42 as a possible second review point (D-152);
  - the M7 housekeeping items: superseded tab lists (decision 1), "Dashboard" in NFR-010 and ch.09 (decision 14), ROL-102a for snooze, quiet hours and watchlist (decision 9), the mockup file (decision 36); the annotation route path `/api/learning/annotations` against `/api/annotations` (D-125).
- (e) **Carried from [M7_exit_evidence.md](M7_exit_evidence.md) and [M6_exit_evidence.md](M6_exit_evidence.md), still open:** every item in their "Open / pending" sections that is not repeated above, namely the golden-set spot check and the first bake-off (R3 chain, `llm_classifier_model`, dated `trains_on_prompts`), approval of the new dispatch-only workflows `kb-archive.yml` and `llm-bakeoff.yml`, per-request approval of each promotion, force-apply and rollback, the TST-127 screenshot baselines (needs the fixtures read-only token), the AT-26 manual keyboard and screen-reader check, the AT-30 walkthrough, the DAT-124 reading for company pages (decision 21) and the delayed-price quote source (decision 22, not built).

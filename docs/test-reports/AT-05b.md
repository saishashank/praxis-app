# AT-05b Release control

Reference: [spec/14_system_acceptance.md](../../spec/14_system_acceptance.md) line 14, row AT-05b. The row text there is the requirement; this file does not restate it.

## Home environment (TST-115)

production (data-only mode)

TST-115: production.

## Current evidence

Tests (run in CI or locally; a green test is not an Owner or staging result):

- [`tests/watchdog/approvedCommit.test.ts`](../../tests/watchdog/approvedCommit.test.ts)
- [`tests/watchdog/route.test.ts`](../../tests/watchdog/route.test.ts)
- [`scripts/ci/approved-commit.test.mjs`](../../scripts/ci/approved-commit.test.mjs)

Milestone records:

- [`docs/M1_exit_evidence.md`](../../docs/M1_exit_evidence.md) (dated milestone record)
- [`docs/M8_exit_evidence.md`](../../docs/M8_exit_evidence.md) (M8 re-statement of the evidence)

Requirement-to-test coverage: [`docs/test-map.md`](../../docs/test-map.md).

## Results

| Row | Where | Result | Date | By |
| --- | --- | --- | --- | --- |
| CI evidence | CI | met locally and in the CI test suites on synthetic data: full unit and component run 6,276 passed, script tests 585, route list 83/83 (D-161); detail in the milestone records above and `docs/M8_exit_evidence.md`. Not a staging, production or Owner result | 2026-10-21 | agent |
| Pre-registered test incident on production (M8 design P2) | Owner or staging or production | pending | pending | Owner |
| Owner approval of `deploy-production`; confirm only approved commits run | Owner or staging or production | pending | pending | Owner |

Nothing in this file claims a result that has not happened. A row changes from "pending" only when the run is recorded, with the date and who ran it (decision 42).

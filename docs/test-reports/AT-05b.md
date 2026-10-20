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

Requirement-to-test coverage: [`docs/test-map.md`](../../docs/test-map.md).

## Results

| Row | Where | Result | Date | By |
| --- | --- | --- | --- | --- |
| CI evidence | CI | see the exit-evidence records above; refreshed by task T18 | pending | agent |
| Pre-registered test incident on production (M8 design P2) | Owner or staging or production | pending | pending | Owner |
| Owner approval of `deploy-production`; confirm only approved commits run | Owner or staging or production | pending | pending | Owner |

Nothing in this file claims a result that has not happened. A row changes from "pending" only when the run is recorded, with the date and who ran it (decision 42).

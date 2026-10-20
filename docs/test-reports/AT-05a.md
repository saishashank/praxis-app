# AT-05a Deploy isolation & public-repo hygiene

Reference: [spec/14_system_acceptance.md](../../spec/14_system_acceptance.md) line 13, row AT-05a. The row text there is the requirement; this file does not restate it.

## Home environment (TST-115)

staging (recorded data)

TST-115: staging. CI runs the repo-hygiene scan on every push.

## Current evidence

Tests (run in CI or locally; a green test is not an Owner or staging result):

- [`scripts/ci/repo-hygiene.test.mjs`](../../scripts/ci/repo-hygiene.test.mjs)
- [`scripts/ci/repo-hygiene.mjs`](../../scripts/ci/repo-hygiene.mjs)
- [`scripts/ci/kb-archive.workflow.test.mjs`](../../scripts/ci/kb-archive.workflow.test.mjs)
- [`tests/acceptance/m6/at24.test.ts`](../../tests/acceptance/m6/at24.test.ts)

Milestone records:

- [`docs/M1_exit_evidence.md`](../../docs/M1_exit_evidence.md) (dated milestone record)
- [`docs/M6_exit_evidence.md`](../../docs/M6_exit_evidence.md) (dated milestone record)

Requirement-to-test coverage: [`docs/test-map.md`](../../docs/test-map.md).

## Results

| Row | Where | Result | Date | By |
| --- | --- | --- | --- | --- |
| CI evidence | CI | see the exit-evidence records above; refreshed by task T18 | pending | agent |
| GitHub settings check: BLD-010 rows 1 and 16 (no deployment from data-repo pushes) | Owner or staging or production | pending | pending | Owner |

Nothing in this file claims a result that has not happened. A row changes from "pending" only when the run is recorded, with the date and who ran it (decision 42).

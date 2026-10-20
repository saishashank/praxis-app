# AT-20b Attention reminder

Reference: [spec/14_system_acceptance.md](../../spec/14_system_acceptance.md) line 47, row AT-20b. The row text there is the requirement; this file does not restate it.

## Home environment (TST-115)

staging (recorded data)

Not named separately in TST-115; follows the AT-20 family (staging).

## Current evidence

Tests (run in CI or locally; a green test is not an Owner or staging result):

- [`tests/acceptance/m5/at20ab.test.ts`](../../tests/acceptance/m5/at20ab.test.ts)
- [`tests/email/reminder.test.ts`](../../tests/email/reminder.test.ts)

Milestone records:

- [`docs/M5_exit_evidence.md`](../../docs/M5_exit_evidence.md) (dated milestone record)

Requirement-to-test coverage: [`docs/test-map.md`](../../docs/test-map.md).

## Results

| Row | Where | Result | Date | By |
| --- | --- | --- | --- | --- |
| CI evidence | CI | see the exit-evidence records above; refreshed by task T18 | pending | agent |
| Staging run with an amber fixture; snooze check | Owner or staging or production | pending | pending | Owner |

Nothing in this file claims a result that has not happened. A row changes from "pending" only when the run is recorded, with the date and who ran it (decision 42).

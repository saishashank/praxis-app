# Replay hash policy

What the AT-32 replay hash compares, what it leaves out, and who may change that. Written for M11-lite residual 12 (closed in M18, OPS-111, D-977).

## The rule

The AT-32 hash (`tests/acceptance/v2/at32Steelman.test.ts`) is taken over **every main table except the steelman's own** (the complement of an allowlist, D-586), once with the steelman stage on and once with it off. The two hashes must be equal: the steelman is an opinion and changes nothing else. A list that can only shrink by omission is the wrong shape, so a new table is in the hash from the day it exists, and 24 named tables must be present in it.

## The three wall-clock columns

Three columns hold the real clock, not data the world decided. They differ between any two builds of the same world, with the stage or without it, so each is dropped **by name** from the hash while its table stays in:

| Table | Column | Why it differs |
|---|---|---|
| `schema_migrations` | `applied_at` | the time each migration ran |
| `source_register_history` | `changed_at` | a trigger stamps `strftime('now')` on every seeded register row |
| `cortex_night` | `runtime_ms` | the measured run time of the Cortex night |

Nothing the steelman does can reach these columns. A reviewer should know the three are not compared and that nothing else is dropped.

## Changing the list

- Adding a wall-clock column to the list needs a reason in this table, a decision, and a look by the reviewer of the milestone: it is the only way a real difference could hide.
- A new column that holds a clock reading (a `*_at` written by a trigger, a measured duration) will make the replay fail the first time it runs. The right fix is usually to stamp it from the run's own injected clock; adding it here is the last resort.
- The same rule holds for the recorded-day job (AT-84): its replay compares the same tables with the same three exceptions.

`tests/docs/replayHashPolicy.test.ts` checks that this page names exactly the columns the AT-32 test drops.

# Runbook: a cohort stopped by a ledger check (ledger_invariant)

What happened: the nightly close found a fatal ledger check (ARN-101) for one cohort. That cohort is
frozen: no further phase runs for it, the other cohorts carry on, and the nightly run reads "degraded".
Nothing is lost; the failed day is kept as a permanent record and is never edited.

1. Open the app log for the night and read the line `invariants failed for <cohort> on <date>: <codes>`.
2. Fix the cause (for example a corrected vendor bar, or a correcting ledger entry). Do not clear first.
3. Strategies > Risk > Owner controls > "Stopped by a ledger check" > Resume next to the cohort. Write what
   was fixed (it goes in the audit log) and confirm.
4. The app replays the sessions the cohort missed, for that cohort only, oldest first, then clears it. If
   a replayed session fails the check again nothing is cleared: fix the cause and try again.
5. If it says "too many sessions" (more than 10 missed), leave the cohort frozen and ask the builder to
   replay them in two or more steps (the same Resume, run after each partial replay by the builder with
   `closeBooksDay` and `catchUpCohort`, oldest first); then use Resume.

Resume it as early as you can: every night it stays frozen is one more session to replay.

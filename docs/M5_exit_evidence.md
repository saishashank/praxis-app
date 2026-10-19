# M5 exit evidence (AT-18, AT-19, AT-20, AT-20a, AT-20b, AT-21)

Status date: 2026-10-20. Branch `build`. Source rows: [spec/14_system_acceptance.md](../spec/14_system_acceptance.md) section 14.4. Test files are listed in [test-map.md](test-map.md) (M5 rows). Requirements: [M5_requirements.md](M5_requirements.md). Design: [M5_design.md](M5_design.md).

Overall: the Sentinel, alerts, email core, Evening Review, incident emails, watchdog, pre-open re-check, thesis-breaker evaluation, Morning Brief and attention reminder are built and pass their local tests with the mock email provider. Every AT has an automated check through the real code paths. The parts that need the Owner or production (Part A of AT-18, AT-21 on the real feed, the forced watchdog run, inbox checks, the deliberate-failure test, the staging run) are **pending**, not faked. M5 exit is **met locally, not yet on staging or in production**. Production email stays `off` until the Owner sets it.

## Commits

Range `bfb0e82^..HEAD` (21 commits). T15 (acceptance tests, test map, this page, D-109) is uncommitted.

| Commit | Task | Decision |
|---|---|---|
| bfb0e82 | M5 requirements extract | |
| 8e866b9 | M5 design and architect decisions | D-096 |
| 3b861b1 | T1 + T2 migrations main 0009 and auth 0004, config keys, Owner email controls | D-097 |
| c4e1d4a, fc1a561 | T4 email templates and renderer | D-098 |
| 28c617f | T3 email core (provider, mock, claims, caps, retries, test route) | D-099 |
| b13920f, b08b97c | decisions D-097/D-098; route-coverage manifest fix | |
| e7a9070 | T5 Sentinel ingest | D-100 |
| 224bd0a | T6 alerts, P0 delivery, alert-flush, incident route | D-101 |
| fb19649, 90d34c3 | T7 thesis-breaker evaluation | D-102 |
| ed29441 | T8 pre-open re-check | D-103 |
| 9307d16 | T9 Evening Review facts and pages | D-104 |
| 7dd7886 | T11 incident emails | D-105 |
| 4ea8f66, c7743cf | T12 YAML watchdog, generated cron lines | D-106 |
| cd1a0c7 | T10 Evening Review send, Worker route runner | D-107 |
| 45af10c, 0adcb5d | T13 Morning Brief, health components, attention reminder | D-108 |
| 2bda5ca | T14 slot instants, TST-123 matrix, CPU budget, NFR-012 median | |
| (uncommitted) | T15 acceptance tests, test map, this page, section 9 ASX fix | D-109 |

CI status: remote CI on `build` is green for the last pushed commit (2bda5ca, run 39267061485, 6 min 53 s). Two earlier runs on `build` failed (runs 39225549100 for T8 and 39230419794 for the D-104..D-106 commit) and were fixed by later commits. Remote CI for the T15 change has not run, because nothing is committed or pushed yet.

## Test counts

Full suite (`npx vitest run --testTimeout=60000`, about 10.5 minutes): **207 files, 3,958 tests: 3,956 passed, 2 skipped** (the skips are the real-fixture tests that run only in the `fixtures` CI job). T15 adds 5 test files and 28 tests in `tests/acceptance/m5/` (AT-18 4, AT-19 6, AT-20 9, AT-20a/20b 8, AT-21 1; about 20 s together) plus the shared harness `alertWorld.ts`. The Worker tests (`worker/test/*`) run in the Worker package and are not in this total.

## AT checklist

- **AT-18 Part A (production data-only): engine checks met locally; evidence run pending.** `tests/acceptance/m5/at18.test.ts` ("AT-18 Part A"): the real Worker poll hands each changed body, signed, to the real ingest handler over a migrated database. Three sessions of 4-minute polls meet the 98 % bar (the test asserts at least 98 % per day); no two ASX requests are under 65 s apart and a burst 30 s later is refused by the token; the daily count is within 720; every repeated item is stored once; one ingest per feed change. In depth: `worker/test/sentinel.test.ts`, `worker/test/asx.test.ts`, `worker/test/m5Slots.test.ts` (TST-124 CPU budget). **Not evidenced:** three real announcement-hour sessions on production, the Cloudflare CPU metrics, and a recorded real ASX feed (the parser reads the synthetic shape, D-100).
- **AT-18 Part B (re-check): met locally.** Same file ("AT-18 Part B"): no re-check by the open gives a `not_rechecked` fill and one P1; a halt since the decision cancels with the reason stored; a rerun is a no-op. In depth: `tests/arena/preopen.test.ts` (retry at 09:58, P1 after two failures, ASX-off proxy, replay parity, DST bound). The staging run is pending.
- **AT-19 Alert tiers: met locally.** `at19.test.ts`: first P0 mailed at once with template text, source link and Melbourne time; follow-ups inside 5 minutes become one batch mail; duplicates suppressed; 12 P0 events give 10 sent and 2 `suppressed_cap`, counted in section 9, and the reserved review slot still sends; P1 and P2 are never mailed and appear in review section 8; controls never alert. NFR-012 median: `tests/time/m5Slots.test.ts`. The live "[STAGING]" P0 is pending.
- **AT-20 Evening Review: met locally.** `at20.test.ts`: one email for three runs on a trading day, 20:00 first tick, Owner only, 10 sections, HTML within 90 KB, plain text, no remote image; Saturday keeps all headings; late pipeline gives a partial at 20:30 and a stored complete version later, not re-sent; LLMs off gives "Written without AI today"; `[STAGING]` prefix; mark-as-read once. Watchdog fallback through `scripts/watchdog/run.mjs` with the route down: minimal review under the review key, run fails on purpose; route already sent: nothing more. In depth: `tests/review/*`, `tests/watchdog/run.test.ts`. **Not evidenced:** inbox not spam, the KB archive (M6, AT-24), the forced production watchdog run.
- **AT-20a Morning Brief: met locally.** `at20ab.test.ts`: enabled + trading day + active market gives one brief; non-trading, disabled and data-only give none. Staging run pending.
- **AT-20b Attention reminder: met locally.** `at20ab.test.ts`: one amber credential on a Sunday gives one reminder with item, deadline and fix link; all green none; snooze hides it and it returns after; a red item is not hidden; never two in one day. Staging run pending.
- **AT-21 Kill switch: met locally.** `at21.test.ts`: the Owner control turns `asx_enabled` off (audited), the next ticks make no ASX request, and section 9 lists the feed as off. This test found a real gap, fixed in D-109: section 9 read only `source_status`, so with the switch off the review still said the feed was on. The production run with AT-18 Part A is pending.

## Decisions

D-096 (design), D-097 (migrations, keys, Owner controls), D-098 (templates), D-099 (email core), D-100 (Sentinel ingest, draft), D-101 (alerts), D-102 (thesis-breakers), D-103 (pre-open), D-104 (Evening Review facts), D-105 (incident emails), D-106 (watchdog), D-107 (review send, Worker route runner), D-108 (Morning Brief, reminder). D-109 (T15, section 9 ASX line) is also in [07_decision_log.md](07_decision_log.md).

## Open / pending

- (a) **Owner prerequisites** (nothing below is faked or done):
  - check the Resend keys (production and staging) and that the Resend account email equals `OWNER_EMAIL` (EML-003a);
  - the Gmail filter and SPF/DKIM check so the sender never goes to spam (EML-036);
  - approve `watchdog.yml` (dispatch-only, D-062 pattern), and later its schedule: paste the dual-UTC lines from `node scripts/time/genWatchdogCron.mjs` (`40 9`, `40 10`, `50 10`, `50 11`, all `* * *`);
  - O-23 accepted, then `asx_enabled`, `ASX_LIVE` and `ASX_USER_AGENT`, before AT-18 Part A and AT-21 on production;
  - a recorded ASX feed fixture in the fixtures repo (the parser is `TODO(fixtures)`);
  - one forced production watchdog run (`email_mode = incidents` plus a review test date), TST-115;
  - the inbox checks for AT-05 and AT-20;
  - the deliberate-failure test (NFR-006, `m0-failure-email-test.yml` or the watchdog `deliberate_failure` mode);
  - the credential expiry dates on System Health (so tokens-due and the reminder have data);
  - the `email_mode` switch itself (default `off`; `incidents`, then `full`);
  - enable the Worker slots, which all ship disabled: `alert-flush`, `pre-open`, `pre-open-retry`, `evening-review`, `evening-review-late`, `morning`;
  - [VERIFY] the Resend Idempotency-Key 24 h window.
- (b) **Migrations main 0007, 0008 and 0009 and auth 0004 are not applied anywhere.** They reach staging and production at the next review point (D-022); the staging run for AT-14 to AT-21 waits for it.
- (c) **Known limits and follow-ups:**
  - the T7 breaker alert sink is not yet wired to the T6 tiers, so a thesis-breaker never produces a P0 (D-102);
  - no caller yet for the ledger-invariant incident (D-105);
  - the real ASX feed format is unknown, the parser reads the synthetic shape (D-100, `TODO(fixtures)`);
  - the ARN-011 promotional keyword list is still the Owner's to supply (pre-open filter is off for it, D-103);
  - section 7 uses day-0 abnormal return only for the Sentinel score (D-104); ARN-075 has no definition in the spec;
  - A6 lessons and the KB archive of reviews are M6.
- (d) **Carried from [M4_exit_evidence.md](M4_exit_evidence.md), still open:**
  - the AT-14 to AT-17 staging run and the real-data null runs (need a release);
  - Owner approvals: the four M4 dispatch-only workflows and their Worker slots, O-26 Yahoo, location of the null runs, the token budget reading, `^AXJO`, the continuous-trading end time, `c1_etf_code`, the TA-Lib reference fixture;
  - proposed config keys still missing (ARN-011 thresholds, F5 volume-exit numbers, `code_reuse_gap_sessions`, CIF horizons, `LINEAGES_FLOOR_MIN`, `llm_injection_phrases`, `dsr_default_sr_variance`);
  - known limits (deferral dates without the holiday calendar, no replay group restart, replay snapshot has no events or dividends, no incremental `indicator_daily`, batch 3 live outcome basis, real-data compute time not measured);
  - the M2 ASX by-date backfill.

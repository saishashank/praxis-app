# M18 requirements: Live-risk fixes, ops and test debt

Delta extract from `Requirement/v3/spec/` (V3 draft, session V3-1, 2026-11-11): ch. 12 V3 (M18 row, BLD-048…BLD-055), ch. 25 (OPS-103…OPS-111, SEC-115, PLT-080), ch. 26 (TST-134…TST-139, AT-85), ch. 23 (DAT-251…DAT-253), ch. 24 (ARN-123), ch. 14 V3 (AT-83…AT-85), ch. 15 V3 (M18 keys), ch. 01 V3 (PRD-039…PRD-049), ch. 00 V3 (D-923…D-950, O-82, O-83). AT-26 and AT-30 are v1 tests (`Requirement/v1/spec/14_system_acceptance.md`) re-run in M18. Continues from M17 on `build`. Build decisions in this milestone start at **D-951** (BLD-054) and are recorded in `docs/M18_design.md`.

Source of truth: the V3 spec in `D:\Projects\Praxis\wt-v3-req\Requirement\v3\spec\` (read-only). Quotes below are copied from that text. Code paths are the files in `D:\Projects\Praxis\wt-v3` that most likely change; they come from a grep and are marked **(guess)** where the path is only a probable home. "new" means no existing file was found.

## Scope

M18 is the first V3 milestone and the live-risk gate (PRD-049, BLD-049 order of value, D-941, D-942). It is 8 build-agent days in the estimate. Its first task is **OPS-110** (production picks 0 since 26 Oct), and it runs before any feature work. It has four kinds of work:

1. **Live risk**: OPS-110 (picks), OPS-109 (small ops), OPS-106 (money-path gaps).
2. **Security and signing**: SEC-115 (HMAC covers method and path, flagged **F**, Fable review).
3. **Ops and metering**: OPS-103 (calendar draft job), OPS-104 (Turso metering and the 20 % line), OPS-105 (restore drill), PLT-080 (Turso free-plan guard), OPS-107 (staging retirement, flagged **F**), OPS-108 (waivers and runbook).
4. **Residuals and test debt**: OPS-111, OPS-112 (M11L and M13L residuals), DAT-251…253 (ASX failures, news cap, RBA/ABS, universe fallbacks, source hosts), ARN-123 (dividends check), TST-134…TST-139 (e2e specs in CI, seed states, timing tests, Owner-run scripts, recorded-day job, test map).

**ID count: 22** (16 IDs in the M18 row, with TST-134…TST-139 counted as six).

Exit (ch. 14 V3): AT-83, AT-84, AT-85, plus the re-runs of AT-26 and AT-30. Exit evidence goes to `docs/M18_exit_evidence.md`.

## Hard constraints that apply to every M18 item

- **PRD-045 Cost ceilings.** $0 running cost. Turso stays on the FREE plan; at most 20 % of the free plan's monthly reads and writes; keyset paging, never OFFSET.
- **PRD-046 No staging.** Staging was switched off on 2026-11-09 (OPS-107). Verification is CI plus prod-safe flags.
- **PRD-047 ASX Worker live fetch stays off.** `ASX_LIVE` stays off in the Worker; ASX data arrives through the GitHub `asx-fetch` job only.
- **PRD-048 One pull request.** No intermediate PRs. No Owner prompts during the build.
- **PRD-049 Live-risk first.** M18 closes OPS-110 and the other live-risk ops items before feature work.
- **PRD-040 / BLD-050 / MKT-110 / D-926.** IN and US stay `off` in production; `markets_enabled` in production stays `["AU"]`; AT-68 is green on every CI run.
- **PRD-041 / PRD-033.** No LLM output may create, size, change or cancel an order, thesis-breaker or rule.
- **SEC-108 c / D-021.** Secret rotation and PAT revocation are Owner steps listed in the PR, not build work.
- **BLD-051 / D-934.** Research honesty rules apply to any research item; none is in M18.

---

## A. Live risk (task 1 and the money path)

### OPS-110 Production picks 0 since 26 Oct (E49)
- **Summary:** Verify, explain or fix the zero-pick run; the Owner must see a plain-words reason, never a silent zero. Task 1 of M18.
- **Full text:** "**OPS-110 "Production picks 0 since 26 Oct" — verify and close (E49).** Facts on record: production had no U1 code for a week because D-189 required a bar on every one of 60 sessions (fixed by D-861 on 2026-11-02: ≥ 54 bars); the production full replay failed on every run after the V2 release (`UND_ERR_SOCKET`, fixed by D-883); the first production night with candidates was 2026-11-03 (candidates = 12, published = 0, D-883 evidence); the go-live set is F1 alone (O-79a) and every family starts in shadow until CTX-053 passes. **Task 1 of M18:** run the read-only `diagnose-signals.yml` (`picksReadiness`) against production and record, night by night since 2026-10-26: U1 size, candidates, the first failing gate per candidate with its plain label (CTX-013), the family status (shadow / allowed), the `holdout_look` and ledger-row counts the scenario reads. **Close condition:** either (a) picks publish on nights with passing candidates, or (b) `published = 0` is explained by a named gate (e.g. family in shadow because CTX-053 is not met — expected after O-79) and the Owner sees that reason in the Evening Review and on Home in plain words ("No picks tonight: the momentum strategy is still in its proving period, n of 200 cases") — never a silent zero. Any gate found to fail by defect (wrong cut-off, missing bar, replay/live mismatch) is fixed under the `fix/*` path if it is live-critical, else in M18 itself, and the fix is proved by AT-32 replay of the affected night. The evidence is `docs/M18_exit_evidence.md` §1."
- **Decisions:** D-941 (task 1; close condition), PRD-049. Background: D-189, D-861, D-883 (V2 numbering, cited in text).
- **Acceptance:** AT-83 (OPS-110 evidence: every night since 2026-10-26 with a named gate or published picks, and the "No picks tonight: …" line renders); AT-32 replay for any fixed night.
- **Files:**
  - `src/lib/arena/diagnose.ts`, `scripts/arena/diagnose.mjs`, `.github/workflows/diagnose-signals.yml`, `tests/arena/diagnose.test.ts` (the read-only `picksReadiness` scenario).
  - `src/lib/picks/generate.ts`, `src/lib/picks/floor.ts`, `src/lib/picks/shortlist.ts` (publish path, guess for the defect search).
  - `src/lib/cortex/night.ts`, `src/lib/cortex/gates/gates.ts` (first failing gate per candidate, guess).
  - `src/app/(app)/home/HomeContent.tsx` (the existing "No picks yet" line, lines 137 and 540, is where the plain-words gate text goes), `src/app/(app)/reviews/[date]/NewPicks.tsx` (Evening Review line, guess).
  - `docs/M18_exit_evidence.md` (new).

### OPS-109 Small ops (E49)
- **Summary:** Pin the Vercel CLI, verify the watchdog heartbeat alarm, and make quote-budget starvation visible.
- **Full text:** "**OPS-109 Small ops (E49).** (a) Pin the Vercel CLI version in `deploy-production.yml` (no `npx --yes` latest); (b) the watchdog's own schedule (D-106, O-52) is verified to run and alert on a missed heartbeat with a fixture; (c) quote-budget starvation (D-502, D-694): the intraday poll's budget allocation (armed picks first, then watch-listed and held codes) publishes per-slot "requests used / skipped" on System Health and alarms when held codes have not refreshed for > 30 min on a trading day."
- **Decisions:** none in the V3 table (references D-106, O-52, D-502, D-694 in text).
- **Acceptance:** AT-83 ("CLI pin; watchdog; quote budget").
- **Files:**
  - `.github/workflows/deploy-production.yml`: line 59 already runs `npx --yes vercel@63.1.0 deploy --prod --yes`, so (a) looks partly done. Verify no `latest` path remains (guess).
  - `scripts/watchdog/run.mjs`, `scripts/watchdog/lib.mjs`, `scripts/watchdog/watchdog.workflow.test.mjs`, `.github/workflows/watchdog.yml`, `scripts/time/genWatchdogCron.mjs` (heartbeat fixture).
  - `src/lib/alerts/pick/reserve.ts` (intraday quote budget reserve, guess for the allocation), `src/lib/health/snapshot.ts`, `src/lib/health/summary.ts` (System Health lines).

### OPS-106 Money-path accepted gaps (E46)
- **Summary:** Re-open every money-path gap; each is closed by code (if under a day) or re-accepted with a reason and a detector. None stays silent.
- **Full text:** "**OPS-106 Money-path accepted gaps (E46; D-666, D-683/684, D-699, R4-I3).** Each gap is re-opened in M18 and either **closed** by code (preferred when < 1 day: e.g. D-666 — a 2a recovery after the 18:10 2b slot now re-runs 2b once when it completes before 18:40, otherwise the night records `degraded` with the reason) or **re-accepted** with the reason and the detection that shows the Owner when it bites. The resulting table is in the M18 evidence; none may stay silent."
- **Decisions:** none in V3 table; D-666, D-683/684, D-699, R4-I3 are V1/V2 decisions named in the text.
- **Gap list:** **not in the V3 spec.** The gap table must come from the V1/V2 decision log (`docs/07_decision_log.md`, `docs/V2_decisions.md`). Flagged, not invented.
- **Acceptance:** AT-84 ("every money-path gap closed (test) or re-accepted (detection)").
- **Files:** `src/lib/agents/batch2b.ts`, `src/lib/agents/batch3.ts` (2a/2b slots, guess for the D-666 recovery), `src/lib/arena/closeBooks.ts`, `docs/M18_exit_evidence.md` (gap table, new).

### SEC-115 HMAC signature covers method and path (E45; D-780) **F**
- **Summary:** One signing scheme that signs method, path, timestamp, nonce and body hash, with a version byte so an old signer is refused after the deploy.
- **Full text:** "**SEC-115 HMAC signature covers method and path (E45; D-780).** The one signing scheme (`hmacCore.mjs`) signs `method + path + timestamp + nonce + body hash`; both sides (Actions → Vercel routes, Worker → Vercel routes) move together under a version byte so an old signer is refused after the deploy; the smoke test stage 2 and every signed-route test are updated."
- **Decisions:** D-780 (cited in text); `hmac_scheme_version` = 2, fixed per deploy (ch. 15 V3).
- **Current code (checked):** `src/lib/security/hmacCore.mjs` signs `${timestamp}.${nonce}.${rawBody}`, with no method or path. The `hmac.ts` header comment repeats that scheme. So SEC-115 is not yet done.
- **Acceptance:** AT-83 ("HMAC v2 refuses an old signer and both signed paths pass smoke stage 2").
- **Files:**
  - `src/lib/security/hmacCore.mjs`, `src/lib/security/hmac.ts`, `src/lib/security/replay.ts` (nonce store, guess).
  - `scripts/smoke/sign.mjs`, `scripts/smoke/README.md`, the smoke test workflow `.github/workflows/smoke-test.yml`.
  - `worker/src/selfcheck.ts` (Worker signer).
  - Signed routes (all need the v2 check): `src/app/api/test-identity/login/handler.ts`, `src/lib/alerts/machine.ts`, `src/lib/auth/testIdentity.ts`, `src/lib/backup/exportHandler.ts`, `src/lib/data/universe/handler.ts`, `src/lib/maintenance/handler.ts`, `src/lib/review/routeHandler.ts`, `src/lib/selfcheck/handler.ts`, `src/lib/sentinel/handler.ts`, `src/lib/workerReport/handler.ts`.
  - Tests: `tests/security/hmac.test.ts`, `tests/auth/testIdentity.test.ts`.

---

## B. Ops and metering

### OPS-103 Yearly trading-calendar draft job (E42; D-712, DAT-160)
- **Summary:** Draft next year's calendar for every built market on 1 November; prove the job with a clock fixture.
- **Full text:** "**OPS-103 Yearly trading-calendar draft job (E42; D-712, DAT-160).** The job that drafts next year's calendar from each enabled market's published holiday list runs on 1 November for every **built** market (AU, IN, US); the first live alarm is 2027-11-02, so M18 proves it with a clock fixture (draft written, Owner notice raised, confirmation flow, the 1 December and 1 January escalations of DAT-160)."
- **Decisions:** D-712 (cited); `calendar_draft_markets` = built markets (derived).
- **Acceptance:** AT-83 ("Calendar job clock fixture: draft, notice, confirmation and both escalations fire on the clock dates for every built market").
- **Files:**
  - `scripts/data/make-au-calendar.mjs` (existing AU seed generator).
  - `db/migrations/main/0005_au_calendar_seed.sql`, `db/migrations/main/0013_au_calendar_history.sql` (existing calendar tables).
  - `scripts/time/scheduleGate.mjs`, `scripts/time/scheduleGate.test.mjs` (clock gate, existing).
  - The draft job itself: **new** (guess: `scripts/calendar/draft.mjs` and a workflow or maintenance slot in `.github/workflows/maintenance.yml`).

### OPS-104 Turso usage metering and the 20 % ceiling (E43; D-720, D-042, O-81)
- **Summary:** Meter real Turso usage against the free plan, alarm at 15 % and degrade at 20 %, forbid OFFSET, and count rows by market nightly.
- **Full text:** "**OPS-104 Turso usage metering and the 20 % ceiling (E43; D-720, D-042, O-81).** (a) `getMeters` reads the real Turso usage (platform API, free [VERIFY endpoint and auth]) instead of summing `run_record.rows_*`, with the summed figure kept as a cross-check; (b) the Usage page shows reads/writes/storage as % of the **free plan** with the 20 % line (PRD-045) and per-market and per-job split; (c) alarms: P1 notice at 15 %, degrade mode (PLT-051: pause non-essential jobs, standby markets first) at 20 %; (d) a static test forbids `OFFSET` in application SQL (keyset paging only) and a review checklist item requires an index for every keyset; (e) the nightly invariant job counts rows by market (MKT-110 b)."
- **Decisions:** D-940 (Turso metering reads the platform API; 15 % notice, 20 % degrade; static OFFSET test; nightly row-by-market invariant), O-81, PRD-045.
- **Config:** `turso_free_ceiling_pct` = 20 (fixed); `turso_notice_pct` = 15 (range 10–19, Owner).
- **Acceptance:** AT-83 ("Turso meters; OFFSET scan; row invariant").
- **Current code (checked):** `src/lib/usage/meters.ts` `getMeters` (line 149) sums `run_record` rows (line 171); `NONCE_WRITES_PER_SIGNED_CALL` and `WORKER_READS_PER_TICK` are estimates. The platform client `scripts/restore/turso-platform.mjs` exists and may be reusable for (a) (guess).
- **Files:**
  - `src/lib/usage/meters.ts`, `src/app/(app)/usage/page.tsx`, `src/lib/ui/loaders/usage.ts`, `src/lib/incidents/detectors.ts` (degrade and notice alarms).
  - `src/lib/config/keys.ts` (Turso keys; the two V3 keys are new).
  - `scripts/restore/turso-platform.mjs` (platform API).
  - **OFFSET grep hits to review (not yet confirmed as SQL, not comments):** `src/lib/picks/portfolioStore.ts`, `src/lib/picks/shortlistLoad.ts`, `src/lib/ui/loaders/cortex.ts`, `src/lib/ui/loaders/news.ts`, `src/lib/ui/loaders/reviews.ts`, `src/lib/learning/dailyLoad.ts`, `src/lib/maintenance/retention.ts`, `scripts/backup/core.mjs`. Each must become keyset paging or be shown to be a comment.
  - Static OFFSET test: **new** (guess: `tests/static/noOffset.test.ts`).
  - Row-by-market invariant job: **new** (guess: a job in `src/lib/maintenance/`).
  - `src/lib/health/snapshot.ts` (P1 and degrade lines).

### OPS-105 Scheduled real-key restore drill (E44; PLT-015, D-052, TST-108)
- **Summary:** The drill stays Owner-run. Build the script, a CI dry-run with the test key, and a quarterly reminder item.
- **Full text:** "**OPS-105 Scheduled real-key restore drill (E44; PLT-015, D-052, TST-108).** The quarterly real-key drill stays **Owner-run** (the backup private key never sits on GitHub, SEC-108 f): the build ships the drill script, a dry-run mode that CI runs quarterly with the test key, and a reminder Owner item on the first day of each quarter; the result is recorded on System Health."
- **Decisions:** D-052 (cited); `restore_drill_reminder` = quarterly, first day (fixed).
- **Acceptance:** AT-83 ("restore dry run passes in CI with the test key and the quarterly Owner item appears").
- **Files:**
  - `scripts/restore/drill-turso.mjs`, `scripts/restore/restore.mjs`, `scripts/restore/drill-size.mjs`, `scripts/restore/cohortCheck.mjs`, `scripts/restore/restore-drill.workflow.test.mjs`, `scripts/restore/README.md`.
  - `.github/workflows/restore-drill.yml` (existing; dry-run CI step and quarterly guard, guess).
  - Reminder Owner item and System Health line: **new** (guess: `src/lib/health/snapshot.ts`).

### PLT-080 Turso free-plan guard
- **Summary:** Never rely on a paid Turso feature; warn on System Health if the plan is not Free after 1 December.
- **Full text:** "**PLT-080 Turso free-plan guard.** The system never relies on a paid Turso feature; the November Developer plan is treated as temporary; the Owner's downgrade before 1 December is listed in the PR; a System Health check reads the plan name [VERIFY API] and warns if it is not Free after 1 December."
- **Decisions:** none in the V3 table. PRD-045 (hard constraint) and the Owner step in ch. 14 ("Turso downgrade to Free before 1 December (PLT-080)") apply.
- **Acceptance:** **none named.** AT-83 does not list a PLT-080 clause. Flagged as a coverage gap for the test map (TST-133).
- **Files:** `src/lib/health/snapshot.ts`, `src/lib/health/summary.ts` (System Health check, guess), `scripts/restore/turso-platform.mjs` (plan-name read, [VERIFY API]).

### OPS-107 No staging (staging off 2026-11-09; D-860 waiver) **F**
- **Summary:** Staging workflows dispatch-only; the release gate's staging condition is replaced by a recorded-day CI job; the waiver is closed by removing the condition.
- **Full text:** "**OPS-107 No staging (staging off 2026-11-09; D-860 waiver).** (a) The staging deploy, Nightly staging and Staging E2E day workflows are **disabled** (kept in the repo with `workflow_dispatch` only and a header comment, so the history and the rollback runbook stay readable); (b) the release gate's `staging-e2e-day` condition is replaced by a **recorded-day CI job** (`e2e-day` scripts: a full pipeline day on a seeded local database with recorded fixtures: Batch 1–3, Sentinel items, pre-open re-check, close, Evening Review render, intraday scan slots) that must be green on the PR's head commit; (c) the D-860 waiver is closed by removing the condition, not by extending `waivers.json`; (d) the Owner guide's "staging" sections are rewritten to "recorded day" and the `rollback-v2.md` runbook keeps the production rollback steps; (e) `NFR-040` (staging never calls ASX/Yahoo) is re-stated for the recorded-day job: no network to any market-data host (CI asserts)."
- **Decisions:** D-935 (staging retired; the condition is replaced; the waiver is closed), PRD-046, D-860 (waiver).
- **Acceptance:** AT-84 ("Staging workflows dispatch-only; gate passes only with a green recorded-day job; no active waiver; 0 requests to market-data hosts").
- **Current code (checked):** `.github/workflows/staging-e2e-day.yml` already has `workflow_dispatch` only. `.github/workflows/deploy-staging.yml` has `workflow_dispatch`. `scripts/ci/release-gate-core.mjs` has `WAIVABLE = ["staging-e2e-day"]` (line 57) and the condition id at line 172. `docs/release/waivers.json` holds an active `staging-e2e-day` waiver (decided 2026-11-02, expires 2026-11-16). **Open:** the nightly workflow `.github/workflows/nightly.yml` still has a `schedule:` cron; whether it is the "Nightly staging" workflow is not checked.
- **Files:**
  - `.github/workflows/staging-e2e-day.yml`, `.github/workflows/deploy-staging.yml`, `.github/workflows/nightly.yml` (check).
  - `docs/release/waivers.json` (delete the active waiver), `scripts/ci/release-gate-core.mjs`, `scripts/ci/release-gate-core.test.mjs`, `scripts/ci/release-gate.mjs`, `scripts/ci/release-gate.test.mjs`.
  - `scripts/e2e-day/check.mjs`, `scripts/e2e-day/lib.mjs` (recorded-day job, existing), `.github/workflows/ci.yml` (add the job).
  - `e2e/prepare-db.mjs` (seeded local database), `playwright.staging.config.ts`, `e2e-staging/` (retire or document, guess).
  - Docs: `docs/runbooks/gates.md`, `docs/owner-guide/V2_go_live.md`, `docs/owner-guide/M8_go_live.md`, `docs/test-map.md`.
  - Network assertion (NFR-040): **new** (guess: a CI test in `tests/` that fails on any market-data host request).

### OPS-108 Go-live waivers (E48; GO-LIVE-TODO)
- **Summary:** Write the rotation runbook; list the PAT revocation and rotation as Owner steps; close staging proof with OPS-107; run AT-26 and AT-30 in M18 and record the results.
- **Full text:** "**OPS-108 Go-live waivers (E48; GO-LIVE-TODO).** (a) Secret rotation (D-021): a rotation runbook (`docs/runbooks/rotate-secrets.md`) with the `secrets` tool steps per secret; the rotation itself is an Owner step listed in the PR; (b) bot access (SEC-108 c): the build-agent PAT is revoked by the Owner after the V3 PR merges — listed; (c) staging proof: replaced by OPS-107; (d) AT-26 and AT-30 are run in M18 in their TST-115 home environment (now CI + production read-only checks) and their results recorded."
- **Decisions:** D-021 (rotation), SEC-108 c (PAT).
- **Acceptance:** AT-26 and AT-30 re-run (see the AT table below); the Owner steps are listed in the PR.
- **AT-26 (v1, quoted):** "Mobile & a11y | 360 px width usable; WCAG 2.2 AA automated checks pass; Lighthouse ≥ 80 on Home (ex-Dashboard); **(s11)** Owner performs a manual keyboard + screen-reader check of the six main tabs (UXN-270, s14) at M8 | UX-001, UX-005".
- **AT-30 (v1, quoted):** "Owner sign-off (Owner-executed) | Every production token rotated and the build-agent PAT revoked/expired (SEC-108 c); first real-key restore drill with cohort replay passes (TST-108); Owner walkthrough of Home, Picks, Market, Strategies, News, Reviews and the gear-menu pages (s14); $0 confirmed on every provider; sign-off recorded in decision log | PRD-007, BLD-030".
- **Files:**
  - `docs/runbooks/rotate-secrets.md` (**new**, the path the spec names; not found in the repo by grep of the runbook names).
  - AT-26 checks: `e2e/a11y.spec.ts`, `e2e/mobile.spec.ts`, `e2e/lighthouse.spec.ts`, `e2e/keyboard.spec.ts`.
  - AT-30: Owner-executed; the record goes to `docs/M18_exit_evidence.md` and the decision log.
  - `docs/release/waivers.json` (waiver closed by OPS-107).

---

## C. Residuals and data

### OPS-111 M11L residuals
- **Summary:** Close or re-accept each of the 13 items in `docs/M11L_exit_evidence.md` §5, each with a one-line reason.
- **Full text:** "**OPS-111 M11L residuals (`docs/M11L_exit_evidence.md` §5, items 1–13).** Each is closed or re-accepted in M18 with a one-line reason: (1) R6 rules-only → LLM-077; (2) LLM-074 measured token counts replace the estimate; (3) partial persist: night counters are recovered from the written rows on resume; (4) a `critic_unavailable` call row is written; (5) a test breaks the bundle build; (6) unexpected errors get their own count and text; (7) UXN-323; (8) Editor/Viewer card e2e (TST-134); (9) the reader-file guard gains a generated list; (10) reflections → AGT-146; (11) AT-32 runs the bundle path once in CI; (12) wallclock columns documented in the hash policy; (13) the health line masking rule gets a test."
- **Decisions:** none in V3 table.
- **Acceptance:** no AT row in ch. 14 V3 names OPS-111. Closure is evidenced in `docs/M18_exit_evidence.md`. Flagged.
- **Files:** `docs/M11L_exit_evidence.md` (source list), `e2e/m11l-steelman.spec.ts`, `tests/steelman/` (existing), `src/lib/llm/` (LLM-074 token counts, guess), the AT-32 bundle test under `tests/acceptance/` (guess), `src/lib/health/` (masking test, guess).

### OPS-112 M13L residuals
- **Summary:** Close the ten M13L residual items in `docs/M13L_exit_evidence.md` §7.
- **Full text:** "**OPS-112 M13L residuals (`docs/M13L_exit_evidence.md` §7, items 1–10).** (1) the horizon close waits for the bar or marks "early"; (2) expert document links are rendered as links where the host is in `SOURCE_HOSTS` (DAT-253) and masked otherwise; (3) AT-41 gains a weekly-run hash with eligible clusters; (4) a merge gate runs the security tests of both sides (TST-134); (5) `m13l-experts.spec.ts` runs (TST-134); (6) health line date masking test; (7) refused proposal rows show their reason in the queue; (8) calls → KB-084; (9) licence status → KB-083; red flags stay source + date only; (10) hash policy as OPS-111 (12)."
- **Decisions:** none in V3 table.
- **Acceptance:** no AT row names OPS-112. Flagged as with OPS-111.
- **Files:** `docs/M13L_exit_evidence.md`, `e2e/m13l-experts.spec.ts`, `src/lib/http/safeLink.ts` (SOURCE_HOSTS, DAT-253), `tests/experts/` (existing), `src/lib/golive/checklist.ts` (SOURCE_HOSTS reference).

### DAT-251 ASX request failures, news cap, RBA/ABS
- **Summary:** Classify and reduce ASX fetch failures (target < 10 per run, PROPOSED); make the news-assessment cap a key within the LLM and Turso budget; build RBA and ABS fetchers as Actions steps.
- **Full text:** "**DAT-251 ASX request failures, news cap, RBA/ABS.** (a) The ≈ 192 failed ASX requests per `asx-fetch` run are classified by cause (delisted or renamed code, 404, 429, parse) and handled: dead codes leave the fetch list through the code-history table (CTX-015), 429s back off within the run's budget, parse failures are stored with the raw body hash for the fixture set; target after M18: < 10 failures per run excluding genuine delistings [PROPOSED]. (b) The news-assessment cap of 40 items per run becomes the key `news_assess_per_run` (default 40, bounds 20–200) raised only inside the LLM budget and the Turso 20 % ceiling, with the Sentinel item count that was left unassessed shown on System Health. (c) The RBA and ABS fetchers (F-A3-14) are built as Actions steps (CSV/XLS endpoints [VERIFY terms, both public statistics]) feeding the macro series for AU; per-market equivalents (RBI/MOSPI, FRED) follow the profile."
- **Decisions:** none in V3 table; D-945 (FRED, regime inputs) is related to (c) per-market equivalents, not M18.
- **Config:** `news_assess_per_run` = 40, range 20–200, Owner (ch. 15 V3, ch. 23).
- **Conflict flagged:** the existing key `sentinel_max_items_per_run` (`src/lib/config/keys.ts` line 316) has default 40 and range **1–40**, and the code comment cites AGT-010 and PLT-075. The V3 spec asks for a new key `news_assess_per_run` with range 20–200. The build must decide: rename, or add the new key and keep the old one. Record as a D-951+ build decision.
- **Acceptance:** no AT row names DAT-251 in ch. 14 V3. Flagged. Evidence in `docs/M18_exit_evidence.md`.
- **Files:**
  - `scripts/asx/fetch.mjs`, `scripts/asx/fetch.test.mjs`, `scripts/asx/ingest.mjs`, `.github/workflows/asx-fetch.yml` (failure classification, backoff).
  - `src/lib/sentinel/ingest.ts` (line 112 `clampItems`, the assessment cap), `src/lib/sentinel/schema.ts`.
  - `src/lib/config/keys.ts` (new `news_assess_per_run` or a rename), `docs/config-reference.md` (regenerated by `scripts/ci/config-reference.mjs`).
  - Code-history table for dead codes (CTX-015): existing `db/migrations/main/` tables (exact file guess: **new** migration or existing).
  - RBA and ABS fetchers: `db/migrations/main/0004_au_data.sql` and `0018_m14.sql` mention RBA and ABS. The fetcher scripts are **new** (guess: `scripts/macro/rba.mjs`, `scripts/macro/abs.mjs`) and a workflow step in `.github/workflows/`.
  - System Health: `src/lib/health/snapshot.ts`.
  - Fixtures: `praxis-app-fixtures` (not in `praxis-app`; CLAUDE.md rule).

### DAT-252 Alternative universe sources and split-day frequency
- **Summary:** The two recorded alternative universe sources run in CI against a fixture and are enabled as fallbacks only when the ASX list fails for ≥ 3 runs and the licence terms are confirmed. The split-day frequency is measured on the production full replay.
- **Full text:** "**DAT-252 Alternative universe sources and the split-day frequency (C34; DAT-236, O-53, DAT-232).** The two recorded alternatives (Wikidata CC0 and the Wikipedia S&P/ASX 200 list CC BY-SA 4.0, D-239) get their converter run in CI against a fixture and are **enabled as fallbacks** only when the ASX list fetch fails for ≥ 3 runs and their terms are confirmed in the licence register [VERIFY]; the split-day frequency (DAT-232, AT-45) is measured on the **production full replay** output (no staging) and reported in the M18 evidence. For IN and US the alternative source is the exchange's own listing file (NSE equity list; Nasdaq/NYSE symbol directories [VERIFY terms])."
- **Decisions:** D-239 (alternatives, cited); O-53.
- **Acceptance:** no AT row names DAT-252 in ch. 14 V3. AT-45 (split-day, v1) is referenced for the measurement. Flagged.
- **Files:**
  - `scripts/data/universe-from-wikidata.mjs` (+ `.d.mts`), `scripts/data/split-frequency.mjs` (+ `.d.mts`), `scripts/ci/licence-register.mjs` (+ test), `docs/source-licence-register.md`.
  - `src/lib/data/schema.ts`, `src/lib/data/universe/handler.ts`.
  - Fallback switch (ASX-fail counter ≥ 3 runs): **new** (guess: under `src/lib/data/universe/`).
  - `.github/workflows/replay.yml` (production full replay output, existing).

### DAT-253 Source hosts
- **Summary:** Add `asic.gov.au` and `ssrn.com` to `SOURCE_HOSTS` with the same fetch rules; record the licence rows.
- **Full text:** "**DAT-253 Source hosts (C35; D-631, D-656).** `asic.gov.au` and `ssrn.com` are added to `SOURCE_HOSTS` for KB documents and expert sources with the same fetch rules (robots, conditional requests, no full text stored beyond the licence); the licence register rows are recorded [VERIFY]."
- **Decisions:** D-631, D-656 (cited).
- **Config:** `source_hosts` (existing list) gains `asic.gov.au`, `ssrn.com` (ch. 15 V3, DAT-253).
- **Current code (checked):** `src/lib/http/safeLink.ts` line 6: `const SOURCE_HOSTS: readonly string[] = ["asx.com.au"];`. Only one host today.
- **Acceptance:** no AT row. Flagged. Covered in part by OPS-112 (2) and TST-135 (b).
- **Files:** `src/lib/http/safeLink.ts`, `docs/source-licence-register.md`, `scripts/ci/licence-register.mjs` (+ test), `src/lib/kb/` (KB fetch rules, guess), `docs/owner-guide/V2_go_live.md` (mentions SOURCE_HOSTS).

### ARN-123 Dividends in pick tracking (D-143 vs D-490)
- **Summary:** Verify whether the picks track record credits dividends in the holding window like the books do. If yes, supersede D-143. If not, fix the outcome basis to total return for new settlements only.
- **Full text:** "**ARN-123 Dividends in pick tracking (D-143 vs D-490).** The build verifies in M18 whether the picks track record credits dividends in the holding window the way the books do (D-490, O-51 total-return basis). If it does, D-143 is recorded superseded; if not, the pick outcome and "vs market" figures are fixed to the total-return basis for new settlements only (settled rows are immutable, AT-35) and the discrepancy is recorded in the exit evidence."
- **Decisions:** D-143 (superseded or kept), D-490, O-51.
- **Acceptance:** AT-35 (settled rows immutable, v1, referenced; text not extracted). No AT row in ch. 14 V3 names ARN-123. Flagged.
- **Files:**
  - `src/lib/picks/track.ts`, `src/lib/picks/vsMarket.ts`, `src/lib/picks/benchmark.ts`, `src/lib/picks/portfolio.ts` (dividend references found by grep).
  - `src/lib/arena/exDividend.ts`, `src/lib/arena/closeBooks.ts`, `src/lib/arena/nav.ts` (the books' total-return treatment, the reference).
  - `docs/M18_exit_evidence.md` (the discrepancy record).

---

## D. Test debt (TST-134…TST-139)

### TST-134 Every written e2e spec runs in CI (F52)
- **Summary:** Each e2e spec that exists but is not in CI runs on every PR. No spec may be skipped; a spec that cannot run is deleted with a decision.
- **Full text:** "**TST-134 Every written e2e spec runs in CI (F52).** The specs that exist but are not in the CI matrix (`e2e/picks-sections.spec.ts`, the AT-65 family-badge walk in `e2e/walks.spec.ts`, `e2e/m13l-experts.spec.ts`, the Editor/Viewer steelman card walk added to `e2e/m11l-steelman.spec.ts`) run on every PR against the seeded local database with the states they need (TST-135). A spec may not be skipped; a spec that cannot run in CI is deleted with a decision, never left unrun. The `.github/workflows/ci.yml` e2e job lists the spec files explicitly and a test fails when a spec file exists that is not listed."
- **Decisions:** none in V3 table.
- **Acceptance:** AT-85 ("CI lists and runs every e2e spec file (a planted unlisted spec fails the check)").
- **Current code (checked):** `.github/workflows/ci.yml` e2e job (line 55) runs `npx playwright test e2e/readability.spec.ts --project=desktop` at line 72; the file list is not yet explicit in what was read. Check.
- **Files:** `e2e/picks-sections.spec.ts`, `e2e/walks.spec.ts`, `e2e/m13l-experts.spec.ts`, `e2e/m11l-steelman.spec.ts`, `.github/workflows/ci.yml`, a new listing check under `scripts/ci/` (guess).

### TST-135 Seeded e2e states and the manual tests (F53)
- **Summary:** Named seed states in `e2e/prepare-db.mjs`; AT-39 fetch clauses run with fixtures; AT-59 Blueprint draw.io automated as UXN-324 (c).
- **Full text:** "**TST-135 Seeded e2e states and the manual tests (F53).** (a) `e2e/prepare-db.mjs` gains named states (`picks-two-sections`, `experts-queue`, `steelman-cards`, `alerts-muted`, `market-built-off`, `blueprint-full`) so every e2e spec starts from a recorded state; (b) **AT-39** is completed: the fetch clauses (robots disallow, conditional requests, daily caps, X manual paste) run with fixture feeds in CI (KB-082); (c) **AT-59** (Blueprint draw.io) is automated as UXN-324 (c), the remaining manual look (visual sanity of the diagram) is listed as an Owner-run check (TST-137)."
- **Decisions:** none in V3 table; KB-082 (polling, licence-gated), UXN-324.
- **Acceptance:** AT-85 ("every seed state loads; AT-39 clauses pass").
- **Files:** `e2e/prepare-db.mjs` (existing; add six states), `e2e/seed/` (existing seed dir), `tests/kb/` (AT-39 fixtures, existing dir), `src/lib/kb/` (fetch rules, guess), `e2e/blueprint-*` (existing `e2e/m16-blueprint-*.spec.ts`).

### TST-136 `[timing]` tests without CI-only retries (F54; D-820)
- **Summary:** Rewrite the three timing checks as deterministic budget tests and remove the retry wrapper.
- **Full text:** "**TST-136 `[timing]` tests without CI-only retries (F54; D-820).** The three timing checks (Worker CPU budget, default-size replay, live look) are rewritten as **deterministic budget tests**: operation counts or simulated clocks instead of wall time; the retry wrapper is removed; a wall-time variant may stay as a non-blocking nightly report."
- **Decisions:** D-820 (cited).
- **Acceptance:** AT-85 ("no `[timing]` test has a retry wrapper and each passes deterministically 20 times in a row locally"). Success metric: 0 CI-only retries (ch. 01).
- **Current code (checked):** `tests/cortex/look.test.ts` line 122: `describe("[timing] the live look (CTX-053 in the app)", { retry: process.env.CI ? 1 : 0 }, ...)`. This is the live-look retry wrapper. The Worker CPU-budget test and the default-size replay test were not located in this grep (guess: `worker/` and `tests/replay/cohortReplay.test.ts`, `tests/coverage/replayCli.test.ts`).
- **Files:** `tests/cortex/look.test.ts`, the Worker CPU test under `worker/` (guess), `tests/replay/cohortReplay.test.ts`, `tests/coverage/replayCli.test.ts`, `vitest.config.mts` (retry setting, guess).

### TST-137 Owner-run checks (F55)
- **Summary:** Each Owner-run check gets a script, a plain-words guide page and a reminder.
- **Full text:** "**TST-137 Owner-run checks (F55).** Each Owner-run check gets a script, a plain-words guide page and a reminder: the quarterly real-key restore drill (D-052, OPS-105), the golden-set spot check (CXA-008: the Owner re-labels 20 random items and the agreement is shown), and the first bake-off review (LLM-077: the Owner reads the report and adds a role to `llm_live_roles`). The V3 PR lists them under "Owner steps after merge"."
- **Decisions:** D-052.
- **Acceptance:** AT-85 ("the Owner-run checks have scripts and guide pages").
- **Files:** `scripts/restore/drill-turso.mjs` (drill, existing), `docs/owner-guide/` (guide pages, new pages, guess), golden-set spot check script under `scripts/` (**new**, CXA-008 is M23), bake-off review: `.github/workflows/llm-bakeoff.yml`, `src/lib/config/keys.ts` (`llm_live_roles`).

### TST-138 Recorded-day replay as the staging replacement
- **Summary:** The OPS-107 recorded-day job is the home for every AT that v1/V2 put on staging. `docs/test-map.md` names a V3 home for each AT.
- **Full text:** "**TST-138 Recorded-day replay as the staging replacement.** The OPS-107 recorded-day job is the home environment (TST-115) for every acceptance test that v1/V2 placed on staging (AT-28 parts, AT-42, AT-60…AT-62, AT-M4); the test map (`docs/test-map.md`, TST-133) is updated so every AT names its V3 home."
- **Decisions:** PRD-046, D-935.
- **Acceptance:** AT-85 ("every AT names a V3 home"); AT-26 and AT-30 re-run in their V3 home (ch. 14 V3 intro).
- **Files:** `docs/test-map.md`, `docs/test-map.baseline.json`, `scripts/e2e-day/check.mjs`, `scripts/e2e-day/lib.mjs`, `.github/workflows/ci.yml`.

### TST-139 Market-aware test matrix
- **Summary:** Unit, job and contract tests run per built market (AU, IN, US) where the code reads the profile. The recorded-day job runs AU `full`, IN and US `off`, plus one IN and one US recorded day in `data_only`. AT-68 runs on every CI run.
- **Full text:** "**TST-139 Market-aware test matrix.** Unit, job and contract tests run per built market with that market's profile fixture (AU, IN, US) where the code path reads the profile; the recorded-day job runs AU in `full` and IN/US in `off` (the production shape) **and** one IN and one US recorded day in `data_only` (the development shape); AT-68 is part of every CI run."
- **Decisions:** D-925 (profile model, referenced by the matrix), D-926 (off-in-production proofs).
- **Acceptance:** AT-85 ("the market matrix runs AU/IN/US profile fixtures"); AT-68 every CI run.
- **Note:** the profile loader is M19 (MKT-107). In M18 the matrix may be set up with AU only; IN/US fixtures are a M19–M20 dependency (guess). Flagged.
- **Files:** `tests/market/` (existing dir), `.github/workflows/ci.yml`, `scripts/e2e-day/check.mjs`, `docs/test-map.md`.

---

## Acceptance tests

### AT-83 Ops and metering (ch. 14 V3, ch. 25 §AT-83)
- **Pass condition (spec):** "Calendar job clock fixture; Turso meters; OFFSET scan; row invariant; HMAC v2; restore dry run; CLI pin; watchdog; quote budget; OPS-110 evidence" — "All as ch. 25 states; OPS-110 lists every night since 2026-10-26 with a named gate or published picks and the plain-words "No picks tonight: …" line renders."
- **Full text (ch. 25):** "Calendar draft job fixture: draft, notice, confirmation and both escalations fire on the clock dates for every built market; Turso meters show the real usage with the summed cross-check, the 15 % notice and the 20 % degrade fire at their lines; the `OFFSET` static test fails on a planted query; the nightly row-by-market invariant alarms on a planted IN row; HMAC v2 refuses an old signer and both signed paths pass smoke stage 2; the restore drill dry run passes in CI with the test key and the quarterly Owner item appears; Vercel CLI is pinned; watchdog fixture alarms on a missed heartbeat; the quote-budget health line and alarm behave; OPS-110 evidence lists every night since 2026-10-26 with a named gate or published picks and the "No picks tonight: …" line renders in plain words."
- **IDs covered:** OPS-103, OPS-104, OPS-105, OPS-109 (a, b, c), OPS-110, SEC-115.

### AT-84 Staging retirement (ch. 14 V3, ch. 25 §AT-84)
- **Pass condition (spec):** "Staging workflows dispatch-only; gate passes only with a green recorded-day job; no active waiver; 0 requests to market-data hosts; every money-path gap closed (test) or re-accepted (detection)."
- **Full text (ch. 25):** "Staging workflows are dispatch-only and documented; the release gate passes with a green recorded-day job and fails when it is red or missing; `waivers.json` holds no active waiver; the recorded-day job makes no request to any market-data host (network assertion); the money-path gap table lists every gap as closed (with its test) or re-accepted (with its detection)."
- **IDs covered:** OPS-107, OPS-106, OPS-108 (c), NFR-040 (restated, not an M18 ID).

### AT-85 Test completeness (ch. 14 V3, ch. 26)
- **Pass condition (spec):** "Planted unlisted spec fails; every seed state loads; AT-39 clauses pass; no retry wrapper, 20/20 deterministic; every AT names a V3 home; scripts and guides exist; AU/IN/US profile fixtures run."
- **Full text (ch. 26):** "CI lists and runs every e2e spec file (a planted unlisted spec fails the check); every named seed state loads; AT-39 fetch clauses pass with fixtures; no `[timing]` test has a retry wrapper and each passes deterministically 20 times in a row locally; the test map names a V3 home for every AT-01…AT-85 and AT-M1…AT-M5; the Owner-run checks have scripts and guide pages; the market matrix runs AU/IN/US profile fixtures."
- **IDs covered:** TST-134, TST-135, TST-136, TST-137, TST-138, TST-139.

### AT-26 re-run (v1, in M18 at its TST-115 home)
- Quoted in OPS-108 (d) above. Home: CI + production read-only checks.

### AT-30 re-run (v1, Owner-executed)
- Quoted in OPS-108 (d) above. Owner sign-off step; the agent records the result.

### AT referenced by M18 items but not in the M18 AT row
| Test | Used by | Note |
|---|---|---|
| AT-32 | OPS-110 (fix proof by replay), OPS-111 (11, bundle path in CI) | v2 test, replay hash |
| AT-35 | ARN-123 (settled rows immutable) | v1 test; text not extracted |
| AT-39 | TST-135 (b), AT-85 | v1 test; fetch clauses |
| AT-45 | DAT-252 (split-day frequency) | v1 test; text not extracted |
| AT-59 | TST-135 (c) | Blueprint draw.io, automated as UXN-324 (c) |
| AT-68 | TST-139 (every CI run) | M19/M20 test, must be green on every commit |
| AT-41 | OPS-112 (3) | v2 test |

## AT coverage table (M18)

| Acceptance test | Covers |
|---|---|
| **AT-83** Ops and metering | OPS-103, OPS-104, OPS-105, OPS-109 (a, b, c), OPS-110, SEC-115 |
| **AT-84** Staging retirement | OPS-106 (gap table), OPS-107, OPS-108 (c) |
| **AT-85** Test completeness | TST-134, TST-135, TST-136, TST-137, TST-138, TST-139 |
| **AT-26** re-run (v1) | OPS-108 (d) |
| **AT-30** re-run (v1) | OPS-108 (d) |
| *no AT named* | OPS-108 (a, b: Owner steps), OPS-111, OPS-112, DAT-251, DAT-252, DAT-253, ARN-123, PLT-080 |

Coverage gaps (flagged, not fixed here): **PLT-080, DAT-251, DAT-252, DAT-253, ARN-123, OPS-111, OPS-112** have no AT row in ch. 14 V3. Their proof is the M18 exit evidence. The test map (TST-133) should give each one a test before M18 exits (guess, per PRD-039 and BLD-055).

## Configuration keys (ch. 15 V3, M18 rows)

| Key | Default | Range | Clause | State |
|---|---|---|---|---|
| `news_assess_per_run` | 40 | 20–200 | DAT-251 b | new (conflicts with existing `sentinel_max_items_per_run`, 1–40) |
| `turso_free_ceiling_pct` | 20 | fixed (O-81) | OPS-104, PRD-045 | new |
| `turso_notice_pct` | 15 | 10–19 | OPS-104 | new |
| `calendar_draft_markets` | built markets | derived | OPS-103 | new |
| `restore_drill_reminder` | quarterly, first day | fixed | OPS-105 | new |
| `hmac_scheme_version` | 2 | fixed per deploy | SEC-115 | new |
| `source_hosts` (existing list) | + `asic.gov.au`, `ssrn.com` | list | DAT-253 | exists; add two hosts |

## Decisions linked to M18 (from ch. 00 V3)

| D-nnn | Decision (short) | M18 IDs |
|---|---|---|
| D-923 | V3 is a delta; CXA amendments only | context |
| D-924 | Build decisions from D-951 | BLD-054 |
| D-934 | Research items time-boxed | none in M18 |
| D-935 | Staging retired; condition replaced; waiver closed | OPS-107, AT-84 |
| D-940 | Turso metering reads platform API; 15 % notice, 20 % degrade; static OFFSET test; row-by-market invariant | OPS-104 |
| D-941 | OPS-110 is task 1; close condition | OPS-110, PRD-049 |
| D-942 | Milestones M18…M23 in order | BLD-049 |
| D-948 | AT-M1…AT-M5 in development mode | context |
| D-926 | Off-in-production proofs | TST-139, AT-68 |

Cited in text but outside the V3 decision table (V1/V2 decisions, need the decision log): D-021, D-042, D-052, D-106, D-143, D-189, D-239, D-490, D-502, D-631, D-656, D-666, D-683/684, D-694, D-699, D-712, D-780, D-820, D-860, D-861, D-883, O-51, O-52, O-53, O-81, R4-I3, SEC-108 c.

## Hard constraints restated for M18

- **Turso free plan ≤ 20 %** of reads and writes per month (PRD-045, O-81). Metering must use the real platform figure (OPS-104 a). The Turso downgrade to Free before 1 December is an Owner step (PLT-080).
- **No OFFSET.** Keyset paging only; the static test is OPS-104 (d). The grep found OFFSET hits in application code that must be reviewed (see OPS-104 Files).
- **No staging.** OPS-107; PRD-046.
- **ASX Worker off.** `ASX_LIVE` stays off in the Worker (`worker/src/asx/slots.ts` line 182, `worker/src/asx/universe.ts` line 107). PRD-047. ASX data only through `asx-fetch`.
- **IN and US off in production.** `markets_enabled` in production stays `["AU"]`; no IN/US job, row or UI (PRD-040, MKT-110, D-926); the nightly invariant (OPS-104 e) alarms on any IN/US row.

## Items in the M18 row whose text was not found

None missing. All 22 IDs were found in the V3 spec (ch. 23, 24, 25, 26 and ch. 12 for the row). Spec-level gaps, flagged rather than invented:

1. **OPS-106:** the list of money-path gaps is not in the V3 spec (it cites D-666, D-683/684, D-699, R4-I3). The table must be built from the decision log.
2. **OPS-108 (a):** the runbook `docs/runbooks/rotate-secrets.md` is named but not written (new file).
3. **OPS-110 and DAT-251 (a):** the [VERIFY] markers and [PROPOSED] target (< 10 failures per run) are unresolved and need a recorded result at build time.
4. **DAT-251 (b):** the spec key `news_assess_per_run` (20–200) conflicts with existing `sentinel_max_items_per_run` (1–40). Decide and record.
5. **ARN-123, AT-35:** AT-35 text was not extracted (v1, referenced only).
6. **PLT-080:** no AT clause. Flagged in the coverage gap above.

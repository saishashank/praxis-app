# M2 design note: AU data model and pipeline (PROPOSAL)

Status: draft for architect review. Sources: `docs/M2_requirements.md`, spec ch. 02, 06, 14, 15, decision log D-001..D-056. Where the spec is open, options are in section 6. No real data or vendor payloads appear in this repo (SEC-110).

## 1. Scope

**In M2** (ch.12 milestone row; acceptance AT-05, AT-06..AT-09):
- Worker master clock, per-minute tick, ASX rate token and slot schedule, dispatch and heartbeats (DAT-122, PLT-071, PLT-074, PLT-075).
- DAT-101 source evaluation (at least 5 trading days; start first, BLD-020).
- The 9 pipeline stages with run records (DAT-020), quality gates (DAT-200..211), AU calendar (DAT-160).
- Corporate-action capture and review queue (DAT-220..223).
- Daily universe snapshots from day 1 (DAT-130).
- Staged announcement and short-interest backfill into history files (DAT-125, 125a, 140).
- Production data-only mode (BLD-024).

**Not in M2:**
- Arena, simulator, cohorts, decision agents A2..A8, Resend emails, Evening Review (M3 onward).
- LLM calls (`llm_tokens` stays 0).
- Backtests and replays (M4; they only consume M2 data, BLD-022).
- IN and US markets (BLD-021, MKT-102).
- Sentinel materiality/polarity rules and alerts (AGT-115) and the AT-18 load test (M5).
- Weekly fundamentals (stage 7) beyond a stub; full PDF parsing (only slot-4 plumbing, see decision 9).
- Batch 2 and Batch 3.

## 2. Tables (main DB, migration `0004_au_data.sql`, D-030/D-031)

Conventions: ISO-8601 UTC text with `Z` (D-031); `market` is `'AU'`; trading date `d` is the Sydney local date `YYYY-MM-DD`. Sydney and Melbourne share UTC offset and DST dates, so the value is the same as Melbourne (DAT-011 applies to Owner-facing times). Append-only uses the same `BEFORE UPDATE/DELETE ... RAISE(ABORT)` triggers as `config_version`. Writes are `INSERT ... ON CONFLICT DO NOTHING` so a re-run never duplicates (DAT-003).

| Table | Main columns | Keys / indexes | Mutability | Retention (DAT-142) |
|---|---|---|---|---|
| `market` | code, tz, session times, cutoff, currency, mode | PK code | config only | forever |
| `trading_calendar` | market, d, kind (session/holiday/early_close), close_time, confirmed, source | PK (market,d) | insert; `confirmed` 0 to 1 once, audited | forever |
| `instrument` | id, market, code, name, listed_on, delisted_on, delist_reason, last_price, last_price_d | UNIQUE (market,code); idx (market,delisted_on) | status fields only | forever (delisted kept, DAT-130) |
| `universe_snapshot` | market, d, code, status, tier U1/U2/U3, mcap_est, adv, halted | PK (market,d,code) | append-only | forever |
| `price_bar` | market, code, d, o,h,l,c, volume, source, published_at, ingested_at | PK (market,code,d); idx (market,d) | **first-seen immutable** (DAT-002): triggers refuse UPDATE/DELETE except the maintenance prune | 500 sessions in Turso, older archived to history files first (DAT-140) |
| `bar_refetch` | market, code, d, fetched_at, ohlcv, max_diff_pct | PK (market,code,d,fetched_at) | append-only | with its bar |
| `adjustment_factor` | market, code, ex_date, factor, corporate_action_id, computed_at | PK (market,code,ex_date,corporate_action_id) | append-only; recompute adds rows (DAT-222) | forever |
| `corporate_action` | id, market, code, type (DAT-220 list), ex_date, record_date, payload_json, evidence_json | idx (market,code,ex_date) | append-only | forever |
| `corporate_action_event` | action_id, at, status (auto_confirmed / queued / applied_best_evidence / resolved), by, note | idx (action_id) | append-only (status history, no UPDATE) | forever |
| `announcement` | id, market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source | UNIQUE (source,ann_id); idx (market,code,published_at); idx (published_at) | append-only | 400 days in Turso (news class); older in history files |
| `source_register` (+ `_history`) | source, terms_url, permitted_use, rate_limits, last_checked, risk, status, owner_ref, summarisation_permitted | PK source | updatable, every change logged | forever |
| `source_status` | source, mode on/off/tripped, since, reason, tripped_by | PK source | updatable; change raises audit/incident | state |
| `data_quality_flag` | id, market, code, d, check_id, severity, detail_json, raised_at, cleared_at, blocks_entries | idx (market,d); idx (market,code,d); partial idx where cleared_at IS NULL | append; `cleared_at` set once | see decision 5 |
| `quality_score` | market, d, tier, valid, expected, score, gate_pass | PK (market,d,tier) | append-only | forever (3 rows/day) |
| `ingest_cursor` | job, market, source, cursor_json, updated_at | PK (job,market,source) | updatable | state |
| `completion_marker` | market, d, kind (data / non-trading / late_sweep), at, run_id, outcome | PK (market,d,kind) | insert once | forever |
| `asx_rate_token` | id=1, last_request_at, day_count_date, day_count | one row, compare-and-set | CAS | state |
| `worker_state` | key, value_json, updated_at | PK key | written only on change | state |
| `backfill_job` | name, source, next_date, done, rows_written_month | PK name | updatable | state |

Reused as is: `run_record` (has `rows_read`, `rows_written`; unique success index per concurrency key gives PLT-076), `incident`, `config_version`, `app_log`.

### Volume and quota arithmetic (DAT-141: writes <= 6M/month, reads <= 300M/month, storage <= 3 GB)

Assumptions (to be measured in AT-06): about 2,200 listed codes including ETFs; 21 trading days/month; about 500 announcements per trading day; an index entry counts as a written row, so indexed tables use a x2.5 factor ([VERIFY] Turso metering).

| Item | Raw rows/month | Counted writes |
|---|---|---|
| `price_bar`: 2,200 x 21 | 46,200 | ~115,000 |
| `universe_snapshot`: 2,200 x 21 | 46,200 | ~115,000 |
| `announcement`: 500 x 21 | 10,500 | ~26,000 |
| flags (~50/day), scores, markers, CA events, run records (~40/day) | ~3,500 | ~9,000 |
| `asx_rate_token` CAS: 720 slots x 30 | 21,600 | 21,600 |
| `worker_state`, `ingest_cursor` (on change, ~100/day each) | 6,000 | 6,000 |
| **Steady state** | | **~0.3M = 5% of 6M** |

- **Backfill** (DAT-125/125a, DAT-140 "staged to <= 50% of a month's write quota"): 6 years x ~126k announcements ≈ 756k rows ≈ 1.9M counted writes. ASIC short history at about 2,200 codes x 252 days x 6 years ≈ 3.3M rows would blow the budget, so it goes to history files only (decision 7). Proposed cap 2M backfill writes/month (33% of the 6M ceiling) tracked in `backfill_job`.
- **Reads:** Worker per minute (token, cursor, state, about 6 rows x 43,200) ≈ 0.26M; nightly checks (about 3 prior bars per code) ≈ 7k/night ≈ 0.15M; re-fetch compare ≈ 0.05M; dashboards and usage meters (index-backed) < 1M. Total about 2M of 300M (< 1%).
- **Storage:** `price_bar` 1.1M rows x ~70 B ≈ 80 MB, with index ≈ 120 MB; `universe_snapshot` ≈ 35 MB per year, forever; `announcement` 130k rows x ~400 B with indexes ≈ 80 MB; `bar_refetch` small if only differing re-fetches are stored (decision 4). Total about 0.3 GB in year 1, growing about 0.05 GB/year, far below 2.5 GB warn and 3 GB ceiling.

## 3. Pipeline: who runs what

Principle (PLT-070, PLT-012): the Worker is a clock and poller, never a processor. CPU per invocation stays at or below 10 ms (network wait excluded): read state in one batched request, conditional GETs of tiny feeds, hash de-duplication, one batched write (PLT-075), then `workflow_dispatch` or a signed POST. Parsing, PDFs and bar maths run in Vercel routes or Actions.

| Component | Does | Does not |
|---|---|---|
| Worker (per-minute cron; secrets per D-055/D-056) | Schedule table; dispatch with `ref: release` (PLT-071); ASX token CAS and slots (DAT-122); announcement poll, <= 40 items (PLT-075); signed calls to Vercel routes for pre-open re-check, late sweep, PDF queue, backfill pages; daily re-enable of GitHub-disabled workflows (PLT-015); 19:50 missing-marker incident; daily ASX request count to System Health | Parse PDFs; run stages; use KV (PLT-075) |
| GitHub Actions (`workflow_dispatch` only, no `schedule:`, PLT-015) | `ingest-batch1` (stages 1..9 and the D-1 re-fetch, DAT-002), `backfill-history` (writes history files to the data repo). Job pattern from `maintenance.yml`: `if: github.ref == 'refs/heads/release'`, `environment: production` with `deployment: false` (D-023), approved-commit checkout (SEC-108 c), non-cancelling `concurrency`, secrets only in `env:` | Wait on the ASX token or fetch asx.com.au (DAT-122); Yahoo only |
| Vercel routes (`/api/internal/*`, HMAC per D-029/D-055) | ASX HTML/PDF fetch and parse on a Worker tick; late sweep and pre-open (light tasks, PLT-014a); heartbeat GET routes with `CRON_SECRET`, production only (PLT-074) | Exceed the Hobby time limit [VERIFY] |

**Idempotency, concurrency, catch-up (PLT-016, PLT-076, DAT-003).**
- Concurrency key is `<job>:<market>:<local date>` in `run_record.concurrency_key`. The unique-success index makes a second success impossible, and every workflow's first step exits if a success exists, so duplicate dispatch is a no-op.
- The Worker re-dispatches only when the slot has passed and there is neither a success nor a running record for the key.
- Catch-up: each stage reads `ingest_cursor` and the last marker and processes all missing trading dates (bounded, for example 5), oldest first. Cursors advance only after commit.
- Every run records `rows_read` and `rows_written` through the existing `startRun/finishRun`. The Worker keeps its own counts in `worker_state` and writes one daily rollup run record (decision 10).

**AU slot schedule (PLT-073).** The spec states times in Australia/Melbourne; the exchange is Sydney. The two zones share offset and DST dates (AEST UTC+10, AEDT UTC+11, changes first Sunday of October and April), so one zone key serves both. The Worker ticks every minute in UTC and decides on the local minute, which replaces the "which trigger fired" guard of PLT-019 (TST-103 DST cases still apply, decision 12).

| Local time | Slot | Runner | Notes |
|---|---|---|---|
| 07:00..19:30, every 4 min | ASX announcement poll (DAT-122 slot 1) | Worker, then Vercel route if parsing is needed | alternate ticks; one ASX slot in 4 minutes stays free for slots 2..5 |
| 09:54 | Pre-open re-check (slot 2) | Worker to signed Vercel route | stub in M2 (Arena disabled) |
| 10:00..10:59 AEST / 11:00..11:59 AEDT | Morning heartbeat (Vercel Cron 00:xx UTC) | Vercel | Worker last poll fresh? |
| 17:30 | Batch 1, stages 1..9 (DAT-020) | Actions `ingest-batch1` | complete by 18:10 (DAT-021) |
| 18:10 | Decision cut-off | Worker | M2 records only the first completed ASX poll after 18:10; Batch 2 does not exist yet |
| 19:35 | Late sweep (D+1 inputs) | Worker to Vercel route | must finish before 19:45 |
| 19:45 | Completion marker `data` or `non-trading` (DAT-022) | Batch 1 / route | |
| 19:50 | Marker check | Worker | in-app incident if missing |
| 20:40 and 21:50 | YAML watchdog | Actions | fails on purpose, GitHub failure email is the channel (NFR-006); no Resend email in data-only mode |
| 21:00..21:59 AEST / 22:00..22:59 AEDT | Evening heartbeat (11:xx UTC) | Vercel | data-pipeline and Worker checks only |
| Outside announcement hours | Slots 3..5: batch needs, PDF queue, backfill | Worker | every ASX slot is free |
| 02:15 UTC | Worker self-check (D-056) | Worker | existing |

**ASX slot supply:** at most 720 per day. Announcement hours 07:00..19:30 are 750 min = 375 slots, 188 of them polls and 187 free. Outside hours are 690 min = 345 slots. About 530 free slots per day serve slots 3..5. If date enumeration costs 1 to 3 requests per date (unknown, [VERIFY]), 6 years = 2,190 dates = about 2,200..6,600 requests = 4..12 days. If it needs per-code requests it will take weeks. M2 measures and reports (DAT-125).

## 4. Sources

| Source | Fetching runtime (DAT-101) | Request pattern | Limits |
|---|---|---|---|
| ASX announcements (O-23) | Worker (poll), Vercel route (PDF/HTML) | One conditional GET of the latest-announcements list per poll slot; diff by `ann_id` hash; detail fetch in a later slot | Spec: 65 s minimum spacing, <= 720/day, poll every 4 min; sustained 403/challenge over 5% for 1 h trips the kill switch (DAT-122/123, `asx_block_trip`). No vendor number is in the spec; confirm in AT-06 |
| Yahoo EOD (yfinance `.AX`, O-26) | Actions runner | Batched download in chunks (proposed 100 tickers, pause between), one pass at 17:30 plus the D-1 re-fetch | **Spec gives no numeric limit (gap).** Proposal: at most one chunk per 5 s, back off on 429, fail the stage visibly rather than fill (DAT-004) |
| RBA / ABS / ASIC | Actions | CSV/XLS download, `as_of` and `published_at` stored | Public, low volume; ASIC history to history files |

**Fixtures (TST-105, SEC-110).** Recorded responses (list pages, Yahoo chunks including bad bars, 429 and challenge pages, calendar pages) live only in the private fixtures repo, read through `FIXTURES_READ_TOKEN` (f-r) in the `ci-fixtures` environment. The public repo holds only hand-written synthetic fixtures (fake codes, invented prices, no vendor text). Fork PRs run synthetic tests only. Staging never contacts ASX or Yahoo (DAT-122, NFR-040).

## 5. Production data-only mode (BLD-024)

**Runs in production:**
- Worker clock and dispatch, ASX poll and slots 3..5.
- Batch 1 stages 1..9, snapshots (DAT-130), quality gates.
- Late sweep, completion marker, 19:50 check.
- Vercel heartbeats and YAML watchdog (pipeline and Worker checks only).
- DAT-125/125a backfill and the DAT-101 harness.
- Existing maintenance and backup, and source kill switches.

**Does not run:** Arena, A2..A8, Resend emails and Evening Review, LLM calls, the pre-open re-check (stub), Batch 2/3.

Switch: a new config key (decision 3) read by the Worker and every job. Staging runs the same code on fixtures.

## 6. Open decisions for the architect

1. **Date key.** Sydney local date for `d` (recommended; same value as Melbourne) or Melbourne.
2. **Where Batch 1 fetches and writes.** (a) Node script writing Turso directly; (b) Python/yfinance fetch (PLT-072) posting batches to a signed Vercel route. Recommend (b) for one DB path and row accounting; fall back to (a) if the route time limit bites.
3. **Data-only switch.** New key `market_mode` (recommended; needs ch.15 and `keys.ts` entry) or derive from "Arena disabled".
4. **`bar_refetch`.** Store all re-fetches (+~110 MB) or only differing ones plus a nightly hash (recommended).
5. **Flag retention.** 180 days or forever when the flag blocked a decision (recommended).
6. **`cleared_at` on flags.** Permit one NULL-to-value update by trigger (recommended) or a separate event table.
7. **ASIC history.** History files only (recommended) or last 500 sessions in Turso.
8. **Yahoo throttle.** Add keys `yahoo_chunk_size` 100 and `yahoo_min_gap_s` 5 (O), then record the measured limit in `source_register` (recommended).
9. **PDF queue in M2.** Build only slot-4 plumbing and the route (recommended) or defer all to M5.
10. **Worker run records.** One daily rollup (recommended), per minute (43k writes/month, rejected), or on change only.
11. **AU calendar source.** Seed 2026..2027 with `confirmed=0` for one-click Owner confirmation (recommended) or fetch the ASX holiday page.
12. **DST tests.** AT-05 needs them in M2 while the sheet points to M5; recommend M2 for the Worker schedule and TST-103 cases.
13. **Backfill cap.** 2M writes/month (recommended) or the spec's 50% (about 3M of the 6M ceiling).
14. **AT gaps.** No AT names DAT-127 or the AU calendar; recommend unit tests mapped in `docs/test-map.md` and flag as spec gaps.
15. **D-022 ID collision.** The review-point rule cited as D-022 is not in the decision log (that ID is the database decision); recommend a new D-number.

### Architect decisions (Opus, 2026-10-11 — D-057)
1. **Date key:** Sydney local date (ASX trading date; same offset and DST dates as Melbourne).
2. **Batch 1:** Python/yfinance (PLT-072) runs in the GitHub Actions job and only **fetches** into a JSON file in the runner; a Node writer in the same job, using the shared, tested DB library, validates and writes Turso directly with run-record row accounting. No Vercel hop (no route time limit, one write path).
3. **Data-only switch:** new config key `market_mode` (`off` | `data_only` | `full`, per market; production AU starts `data_only` for BLD-024).
4. **`bar_refetch`:** store only re-fetches that differ, plus a nightly hash per session.
5. **Flag retention:** 180 days, except flags that blocked a decision, which are kept forever.
6. **`cleared_at`:** one NULL→value update allowed by trigger; everything else append-only.
7. **ASIC history:** history files in the data repo only; Turso keeps the current window.
8. **Yahoo throttle:** keys `yahoo_chunk_size` = 100 and `yahoo_min_gap_s` = 5 (Owner-editable); the measured limit is recorded in `source_register`.
9. **PDF queue:** slot-4 plumbing and route only in M2; parsing in M5.
10. **Worker run records:** one daily rollup row (plus a record on any failure).
11. **AU calendar:** seed 2026–2027 with `confirmed = 0`; the Owner confirms with one click on System Health.
12. **DST tests:** in M2 for the Worker schedule and TST-103 cases.
13. **Backfill cap:** 2M writes/month (stricter than the spec's 50 %).
14. **AT gaps:** unit tests mapped in `docs/test-map.md`; recorded as spec gaps in `docs/06_open_questions.md`.
15. **Not an issue:** D-022 in `docs/07_decision_log.md` is the three-review-points decision; no renumbering.

## 7. Task breakdown

| # | Task | Files | Tests | Owner action |
|---|---|---|---|---|
| T1 | Migration `0004_au_data.sql`: all tables, triggers, indexes; seed `market`, `source_register`, `source_status` | `db/migrations/main/0004_au_data.sql`, `src/lib/data/*.ts`, `docs/test-map.md` | up/down; trigger refusals; re-run uniqueness (DAT-003); index plan checks (DAT-141) | Record O-23, O-26 acceptance |
| T2 | Calendar and DST library; AU calendar seed; confirm stub | `src/lib/data/calendar.ts`, seed SQL | TST-103 DST both ways, holidays, early close | Confirm calendar (DAT-160) |
| T3 | Worker master clock: schedule, local-time decision, dispatch `ref: release`, workflow re-enable, 19:50 check | `worker/src/{clock,dispatch,schedule}.ts`, `index.ts` | TST-124 (CPU margin, duplicate dispatch, DST); AT-05 parts | Cloudflare accounts (O-32), tokens b, b-s, c2 (D-055) |
| T4 | ASX rate token and slot scheduler (CAS, 65 s, 720/day counter, priorities 1..5), poll adapter | `worker/src/asx/*`, `src/lib/data/asxToken.ts` | AT-05 spacing and cap; race test; priority order; kill switch | None |
| T5 | Source adapters and fixtures harness (Yahoo, ASX list parser), synthetic fixtures, fixtures-repo loader; DAT-101 evaluation harness (start first) | `scripts/ingest/*`, `src/lib/data/sources/*`, `tests/fixtures/synthetic/` | parsers; 429/challenge; staging no-network guard | Fixtures repo content; check `FIXTURES_READ_TOKEN` in `ci-fixtures` |
| T6 | Batch 1 stages 1..9, run records, markers, catch-up, re-fetch compare | `.github/workflows/ingest-batch1.yml`, `src/app/api/internal/ingest/*`, `src/lib/data/pipeline/*` | idempotency, resume after kill, immutability, duplicate dispatch | None |
| T7 | Quality engine (DAT-200..211), scores, U1 gate, System Health section | `src/lib/data/quality/*` | AT-07 (entries blocked, exits not); golden cases | None |
| T8 | Corporate actions: capture, auto-confirm, review queue, factors, 5-session rule | `src/lib/data/corporateActions/*`, review-queue page | AT-08 goldens; DAT-126 reversal | Resolve queued items |
| T9 | History files, backfill jobs (announcements by date, ASIC), budget cap | `.github/workflows/backfill-history.yml`, `src/lib/data/backfill/*` | AT-09 Part A and B; cap test | Data-repo token (f) in `production` |
| T10 | Data-only mode, heartbeat routes, watchdog, DAT-101 report, "M2 data start:" PR | `src/lib/config/keys.ts`, `src/app/api/cron/heartbeat/route.ts`, `.github/workflows/watchdog.yml`, `docs/M2_source_evaluation.md` | AT-05 (3 days, Worker stopped, expired token, staging no-op); AT-06 report | Approve production deploy; inbox check (AT-05); ASX outreach (O-23); review the PR (D-022) |

Order: T1, T5 (start the 5-day DAT-101 clock), T2, T3, T4, T6, T7, T8, T9, T10. T6 should reach production as soon as possible because real snapshot days cannot be recovered.

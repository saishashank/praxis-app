# M2 requirements extract: AU data layer and Sentinel Worker

Source: `praxis-app-data/Requirement/v1/spec/` (chapters 02, 06, 07, 10, 12, 14, 15). Extract only. Quotes are trimmed with "…". Where a rule is stated in imperative prose without an RFC keyword (most DAT-* rules), the operative sentence is quoted. Spec IDs are cited as written.

## 1. M2 scope (ch.12, milestone table, verbatim)

> M2 | AU data | **Worker master clock, ASX rate token and slot schedule, Worker dispatch and heartbeats (in-app + GitHub-failure channels)**; DAT-101 source evaluation (≥ 5 trading days — start early), pipeline stages, quality gates, calendar, **daily universe snapshots start immediately** (DAT-130), staged history backfill into history files | AT-05, AT-06…AT-09

## 2. Requirements table

Columns: ID | MUST/SHOULD text (verbatim, trimmed) | Acceptance (AT named in the M2 row, or gap) | ch.15 keys (default, bounds, edit)

Key: "O" = Owner-only edit, "—" = fixed by spec. Bounds are not given in ch.15 §15.5 or §15.6.

### 2a. Ingestion and sources

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| DAT-101 | "…evaluated **from the runtime that will actually fetch it in production** (GitHub Actions runner for batch/EOD sources, the Worker for the ASX announcement poll, the Vercel route for ASX PDFs/HTML)… over ≥ 5 consecutive trading days on: coverage (≥ 98% of U1 and ≥ 90% of U2/U3 codes…), blocked/429 rate (fails if > 2% on any day)… No source is "primary" until it passes." | AT-06 | source pass bars (98% U1, 90% U2/U3, 4 of 5 days, ≤ 2% blocked): as DAT-101, — |
| DAT-103 | AU EOD prices: Yahoo via yfinance (`.AX`), **Owner-accepted risk O-26**. Listed codes, halts, announcements metadata and PDFs: ASX, **O-23**, DAT-122. Macro RBA/ABS, FX RBA, short interest ASIC (store `as_of` and `published_at`). | AT-06 (report and licence register) | none (see DAT-120) |
| DAT-120 | "Per source: terms URL, permitted use, rate limits, last-checked date, risk rating, status… A source whose terms forbid the intended use is disabled unless an Owner risk acceptance is recorded (currently O-23 ASX, O-26 Yahoo). Re-checked monthly (OPS-020)." | AT-06 | none. Yahoo numeric rate limit is not in the spec (gap, see §4) |
| DAT-121 | "Any exchange website not covered by an Owner acceptance (e.g. NSE, BSE) is **off** until checked and recorded." | none named (AT-M1 for IN/US) | none |
| DAT-122 | "All asx.com.au requests from every component are made **only on Worker cron ticks**, through one database-backed rate token (last_request_at with compare-and-set, minimum spacing 65 s)…" Slots alternate ticks (every 2 minutes). Announcement poll every 4 minutes in announcement hours. Priority order: (1) poll, (2) 09:55 pre-open re-check, (3) batch needs, (4) PDF queue, (5) history backfill. "GitHub Actions never waits on the ASX token." "By construction ASX requests ≤ 720 per day." | AT-05 (ASX requests only on slots ≥ 65 s apart) | asx_min_spacing 65 s (—); asx_poll_interval 4 min (O); asx_slot_priorities poll > pre-open > batch > PDF queue > backfill (—); asx_block_trip > 5% 403/challenge over 1 h (O) |
| DAT-123 | "Kill switch per source: off within one cycle; the Evening Review lists feeds that are off." | none named | none |
| DAT-124 | "Content from any personal-use-only source (ASX, Yahoo) shown to Editors/Viewers is limited to derived numbers, headlines, links and our own summaries…" | none named | none |
| DAT-127 | "*ASX off:* no new announcement events, halts inferred only from zero-volume sessions (flagged), F2/F3/F5/F6 make no new entries, F1/F4 continue with halt proxy; exits continue. *Yahoo off:* no new bars → DAT-210 blocks all new entries; open positions are marked at the last price and flagged; exits resume when data returns." Also ASIC-off mode (F6-no-short-interest). | **No M2 AT names DAT-127** (gap) | source_off_mode per DAT-127 (O) |

### 2b. Data quality and immutability

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| DAT-001 | "Every market-data row carries `source`, `published_at` and `ingested_at`. A decision for session D uses only rows published before D's **fixed decision cut-off** (§5.1, AU 18:10 Melbourne)…" | AT-09 (Part A staging; Part B production snapshots since M2) | AU cut-off 18:10 (fixed) |
| DAT-002 | "Each day's bar is stored as **first-seen and immutable**; batch 1 of the next session re-fetches the previous session's bars; a difference > 0.1% on any field flags the bar and every decision made on it… Prices are stored raw; adjustment factors are derived **only from recorded corporate actions** (DAT-220)…" | none named (gap) | refetch_diff_flag 0.1% (O) |
| DAT-003 | "Idempotent, resumable ingestion (PLT-016); re-runs never duplicate." | none named | none |
| DAT-004 | "Fail visible. Missing/suspect inputs create a quality record and block affected decisions (DAT-210); never silently filled." | none named | none |
| DAT-020 | "Stages on trading days, each writing a run record and independently re-runnable… Batch 2's first step MUST verify Batch 1's completion marker for the same market-date; if absent it re-dispatches Batch 1 once; if still absent by 19:30, no new orders are created that night…" Sweep MUST finish before the 19:45 marker. | none named (pipeline stages in M2 row) | none |
| DAT-021 | "AU stages 1–9 complete by 18:10 Melbourne (batch 2 start)." | none named | none |
| DAT-022 | Non-trading days: reduced pipeline writes a `non-trading` completion marker by 19:45. | none named | none |
| DAT-102 | "U1 closes are cross-checked daily when two sources exist; disagreement > 0.5% flags the bar and blocks new entries until resolved." | none named | cross_check_tolerance 0.5% (O) |
| DAT-200 | Per-bar checks: high ≥ max(open, close); low ≤ min(open, close); prices > 0; volume ≥ 0; \|close-to-close move\| > 40% without a corporate action or price-sensitive announcement → suspect; zero volume on a non-halted U1 code → suspect; identical OHLCV to previous day → suspect. | AT-07 | suspect_move 40% (O) |
| DAT-201 | "Quality score per market-day = valid expected bars ÷ expected bars, reported for U1, U2, U3…" | none named | none |
| DAT-210 | "Suspect/missing bars block new entries on those codes (exits still process, flagged). If U1 score < 95% the market makes **no new entries** that night (open positions still marked; exits processed)… Two consecutive failing nights → incident (EML-021)." | AT-07 (blocks entries, not exits) | u1_quality_gate 95% (O) |
| DAT-211 | "Every check is stored and summarised on System Health and in review section 9." | none named | none |

### 2c. Calendars and corporate actions

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| DAT-160 | "Calendars per market (sessions, holidays, early closes, announcement hours) refreshed yearly: by 1 November the build agent's calendar job **drafts** next year's calendar… the Owner only confirms it… (s13) If next year's calendar is still unconfirmed on 1 January, the system uses the provisional calendar, flags every affected day…" | AT-M2 names calendar for markets; **no M2 AT names AU calendar** (gap) | none |
| DAT-220 | "Types: cash dividend…, special dividend, split, consolidation, bonus issue, renounceable and non-renounceable rights/entitlements, spin-off/demerger, merger/takeover (cash and scrip), code/name change…" | AT-08 | none |
| DAT-221 | "An action is **auto-confirmed** when a structured announcement… and the price/vendor data agree. Only **conflicts on held or candidate codes** go to the Owner review queue… A queued item unresolved after 5 sessions is applied using the best-evidence interpretation and flagged." | AT-08 (unconfirmed action appears in review queue) | ca_auto_confirm (O) |
| DAT-222 | "Until resolved: affected codes blocked for entries, cohorts flagged; resolution recomputes factors and positions from the event date (reproducible)." | AT-08 (blocks entries) | none |
| DAT-223 | Non-renounceable entitlements: no compensation. Renounceable: valued at last traded price if traded, else zero. Scrip mergers convert to the acquirer. | AT-08 (golden rights issue) | none |

### 2d. Storage, retention and quota

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| DAT-140 | "Turso holds operational state and the last 500 sessions of market data per market. Full price history is appended nightly to compressed columnar files (one per market-year) stored as **release assets of a separate private data repository** (`<repo>-data`, PLT-022a)… Backfills are staged to ≤ 50% of a month's write quota." | none named (the ≤ 50% backfill rule has no ch.15 key, gap) | turso_recent_sessions 500 (O); backfill ≤ 50% write quota: no key |
| DAT-141 | "Turso budget: 5 GB storage, 500M rows read/month, 10M rows written/month… Ceilings: storage ≤ 3 GB; writes ≤ 6M/month (staging ≤ 15% of that); reads ≤ 300M/month… At `storage_warn_gb` the system shows an in-app notice; at `storage_ceiling_gb` oldest raw price and news rows beyond the retention window… are archived…" Every frequent query MUST be index-backed. | none named | storage_warn_gb 2.5 GB (O); storage_ceiling_gb 3 GB (O); turso ceilings 3 GB / 6M / 300M (O) |
| DAT-142 | "Retention: market data in Turso 500 sessions; logs 30 days; run records 180 days; news 400 days; **forever**: decision cards, trades/fills/ledgers, lessons, change ledger, documents, universe_snapshot, corporate_action, adjustment_factor, trading_calendar, source_register, audit events…" | none named | logs 30 d, runs 180 d, news 400 d (O) |
| DAT-143 | "Nightly backup (PLT-022b) includes every forever table of the main DB, plus the auth DB fetched as an already-encrypted export from a signed Vercel route (ROL-101a); price history files plus the backup reproduce every cohort…" | TST-108 (not an AT in the M2 row) | backup retention 14 daily / 8 weekly / 12 monthly (O) |

### 2e. Sentinel Worker (cron master clock, CPU, slots, heartbeat, dispatch)

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| PLT-012 | "The **Sentinel poller and master clock** MUST run as a **Cloudflare Worker with Cron Triggers**… (Workers Free, 2026-09 [VERIFY]: 10 ms CPU per invocation, 5 cron triggers **per account** (production and staging are separate Cloudflare accounts, O-32)… 50 subrequests per invocation, 100,000 requests/day, no automatic retries). It MUST only fetch/normalise/enqueue…" | TST-124 (CI: CPU budget with margin; ≤ 720 ASX requests/day; slot schedule) | **no ch.15 key** for the 10 ms CPU budget (gap) |
| PLT-070 | "Sentinel on Cloudflare Workers Free. Limits (2026-09, [VERIFY]): 10 ms CPU per invocation (network wait excluded)…" The Worker MUST only fetch small feeds with conditional requests, de-duplicate by hash, write new items, and hand parsing to a Vercel route. | TST-124; AT-18 Part A (M5) "Worker within CPU limit" | none |
| PLT-071 | "One master clock. The Worker's per-minute cron is the master clock: at configured local times it triggers GitHub Actions via `workflow_dispatch` **with `ref: release`** (fine-grained token stored as a Worker secret)… every production workflow's first step exits unless the checked-out ref is `release` (SEC-108 b)… A 19:50 check raises an in-app incident if the nightly completion marker is missing." | AT-05 (`ref: release`; 3 consecutive days with YAML disabled; duplicate dispatch no-op; DST cases pass) | schedule times per PLT-073 table, Melbourne local (O) |
| PLT-072 | Batch/backtest jobs in Actions MAY be Python. No separate Express server. | none | none |
| PLT-074 | "Independent heartbeat. Outside the Worker: two daily **Vercel Cron** checks… and the single YAML watchdog (20:40, 21:50; ~1 billed min per run)… the watchdog run **fails on purpose** so GitHub's own failure email reaches the Owner… Heartbeat routes are GET (Vercel Cron) authenticated with `CRON_SECRET`, idempotent, and **no-op outside the production environment**… an immediate incident on 401/403 from a provider." | AT-05 (heartbeat incident with Worker stopped; watchdog email; heartbeats no-op on staging; expired token → immediate incident) | heartbeat_crons 00:xx and 11:xx UTC (O); watchdog_times 20:40 and 21:50 Melbourne (O) |
| PLT-075 | "Worker batching. Each invocation processes ≤ 40 new items (rest carried over), writes to Turso in one batched request, keeps per-minute state in the database (never Workers KV), and respects the shared ASX rate token (DAT-122)." | AT-18 Part A (M5); none in M2 row | sentinel_max_items_per_run 40 (O) |
| PLT-076 | "Idempotent dispatch. Every workflow declares a concurrency key (job, market, local date) without cancelling in-progress runs, and exits in its first step if a success run record already exists for that key." | AT-05 (duplicate dispatch is a no-op) | none |
| AGT-010 | "Polls only enabled sources (DAT-120); ASX requests follow the slot schedule and rate token of DAT-122; ≤ 40 new items processed per invocation, remainder carried to the next minute; one batched database write per invocation; per-minute state in the database (never Workers KV) (PLT-075)." | AT-18 (M5) | sentinel_max_items_per_run 40 (O) |
| AGT-012 | "The Sentinel never places or changes orders except cancelling at the pre-open re-check (ARN-020a)." | none named | preopen_recheck 09:55 local (O) |
| AGT-015 | "Tracked codes = all codes in U1–U3 of the latest universe snapshot plus any held code." | none named | none |
| PLT-018 | "…the Sentinel MUST implement its own retry with backoff and a "Sentinel blind" alert (email via Chapter 04) when no successful poll occurs for 15 minutes during MAP hours." | none named in M2 row | sentinel_blind_alert 15 min (O) |

### 2f. Dispatch, run records and platform limits (M2 platform support)

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| PLT-014 | "Actions minutes: the code repo is **public**, so GitHub-hosted standard runners are free… The system still meters usage… keeps a self-imposed **soft ceiling of 3,000 minutes/month** (alert at 70%/90%)… Workflows MUST use Linux standard runners." | none named | actions_minutes_soft_ceiling 3,000/month (O); actions_reserve last 10% (—) |
| PLT-014a | Per-job minutes table on the Usage page and in docs/. Light tasks (email send, late sweep, pre-open re-check, heartbeat checks, ASX fetching) run as Vercel routes invoked by the Worker or Vercel Cron. | none named | none |
| PLT-015 | "In a public repo GitHub disables scheduled workflows after 60 days without repository activity. Therefore: Worker-dispatched workflows have **no `schedule:` trigger** (`workflow_dispatch` only)… the Worker checks their state daily (token b, actions read/write), **re-enables** any that GitHub disabled and raises an in-app notice each time." | AT-05 (re-enable with in-app notice) | none |
| PLT-016 | "Every job MUST be **idempotent** (safe to run twice), **short** (respect platform time limits), and MUST support **catch-up** of missed periods." | none named | none |
| PLT-017 | "Every scheduled run MUST write a run record: job name, scheduled time, start/end, status, items processed, duration, token usage, error summary. The dashboard MUST show each job's last success and flag any job older than 2× its expected interval." | none named | run records 180 d (O) |
| PLT-013 | Batch jobs MUST run as GitHub Actions workflows in the public code repo (dispatched by the Worker, PLT-071). Constraints: 5-minute minimum interval, frequent 5–30 minute start delays, no SLA. | none named | none |

### 2g. Backfill and history

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| DAT-125 | "From M2, announcement **metadata** (code, time, type, price-sensitive flag, title) is backfilled over ≥ 6 years via DAT-122 slot (5), **enumerated by date rather than by today's code list** so delisted codes are included [VERIFY the ASX search supports this; otherwise record the gap]… Estimated duration is measured in M2 and reported… M4 replay work that needs it is scheduled after the backfill completes (BLD-022)." | none in the M2 row; M4 AT-17 depends (BLD-022) | event_backfill_years 6 (O); event_coverage_min 90% (—) |
| DAT-125a | "From M2 the ASIC daily aggregated short-position history… is backfilled with `as_of` and `published_at`… If it cannot be backfilled, F6 replay is "not reachable" for the missing years and the app says so; no substitute threshold is invented." | none in M2 row | none |
| DAT-126 | Vendor history is split-adjusted; as-of-D raw prices are reconstructed by reversing vendor split events cross-checked against announcement titles; mismatches flag the code. | TST-102 golden test (consolidation) | none |
| DAT-130 | "No free point-in-time membership or complete delisted history exists: the system stores its own daily universe snapshot from day 1 of M2 for AU… Delisted codes are kept forever with last price and reason." | AT-09 Part B (snapshots stored daily since M2 start) | none |
| DAT-131 | Backtest reports state the share of the test period covered by own snapshots and by the event backfill. | none in M2 row | none |
| BLD-020 | "M2 source evaluation and universe snapshots SHOULD start in the first days, because they need real trading days…" | none | none |

### 2h. Production data-only mode and market gating

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| BLD-024 | "Production data-only mode from M2. From M2 the production deployment runs the real nightly data pipeline and universe snapshots (DAT-130) with the Arena, emails and decision agents (A2–A8) disabled — the A1 Sentinel polling and the DAT-125 backfill do run… staging never calls ASX/Yahoo (DAT-122, NFR-040) and uses recorded fixtures." | AT-05 (production); TST-115 production list includes AT-05 | none |
| 10_nfr table row (data-only) | Market in production data-only mode: heartbeat and watchdog skip email/review checks for that market; data-pipeline and Worker checks still apply. PLT-074 evening check: "email checks skipped for markets in data-only mode". | AT-05 (inbox check is Owner-executed) | none |
| BLD-021 | "Markets are strictly sequential: M9 (India) starts only when AU meets MKT-105 and the Owner approves… No IN/US pipelines run before their milestone starts…" | AT-M1…AT-M5 (per market, not M2) | none |
| BLD-022 | "Estimate (not a commitment): M1–M8 ≈ 4–8 calendar weeks… plus the DAT-125 announcement backfill which may take several weeks at the ASX rate limit (runs in the background from M2…)." | n/a (estimate) | none |

## 3. Needs the Owner

- **O-23 (ASX automated access):** accepted risk; the Owner seeks ASX confirmation in parallel (spec/00 row O-23; open question Q-052). Blocks DAT-103/DAT-120 "enabled" status for ASX. Owner must record the outcome.
- **O-26 (Yahoo via yfinance):** accepted risk for EOD prices (DAT-103, DAT-120). Owner must acknowledge.
- **O-32:** production and staging are separate Cloudflare accounts (PLT-012) so each has its own cron budget. Owner creates and confirms the accounts.
- **Worker secrets (entered by the Owner directly into the stores, never in chat; NFR table SEC-017):**
  - **(b)** production Worker dispatch token: fine-grained, code repo only, Actions read/write, `ref: release`, ≤ 1 year.
  - **(b-s)** staging dispatch token: separate value, dispatches `ref: main` in test windows only.
  - **(c2)** Worker to Vercel HMAC: random 32 bytes, separate value per environment, yearly rotation.
  - Also (d) per environment (BUILD_SETUP M0 step 3, 12_build_plan row 21).
  - Data-repo token (Contents read/write, ≤ 1 year) is needed for DAT-140 archives (BUILD_SETUP M0 step 4).
- **AT-05 inbox check:** Owner-executed (confirms the GitHub failure email arrives).
- **M2 review point (D-022, BUILD_SETUP §9 notes):** "M2 data start:" PR (production data-only mode, BLD-024) is one of the three PR review points. The bot requests review from the Owner on that PR only.

## 4. Cross-references not found / contradictions

- **D-022 ID collision:** `docs/07_decision_log.md` D-022 (2026-09-21) is the Turso/Cloudflare/GitHub database decision. BUILD_SETUP and CLAUDE.md cite D-022 for the three-review-point rule (2026-10-09), which is not in the decision log.
- **DST placement:** AT-05 (M2) requires "DST cases pass" for Worker dispatch, but the M5 row lists "DST handling" and AT-M2 covers calendar DST per market. Which milestone owns the PLT-019 DST tests is unclear.
- **Heartbeat email in data-only mode:** AT-05 requires the watchdog's GitHub failure email in M2, while PLT-074 and the NFR table skip email checks for data-only markets. Read as: the GitHub failure email is a GitHub channel, not a Resend email; confirm.
- **No ch.15 key** for: Worker 10 ms CPU budget (TST-124 requires margin), 720 ASX requests/day (DAT-122 s13), 50 subrequests, backfill ≤ 50% monthly write quota (DAT-140), Yahoo rate limit (DAT-120), 65 s is fixed (—) but no bounds given.
- **Undefined term:** "MAP hours" (PLT-018) is not defined in ch.02 or ch.15.
- **Not in M2 row but cited by M2 work:** AT-05a (public-repo hygiene, PLT-022a), AT-05b (release control), DAT-127 (source-off), DAT-160 (AU calendar). No M2 AT names DAT-127 or the AU calendar.
- **Build-time [VERIFY] items:** ASX enumeration by date (DAT-125), ASIC archive depth (DAT-125a), Workers Free limits (PLT-070), Vercel Hobby timeout (PLT-012), Turso metering (DAT-141), ASX platform close time about 19:30 (DAT-020).
- **Cron timing (ch.07 vs spec):** ch.07 AGT-010 table says other sources every 15–30 min outside hours; DAT-122 allows non-ASX sources every minute and gives outside-hours slots to (3)–(5). Not strictly contradictory; confirm the outside-hours cadence for non-ASX sources.
- **Milestone ownership:** M2 row names AT-05 and AT-06…AT-09; AT-M1…AT-M5 are per market (M9/M10) and must not gate M2.

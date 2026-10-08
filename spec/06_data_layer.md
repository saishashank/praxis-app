# Chapter 06 — Data Layer: markets, sources, ingestion, quality, storage  (v2.0, session 10)

_v1.0 rewrote the imported draft; v1.1 applies the session-9 review fixes and owner decisions O-25…O-27. IDs are stable. Requirements only — no code. Provider facts are **[VERIFY at build]** and configuration (Ch. 15)._

## 6.0 Scope
The data layer obtains, validates, versions and stores the listed universe, EOD prices, corporate actions, announcements metadata, macro series, FX, short interest, director/substantial-holder notices, optional fundamentals, calendars and the source-licence register — **for Australia first**, then India, then USA (O-27).

## 6.1 Principles
- **DAT-001 (s9) Point-in-time.** Every market-data row carries `source`, `published_at` and `ingested_at`. A decision for session D uses only rows published before D's **fixed decision cut-off** (§5.1, AU 18:10 Melbourne). Live rows without a known publication time use `ingested_at`. **Historical (backfilled) rows** use an assumed publication time: bars = that session's close + 30 min; announcements without a time follow ARN-020's session-level rule (day 0 = the announcement date if a trading day, usable from that day's cut-off) — flagged `assumed_time` and disclosed in replay reports.
- **DAT-002 (s9) First-seen and raw.** Each day's bar is stored as **first-seen and immutable**; batch 1 of the next session re-fetches the previous session's bars; a difference > 0.1% on any field flags the bar and every decision made on it (Decision Card, System Health) — a flag only, since the resulting order has already been placed. Prices are stored raw; adjustment factors are derived **only from recorded corporate actions** (DAT-220), never from a vendor's adjusted series.
- **DAT-003 Idempotent, resumable ingestion** (PLT-016); re-runs never duplicate.
- **DAT-004 Fail visible.** Missing/suspect inputs create a quality record and block affected decisions (DAT-210); never silently filled.
- **DAT-005 No redistribution** beyond the licence (DAT-120, DAT-124, UX-101).

## 6.2 Markets
- **MKT-101 (s9, O-21/O-27)** The data model, agents, schedules and UI are market-parameterised (`market` ∈ {AU, IN, US}) from the first build, but **work is strictly sequential: AU is built and run first; IN development starts only when AU is "in good shape" (MKT-105); US only after IN is in good shape (O-29).**
- **MKT-102 (s9)** A market is **activated** only when: its market profile (DAT-010) is complete; its sources pass DAT-101 and are recorded in DAT-120; its cost-profile known-answer tests pass; Ch. 14 AT-M1…AT-M5 pass; and the Owner switches it on. No IN/US pipelines, polling or storage run before that market's build starts.
- **MKT-103** Each market has its own Arena, controls, ledgers and labels, in its own currency; never pooled.
- **MKT-104** Quotas are shared; the Usage page shows per-market consumption; a newly activated market must fit the budget tables (PLT-014a, DAT-141) before activation.
- **MKT-105 (s9) "In good shape" (gate to start the next market's build)** = AU live ≥ 60 trading days; NFR-001…003 met over the last 30 days; no open S1/S2 incident; AT-01…AT-31 passing; evidence timeline populated; **projected quotas with the next market ≤ 90% of every budget** (PLT-014a gives the Actions projection; within the PLT-014 soft ceiling — the Owner is told before approving); **and** the Owner approves. (Not an "accuracy %" — VAL-103.)
- **MKT-106 (s9) Market work status** shown on the Dashboard and System Health for every market: `not started` / `in build` / `testing` / `active` / `paused`, with the milestone reached (M9/M10) and the date of the last status change (O-27).
- **DAT-010 (s9) Market profile.** One configuration record per market. **AU is fully specified; IN and US fields MUST be completed and verified at the start of their build milestone** (defaults below are provisional):

| Field | AU | IN (provisional) | US (provisional) |
|---|---|---|---|
| Exchange / timezone | ASX, Australia/Sydney | NSE, Asia/Kolkata | NYSE+Nasdaq, America/New_York |
| Session (local) | 10:00–16:00 + closing auction ≈ 16:10 [VERIFY] | 09:15–15:30 | 09:30–16:00 |
| Announcement hours (local) | 07:00–19:30 [VERIFY, ASX GN14] | [VERIFY] | EDGAR 06:00–22:00 ET [VERIFY] |
| Close in Melbourne time | 16:10 same day | ≈ 20:00–21:00 same day (DST-dependent) | ≈ 06:00–08:00 next day |
| Batch 1/2/3 (Melbourne) | 17:30 / 18:10 / 18:40 (PLT-073) | 1 h after close, then +40/+70 min | 1 h after close, then +40/+70 min |
| Review-date rule | block covers session D (today) | block covers the latest session with a completion marker at 19:45 Melbourne (i.e. previous day) | same rule (previous US session) |
| Currency / seed | AUD / **A$600** [OWNER O-25] | INR / A$600 converted at the activation-day FX close, rounded to ₹1,000 | USD / same rule, rounded to US$10 |
| Marketable parcel | A$500 [VERIFY] | none (1 share) [VERIFY] | none (1 share) |
| Tier thresholds (ADV, price) | Ch. 05 ARN-010 in A$ | set at M9 in ₹ | set at M10 in US$ |
| Slippage buckets, tick table | ARN-032 | set at M9 | set at M10 |
| Default cost profile | P5 (ARN-031) | IN-P1: brokerage min(₹20, 0.03%) per order + STT, exchange, SEBI, stamp duty, GST — formula with known answers at M9 | US-P1: $0 commission + SEC fee and FINRA TAF on sells — formula at M10 |
| Settlement | T+2, matched (ARN-025) | T+1 | T+1 |
| C1 control | S&P/ASX 200 ETF [VERIFY code] | Nifty 50 ETF [VERIFY] | S&P 500 ETF [VERIFY] |
| Benchmark / regime index | S&P/ASX 200 | Nifty 50 | S&P 500 |
| Sleeve reality cap/label | 5× (ASIC), ARN-049 | set at M9 (SEBI rules) | set at M10 |
| FX source (for seeds/reporting) | RBA daily exchange rates | same | same |

- **DAT-011** Owner-facing times are always Australia/Melbourne; each market's jobs follow its own calendar and timezone with PLT-019 dual-trigger rules.

## 6.3 Sources
- **DAT-101 (s9) Source selection by evidence.** At build, for each market and data type, candidate sources are evaluated **from the runtime that will actually fetch it in production** (GitHub Actions runner for batch/EOD sources, the Worker for the ASX announcement poll, the Vercel route for ASX PDFs/HTML), not a developer machine, over ≥ 5 consecutive trading days on: coverage (≥ 98% of U1 and ≥ 90% of U2/U3 codes with valid bars on ≥ 4 of 5 days), blocked/429 rate (fails if > 2% on any day), latency after close, raw vs adjusted, corporate-action fields, licence (DAT-120). The report is stored in `docs/` and the decision log. No source is "primary" until it passes.
- **DAT-102** U1 closes are cross-checked daily when two sources exist; disagreement > 0.5% flags the bar and blocks new entries until resolved.
- **DAT-103 (s9) AU sources** (IN/US are chosen at M9/M10 under the same rules). **(s11)** If a market has no free short-interest data source available, F6 runs as a separately labelled variant "F6-no-short-interest", requiring ≥ 2 of the remaining 3 evidence classes, at least one being (a) or (b) (instead of F6's normal ≥ 3 of 4) **(s11)**:

| Data | AU source (all [VERIFY]) | Status |
|---|---|---|
| EOD prices | Yahoo via yfinance (`.AX`) | **Owner-accepted risk O-26** (personal use; unofficial; rate-limited) |
| Listed codes, status, halts/suspensions | ASX company directory and announcements (trading halt / suspension types) | Owner-accepted risk O-23 |
| Announcements metadata + PDFs | ASX Market Announcements | O-23, DAT-122 |
| Corporate actions | Announcements (Appendix 3A.1 dividends incl. franking %, reorganisations, 2A/3B issues) + price-jump check; Yahoo fields as secondary | O-23/O-26 |
| Results / ex-dividend calendar | Derived from announcements (Appendix 3A.1 ex-dates; results-date notices); where absent, "no known event" | O-23 |
| Macro | RBA statistical tables, ABS Data API | public |
| FX | RBA daily exchange rates | public |
| Short interest | ASIC daily aggregated short position reports (published with a lag; store `as_of` and `published_at`) | public |
| Director / substantial-holder notices | Appendix 3Y, Forms 603/604/605 (PDF) | O-23 (DAT-122 PDF quota) |
| Fundamentals (optional) | Yahoo fields, weekly snapshot | O-26; F2 degrades per DAT-170 |
| Benchmark, C1 ETF | Price source above | as above |

- **DAT-104 Excluded in the deployed system:** NewsAPI.org free plan; Finnhub free for non-US; Alpha Vantage free as a primary feed; CEIC; "ASX FTP"; paywalled news sites.
- **DAT-110** News: central-bank/statistics releases, regulator media releases, company announcements (DAT-122), and free RSS feeds whose terms allow automated personal use. Stored: headline, source, time, link, our summary (UX-101).
- **DAT-120 Source licence register.** Per source: terms URL, permitted use, rate limits, last-checked date, risk rating, status (`enabled` / `disabled` / `owner-accepted-risk` with O-n reference). A source whose terms forbid the intended use is disabled unless an Owner risk acceptance is recorded (currently O-23 ASX, O-26 Yahoo). Re-checked monthly (OPS-020). **(s13)** Register field 'automated summarisation permitted: yes / no / unknown'; for 'no' (and 'unknown' until checked) the source is shown as headline + link only, with no LLM summary.
- **DAT-121** Any exchange website not covered by an Owner acceptance (e.g. NSE, BSE) is **off** until checked and recorded.
- **DAT-122 (s9) ASX access (O-23) and slot schedule.** All asx.com.au requests from every component are made **only on Worker cron ticks**, through one database-backed rate token (last_request_at with compare-and-set, minimum spacing 65 s). Because ticks are 60 s apart, **ASX slots occur on alternate ticks (every 2 minutes)**; anything needing parsing (PDFs, large HTML) is fetched and parsed by a **signed Vercel route** invoked on that tick (timeout and retry rules per PLT-012 **(s11)**), which stores only extracted facts, metadata and the PDF link. **GitHub Actions never waits on the ASX token.** Slot priorities: (1) announcement poll — every **4 minutes** (every second ASX slot) during announcement hours, so at least one ASX slot in every 4 minutes remains for priorities (2)–(5) (other, non-ASX sources may be polled every minute); (2) the 09:55 pre-open re-check; (3) batch needs (directory/status refresh after close); (4) PDF queue — held and watch-listed codes first, then Appendix 3Y / 603–605 for U1–U2 codes; (5) history backfill (DAT-125). Outside announcement hours all slots go to (3)–(5). Daily PDF capacity is computed and shown on System Health; a backlog older than 2 trading days marks AGT-105 `unknown` for affected codes. Reachability is tested from each runtime that contacts ASX — Worker and Vercel route (DAT-101); a sustained 403/challenge rate > 5% over an hour trips DAT-123 automatically. **Staging never contacts asx.com.au or Yahoo.** **(s13)** By construction ASX requests ≤ 720 per day (one slot per 2 minutes); the Worker logs the daily count to System Health.
- **DAT-123 Kill switch** per source: off within one cycle; the Evening Review lists feeds that are off.
- **DAT-124 (s9)** Content from any personal-use-only source (ASX, Yahoo) shown to Editors/Viewers is limited to derived numbers, headlines, links and our own summaries; code-level signals are subject to ROL-107.
- **DAT-125 (s9) Historical announcement backfill.** From M2, announcement **metadata** (code, time, type, price-sensitive flag, title) is backfilled over ≥ 6 years via DAT-122 slot (5), **enumerated by date rather than by today's code list** so delisted codes are included [VERIFY the ASX search supports this; otherwise record the gap]; this list of historical codes is also the survivorship reference (ARN-082). Estimated duration is measured in M2 and reported (at one request per 2 minutes outside announcement hours and every 4 minutes during them, likely several weeks); M4 replay work that needs it is scheduled after the backfill completes (BLD-022).
- **DAT-125a (s9) Short-interest history.** From M2 the ASIC daily aggregated short-position history (public, free [VERIFY archive depth]) is backfilled with `as_of` and `published_at`, so F6's class (d) is replayable. If it cannot be backfilled, F6 replay is "not reachable" for the missing years and the app says so; no substitute threshold is invented.
- **DAT-126 (s9) Historical raw prices.** Vendor history is split-adjusted; for replays, as-of-D raw prices are reconstructed by reversing vendor split events **cross-checked against announcement titles** (consolidations, splits); mismatches flag the code. Indicators use only adjustment factors with ex-date ≤ D; tier, tick, parcel and stop computations use raw prices; historical dividends come from vendor dividend events (labelled). A golden test includes a consolidation (TST-102).
- **DAT-127 (s9) Source-off modes.** *ASX off:* no new announcement events, halts inferred only from zero-volume sessions (flagged), F2/F3/F5/F6 make no new entries, F1/F4 continue with halt proxy; exits continue. *Yahoo off:* no new bars → DAT-210 blocks all new entries; open positions are marked at the last price and flagged; exits resume when data returns. Both consequences are stated in the Owner's risk acceptance (BLD-010). Families whose replay dates have < 90% event-history coverage are **UNVALIDATABLE** (ARN-086) until coverage is reached. **(s13)** Halt proxy (ASX off) = the code traded zero volume or has no price in the last session. *ASIC off:* F6 runs as F6-no-short-interest (as DAT-103); other families unaffected; System Health shows the mode.

## 6.4 Nightly pipeline (per active market)
- **DAT-020 (s9)** Stages on trading days, each writing a run record and independently re-runnable: **(s13)** 'Platform close' = close of the ASX announcements platform for the day (≈ 19:30 Melbourne [VERIFY at build]); late-sweep items are stored for D+1 and the sweep MUST finish before the 19:45 marker. Batch 2's first step MUST verify Batch 1's completion marker for the same market-date; if absent it re-dispatches Batch 1 once; if still absent by 19:30, no new orders are created that night, the review is sent 'partial' (EML-011) and an S2 incident is raised.
  1. Calendar check. 2. Universe snapshot (codes, status, tier, market-cap estimate, ADV) (DAT-130). 3. EOD bars for **every listed code** (tiers are ranked from these bars; first-seen, DAT-002). 4. Corporate actions (§6.6). 5. Announcements metadata of the day collected so far by the Sentinel (batch 2 is dispatched by the Worker only after the **first completed ASX poll after 18:10**, and reads items published before 18:10; replays apply the same rule, so live and replay use the same cut-off). 6. Macro, FX, short interest, insider notices on their schedules. 7. Weekly fundamentals snapshot. 8. Quality checks (§6.5). 9. Data completion marker.
  Separate step at 19:35 Melbourne (AU): **late sweep** of announcements published between the cut-off and platform close — stored as D+1 inputs (ARN-020).
  **Batch 1 of D+1** re-fetches D's bars (DAT-002).
  **(s11)** When the trading calendar is unconfirmed for a date, stage 1 treats it as a trading day only if the benchmark index has a bar for it, and flags the day; the decision to include it relies on DAT-210's quality gate.
- **DAT-021** AU stages 1–9 complete by 18:10 Melbourne (batch 2 start).
- **DAT-022 (s9) Non-trading days:** a reduced pipeline (announcement sweep, macro, learning summaries, scheduled replays) writes a `non-trading` completion marker by 19:45 so the daily review is not "partial" (EML-035).

## 6.5 Data quality
- **DAT-200** Per-bar checks: high ≥ max(open, close); low ≤ min(open, close); prices > 0; volume ≥ 0; trading day; no duplicate; |close-to-close move| > 40% without a corporate action or price-sensitive announcement → suspect; zero volume on a non-halted U1 code → suspect; identical OHLCV to the previous day → suspect; first-seen vs re-fetch difference > 0.1% → suspect.
- **DAT-201** Quality score per market-day = valid expected bars ÷ expected bars, reported for U1, U2, U3, plus counts of suspect, missing, cross-source disagreements and unresolved corporate actions.
- **DAT-210** Suspect/missing bars block new entries on those codes (exits still process, flagged). If U1 score < 95% the market makes **no new entries** that night (open positions still marked; exits processed); the review says why. Two consecutive failing nights → incident (EML-021).
- **DAT-211** Every check is stored and summarised on System Health and in review section 9.

## 6.6 Corporate actions
- **DAT-220** Types: cash dividend (amount, ex-date, pay date, franking % for AU), special dividend, split, consolidation, bonus issue, renounceable and non-renounceable rights/entitlements, spin-off/demerger, merger/takeover (cash and scrip), code/name change, delisting (with reason: takeover, administration/liquidation, voluntary, other).
- **DAT-221 (s9)** Detection = announcements + source fields + unexplained-jump check. An action is **auto-confirmed** when a structured announcement (e.g. Appendix 3A.1, reorganisation notice) and the price/vendor data agree. Only **conflicts on held or candidate codes** go to the Owner review queue (Settings → Data, UX-114) as plain-language cards; conflicts on other codes are simply blocked for entry. A queued item unresolved after 5 sessions is applied using the best-evidence interpretation and flagged. **(s13)** If a code with an unresolved queued conflict becomes held or a candidate, the item moves to the Owner review queue immediately and the 5-session auto-apply timer restarts.
- **DAT-222** Until resolved: affected codes blocked for entries, cohorts flagged; resolution recomputes factors and positions from the event date (reproducible).
- **DAT-223 (s9)** Entitlement offers are not taken up: **non-renounceable** — no compensation (holding simply dilutes via price); **renounceable** — rights valued at their last traded price if traded, else zero. Scrip mergers convert to the acquirer if listed in the same market, else cash at the last price. Administrations/liquidations per ARN-026.

## 6.7 Survivorship and point-in-time history
- **DAT-130** No free point-in-time membership or complete delisted history exists: the system stores its own daily universe snapshot from day 1 of M2 for AU (and from the start of each later market's build). Delisted codes are kept forever with last price and reason. Earlier dates carry the survivorship caveat; U2/U3 and F5 replays follow ARN-082's coverage formula (development ≥ 252 + two purges + validation + holdout + completion window of own snapshots, ARN-082) before they can be validated.
- **DAT-131** Backtest reports state the share of the test period covered by own snapshots and by the event backfill (DAT-125).

## 6.8 Storage, quotas, retention, backups
- **DAT-140 (s9) Where data lives.** Turso holds operational state and the last 500 sessions of market data per market. Full price history is appended nightly to compressed columnar files (one per market-year) stored as **release assets of a separate private data repository** (`<repo>-data`, PLT-022a) [VERIFY asset limits]. Backtests and replays run on a local snapshot inside the Actions job, never by row-reading Turso. Backfills are staged to ≤ 50% of a month's write quota.
- **DAT-141 (s9) Turso budget (per account — staging included, [VERIFY] metering):** 5 GB storage, 500M rows read/month, 10M rows written/month, 1-day PITR (Free, 2026-09). Ceilings: storage ≤ 3 GB; writes ≤ 6M/month (staging ≤ 15% of that); reads ≤ 300M/month. **(s11)** A yearly storage-growth projection (estimated from the first 30 days, re-estimated each quarter) is shown on the Usage page. At `storage_warn_gb` (configuration key in ch. 15) the system shows an in-app notice; at `storage_ceiling_gb` (config key) oldest raw price and news rows beyond the retention window of derived data are archived to the private data repository as compressed files, keeping "forever" tables in Turso. Restores use a **whole-database import from a SQLite file** (not row inserts) [VERIFY how it is metered]. Rows **scanned** count as reads: every frequent query (dedupe by hash, rate token, lookups) MUST be index-backed; each job records rows read/written; backups are incremental by id watermark nightly plus a weekly full export. Week-1 measurement confirms estimates (AU ≈ 2,300 bars + ≈ 5,000 other rows per trading day). **(s13)** If AGT-112 is accepted, factor-bucket statistics are computed once per night per family into a summary table (not per signal) and those reads count in this budget.
- **DAT-142 (s9) Retention:** market data in Turso 500 sessions; logs 30 days; run records 180 days; news 400 days; **forever**: decision cards, trades/fills/ledgers, lessons, change ledger, documents, universe_snapshot, corporate_action, adjustment_factor, trading_calendar, source_register, audit events (user identity hashed after 90 days per NFR-030).
- **DAT-143 (s9)** Nightly backup (PLT-022b) includes every forever table of the main DB, plus the auth DB fetched as an already-encrypted export from a signed Vercel route (ROL-101a); price history files plus the backup reproduce every cohort (ARN-102, verified by TST-108).

## 6.9 Data entities and state machines
- **DAT-150 (s9) Entities** (indicative; keyed by `market` where applicable): **(s14)** pick, pick_outcome (incl. its luck-check twin) and factor_bucket_stat (ch. 16 AGT-112/113, ARN-095; picks and outcomes kept forever like decision cards); watchlist (UXN-047); security; universe_snapshot; price_bar (+ first_seen flag, refetch diff); adjustment_factor; corporate_action (+ review status); trading_calendar; announcement (type, polarity, price-sensitive flag, materiality_rule, materiality_llm, link, our summary); macro_series; fx_rate; short_interest; insider_notice; fundamentals_snapshot; market_profile (+ work status MKT-106); cost_profile; execution; rule_version; cohort; order; fill; position; cash_ledger; dividend_receivable; sleeve_state; sleeve_trade (+ shadow flag); control_portfolio; signal; decision_card; blocked_trade; alert (+ per-user acknowledgement); watch_list; lesson; critique; challenger; trial_counter; change_ledger; config_version; calibration_report; bakeoff_result; llm_call; llm_cache; run_record; completion_marker; incident; ops_task; usage_meter; email_delivery; document; annotation; data_quality_check; source_register; rate_token; user (allowlist, role, Google `sub`, session_version); user_preference; audit_event.
- **DAT-151 (s9) State machines** (each transition is timestamped and audit-logged):

| Entity | States and transitions |
|---|---|
| order | created → (pre-open check) cancelled \| submitted (flag `not_rechecked` if ARN-020a didn't run) → filled \| partially filled (participation cap reduced the quantity) \| cancelled (F3 gap rule / halt at open) \| rejected (parcel, cap, halt) |
| cohort | active → target \| bust \| stalled \| timeout ; flags (not states): `shadow` (live liquidated, continued for statistics, ARN-053), `data-event` (a corporate action, suspension or data correction affected the cohort; shown on its record, excluded from nothing) |
| sleeve | unlocked → open → (closed win) unlocked \| (closed loss) locked → unlocked (recovery rule) ; cohort end → unlocked |
| alert | new → acknowledged (per user) → archived (30 days) |
| lesson | L0 → L1 → L2 (automatic by ARN-063 criteria, development data only) → L3 (on adoption) ; any → retired |
| challenger | proposed → replay → shakedown → review → approved → promoted \| rejected \| retired (KB-040) |
| market | not started → in build → testing → active ⇄ paused (MKT-106) |
| corporate_action | detected → confirmed \| edited \| rejected (Owner) |
| user | invited → active → revoked |

## 6.10 Calendar and fundamentals
- **DAT-160** Calendars per market (sessions, holidays, early closes, announcement hours) refreshed yearly: by 1 November the build agent's calendar job **drafts** next year's calendar from the exchange's published holiday list and the Owner only confirms it (one click, OPS-020); a missing confirmed calendar by 1 December raises a notice. **(s13)** If next year's calendar is still unconfirmed on 1 January, the system uses the provisional calendar, flags every affected day 'calendar unconfirmed' and shows a daily P1 notice until the Owner confirms. [OWNER, O-38]
- **DAT-170 (s9) Fundamentals are optional and point-in-time.** A family skips a condition whose field is missing (logged "data gap"); results are sliced by data coverage. Fundamentals are usable only from their `fetched_at`. **Until own fundamentals snapshots satisfy ARN-082's coverage formula (development ≥ 252 + two purges + validation + holdout + completion window, ARN-082), F2 replays run as a separately labelled variant "F2-no-fundamentals"**; using any snapshot fetched after the decision date is a TST-109 failure.

## Acceptance criteria — Chapter 06
- **Given** a decision for D, **then** no input was published after D's cut-off (DAT-001, TST-109).
- **Given** a re-fetch differing by 0.3% from the first-seen bar, **then** the bar and decisions made on it are flagged (DAT-002).
- **Given** the same date is ingested twice, **then** stored results are identical (DAT-003).
- **Given** U1 quality 93%, **then** no new entries, exits processed, review explains (DAT-210).
- **Given** a 1-for-2 split, **then** no artificial P/L and a recorded adjustment factor (DAT-222).
- **Given** a non-renounceable offer, **then** the position is not compensated (DAT-223).
- **Given** two components requesting asx.com.au within 65 s, **then** the second waits for the rate token (DAT-122).
- **Given** staging, **then** no request reaches asx.com.au or Yahoo (DAT-122).
- **Given** a Saturday, **then** a `non-trading` completion marker exists by 19:45 and the review is not partial (DAT-022).
- **Given** a nightly replay, **then** Turso rows read by the job are < 1% of the monthly quota (DAT-140).
- **Given** IN has not started its build, **then** no IN job, poll or table rows exist and the Dashboard shows IN "not started" (MKT-102, MKT-106).

# Chapter 13 — Review Errata & Addenda  (HISTORY as of session 9)

> **Status s9:** chapters 06–12 were rewritten to v1.0 with this chapter folded in. Requirements first written here now live in their home chapters with the **same IDs**: DAT-/MKT- → Ch. 06; AGT-/FAM- (and §13.6 family table) → Ch. 07; KB rules → Ch. 08; UX-10x → Ch. 09; SEC-/ROL-/VAL-/TST- → Ch. 10; OPS-10x → Ch. 11; PLT-070…073 → Ch. 02. If wording here differs from the home chapter, **the home chapter wins**. This chapter is kept as the record of what the session-8 review found and changed.

_Produced by the fresh-eyes review (`docs/15_fresh_eyes_review.md`, which holds the evidence and web sources). This chapter is **binding**: it corrects errors, resolves contradictions between chapters, and adds missing requirements. No code. RFC-2119 keywords. New IDs never reuse old ones. Tags: [OWNER] [PROPOSED] [OPEN] [VERIFY at build]._

## 13.1 Precedence and status (read first)
- **REV-001** _(amended s9)_ Order of authority when texts disagree: **(1) owner decisions in `spec/00` (O-n) → (2) chapters 01–12 and 14 (v1.0) → (3) this chapter 13 (history) → (4) anything in `docs/project_imports/`**. Original s8 wording: owner decisions → chapter 13 → chapters 01–05 → chapters 06–12 and the Project-only documents (`claude/spec/06_data_layer.md`, `07_agents.md`, `08_knowledge_base.md`, `08_playbooks_v1_concrete.md`, `09_ui_ux.md`, `10_nfr_testing.md`, `11_ops_runbook.md`, `12_build_plan.md`, and `claude/*.md` protocol/guide documents).
- **REV-002** Chapters 06–12 are **DRAFT — superseded where this chapter says so**. A build agent MUST read them for structure and intent, but MUST apply every correction below.
- **REV-003** Any performance figure (win rate, expectancy, CAGR, confidence %, uptime, data-quality %, test coverage, line counts) that appears in any document **without a stored measurement behind it is void**. The system MUST display such fields as "not yet measured" until computed from its own data (LLM-034, ARN-063).
- **REV-004** _(amended after owner answers, §13.11)_ v1 scope: **Australia live first; India and USA inside v1 but activated later (O-21); Owner/Editor/Viewer roles in v1 (O-22); simulation only.** Real-trading recommendation tiers and holdings screenshots remain **Phase R (later)**. Chapter 01 §1.5 non-goals "non-ASX markets" and "multi-user access" are superseded accordingly.

## 13.2 Corrections to existing chapters (errata)
| ID | Where | Wrong / conflicting text | Correct requirement |
|---|---|---|---|
| FIX-001 | 06 §1.2, §3–4, 07, 12, PRE_BUILD | "ASX FTP (official, free, ~600 stocks)" as primary OHLCV | No free official ASX EOD feed is assumed. Primary EOD source is chosen at build per DAT-101; ASX has ~2,000+ listed entities. |
| FIX-002 | 06, 07, 12, NEWS_API_RESEARCH, PRE_BUILD | NewsAPI.org free tier used by the running system | MUST NOT be used in the deployed system (its Developer plan forbids staging/production use and delays articles 24 h). MAY be used only on a developer's machine for exploration. |
| FIX-003 | 06, 12 | Finnhub as ASX/India fallback | Finnhub free covers US markets only; MUST NOT be listed as an ASX source. |
| FIX-004 | 07 Sentinel inputs | "5-min OHLCV from Alpha Vantage" | Alpha Vantage free = 25 requests/day. The v1 Sentinel is announcement/news-driven (PLT-010); intraday price alerts are out of v1 (ARN-020). |
| FIX-005 | 06 | CEIC as a free macro source | CEIC is paid; remove. Macro = RBA and ABS official releases. |
| FIX-006 | 06, 10, 11, 12, PRE_BUILD, SECURITY | Turso free "8 GB", "30-day PITR", "audit logs" | Turso Free (2026-09): 5 GB storage, 500M rows read/month, 10M rows written/month, 1-day point-in-time restore, no audit logs [VERIFY at build]. |
| FIX-007 | PRE_BUILD | `DATABASE_URL=postgresql://…` | Turso uses a `libsql://` URL and an auth token; env var names are fixed by the build agent in `.env.example`. |
| FIX-008 | 12 §9 | "GitHub Actions free tier 300 min/mo" | Free plan private repos: 2,000 min/month; planned usage ≤ 1,500 (PLT-014). |
| FIX-010 | 08_playbooks "Historical Profile" tables, summary table, "~17% per month" | Estimated win rates/expectancy labelled "L2 proven on ASX" | All six families start at **evidence grade L0 and label UNVALIDATED**; the tables are replaced by empty metric slots filled only by ARN-080 replay results. |
| FIX-011 | 08_knowledge_base sector rules and pattern examples | Magnitudes/grades such as "25 bp hike → ~1% bank upside (L3)", "sample_size 42, reversal 78%" | These are **hypotheses (L0)**, stored as Lane-B challenger ideas, never as graded knowledge. |
| FIX-012 | FINAL_HANDOFF_CONFIRMATION, 09 System Monitor, DAILY_UPDATE_EMAIL_TEMPLATE | Pre-filled metrics (98.2%, 87% coverage, 73% confidence, 12,400 lines…) | Templates MUST use named placeholders only; mock screens MUST carry a visible "SAMPLE DATA" label. |
| FIX-013 | 08_knowledge_base §3, §8 | Evidence grades redefined (L3 = "high confidence"); Lane B promoted at ">10% outperformance over a cohort"; nightly weight changes when win rate >70% / <40% | Grades are exactly ARN-063 (L0 Observation → L1 Hypothesis → L2 Tested → L3 Adopted). Promotion only per ARN-065 + ARN-081 (statistical, after correction for multiple testing, at cohort boundary). Lane A never changes rule weights or thresholds (see FIX-030). |
| FIX-014 | 08_playbooks cohort allocation ("F1: 3 cohorts, F2: 2…") and family definitions | Different families and allocation from confirmed ARN-002 | Families and executions are exactly ARN-002 (6 families × U/L twins = 12) [OWNER O-18]. Rules per family are in §13.6. |
| FIX-015 | 08_playbooks exits, 08_knowledge_base | Per-position +100% take-profit and −50% stop | 2× and −50% are **cohort NAV** thresholds (ARN-051/052). Position exits are family-specific (§13.6). |
| FIX-020 | 06, 07, 09, 11, 12 | Mixed "AEDT/AEST/Sydney" and wrong UTC conversions (e.g. `'17 10 * * *'` for 17:30 AEDT; "9 AM Melbourne ≈ 5 PM UTC") | Exchange clock = **Australia/Sydney**; owner-facing = **Australia/Melbourne**; storage = UTC; schedules follow PLT-019 (dual UTC triggers + local-time guard). The canonical timeline is §13.4. |
| FIX-030 | 07 §6, 08 §3.1 | Daily Review changes playbook weights nightly | Lane A (daily) may change only knowledge text, watch/block lists, Sentinel materiality weights and data-quality flags (ARN-064). Any rule weight/threshold change is a Lane-B challenger (ARN-065). |
| FIX-040 | 07 overview | "All agents are LLM-backed" | Agents are deterministic programs; LLMs only in the roles of chapter 03 (LLM-001). Strategy Lab is fully deterministic (ARN-090). |
| FIX-041 | 07 §5 Strategy Lab | "Deploy leverage sleeve when confidence high + rate environment favourable" | Sleeve opens only alongside its family's entry per ARN-042; no discretionary leverage. |
| FIX-042 | 07 §5, §6 | "A$20 @ 4% = A$0.80/day" | Financing accrues on exposure at the configured rate (ARN-045 default 9% p.a.): A$200 × 9% ÷ 365 ≈ A$0.05/day. |
| FIX-043 | 07 communication protocol | "Sentinel → Strategy Lab synchronous (price spike triggers immediate decision)" | v1 decisions are made after the close for the next open (ARN-020); Sentinel items feed the nightly step and the owner's alerts. |
| FIX-044 | 07 timeline, 10 §2.3, 12 | Review at 20:00 and Scribe email at 20:30 | Pipeline complete by 19:45; email 20:00–20:45 (EML-010/011); see §13.4. |
| FIX-045 | 07 Sentinel P0–P3 gap/volume table | Alert priority by raw gap % | Replaced by AGT-115 (portfolio-weighted tiers, D-034). |
| FIX-050 | spec/00 O-16, 04 EML-003/006, RESUME | Recipient "to be supplied later" | Recipient supplied: **the Owner's Gmail address (`OWNER_EMAIL`)** [OWNER, recorded in Project s9–10]. The Resend account MUST be registered to this same address while no custom domain exists (the `resend.dev` test sender only delivers to the account's own address). |
| FIX-051 | NEWS_API_RESEARCH cost table | "Resend $1/email" | Resend Free = 100 emails/day, 3,000/month, $0 (EML-002). |
| FIX-060 | USER_GUIDE_LAYMAN | "CBA A$94.20 → A$114.25 (2×)"; 10% stop-loss; "blended 1.56× expected" | A$94.20 → A$114.25 is +21%. Stops follow §13.6. A blend of targets is not an expected return; the guide MUST show targets as targets and the PRD-020 odds table beside them. |
| FIX-061 | 01 PRD-026, 05 ARN-049 | ASIC CFD order "runs to 23 May 2027" | Keep, and the label MUST be re-verified after 23 May 2027 (order may be renewed, changed or lapse) [VERIFY]. |
| FIX-070 | 11 runbook | `wrangler publish`; `npm run batch:nightly` vs Python batch; `curl download.asxonline.com` | Use the current Wrangler deploy command [VERIFY]; one batch entry point per PLT-072; remove ASX FTP checks. |

## 13.3 Data layer addenda (extends chapter 06)
- **DAT-101 Source selection by evidence.** At build, the agent MUST evaluate candidate free EOD sources for the whole ASX (e.g. yfinance/Yahoo `.AX` for personal use; any other genuinely free source found) on: coverage of all listed codes, adjusted vs raw prices, corporate-action fields, latency after close, rate limits, licence terms (DAT-120). Result recorded in `docs/` and `docs/07`. No source is "primary" until it passes.
- **DAT-102 Two independent price sources where possible.** Cross-check closes for U1 daily; a disagreement > 0.5% (configurable) flags the bar and blocks trades on it until resolved.
- **DAT-110 News without NewsAPI.** Allowed v1 news inputs: RBA media releases/RSS, ABS release calendar/releases, ASIC media releases, company announcements (subject to DAT-121/Q-052), and free RSS feeds **whose terms allow automated personal use**. Store headline, source, time, link and our own summary only (UX-101).
- **DAT-120 Source licence register.** A table (in `docs/` and the Usage page) MUST list, per source: terms URL, permitted use (personal/commercial/automated), rate limits, last-checked date, risk rating. Sources whose terms forbid the intended use MUST be disabled by configuration. Re-checked monthly by the ops checklist.
- **DAT-121 ASX website access.** The ASX site terms prohibit robots/scrapers and limit announcements to private personal use. Until the owner answers Q-052, automated fetching from asx.com.au (or its data APIs) MUST be **off by default**, and the Sentinel MUST run on the other permitted sources. If ASX grants written permission, record it in DAT-120 and enable with a polite rate (≥ 60 s between requests, conditional requests, single user).
- **DAT-130 Own point-in-time history from day 1.** No free point-in-time ASX 300 membership or complete delisted history exists. The system MUST store, every trading day: the full listed-code list with names/sector/market cap as seen that day, tier membership (ARN-010), halts/suspensions, and delistings/code changes. Backtests MUST use this history for dates after collection starts and carry the survivorship caveat (ARN-082) for all earlier dates and **all tiers**, not only U2/U3.
- **DAT-140 Quota budget (Turso and Actions).** Turso holds operational state and recent market data (default: last 500 sessions). Full price history lives as compressed columnar files (e.g. Parquet) in a free store the build agent verifies (GitHub release assets or repo LFS alternatives) [VERIFY]. **Backtests and rolling-start replays MUST run on a local snapshot inside the Actions job, never by reading Turso row-by-row.** A historical backfill MUST be staged so it never exceeds 50% of the monthly write quota. The Usage page shows rows read/written vs quota (PLT-050).
- **DAT-150 Required data entities** (names indicative; DDL is the build agent's job): securities, universe_snapshot (daily), price_bar (EOD), corporate_action, trading_calendar, announcement (metadata + our summary), macro_series, short_interest, director_trade / substantial_holder_notice, fundamentals_snapshot (point-in-time, with source + fetched_at), execution, cohort, order, fill, position, cash_ledger, sleeve_state, signal, decision_card (AGT-110), alert, lesson, change_ledger, challenger, run_record, llm_call, email_delivery, document, data_quality_check, source_register. Every market-data row MUST carry `source` and `ingested_at` (point-in-time reconstruction).
- **DAT-160 Trading calendar.** ASX sessions, public holidays and early closes MUST come from configuration refreshed yearly from ASX's published calendar [VERIFY at build]; announcement-platform hours per PLT-010.
- **DAT-170 Fundamentals are optional inputs.** Families MUST degrade gracefully when a fundamental field is missing (skip that condition and log "data gap"), and results MUST be sliced by data-coverage so a family is not judged on names it could not see.

## 13.4 Platform, scheduling and the canonical nightly timeline
- **PLT-070 Sentinel on Cloudflare Workers Free.** Limits (2026-09, [VERIFY]): 10 ms CPU per invocation (network wait excluded), 5 cron triggers per account, 50 subrequests per invocation, 100,000 requests/day. The Worker MUST only: fetch small feeds (RSS/JSON) with conditional requests, de-duplicate by hash, write new items to the database, and hand anything needing parsing/LLM work to a Vercel API route or the next batch. It MUST NOT parse PDFs or large HTML.
- **PLT-071 One master clock.** The Worker's per-minute cron is the master clock: at the configured local times it triggers GitHub Actions via `workflow_dispatch` (a fine-grained token stored as a Worker secret). YAML `schedule:` triggers remain as a backup. Every job writes a run record; a watchdog alerts if the nightly completion marker is missing at 19:50 Melbourne. (Reason: scheduled Actions start 5–30 min late and there are unconfirmed 2026 reports of `schedule` not firing on free private repos.)
- **PLT-072 Languages.** Web app: TypeScript on Next.js (PLT-003). Batch/backtest jobs in Actions MAY be Python. No Express server; security middleware follows Next.js conventions.
- **PLT-073 Canonical trading-day timeline (Australia/Melbourne local; Sydney = Melbourne clock).**

| Local time | Step | Chapter refs |
|---|---|---|
| 07:00–19:30 | Sentinel high-cadence polling of permitted sources | PLT-010, PLT-070 |
| 16:10 | Market closed (after closing auction) — nothing trades intraday in v1 | ARN-020 |
| 17:30 | Batch 1: EOD prices, corporate actions, universe snapshot, data-quality checks | DAT-101…160 |
| 18:10 | Batch 2: indicators, screens, family signals, Decision Cards, orders for next open | §13.5–13.6, ARN-020 |
| 18:40 | Batch 3: close the books, attribution, comparisons, controls, lessons (deterministic) | ARN-060…062 |
| 19:10 | LLM narrative + critic (budgeted) | ARN-063, LLM-032 |
| 19:35 | Late-announcement sweep after MAP closes (report only; affects tomorrow's plan) | EML-011 |
| 19:45 | Completion marker written | EML-035 |
| 20:00–20:45 | Evening Review email | EML-010 |

## 13.5 Agents addenda (implements accepted decisions D-032…D-037 in chapter 07)
- **AGT-101 Regime classifier (D-032).** Deterministic, daily, from: S&P/ASX 200 close vs its 200-session SMA; 20-session realised volatility percentile vs trailing 5 years; drawdown from 52-week high; RBA cash-rate direction of last change. Output one of RISK-ON / NEUTRAL / RISK-OFF / SHOCK with a 3-session hysteresis. Thresholds are configuration [PROPOSED defaults: RISK-OFF if close < SMA200 and vol pct > 70; SHOCK if 5-session index fall > 7% or vol pct > 95]. The regime is a tag on every signal/trade and MAY gate entries per family (§13.6); its usefulness is itself tested (ARN-062).
- **AGT-105 Insider & flow signals (D-033, weight 5%).** Free inputs: director on-market buys/sells parsed from Appendix 3Y announcements; substantial-holder notices (Form 603/604/605) from announcements; ASIC daily aggregated short positions (published with a lag — store `as_of` and `published_at`; never use before publication). Produces an "insider/flow" score used only by F6 and as a Decision Card evidence line. Subject to DAT-121 for announcement access.
- **AGT-110 Decision Card (D-036, D-037).** Every family signal that becomes an order MUST have a stored Decision Card: ticker, family/execution, regime, entry rule(s) that fired with values, evidence list with sources, **thesis-breakers** (3–5 machine-checkable conditions, e.g. "guidance downgrade announcement", "close below announcement-day low", "short interest +2 pp in 10 sessions"), exit plan (stop, trail, time stop), and a **scenario table** (bear/base/bull) whose price ranges come from the stock's own historical return distribution over the holding horizon (e.g. 10th/50th/90th percentile) — **not** from LLM opinion and **without** invented probabilities (VAL-101).
- **AGT-111 Thesis-breaker monitoring (D-036).** The Sentinel and nightly batch MUST evaluate each open position's thesis-breakers; a hit triggers the family exit at the next open (or the alert per AGT-115) and is logged for attribution.
- **AGT-115 Alert tiering (D-034).** Priority = f(position weight in its execution, event materiality, source reliability): P0 = held position with weight ≥ 10% of an execution's NAV **and** materiality ≥ 3, or any trading halt/suspension of a held code; P1 = held position below that weight with materiality ≥ 2, or watch-list item with materiality 3; P2 = everything else (digest). P0 emails follow EML-020 caps; P1/P2 go to in-app and the Evening Review.
- **AGT-120 Roster clarification.** "Data Layer" is a pipeline, not an agent. The agent roster is: Sentinel, Company & Sector Research, Macro & Signal Research (incl. regime), Candle & Pattern, Strategy Lab, Daily Review & Learning, Critic, Scribe — each deterministic except where chapter 03 assigns an LLM role.

## 13.6 Family rules v1 (inside the confirmed families of ARN-002; all [PROPOSED], grade L0, label UNVALIDATED)
_Common to all: signals computed after the close, fill next open + slippage (ARN-020/032); 1–2 positions per execution (ARN-003); every position has a stop and a time stop; ATR = 20-session average true range; "abnormal return" = stock return minus S&P/ASX 200 return that day; all numbers are configuration and bounded for Lane-B tuning._

| Family | Universe | Entry (all must hold) | Exits (first to trigger) | Regime gate |
|---|---|---|---|---|
| **F1 Trend / momentum breakout** | U1 (+U2 opt-in) | Close at a 250-session high; volume ≥ 1.5× 20-session average; 6-month return in top 20% of its tier; ADV filter per tier | Initial stop entry − 2×ATR; trailing stop 3×ATR below highest close; time stop 40 sessions if return < +5% | No entries in RISK-OFF/SHOCK |
| **F2 Quality-value with catalyst** | U1–U2 | Fundamentals where available (DAT-170): positive trailing earnings, P/E below sector median, net debt/EBITDA < 2; **and** a results/guidance announcement in the last 5 sessions with abnormal return ≥ +3% on the day (replaces unavailable consensus-EPS and analyst-upgrade data) | Stop entry − 2.5×ATR; thesis-breaker = guidance downgrade or close below announcement-day low; time stop 60 sessions | No entries in SHOCK |
| **F3 Announcement / event drift** | U1–U2 | Price-sensitive announcement (results, contract, upgrade, M&A target) with abnormal return ≥ +4% and volume ≥ 2× average; next-open gap < +8% (no chasing) | Stop at announcement-day low; time exit 20 sessions; trail 2.5×ATR after +10% | No entries in SHOCK |
| **F4 Mean reversion / validated patterns** | U1 | Close > 200-session SMA and RSI(2) < 10 (or RSI(14) < 30); no negative price-sensitive announcement in last 3 sessions; candlestick patterns only if they passed ARN-074 | Exit when close > 5-session SMA or after 10 sessions; stop entry − 2×ATR | Allowed in all regimes; half size in SHOCK |
| **F5 Small/mid-cap discovery** | U2–U3 (ARN-011 filters mandatory) | Volume ≥ 3× 20-session average **with** an explaining price-sensitive announcement; close in top 25% of the day's range; ADV ≥ tier minimum; price ≥ tier minimum | Stop entry − 2.5×ATR (max −20%); trail 3×ATR; volume < 50% of average for 3 sessions; negative announcement; time stop 30 sessions | No entries in RISK-OFF/SHOCK |
| **F6 Multi-agent consensus** | U1–U2 | ≥ 3 independent agreeing inputs on the same code among: any F1–F5 signal, insider/flow score (AGT-105) positive, Sentinel materiality ≥ 2 positive, regime RISK-ON | Earliest exit of any contributing family's rules | As contributing families |

- **FAM-101** Ideas from the Project playbook doc that do not fit a family above (dividend/ex-date capture, sector rotation on RBA expectations, growth + analyst upgrade) MUST be registered as **Lane-B challenger hypotheses** with a hypothesis document, not as live families.
- **FAM-102** A rule that needs data the system cannot obtain at $0 MUST be marked `BLOCKED-DATA` and skipped, never approximated by an LLM.

## 13.7 Validation addenda (extends chapter 05 §5.10)
- **VAL-101 No uncalibrated probabilities.** Any probability or "confidence %" shown to the owner MUST come from a model whose calibration is measured on held-out data (reliability table stored); otherwise show the evidence grade and validation label instead.
- **VAL-102 Multiple-testing control and evidence timeline.** ARN-081 MUST additionally report the **Deflated Sharpe Ratio** and the **Probability of Backtest Overfitting** across all variants tried (trial count from ARN-085). The app MUST show, per execution, an evidence timeline: cohorts completed, expected date to reach ≥ 5 cohorts at the current pace, and which label (ARN-086) is reachable when.
- **VAL-103 "Accuracy" is not a gate.** Any gate written as "X% accuracy" (e.g. regional pivots in chapter 12) is replaced by: the relevant families hold **PASSED-FORWARD** (ARN-086), beat control C2 per ARN-081 after VAL-102 correction, and show no kill-switch event (ARN-093) in the last 60 sessions.
- **VAL-104 No CAGR gates.** Backtest "CAGR ≥ 20%/15%/10%" gates and "new playbook must beat Lane A by > 5% CAGR" are void; promotion and retirement follow ARN-065/081/092 only.
- **VAL-105 30-day success criteria.** "> 5% return in 30 days" and "20+ trades in 30 days" are removed as success criteria (statistically meaningless at this sample size). System success in the first 30 days = chapter 01 §1.6 metrics + all acceptance tests passing + the evidence timeline populated.

## 13.8 Security & credential hand-off (supersedes CREDENTIAL_REQUEST_PROTOCOL / CREDENTIAL_VERIFICATION_PROTOCOL where they conflict)
- **SEC-101** Secrets MUST NOT be pasted into chat, email, markdown or tickets. The owner enters each secret directly into the platform secret store (GitHub Actions secrets, Vercel environment variables, Cloudflare Worker secrets). The build agent supplies the list of names (not values) and a **CI "credential smoke test"** job that proves each secret works (e.g. DB round-trip on a temp table, test email to the owner, Worker deploy dry-run) without printing values.
- **SEC-102** GitHub access for the build agent uses a **fine-grained personal access token limited to the single private repository**, least privilege (contents, actions/workflows, secrets only if needed), expiry ≤ 90 days. `admin:org` MUST NOT be requested.
- **SEC-103** Secrets MUST NOT be stored in any database table (including a `settings` table).
- **SEC-104** Security tooling MUST be $0: GitHub secret scanning/push protection, `npm audit`/Dependabot, OWASP ZAP baseline scan. Paid penetration tests and AWS S3 backups are out of scope (backups per PLT-022).
- **SEC-105** Auth tests are real: owner account signs in; a second Google account is rejected server-side; an expired session is refused (chapter 02 criteria).
- **SEC-106** _(amended, O-22)_ Roles are in v1 — see ROL-101…106 in §13.11.

## 13.9 UX, email, operations and tests
- **UX-101 News Hub content.** Store and show headline, source, timestamp, link to the original and a system-written summary (≤ 80 words, labelled). Full third-party article text or images MUST NOT be copied into the app unless the source licence permits it (official RBA/ABS/ASIC releases usually do [VERIFY]).
- **UX-102 Sample-data labelling.** Any mockup, seeded demo or empty-state MUST show "SAMPLE DATA".
- **UX-103** The "Jarvis-style" System Monitor is an optional visual theme; functional content = PLT-061 System Health.
- **UX-104** Every page that shows a target, signal or recommendation MUST show the relevant reality panel (PRD-020/021/026) and the validation label (ARN-086).
- **OPS-101 Build progress digest.** During the build, progress emails (if wanted) MUST come from a GitHub Action that summarises commits, CI results and open blockers after each push/night — not from promises that an AI session runs 24/7. Owner-facing times Australia/Melbourne.
- **OPS-102** The ops runbook MUST use the canonical timeline (§13.4) and correct UTC conversions generated from configuration, not typed by hand.
- **TST-101 Known-answer tests.** The simulator MUST pass hand-computed cases: P5 brokerage tiers at each boundary; P2 rule; T+2 settlement; gap-through-stop fills; sleeve close-out at 50% margin; loss cap at margin; R2 unlock; split/consolidation with no artificial P/L; dividend credited on pay date; franking recorded separately.
- **TST-102 Golden datasets.** A frozen small market dataset (≈ 20 codes × 3 years incl. a split, a consolidation, a delisting, a halt) MUST reproduce identical trades/NAV on every run (ARN-102).
- **TST-103 Time tests.** DST transition days (first Sunday in October, first Sunday in April) MUST be tested for the 20:00 email and every scheduled job.

## 13.10 Parked scope (Phase R) and open questions
| Item | Status | Question |
|---|---|---|
| India/USA regions, region switcher | In v1, activated after AU (MKT-101…104) | Q-050 answered |
| Editor/Viewer roles | In v1 (ROL-101…106) | Q-051 answered |
| Automated ASX announcements access | Enabled as owner-accepted risk (DAT-122…124) | Q-052 answered |
| Import Project-only chapters into the folder | Done s8 | Q-053 answered |
| Real-money recommendation tiers (Turbo/Balanced/Steady), holdings screenshot OCR | Parked to Phase R; needs PRD-001/025 revisited | (after Q-050/051) |

## 13.11 Owner answers of session 8 → requirements
**Markets (O-21)**
- **MKT-101** The data model, agents, schedules and UI MUST be market-parameterised (`market` = AU / IN / US) from the first build. **AU MUST go live first** and receives the build and tuning priority (~70% of effort).
- **MKT-102** IN and US are part of v1 but each is **activated only when** (a) its free data sources pass DAT-101 and the licence register DAT-120 (NSE/BSE and US sources have their own terms [VERIFY]), (b) its calendar, cost profile (Ch. 05 style) and timezone are configured, and (c) the owner switches it on. Until then its pipelines MAY run in standby within the quota budget (DAT-140) or stay off.
- **MKT-103** Each market has its own Arena (12 executions, own currency seed), controls, ledgers and validation labels; results are never pooled across markets. Regional "pivot" decisions use VAL-103, not "% accuracy".
- **MKT-104** Quotas are shared: the Usage page MUST show per-market consumption, and standby markets are the first to pause in degrade mode (PLT-051).

**Roles (O-22)** — supersedes PLT-030 "single owner email" and chapter 01 §1.5 "multi-user access".
- **ROL-101** Sign-in via Google OAuth for an **allowlist** of verified emails, each with a role: **Owner** (exactly one: the Owner's Gmail address (`OWNER_EMAIL`)), **Editor**, **Viewer**. Default role for a new entry = Viewer. Checked server-side on every request.
- **ROL-102** Owner only: manage the allowlist and roles, secrets status, configuration, market activation, promotion/rollback of challengers, kill switches. Editor: annotate, run backtests/what-ifs, acknowledge alerts, edit own watch-lists; Editors MUST NOT change strategy rules or configuration. Viewer: read-only.
- **ROL-103** Nothing in v1 places or records real trades for anyone; "execute trade" in the Project role matrix means paper actions only.
- **ROL-104** Every role change, sign-in and sensitive action is audit-logged (append-only); revocation takes effect on the next request.
- **ROL-105** Email in v1 goes to the **Owner only** (the Resend test sender can deliver only to the account's own address, EML-003a). Other users read in-app.
- **ROL-106** Every page visible to non-owners MUST carry "Simulation for personal information only — not financial advice"; before adding non-family users the owner SHOULD check whether sharing outputs requires an AFSL (PRD-025) [VERIFY with a licensed professional]. Other users' emails MUST NOT be sent to any LLM (LLM-036).

**ASX announcements (O-23)** — supersedes DAT-121 default-off.
- **DAT-122** Automated access to ASX announcements is **enabled** as an owner-accepted risk: single polite client (≥ 60 s between requests to the same host, conditional requests, no parallel crawling), metadata + PDF link only (PDFs fetched only for held/watched codes), no redistribution. The licence register MUST record "owner-accepted risk, 2026-09-24; ASX confirmation requested by owner" and the confirmation outcome when it arrives.
- **DAT-123** A single configuration switch MUST turn ASX fetching off instantly (e.g. if ASX objects or blocks), after which the Sentinel continues on other sources and the Evening Review states that ASX feed is off.
- **DAT-124** Because roles let other people see the app (O-22), ASX-derived content shown to Editors/Viewers MUST be limited to headlines, links and our own summaries (the ASX terms allow private personal use).

**Files (O-24)** — Project-only chapters 06–12 and protocol docs are imported into the folder with a banner pointing to this chapter.

## Acceptance criteria — Chapter 13
- **Given** the build agent reads the spec, **when** two chapters disagree, **then** it applies REV-001 and cites the winning ID in its commit/test.
- **Given** a fresh deployment, **when** any performance field has no measurement, **then** the UI shows "not yet measured" (REV-003).
- **Given** the deployed system, **then** no request is made to newsapi.org, and ASX requests respect DAT-122 and stop immediately when the DAT-123 switch is off.
- **Given** a Viewer session, **when** it calls any write endpoint, **then** it is refused server-side (ROL-101/102).
- **Given** India is not activated, **then** no India cohort, alert or email is produced (MKT-102).
- **Given** a Worker invocation, **then** it completes within the platform CPU limit and never parses PDFs (PLT-070).
- **Given** the YAML schedule fails to fire, **then** the Worker-dispatched run still completes and the 19:50 watchdog stays silent (PLT-071).
- **Given** a backtest run, **then** Turso rows-read for that day stay within the daily budget share (DAT-140).
- **Given** any order, **then** a Decision Card with thesis-breakers and a data-derived scenario table exists (AGT-110).
- **Given** a displayed probability, **then** a stored calibration report backs it, otherwise it is not shown (VAL-101).
- **Given** credential setup, **then** no secret value appears in chat, logs, the repo or the database, and the CI smoke test passes (SEC-101…103).
- **Given** the TST-101 cases, **then** all pass exactly.

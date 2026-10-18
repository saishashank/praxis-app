# M4 requirements extract: agents, families and replay engine

Source: `spec/` in this repo (chapters 03, 05, 06, 07, 09, 10, 12, 13, 14, 15, 16; the M4 rows only). `docs/M3_requirements.md` and `docs/M3_design.md` §1, §6 and `docs/07_decision_log.md` D-069…D-077 are cited for the M3 hand-over. Extract only. Quotes are trimmed with "…". Spec IDs are cited as written. `(l.N)` is a line in the named spec file. Where an M4 row names no AT for an ID, the acceptance column says "gap". Items marked **[CHECK]** are unclear or conflicting and need an Owner or architect decision. Spec text is the authority; this file does not change it.

## 1. M4 scope (ch.12 §12.3, verbatim)

> M4 | Agents & families | A2–A5, regime, indicators, events, insider/flow, family rules §7.4, Decision Cards, rolling-start replay engine with VAL-102 statistics | AT-14…AT-17

Related items:

- **BLD-020** (`12_build_plan.md` l.59): M2 source evaluation and universe snapshots "SHOULD start in the first days … every day of snapshots reduces future survivorship bias."
- **BLD-022** (l.61): "M4's AT-17 validation results that need it are completed when it finishes, and AT-17's engine checks do not wait for it." The DAT-125 backfill runs in the background from M2.
- **BLD-024** (l.62): "From M2 the production deployment runs … with the Arena, emails and decision agents (A2–A8) disabled." Staging uses recorded fixtures (see §5 item 26).
- **BLD-031** (l.69): "rolling-start replays provide most early evidence (ARN-080)."
- **TST-115** (`10_nfr_testing.md` l.150): "AT-10…AT-17" run on staging with recorded data.
- **TST-114** (l.149): "one-off heavy work (history backfill into files, DAT-101 evaluation, AT-17 null runs) may run on Actions or in the build agent's own environment."
- **TST-132** (l.167): "re-measured at M4" for the CI budget. ARN-100 (l.131): "M4 delivers a measured budget report."
- The Decision Card data is an M4 deliverable (AT-16). Its screens are built in M7 (§12.3 row M7, UI); see §6.

## 2. Requirements table

Columns: ID (file l.N) | exact MUST/SHOULD/MAY text (verbatim, trimmed) | acceptance | ch.15 keys (default, bounds, edit: O = Owner-only, B = Lane-B, — = fixed, [V] = verify at build).

### 2.1 Agent roster, principles and orchestration (A2–A5)

Roster rows (`07_agents.md` §7.1 l.14–20). M4 covers A2–A5 only:

| # | Agent | When (l.) | Main outputs | LLM role |
|---|---|---|---|---|
| A2 | Company & Sector Research | Batch 2 (18:10) (l.17) | Event records (§7.3.1), insider/flow scores (AGT-105) | R2 summaries (text only) |
| A3 | Macro & Regime | Batch 2 (l.18) | Regime (AGT-101), macro calendar | R2 optional note |
| A4 | Candle & Pattern | Batch 2 (l.19) | Indicators, validated patterns | R4 optional, gated (AGT-033) |
| A5 | Strategy Lab | Batch 2, after books close (ARN-060) (l.20) | Signals, Decision Cards, next-open orders, controls | none |

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| AGT-001 (07 l.6) | "**Deterministic first.** Agents are deterministic programs; LLMs only in the Ch. 03 roles and never compute numbers, choose trades or change configuration" | AT-14; AT-16 | — |
| AGT-011a (07 l.7) | "Everything read by the Strategy Lab, the rule interpreter, filters (ARN-011) and thesis-breakers … MUST be the **rule-derived** value. LLM-adjusted values are stored in separate fields and used only for alert routing and text." | AT-14; gap for the field split | — |
| AGT-002 (07 l.8) | "Every output is a stored record with schema version, input references, agent version, market and timestamp. **(s13)** LLM-based outputs also store provider, model ID and fallback depth (0 = first choice; 'rules-only' when no model was used)." | gap | — |
| AGT-003 (07 l.9) | "One implementation per agent, parameterised by market profile (DAT-010)." | gap | — |
| AGT-004 (07 l.10) | "An agent failure never stops others; downstream steps run on the latest complete inputs and mark outputs `partial`." | gap | — |
| AGT-120 (07 l.11) | "\"Data Layer\" is a pipeline (Ch. 06), not an agent." | gap | — |
| AGT-050 (07 l.97) | "Steps follow PLT-073 with its deadlines; each step checks its predecessor's completion marker and otherwise runs on the latest complete inputs, marking outputs `partial`." | gap in M4 (AT-14 full night) | decision_cutoff 18:10 Melbourne (—, O; ch15 l.15) |
| AGT-051 (07 l.98) | "AU orders are final before the 19:45 marker; IN/US orders are created after their own closes and reported in the next 20:00 review." | gap | — |
| AGT-130 (07 l.94) | "Every entity in DAT-150 carrying market information appears here or is listed as \"stored, not used\"; kept in sync (TST-110)." | TST-110 (10 l.146) | — |

### 2.2 Event records and insider/flow (A2)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| AGT-020 (07 l.35) | "Each announcement of a tracked code becomes an event record: code, published time, **day 0** (ARN-020), category by rules (results, guidance up, guidance down, contract/customer win, capital raising, director trade, substantial-holder change, takeover target, takeover bidder, halt/suspension, exchange query, dividend change, management change, other), price-sensitive flag, day-0 abnormal return …, day-0 volume ratio, and **polarity** by rules: + for guidance up, contract win, takeover target; − for guidance down, capital raising, exchange query, halt; for results and others: sign of the day-0 abnormal return when \|AR\| > 2%, else 0." | gap; AT-15 (events in F2/F3/F5/F6) | event polarity threshold 2% (B; ch15 l.117) |
| AGT-020 (07 l.35, s13) | "Returns are simple close-to-close returns; benchmark = the market profile's regime index (DAT-010)." | gap | — |
| AGT-105 (07 l.36) | "**Insider & flow score** in [−1, +1] = sum, clipped: +0.5 net director on-market buying in the last 30 sessions / −0.5 net selling; +0.25 new substantial holder or increase / −0.25 decrease. (Short interest is **not** in this score …)" … "Where notice PDFs are not yet fetched (DAT-122), the score is `unknown` (not 0); replays without insider history run F6 as the labelled variant \"F6-no-insider\" (ARN-082)." | gap; AT-15 (F6) | insider score weights 0.5/0.25/0.25, 30-session window, 2 pp (B; ch15 l.116) |
| DAT-125 (06 l.71) | "From M2, announcement **metadata** … is backfilled over ≥ 6 years … M4 replay work that needs it is scheduled after the backfill completes (BLD-022)." | AT-17 evidence run | event_backfill_years 6 (O; ch15 l.147); event_coverage_min 90% (—; ch15 l.148) |
| DAT-125a (06 l.72) | "From M2 the ASIC daily aggregated short-position history … is backfilled with `as_of` and `published_at`, so F6's class (d) is replayable. If it cannot be backfilled, F6 replay is \"not reachable\" for the missing years … no substitute threshold is invented." | gap; AT-17 | — |
| DAT-103 (06 l.48) | "If a market has no free short-interest data source available, F6 runs as a separately labelled variant \"F6-no-short-interest\", requiring ≥ 2 of the remaining 3 evidence classes, at least one being (a) or (b) …" | gap | — (no ch15 key; §5 item 2) |
| DAT-127 (06 l.74) | "Families whose replay dates have < 90% event-history coverage are **UNVALIDATABLE** (ARN-086) until coverage is reached." | AT-17 (labels) | — |

### 2.3 Regime (A3)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| AGT-101 (07 l.39) | "Daily per market, from the benchmark: close vs its 200-session SMA; 20-session realised volatility (st. dev. of daily log returns) percentile vs the trailing 1,260 sessions. States: **SHOCK** if the 5-session benchmark fall > 7% or vol percentile > 95 — entered **immediately**; **RISK-OFF** if close < SMA200 and vol percentile > 70; **RISK-ON** if close > SMA200 and vol percentile < 50; otherwise **NEUTRAL**. Hysteresis applies only when **leaving** a state (3 sessions)." | AT-15 "regime gates behave per §7.4"; AC (07 l.108) "SHOCK trigger day … no hysteresis on entry" | regime thresholds (SMA 200, vol pct 70/95/50, 5-session fall 7%, exit hysteresis 3; O; ch15 l.115) |
| AGT-101 (07 l.39) | "The regime tags every signal/trade and gates entries per §7.4; a cohort's regime is the state on its start date, used for cohort-level reporting only; Critic check AGT-041 (2) uses each row's entry-date tag." | AT-15 | — |
| AGT-101 (07 l.39) | "The central-bank rate direction is shown as information, not used in the rule." | — | — |

### 2.4 Indicators and patterns (A4)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| AGT-030 (07 l.42) | "Definitions (on adjusted closes/highs/lows derived per DAT-002): SMA(n) simple mean of the last n closes including today; ATR(20) and RSI(2), RSI(14) with **Wilder** smoothing; 6-month return = close / close 126 sessions ago − 1, percentile within tier; **250-session high** = today's close ≥ max(close of the previous 249 sessions); volume ratio = today's volume ÷ mean volume of the **previous** 20 sessions; ADV = mean traded value … of the previous 20 sessions; day-range position = (close − low) ÷ (high − low) (0.5 if high = low)." | AT-15; AC (07 l.109) | F1 high_lookback 250 (120–250, B; ch15 l.92). ATR, RSI, SMA, ADV windows not keyed (§5 item 22) |
| AGT-031 (07 l.43) | "Candlestick patterns (v1 candidates: bullish engulfing, hammer, morning star, piercing line — standard TA-Lib definitions) are detected deterministically. A pattern that has PASSED (ARN-074) may replace the RSI condition in F4's entry …; until then patterns are informational only." | gap (ARN-074 test) | — |
| AGT-032 (07 l.44) | "Indicator values match the reference implementation **TA-Lib** (Wilder variants) on the golden dataset to 1e-6 (TST-101)." | AC (07 l.109) | — |
| AGT-033 (07 l.45) | "The optional R4 vision reader may influence nothing unless its pattern labels agree with A4 on ≥ 90% of ≥ 200 labelled charts (LLM-060); until then output is \"illustrative\" text." | gap | vision_gate 90% on ≥ 200 charts (—; ch15 l.125) |

### 2.5 Strategy families v1 (§7.4)

Common rule (07 l.48): "signals after the close for next-open fills (ARN-020/021); exits are tagged `intraday_stop` (IS) or `close_signal` (CS) (ARN-021); stops are recomputed at each close and active from the next session; sizing per FAM-001; ARN-094 cost-feasibility labelling applies." All six families are "[PROPOSED] … grade L0, label UNVALIDATED" (07 l.47).

| Family (07 l.52–57) | Universe | Entry (all must hold) — verbatim trimmed | Exits (first to trigger) — verbatim trimmed | Regime gate | Rank score | ch.15 keys (§15.3, all B) |
|---|---|---|---|---|---|---|
| **F1 Trend / breakout** (l.52) | U1 (+U2 opt-in) | "250-session high; volume ratio ≥ 1.5; 6-month return in top 20% of tier; tier ADV filter" | "IS: initial stop entry − 2×ATR; IS: trailing stop 3×ATR below highest close since entry; CS: 40 sessions held and return < +5%; CS: **hard maximum hold** 120 sessions" | No entries in RISK-OFF/SHOCK | 6-month return percentile | F1 volume_ratio_min 1.5 (1.2–3); rs_top_fraction 0.20 (0.10–0.30); initial_stop_atr 2 (1.5–3); trail_atr 3 (2–4); time_stop 40 (20–60); min_gain 5% (0–10%); max_hold 120 (60–120) |
| **F2 Quality-value with catalyst** (l.53) | U1–U2 | "Fundamentals where available and point-in-time (DAT-170): positive trailing earnings, P/E below the median of its GICS sector …, net debt/EBITDA < 2; **and** a + polarity results/guidance-up event with day-0 AR ≥ +3% in the last 5 sessions" | "IS: entry − 2.5×ATR; CS: − polarity guidance event, or close below event-day low; CS: 60 sessions" | No entries in SHOCK | Event AR | event_ar_min +3% (2–6%); lookback_sessions 5 (3–10); stop_atr 2.5 (1.5–3.5); time_stop 60 (30–90) |
| **F3 Event drift** (l.54) | U1–U2 | "+ polarity price-sensitive event (results, contract, guidance up, takeover target) with day-0 AR ≥ +4% and day-0 volume ratio ≥ 2; order cancelled at fill if next open gaps ≥ +8% above day-0 close" | "IS: event-day low; IS: trail 2.5×ATR after +10%; CS: 20 sessions" | No entries in SHOCK | AR × volume ratio | event_ar_min +4% (3–8%); volume_ratio_min 2 (1.5–4); max_gap +8% (5–12%); trail_after +10% (5–20%); trail_atr 2.5 (1.5–4); time_exit 20 (10–40) |
| **F4 Mean reversion / validated patterns** (l.55) | U1 | "Close > SMA200 and (RSI(2) < 10 or RSI(14) < 30); no − polarity event in the last 3 sessions; patterns only if PASSED" | "CS: close > SMA5; CS: 10 sessions; IS: entry − 2×ATR" | All; half size in SHOCK (subject to parcel, ARN-024) | Lowest RSI(2) | rsi2_max 10 (5–20); rsi14_max 30 (20–35); time_exit 10 (5–20); stop_atr 2 (1.5–3) |
| **F5 Small/mid-cap discovery** (l.56) | U2–U3 (ARN-011 mandatory) | "Volume ratio ≥ 3 **with** a + polarity price-sensitive event on day 0; day-0 AR ≥ +3% and close > prior close; day-range position ≥ 0.75; tier ADV/price minimums" | "IS: entry − 2.5×ATR, capped at −20%; IS: trail 3×ATR; CS: volume ratio < 0.5 for 3 sessions; CS: − polarity event; CS: 30 sessions" | No entries in RISK-OFF/SHOCK | Volume ratio | volume_ratio_min 3 (2–5); ar_min +3% (2–6%); range_pos_min 0.75 (0.6–0.9); stop_atr 2.5 (1.5–3.5); stop_cap −20% (−10…−25%); trail_atr 3 (2–4); time_stop 30 (15–45) |
| **F6 Multi-agent consensus** (l.57) | U1–U2 | "Agreement of ≥ 3 of 4 **evidence classes** on the same code, at least one being (a) or (b): (a) technical signal F1 or F4; (b) event signal F2, F3 or F5 (one event counts once); (c) insider/flow score ≥ +0.5 (known, not `unknown`); (d) short interest fell ≥ 2 pp over 10 sessions" | "IS: entry − 2×ATR; CS: 20 sessions; plus the earliest exit of any contributing family (a)/(b)" | No entries in RISK-OFF/SHOCK | Number of classes, then insider/flow score | min_classes 3 (3–4); insider_min +0.5 (0.25–0.75); short_drop_pp 2 (1–4); stop_atr 2 (1.5–3); time_stop 20 (10–40) |

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| FAM-001 (07 l.59) | "**FAM-001 (s9) Sizing.** Deployable cash per ARN-024a. One candidate: buy the largest whole number of shares within deployable cash and the participation cap, if the value ≥ the marketable parcel (ARN-024). Several candidates: take the top-ranked; open a second only if both legs can each be ≥ the parcel after costs (then split deployable cash 50/50); ties break by higher ADV. \"Half size\" (F4 in SHOCK) applies only if the half still meets the parcel; otherwise no entry." | AT-15; AC (07 l.104) "only the top-ranked is bought" | min_marketable_parcel 500 A$ (—, [V]; M3) |
| FAM-002 (07 l.60) | "A code exited by a stop cannot be re-entered by the same execution for 10 sessions." | AT-15; ARN-080 | reentry_block 10 sessions (5–20, B; ch15 l.110) |
| FAM-003 (07 l.61) | "2×/−50% are execution NAV thresholds (ARN-051/052), never position exits." | gap | target_multiple, bust_fraction (M3) |
| FAM-101 (07 l.62) | "Ideas that don't fit a family (dividend/ex-date capture, sector rotation on rate expectations, growth + analyst upgrade) are Lane-B hypotheses." | gap | — |
| FAM-102 (07 l.63) | "Rules needing data unobtainable at $0 are `BLOCKED-DATA` and skipped, never approximated by an LLM." | gap | — |
| §7.4 common (07 l.48) | "ARN-094 cost-feasibility labelling applies." | VAL-110 (iv-b) | cost_feasibility_ratio 2 (—; ch15 l.74) |

### 2.6 Decision Cards and thesis-breakers

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| AGT-110 (07 l.66) | "Every signal that becomes an order has a card: market, code, family/execution, rule version, regime, rules fired with values, rank score, evidence with sources (events with polarity, insider/flow score or `unknown`, data-quality and first-seen flags), thesis-breakers (3–5 machine-checkable conditions), exit plan with IS/CS tags, cost estimate and break-even move, and a **scenario table = 10th/50th/90th percentiles of this family's rule version's net trade outcomes on development-split replay** (ARN-071) …, with n shown; if n < 30 it shows \"insufficient history\". No probabilities, no LLM numbers." | AT-16; AC (07 l.110) "n = 12 … shows 'insufficient history'" | scenario_min_n 30 (—; ch15 l.123) |
| AGT-110 (07 l.66) | "Every scenario table includes a standing footnote with the development-split n and the as-of roll date **(s11)**. Signals not taken also get cards (for attribution)." | AT-16 | — |
| AGT-110 (07 l.66, s13) | "Data-quality flags are exactly: first-seen, assumed-time, quality-suspect, survivorship-exposed, stale-data." | AT-16; DAT-001 | — |
| AT-16 (14 l.37) | "100% of orders have a card with thesis-breakers and a percentile scenario table; no LLM-produced number on any card" | AT-16 (this row) | — |
| AGT-111 (07 l.67) | "Thesis-breakers are evaluated nightly and at the pre-open re-check. Status is reported as: **green** …, **amber** = at least one thesis-breaker's monitored value is within 20% of its trigger threshold, or a keyword-based thesis-breaker is awaiting confirmation …, **red** = at least one thesis-breaker triggered." | Evaluation is M5 (§6); M4 stores the definitions on the card | — |
| VAL-101 (10 l.129) | "Any model-predicted probability or \"confidence %\" MUST come from a model with a stored calibration report on held-out data. Empirical frequencies (ARN-070–072) with n and CIs … are allowed." | AT-27 (M7); AT-16 | — |

### 2.7 Signal ledger and rolling-start replay (ARN-080)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-080 (05 l.114) | "Cohort replays start every 5 sessions (descriptive CIFs with effective N per ARN-053). **Trade-level evidence** uses the **signal ledger**: every family signal that passes filters, de-duplicated so that each (family, rule version, code) has **at most one open row at a time**: a new row may start only after the previous row's exit, applying the **live** re-entry rule and its current `reentry_block` parameter (FAM-002 …), and event families create **at most one row per event**; simulated **unconstrained at fixed notional** (A$600, no position limit, no cash interaction) with its matched C2 control(s)." | AT-17 (signal-ledger de-duplication; one-open-row rule) | rolling_start_step 5 (5–21, O; ch15 l.39); reentry_block 10 (5–20, B; ch15 l.110); c2_controls_per_row 20 (≥ 10, —; ch15 l.56) |
| ARN-080 (05 l.114) | "A secondary **capacity-constrained book** (top-ranked, ≤ 2 positions, as live) with its own C2 controls is reported on the development split only. Replays need 1,260 benchmark sessions of warm-up for the regime classifier before the first decision." | AT-17 (C2 exit mapping); gap for the capacity book | max_open_positions 2 (1–2, O; ch15 l.17) |
| ARN-004 (05 l.24–27) | "**C2** matched random-entry controls per family …" (selection, M4 per M3 hand-over §4) | AT-11 (M3); M4 selection [CHECK] | c2_live_per_family 20 (10–50, O; ch15 l.38) |
| ARN-083 (05 l.117) | "Cost robustness: must pass under P3 + 50% slippage." | gap; VAL-110 (iv) | stress_profile P3 + 50% (—; ch15 l.29) |
| ARN-100 (05 l.131) | "Nightly deterministic compute ≤ 10 min per active market; **weekly light replay ≤ 30 min** (new trades + controls) and **monthly full replay ≤ 90 min**, rotating markets when several are active; shared control path library; M4 delivers a measured budget report." | AT-17 (measured compute/minutes report) | replay_light / replay_full (weekly ≤ 30 / monthly ≤ 90 min; O; ch15 l.61) |
| DAT-140 (06 l.102) | "Backtests and rolling-start replays MUST run on a local snapshot inside the Actions job, never by reading Turso row-by-row." | gap | turso_recent_sessions 500 (O; ch15 l.141) |

### 2.8 Statistics: block bootstrap, splits, trial ledger, labels (ARN-081…087, VAL-102)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-081 (05 l.115) | "Statistic: mean paired excess e = (row net return − matched control net return) over signal-ledger rows, **studentised** = (mean excess) ÷ (block-bootstrap standard error of centred excesses)." | AT-17 (ARN-081 bootstrap); VAL-110 (i) | — |
| ARN-081 (05 l.115) | "Null distribution: **circular block bootstrap over entry dates** with block length = max(5 sessions, the 75th percentile of the lineage's realised holding period), measured and frozen per lineage as in ARN-082 … — the **only** bootstrap procedure for trade-level tests … one-sided. A tested window must contain **≥ 15 blocks**; otherwise the result is \"insufficient independent blocks\" with the date it becomes reachable." | AT-17 ("windows with < 15 blocks return 'insufficient independent blocks'") | min_blocks 15 (—; ch15 l.58); bootstrap_block (—; ch15 l.60) |
| ARN-081 (05 l.115) | "Multiple testing: **Bonferroni over the trial budget** (ARN-085; default m = 20, α_i = 0.0025) and **Bonferroni across the market's active lineages** (L = max(6, number of active lineages); α_i ÷ L ≈ 0.00042 with 6; Holm step-down only when all are tested in one run)." | VAL-110 (i), (ii) | alpha 0.05 (—; ch15 l.62); trial_budget_per_lineage 20 (O; ch15 l.44); active_lineages_L (—; ch15 l.41) |
| ARN-081 (05 l.115) | "Bootstrap replications B = max(1,000, 20 ÷ level used) (≈ 48,000 at α_i ÷ 6); matched controls per row = `c2_controls_per_row` (default 20). AT-17 checks test size at 0.05 and 0.01 (binomial acceptance bounds plus a uniformity check of the lower-tail p-values; reduced B allowed only for these checks) …" | AT-17 | bootstrap_replications (—; ch15 l.57) |
| ARN-081 (05 l.115) | "Every result shows the **minimum detectable effect** (80% power at the level used). **Absolute gate:** the rows' own mean net return must also be > 0 with its one-sided 90% lower bound > 0 under P5 …" | VAL-110 (i); AT-17 (MDE) | — |
| ARN-082 (05 l.116) | "For each lineage the split dates are fixed in a versioned record when the lineage is created: **holdout** = entries in the most recent holdout-length window of history that ends **one completion window before the data end** …; **validation** = entries in the validation-length window before it; **development** = everything earlier. Splits are defined by **entry dates**; purge between splits = the **upper bound of the lineage's maximum-holding-period parameter** (Ch. 15 bounds) + 20 sessions, frozen per lineage …" | AT-17 (rolling holdout); gap for records | split_holdout max(378, 15 × block); split_validation max(504, 15 × block) (—; ch15 l.40); purge_sessions (—; ch15 l.42) |
| ARN-082 (05 l.116) | "**Window lengths are frozen per lineage** as holdout = max(378, 15 × block) and validation = max(504, 15 × block) sessions, where block is the ARN-081 block length **measured once**, on the data before the default 378/504 layout …; both are re-measured only at a roll. If the resulting development split would be < 252 sessions, the lineage's splits are deferred and the date they become possible is shown …" | AT-17 | — |
| ARN-082 (05 l.116) | "Minimum evidence: ≥ 100 signal-ledger trades and ≥ 15 blocks in the tested window; otherwise \"insufficient evidence\" with its computed date. The holdout is used **once** per rule version." | VAL-110 (AC 05 l.147: 80 trades → insufficient evidence) | min_trades 100 (—; ch15 l.59) |
| ARN-082 (05 l.116) | "**Rolling holdout (lineage-level event):** a roll happens when a challenger of the lineage is **promoted**, or when the Owner requests it after at least one holdout-length of new data." | AT-17 (rolling holdout) | — |
| ARN-082 (05 l.116) | "**Survivorship:** each year's **missing share** = codes with ≥ 3 announcements in the previous 60 sessions … that have no price history in the source, ÷ all such codes; shown per year beside every result. Years with missing share > 5% are marked \"survivorship-exposed\" …; a **delisting sensitivity** re-scores signal-ledger trades …" | AT-17 (survivorship missing-share series; delisting sensitivity) | survivorship_flag_share 5% (O; ch15 l.45) |
| ARN-082 (05 l.116) | "F2, F3 and F6 are validated on **U1-only variants** until own snapshots cover U2; **F5 is descriptive-only** until own snapshots (DAT-130) cover development (≥ 252) + purge + validation + purge + holdout + completion window (≈ 1,330 sessions ≈ 5.3 years at defaults …)." | AT-17 (labels); DAT-130 | — |
| ARN-082 (05 l.116) | "**Price-only history:** families that need no announcements (F1, F4) may use price history older than the announcement backfill; those years are marked \"survivorship unknown (exposed)\" …; Pre-backfill F4 rows cannot apply F4's \"no − polarity event\" condition and form a separately labelled variant \"**F4-no-event-filter**\" …" | AT-17 | — |
| ARN-082 (05 l.116) | "Every PASSED-BACKTEST label carries the note \"v1 rules were written with knowledge of recent market history; only forward evidence is fully out-of-sample.\" F2 uses \"F2-no-fundamentals\" and F6 uses \"F6-no-insider\" variants where PIT data is missing. **Labels attach to the exact variant tested** …" | AT-17 (labels) | — |
| ARN-083 (05 l.117) | "Cost robustness: must pass under P3 + 50% slippage." | gap | — |
| ARN-084 (05 l.118) | "**Leverage.** Primary test: H0 = sleeve per-trade net expectancy ≤ 0 on the family's own entries, same bootstrap as ARN-081 at α_i ÷ L, each test recorded in the trial ledger (ARN-085). C3 comparison is secondary; L−U CIF differences are descriptive." | AT-17 (engine) [CHECK: not in AT-17 list] | sleeve_leverage 10 (—; ch15 l.31) |
| ARN-085 (05 l.119) | "**Trial ledger and budget:** one **market-level trial ledger** counts every generated challenger, every validation/holdout access, every candle-pattern test (charged to F4's lineage) and every new lineage (FAM-101 …). The budget is **cumulative per frozen validation split** (default m = 20 per lineage, not per year); when it is exhausted, further promotions of that lineage wait for the next rolling holdout (ARN-082); the new budget = 20 − (accesses already made × share of the new validation window that overlaps the old one), rounded up." | AT-17 (trial ledger); VAL-102 | trial_budget_per_lineage 20 (O; ch15 l.44) |
| ARN-086 (05 l.120) | "**Labels** per (execution, rule version, variant): UNVALIDATED → **PASSED-BACKTEST** (VAL-110 on validation + one holdout confirmation of (i) at one-sided α = 0.05 ÷ L with the same bootstrap) → **CONSISTENT-FORWARD** (≥ 100 forward **signal-ledger** trades at fixed notional and ≥ 6 months …, tested at 100, 200, 300 … trades with α spent as (0.10 ÷ L) / 2^k at look k …). Negative outcomes …: **FAILED** if U < `useful_edge_min` (+0.5% net …); otherwise **NOT-DEMONSTRATED** … Also UNVALIDATABLE (event coverage < 90%, DAT-125) and \"possible luck\" (doubled without PASSED-BACKTEST)." | AT-17 ("every family gets a label … with n and MDE"); UXN-060 (M7) | holdout_confirm_alpha 0.05 ÷ L (—; ch15 l.48); forward_alpha_spending (—; ch15 l.52); useful_edge_min +0.5% (O; ch15 l.46) |
| ARN-087 = VAL-110 (05 l.121) | "**Validation and promotion test.** On the validation split, a family (or a challenger vs its incumbent) passes iff: (i) per-trade net excess over matched C2 controls > 0 (ARN-081), Bonferroni within the trial budget, **and** the absolute gate of ARN-081 (one-sided 90% lower bound of mean net return > 0 under P5);" | AT-17 (engine checks); AC (05 l.147) | alpha 0.05 (ch15 l.62) |
| ARN-087 / VAL-110 (05 l.121) | "(ii) challengers only: the per-row excess over control of the challenger's ledger > the incumbent's over the same period including rows present in only one version, using the ARN-081 bootstrap at one-sided α_i ÷ L; (iii) **safety check:** on non-overlapping cohorts over development + validation, Δ(bust + stalled) CIF at 252 sessions vs the C2 comparator with its interval (effective N, ARN-053); it **blocks** promotion only when effective N ≥ 8 and the point estimate > +5 percentage points, otherwise it is shown descriptively …" | AT-17 | safety_check_min_neff 8 (—; ch15 l.55); delta_bust_tolerance 0.05 (O; ch15 l.63) |
| ARN-087 / VAL-110 (05 l.121) | "(iv) **absolute** per-trade net expectancy (point estimate) > 0 under P3 + 50% slippage; (iv-b) not labelled cost-infeasible (ARN-094); (v) PBO (CSCV per Bailey, Borwein, López de Prado & Zhu 2017; s14; S = 10 blocks, on **weekly** returns of the fixed-notional signal ledger …) ≤ 0.2 when ≥ 5 variants of the lineage have been tested, else \"n/a\"; (vi) Deflated Sharpe Ratio (Bailey & López de Prado 2014, incl. skewness and kurtosis terms; s14) of **daily** returns … ≥ 0.95. A label reached this way reads \"edge vs random entries; positive after costs (lower bound > 0 under P5; point estimate > 0 under stress)\"." | AT-17 (DSR, PBO n/a below 5 variants) | pbo_max 0.2 (—; ch15 l.64); pbo_min_variants 5 (—; ch15 l.50); dsr_min 0.95 (—; ch15 l.65); dsr_default_sr_variance (—, computed at M4; ch15 l.47) |
| VAL-102 (10 l.130) | "**Multiple testing and evidence timeline.** DSR and PBO are computed and used exactly as in VAL-110 (ARN-087), with the trial count of ARN-085. Each execution shows an evidence timeline: forward signal-ledger trades and effective-N cohorts so far, the expected date to reach 100 forward trades and ≥ 5 effective cohorts at the measured signal rate, each family's earliest possible validation date computed from ARN-082 …, and which label (ARN-086) is reachable when …" | AT-17 ("DSR, PBO"); evidence timeline is UI (M7) | — |
| VAL-103 (10 l.131) | "\"Accuracy\" is not a gate. Any gate phrased as \"X% accuracy\" … is replaced by: the relevant families hold CONSISTENT-FORWARD (ARN-086), beat control C2 per ARN-081 after VAL-102 correction, and show no kill-switch event (ARN-093) in the last 60 sessions." | gap | — (60-session window unkeyed; §5 item 10) |
| VAL-104 (10 l.132) | "No CAGR gates. Backtest \"CAGR ≥ x%\" gates … are void; promotion/retirement follow ARN-065/081/092 and KB-041." | gap | — |
| VAL-105 (10 l.133) | "First-30-day success = Ch. 01 §1.6 system metrics + Ch. 14 acceptance tests passing + evidence timeline populated. Return targets over 30 days are not success criteria." | gap | — |

### 2.9 Scorecards, CIFs and rankings (carried from M3; see §4)

The M3 hand-over lists these as M4 (`docs/M3_design.md` §1 l.11; `docs/M3_requirements.md` l.80). They are listed here for the requirement set and marked as carry-over.

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-070 (05 l.103) | "Trade success metrics (net win rate, average win/loss, payoff, expectancy, profit factor, holding period, exposure) with n and **90%** intervals (Wilson for rates), keyed by (execution, rule version). **All intervals in the app are 90%.** **(s13)** Percentiles and success rates are displayed only when n ≥ 30; otherwise 'Not enough history yet (n = x)'." | gap (M4 engine) | scenario_min_n 30 (—; ch15 l.123) |
| ARN-071 (05 l.104) | "**Execution outcomes** as competing-risk cumulative incidence functions (target / bust / stalled / timeout) with censoring, at 3/6/12 months with 90% intervals; P(target) always shown with P(bust) and P(stalled). … **Headline statistics:** CIF_target(252) and E[NAV at cohort end] − seed, each **minus the matched C2 value**, and the **zero-edge benchmark** (…recomputed per (family, rule version) from replay statistics …). **Progress** on tiles = the empirical replay frequency P(target \| current NAV bucket, sessions elapsed bucket) … \"not yet measured\" until effective N ≥ 3." | AT-17 ("CIFs (target/bust/stalled/timeout), effective N"); ARN-071 not M3 (M3 req l.80) | progress_min_neff 3 (—; ch15 l.71); progress_nav_buckets (O; ch15 l.76); progress_sessions_buckets (O; ch15 l.77); zero_edge_trials 20,000 (5,000–100,000, O; ch15 l.180) |
| ARN-071 (05 l.104) | "**Every replay statistic that is displayed, sent to an agent/LLM or used on a Decision Card** … is computed on the **development split only** — which grows each time the holdout rolls (ARN-082); where a figure is not reachable … the app shows \"reachable at next roll (earliest Owner-requestable roll: date)\" or \"not reachable under current history\" (VAL-102); validation and holdout are touched only by VAL-110 and counted in the trial ledger." | AT-17; AGT-110 | — |
| ARN-072 (05 l.105) | "Signal scorecard: triple barrier ±k×ATR(20) (2 / 1.5) with a 20-session limit, net of costs; lift over matched controls on the same dates. **(s13)** Displayed only when n ≥ 30; otherwise 'Not enough history yet (n = x)'." | gap | barrier_k_up 2 / barrier_k_down 1.5 (1–3, O; ch15 l.72) |
| ARN-073 (05 l.106) | "Sentinel scorecard: precision and recall against \"material move\" = \|abnormal return\| ≥ 5% within 1–3 sessions after publication …" | Sentinel is M5 (§6) | — |
| ARN-074 (05 l.107) | "Candle-pattern scorecard; a pattern PASSES when its trade-level lift passes VAL-110 (i) on validation data; each pattern test counts against the market's trial ledger (ARN-085)." | gap | — |
| ARN-075 (05 l.108) | "LLM-role scorecard." | gap (one line in spec) [CHECK] | — |
| ARN-076 (05 l.109) | "Weekly leave-one-input-class-out replay (re-run the family with one evidence class disabled) estimates marginal contribution." | gap | — |
| ARN-078 (05 l.111) | "Rankings use (execution, rule version) pairs with effective N ≥ 3 in replay or effective N ≥ 5 resolved forward cohorts; executions whose 90% intervals overlap are shown as **tied** (grouped), never ordered; others \"insufficient evidence\"; a promotion restarts forward evidence …" | gap | min_cohorts_ranked 5 (—; ch15 l.73) |
| ARN-053 (05 l.87) | "Cohort counts use **effective N** — the **single definition used everywhere** — = the number of resolved cohorts that do not overlap in time with an already-counted cohort (greedy in start order over the cohorts' actual outcome intervals …), never raw counts. Cohort-level intervals are computed on those non-overlapping cohorts only (exact / Aalen–Johansen), shown with effective N." | AT-17 (effective N) | — |

### 2.10 Guardrails and kill switch (ARN-090…094)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-090 (05 l.124) | "Deterministic, versioned rule sets; LLMs never trade." | AT-14 | — |
| ARN-091 (05 l.125) | "No silent edits; changes via challengers or Owner force-apply (KB-050)." | gap | — |
| ARN-092 (05 l.126) | "Retire a version that is FAILED at one of the ARN-086 forward looks (same α spending), or is dominated." | gap | — |
| ARN-093 (05 l.127) | "**Kill switch** per family, checked at 20, 40, 60 … forward trades up to K = `killswitch_max_looks_per_year` (set each year from the measured trade rate); each of the 3 criteria uses α = 0.05 ÷ 3 spent as α/2^k across its looks (overall false-trigger rate ≤ 5% per year): forward per-trade expectancy vs backtest; forward win rate vs the backtest distribution; forward CIF below the backtest 90% lower bound once estimable. (No slippage trigger …)" | gap (no AT; M3 hand-over) | killswitch_looks every 20 forward trades (—; ch15 l.53); killswitch_max_looks_per_year (count, set yearly; ch15 l.54) |
| ARN-094 (05 l.128) | "\"Cost-infeasible at this seed\" label when the development-split **gross mean per-trade return at fixed notional** (before brokerage and slippage) < 2× the round-trip cost of a A$600 trade; it blocks PASSED-BACKTEST (VAL-110 iv-b)." | gap (no AT; M3 hand-over) | cost_feasibility_ratio 2 (—; ch15 l.74) |
| ARN-049 (05 l.81) | "Sleeve figures shown at 10× and at the reality-adjusted 5× … labelled \"hypothetical leverage\"; market-specific." | gap; milestone not assigned (§5 item 32) | reality_cap 5 ([V], —; ch15 l.37) |

### 2.11 Validation tests and quality gates (TST / VAL / AT)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| TST-109 (10 l.145) | "No-look-ahead test: perturb all data after date D; decisions for D and earlier MUST be unchanged." | AT-09 (M2); M4 decisions (A5, Decision Cards) must pass it [CHECK] | — |
| TST-110 (10 l.146) | "Coverage-matrix sync: every data family in DAT-150 appears in AGT-130's matrix or is marked \"stored, not used\"." | TST-110 | — |
| TST-111 (10 l.147) | "LLM bake-off per LLM-040…042 before role assignment and monthly." | gap for M4 roles R2/R4 [CHECK] | — |
| TST-114 (10 l.149) | "… one-off heavy work (history backfill into files, DAT-101 evaluation, AT-17 null runs) may run on Actions or in the build agent's own environment; tests that need recorded real-data fixtures run in the `ci-fixtures` environment (SEC-110) …" | AT-17 (null-run location) | — |
| TST-120 (10 l.155) | "CI MUST fail when **changed lines** have < 90% line coverage and < 80% branch coverage (`diff_coverage_min`, `diff_branch_min`)." | gate | diff_coverage_min 90% lines (80–100%, O; ch15 l.192); diff_branch_min 80% (70–100%, O; ch15 l.193) |
| TST-121 (10 l.156) | "Overall coverage floors (`coverage_overall_min` 80% lines; 90% on money maths, validation statistics, rule interpreter, auth/roles, Worker scheduling)…" | gate; AT-17 (DSR, PBO code) | coverage_overall_min 80% (70–95%, O; ch15 l.194) |
| TST-130 (10 l.165) | "Mutation testing on money maths and validation statistics: weekly mutation run; surviving-mutant score ≥ 80% (`mutation_score_min`); results summarised, not gating each PR." | weekly job | mutation_score_min 80% (60–95%, O; ch15 l.195) |
| TST-132 (10 l.167) | "… `ci_minutes_budget` raised to soft 1,000/month (public repo, standard runners are free — O-29); re-measured at M4." | M4 measurement | ci_minutes_budget soft 1,000/month (O; ch15 l.172) |
| TST-102 (10 l.138) | "A frozen dataset (≈ 20 codes × 3 years per market …) reproduces identical trades/NAV on every run and every platform." | AT-13 (M3); rolling replays (M4) [CHECK] | — |

### 2.12 Acceptance tests AT-14…AT-17 (verbatim, `14_system_acceptance.md` l.35–38)

| AT | Verbatim test (trimmed where marked) | Proves | Mapped rows |
|---|---|---|---|
| AT-14 (l.35) | Rules-only mode — "With every LLM disabled, a full night produces signals, orders, Decision Cards and review numbers" | AGT-001, LLM-002 | §2.1, §2.5, §2.6 |
| AT-15 (l.36) | Family rules — "For each family, a golden scenario triggers exactly the expected entry and exit; regime gates behave per §7.4" | §7.4, AGT-101 | §2.3, §2.5 |
| AT-16 (l.37) | Decision Cards — "100% of orders have a card with thesis-breakers and a percentile scenario table; no LLM-produced number on any card" | AGT-110, LLM-034 | §2.6 |
| AT-17 (l.38) | Replay engine (M4 engine checks) — "on synthetic data with a known injected edge the trade-level test detects it and on ≥ 2,000 null runs (random-signal nulls on real ASX data, reduced B) the rejection rates at 0.05 and 0.01 lie within 99% binomial acceptance bounds and the lower-tail p-values pass a uniformity check; the extrapolated size at α_i is reported (not a pass condition); windows with < 15 blocks return \"insufficient independent blocks\"; signal-ledger de-duplication, C2 exit mapping, CIFs (target/bust/stalled/timeout), effective N, ARN-081 circular block bootstrap with B = max(1,000, 20 ÷ smallest level tested) bootstrap replications, test-size check with random-signal nulls on real ASX data, one-open-row-per-code ledger rule, DSR, PBO (n/a below 5 variants), survivorship missing-share series, delisting sensitivity, minimum detectable effect, and a measured compute/minutes report within budget." Second paragraph, "**Evidence run (after the DAT-125 backfill):** every family gets a label (including \"insufficient evidence\" / NOT-DEMONSTRATED where applicable) with n and MDE — no particular label is required to pass" | ARN-071, ARN-080…087, ARN-100, DAT-125, DAT-131 | §2.7–2.10 |

AT-17 pass wording for the engine part is quoted in full because it is the M4 exit test. Its evidence part is not a pass condition (see §5 item 13).

Other 14-chapter items that name M4: §14.4 header (l.32) "Agents and strategies (M4)"; AT-10…AT-13 (l.27–30) are M3 and are consumed by M4 (AC 05 l.136–148).

### 2.13 Data inputs consumed by M4 (`06_data_layer.md`)

| ID (file l.N) | Text (trimmed) | M4 use | ch.15 keys |
|---|---|---|---|
| DAT-001 (06 l.9) | "Every market-data row carries `source`, `published_at` and `ingested_at`. A decision for session D uses only rows published before D's **fixed decision cut-off** (§5.1, AU 18:10 Melbourne)." | A2–A5 inputs; AT-09 | decision_cutoff 18:10 (—, O) |
| DAT-002 (06 l.10) | "Each day's bar is stored as **first-seen and immutable** …; a difference > 0.1% on any field flags the bar and every decision made on it … Prices are stored raw; adjustment factors are derived **only from recorded corporate actions** (DAT-220)." | indicator inputs (AGT-030) | refetch_diff_flag 0.1% (O; ch15 l.132) |
| DAT-004 (06 l.12) | "Missing/suspect inputs create a quality record and block affected decisions (DAT-210); never silently filled." | Decision Card quality flags | — |
| DAT-101 (06 l.46) | "…evaluated from the runtime that will actually fetch it in production …" | gap for M4 (data sources already M2) | — |
| DAT-122 (06 l.68) | "anything needing parsing (PDFs, large HTML) is fetched and parsed by a **signed Vercel route** …" | insider/flow PDFs → AGT-105 unknown state | ASX asx_poll_interval 4 min (O; ch15 l.136) |
| DAT-126 (06 l.73) | "Indicators use only adjustment factors with ex-date ≤ D; tier, tick, parcel and stop computations use raw prices" | AGT-030, AT-15 | — |
| DAT-127 (06 l.74) | Source-off modes: "*ASX off:* … F2/F3/F5/F6 make no new entries, F1/F4 continue with halt proxy" | AT-15 (entries under source-off) | source_off_mode (O; ch15 l.138) |
| DAT-130 (06 l.98) | "Backtests MUST use this history for dates after collection starts and carry the survivorship caveat (ARN-082) …" (universe snapshot) | F5 / U2 coverage | — |
| DAT-170 (06 l.125) | "A family skips a condition whose field is missing (logged \"data gap\"); results are sliced by data coverage. … Until own fundamentals snapshots satisfy ARN-082's coverage formula …, F2 replays run as a separately labelled variant \"F2-no-fundamentals\"" | F2 | — |
| DAT-160 (06 l.124) | "Calendars per market … refreshed yearly" | regime and replay calendars | — |
| DAT-150 (06 l.108) | Entities used by M4 include "signal, decision_card, trial_counter, calibration_report, bakeoff_result, llm_call, llm_cache" (from the full entity list) | storage | — |
| DAT-011 / §6.2 table (06 l.30–44) | Benchmark / regime index S&P/ASX 200; "Sleeve reality cap/label 5× (ASIC), ARN-049"; "C1 control S&P/ASX 200 ETF [VERIFY code]" | regime; ARN-049 | reality_cap 5 ([V]) |

### 2.14 LLM roles and budgets used by A2–A5 (`03_llm_and_token_policy.md`)

| ID (file l.N) | Text (trimmed) | M4 use | ch.15 keys |
|---|---|---|---|
| LLM-001 (03 l.6) | "Deterministic code MUST perform all calculations and rule-based decisions (indicators, screens, portfolio maths, simulations, backtests, candle patterns)." | A4, A5, replays | — |
| LLM-002 (03 l.7) | "The system MUST work in **rules-only mode** with no LLM available …" | AT-14 | — |
| LLM-003 (03 l.8) | "Strict $0 (PRD-007): only free tiers that need **no payment card**. The router MUST refuse any endpoint flagged paid." | all roles | — |
| LLM-010 (03 l.19) | "The **author and critic of a decision MUST come from different providers/model families** where possible." | M6 critic; M4 R2 authors | — |
| LLM-011 (03 l.20) | "Every role MUST have an ordered **fallback chain** of ≥ 2 providers plus rules-only." | R2/R4 | — |
| LLM-012 (03 l.21) | "Model IDs MUST come from configuration and provider discovery …" | R2/R4 | — |
| LLM-021 (03 l.32) | "A7 Critic wording calls are capped at 10 per night per market …; the rest are marked \"critic wording deferred\" …" | M6 | critic_llm_calls_per_night 10 (O; ch15 l.124) |
| LLM-030 (03 l.36) | "A single **LLM router** module MUST front every model call. …" | R2/R4 | — |
| LLM-031 (03 l.37) | "identical (role, prompt-hash) requests MUST be served from cache … TTL `llm_cache_ttl_hours` …" | R2 | llm_cache_ttl_hours 24 (1–168, O; ch15 l.169) |
| LLM-032 (03 l.38) | "**Escalation ladder:** rules → R1 triage → R2 analysis (only if rule materiality ≥ `r2_materiality_min` … or item touches a held/watched ticker) → R3 …" | R2 gating | r2_materiality_min 2 (O; ch15 l.118) |
| LLM-033 (03 l.39) | "every call MUST request a schema-constrained (JSON) answer; invalid output gets at most one repair retry, then falls back." | R2 | — |
| LLM-034 (03 l.40) | "any number, date or ticker in an LLM answer MUST be traceable to the provided context; … LLMs MUST NOT supply prices, returns or statistics from memory." | AT-16 | — |
| LLM-035 (03 l.41) | "**Prompt-injection defence:** all announcement/news text is **untrusted data** …" | A2 R2 input | llm_injection_phrases (O; ch15 l.182) |
| LLM-036 (03 l.42) | "… only public market information and abstract simulation data (mock portfolios) may be sent to third-party free LLMs." | A2 R2 input | trains_on_prompts (O; ch15 l.168) |
| LLM-037 (03 l.43) | "prompts MUST use compact, pre-summarised structured context packs …" | R2 | — |
| LLM-040 (03 l.46) | "Before assigning a model to a role, and again monthly and whenever a provider/model changes, the system … MUST run a **bake-off** on a stored **golden test set** (≥ 50 items) …" | R2/R4 role assignment [CHECK] | — |
| LLM-041 (03 l.47) | "Initial pass thresholds [PROPOSED]: JSON validity ≥ 98%; invented numbers = 0; injection resistance = 100% on the test set; triage agreement with reference ≥ 85%." | R2 | — |
| LLM-050 (03 l.59) | "When a role's daily budget is exhausted, the router MUST fall to the next provider, then to rules-only …" | A2/A3/A4/A5 | llm_budget_r2_daily 50,000 (25,000–75,000, O; ch15 l.184); llm_budget_r1_daily 60,000 (ch15 l.183); llm_budget_r3_daily 25,000 (ch15 l.185); llm_budget_r5_daily 10,000 (ch15 l.186); llm_daily_budget_total 150,000 (75,000–225,000, O; ch15 l.187) |
| ARN-068 (05 l.99) | "≤ 30,000 LLM tokens per night per market; **(s11)** this is the sum across roles R1–R5 for that market's nightly batch. Deterministic tables and summary always produced." | A5 budget conflict (§5 item 1) | nightly_tokens_per_market 30,000 (0–40,000, O; ch15 l.75) |
| LLM-060 (03 l.63) | "A vision model MUST NOT influence any score or trade unless it passes the Chapter 07 benchmark (AGT-033 …)" | A4 R4 | — |

### 2.15 Configuration keys referenced by M4 but not in §15.3–15.4

Listed for completeness. These are the M4 keys ch.15 does not yet define (see §5 items 2 and 22):

| Name in spec | Where used | Status |
|---|---|---|
| F2-no-fundamentals / F4-no-event-filter / F6-no-insider / F6-no-short-interest variant names | ARN-082 (l.116), AGT-105 (l.36), DAT-103 (l.48), DAT-170 (l.125) | no key; variant labels only |
| ATR(20), RSI(2), RSI(14) Wilder periods; SMA(200) and SMA(5) (F4 exit) | AGT-030 (l.42), F4 (l.55) | period values fixed in text, not keyed |
| 6-month return window 126 sessions; ADV window 20; volume ratio window 20 | AGT-030 (l.42) | fixed in text |
| Short-interest change window 10 sessions | F6 (l.57); DAT-103 | fixed in text; ch15 has `short_drop_pp` 2 but no window key |
| VAL-103 kill-switch lookback 60 sessions | VAL-103 (10 l.131) | no key |
| `untradeable_adv_pct` 0.5% (ARN-013); D-071 gives bounds 0.1–5 % | 05 l.43; decision log D-071 | M3 added; not in ch.15 (M3_design §6 #12) |
| `c1_etf_code` | D-076 | placeholder [VERIFY] |
| `zero_edge_seed` (PRD-020, not read here) | ch.15 l.181 | fixed, stored at build [CHECK] |

## 3. Values to remember (numbers with sources)

- **Decision cut-off** 18:10 Melbourne (ARN-020 `05` l.47; ch15 l.15; DAT-001 `06` l.9). **Batch 2** at 18:10, **batch 3** at 18:40, **19:10** LLM wording, **19:45** marker (`13` errata l.67–69; `06` §6.2 batch times).
- **Event day 0**: an announcement after the 18:10 cut-off on D has day 0 = D+1 (ARN-020 AC `05` l.144: "an announcement at 18:30 on D … its day 0 is D+1"). Backfilled announcements without a time use the session-level rule of DAT-001 (`06` l.9).
- **Regime**: SMA 200 sessions; 20-session realised vol percentile vs trailing **1,260** sessions; **SHOCK** = 5-session fall > 7 % or vol pct > 95; **RISK-OFF** = close < SMA200 and vol pct > 70; **RISK-ON** = close > SMA200 and vol pct < 50; hysteresis **3** sessions on exit (`07` l.39).
- **Indicators**: ATR(20); RSI(2), RSI(14) Wilder; 6-month return 126 sessions; 250-session high; volume ratio over previous 20 sessions; ADV over previous 20 sessions (`07` l.42).
- **Event polarity** threshold |AR| > 2 % (`07` l.35; ch15 l.117). **Returns** simple close-to-close (`07` l.35).
- **Insider/flow**: ±0.5 director on-market net; ±0.25 substantial holder; 30-session window; 2 pp short-interest drop over 10 sessions (`07` l.36, l.57; ch15 l.116).
- **Families** (ch15 §15.3, all B): F1 250/1.5/20 %/2×ATR/3×ATR/40 sessions & +5 %/120 max; F2 +3 %/5/2.5×ATR/60; F3 +4 %/2×/gap < 8 %/trail +10 %/2.5×ATR/20; F4 RSI(2) < 10, RSI(14) < 30, 2×ATR, 10 sessions; F5 3×/+3 %/0.75/2.5×ATR cap −20 %/3×ATR/30; F6 3 of 4 classes/insider ≥ +0.5/2 pp/2×ATR/20.
- **Decision Cards**: thesis-breakers 3–5; scenario = 10th/50th/90th; **n ≥ 30** shows scenarios (`07` l.66; ch15 l.123).
- **Replays**: start every **5** sessions (range 5–21); warm-up **1,260** sessions; capacity book ≤ 2 positions; unconstrained at **A$600** (`05` l.114; ch15 l.39).
- **Split windows**: holdout max(378, 15 × block); validation max(504, 15 × block) entry sessions; development must be ≥ **252** sessions or splits defer; F5 descriptive until ≈ **1,330** sessions (≈ 5.3 yr) (`05` l.116).
- **Purge** = max holding parameter upper bound + **20** sessions (e.g. F1 120 + 20 = 140; F2 90 + 20 = 110 per ch15 l.42).
- **Blocks**: block length = max(**5**, p75 realised holding); **≥ 15 blocks** per tested window (`05` l.115; ch15 l.58–60).
- **Bootstrap**: B = max(**1,000**, 20 ÷ level), ≈ **48,000** at α_i ÷ 6 (`05` l.115).
- **Multiple testing**: trial budget m = **20** per lineage (α_i = **0.0025**); L = max(**6**, active lineages), α_i ÷ L ≈ **0.00042** (`05` l.115, l.119).
- **Labels**: PASSED-BACKTEST one-sided α = 0.05 ÷ L; CONSISTENT-FORWARD ≥ **100** forward trades and ≥ **6** months, looks at 100/200/300 with (0.10 ÷ L)/2^k; **useful edge** +0.5 % net; UNVALIDATABLE below 90 % event coverage (`05` l.120).
- **VAL-110 thresholds**: PBO ≤ **0.2** (S = 10 blocks, ≥ 5 variants); DSR ≥ **0.95**; safety check blocks at effective N ≥ **8** and point estimate > **+5 pp** (`05` l.121; ch15 l.50, 55, 64–65).
- **L2 alpha-investing**: W₀ = **0.10**; α_j = W/(2+W); payout **0.05** (`05` l.94; ch15 l.49). Carried, not M4 (§6).
- **Kill switch**: looks every **20** trades; α = **0.05 ÷ 3** per criterion, spent as α/2^k (`05` l.127).
- **Cost feasibility**: gross mean per-trade return < **2×** round-trip cost of A$600 → "cost-infeasible" (`05` l.128).
- **Survivorship**: missing share > **5 %** → "survivorship-exposed" (`05` l.116; ch15 l.45).
- **Progress and ranking**: progress needs effective N ≥ **3**; ranking needs ≥ **5** effective cohorts and 3 effective in replay (`05` l.104, l.111; ch15 l.71, 73).
- **Timeline**: VAL-102 "≥ 100 forward trades and ≥ 5 effective cohorts" (`10` l.130); UX-017 same (`09` l.59).
- **Compute**: nightly ≤ **10** min per market; weekly light ≤ **30** min; monthly full ≤ **90** min (`05` l.131).
- **LLM budgets**: ARN-068 ≤ **30,000** tokens per night per market (`05` l.99); ch15 nightly 30,000; daily role budgets R1 **60,000**, R2 **50,000**, R3 **25,000**, R5 **10,000**; total **150,000** (`03` §3.6; ch15 l.183–187).
- **Vision gate**: ≥ **90 %** agreement on ≥ **200** labelled charts (`07` l.45; `03` l.63).
- **TA-Lib tolerance**: **1e-6** (`07` l.44).
- **Coverage/mutation**: diff coverage **90 %** lines / **80 %** branches; overall **80 %** (90 % on validation statistics); mutation **80 %** (`10` l.155–165; ch15 l.192–195).
- **Event backfill**: **≥ 6** years; event coverage **90 %** (`06` l.71; ch15 l.147–148).
- **Effort estimate**: M1–M8 ≈ **4–8** calendar weeks; DAT-125 backfill "several weeks" (`12` l.61).
- **Acceptance**: AT-14…AT-17; AT-17 null runs **≥ 2,000**; rejection bounds **99 %** binomial (`14` l.35–38).
- **Owner-only (O)** keys in M4: decision_cutoff; event/insider-related B keys as noted; regime thresholds (O, shared); families (B); rolling_start_step, c2_live_per_family, max_challengers, trial_budget_per_lineage, survivorship_flag_share, useful_edge_min, nightly_tokens_per_market, replay limits, killswitch_max_looks_per_year (set yearly, owner not named).

## 4. Carried over from M3

Each row is an item M3 explicitly left for M4 (`docs/M3_design.md` §1, §6; `docs/07_decision_log.md`), or a spec ID M3's own review found with no M3 acceptance (`docs/M3_requirements.md` §5 item 12, l.206).

| Carried item | Source | What M4 must do |
|---|---|---|
| **Batch 2b** — signals become orders at 18:10 | D-077 (`docs/07_decision_log.md` l.83): "Batches 2b/3 are M4." `docs/M3_design.md` §6 architect decision 1: "batch 2b at 18:10." | Create entry orders from A5 signals, sized by ARN-024a; re-gate at creation with `entriesAllowed()` (`docs/M3_design.md` l.128). Exits are never blocked. |
| **Batch 3** — attribution, comparisons, controls, lessons | D-077 says "Batches 2b/3 are M4" | **[CHECK]** Conflicts with the build plan: A6 (ARN-060…069, batch 3 at 18:40) is M6 (`12_build_plan.md` l.53). Decide whether batch 3 runs in M4 with A5 only (deterministic close, no lessons) or moves to M6. |
| **C2 random-entry selection** | M3_design §1 l.14 ("needs family entries, M4"); ARN-004 (`05` l.24–27); D-076 | Select C2 entries per family from the same dates as the family's signals; M3 already built the C2 exit mapping in ATR units (TST-101). |
| **`order_qty_stale`** | D-077 l.83: "an order sized before an ex-date that exceeds the re-based holding raises `order_qty_stale` (M4 2b must size in post-event terms)" | Size batch 2b orders in post-event terms, so the flag stops firing. |
| **ARN-093 kill-switch evaluation** | M3_design §1 l.13; `arena_control` l.88 ("evaluation is M4") | Evaluate per family at 20/40/60 forward trades with α = 0.05 ÷ 3; write `arena_control` state. |
| **ARN-094 cost-feasibility label** | M3_requirements §2.6 (l.89); M3_design §1 l.13 | Compute the development-split gross mean per trade vs 2× round-trip cost; label; block PASSED-BACKTEST (VAL-110 iv-b). |
| **ARN-049 5× reality display** | M3_design §1 l.13; §6 #19 (l.155, l.177: "display in M4/M6") | Show 10× and reality-adjusted 5× "hypothetical leverage" figures. **[CHECK]** milestone not set in `12_build_plan.md`. |
| **Effective-N reporting** | M3_design §1 l.11 ("effective-N *reporting*" is M4); D-076 ("computed from stored fields, no new columns") | Report effective N per ARN-053 on every cohort-level figure. |
| **Scorecards and CIFs ARN-070…078** | M3_design §1 l.11 ("Scorecards, CIFs and … labels, replays, validation (ARN-070..087, M4)") | §2.9 rows. |
| **Replay start** `rolling_start_step` | `docs/M3_design.md` §6 open decision 3 and architect decision 3: "M4 reads `rolling_start_step`" | Default 5 sessions; read the config key. |
| **ARN-083 cost robustness** | M3_requirements §2.3 (l.53): "validation gate, M4" | Gate under P3 + 50 % slippage (VAL-110 iv). |
| **Shadow sleeve display** (ARN-048) | M3_design §6 #19 | Shadow trades are logged in M3; any display is M4 or M6 [CHECK]. |
| **`untradeable_adv_pct`** | `docs/M3_design.md` §6 open decision 12 (architect decision 12): "add `untradeable_adv_pct` 0.5% to ch.15 (O)"; D-071: key bounds 0.1–5 % | Add to ch.15 as O with the 0.5 % default (decision still open). |
| **Verify approvals** | M3_design §6 #20: Owner must approve [VERIFY] items (A$500 parcel, P0–P5b, tick table, 9 % financing, C1 ETF code) before `full` mode | Agents and replays can run with `verified = 0` rows; VAL-110 (iv) results are labelled until approved [CHECK]. |
| **M3 gaps with no AT** | M3_requirements §5 item 12 (l.206): ARN-020a, ARN-027, ARN-033, ARN-034, ARN-035, ARN-046, ARN-048, ARN-049, ARN-050, ARN-054, ARN-093, ARN-094, TST-109 | ARN-033, ARN-093, ARN-094, ARN-049 and TST-109 are M4 items (§2.9–2.11). ARN-020a is M5. Others are M3 or unassigned. |

## 5. Gaps, contradictions and open questions (numbered)

1. **Token budget contradiction.** ARN-068 (`05` l.99): "≤ 30,000 LLM tokens per night per market … the sum across roles R1–R5." ch.15 `nightly_tokens_per_market` 30,000 (l.75) sits beside `llm_budget_r1_daily` 60,000 (l.183), `llm_budget_r2_daily` 50,000 (l.184), `llm_budget_r3_daily` 25,000 (l.185), `llm_budget_r5_daily` 10,000 (l.186) and `llm_daily_budget_total` 150,000 (l.187), and `03` §3.6 uses daily figures. R1 alone exceeds the nightly cap. Owner decision needed: daily or nightly, and per market or total.
2. **Variant keys missing from ch.15.** The variants F2-no-fundamentals, F4-no-event-filter, F6-no-insider and F6-no-short-interest (`05` l.116; `06` l.48, l.125) are not keys, and their class-count rules are not keyed either.
3. **Errata F-table is superseded but not marked.** `13_review_errata_and_addenda.md` l.87–92 gives different family rules. F6 in the errata uses "≥ 3 inputs … regime RISK-ON" (l.92); ch.07 §7.4 (l.57) uses four evidence classes. Ch.13 l.3 says the home chapter wins. Treat ch.07 as authoritative; confirm the errata is withdrawn.
4. **AGT-110 scenario labels.** The errata says "bear/base/bull" (`13` l.77); ch.07 (`07` l.66) says 10th/50th/90th. UXN-100 (`16` l.55) allows presentation labels "Downside/Typical/Upside". Use ch.07 with the UXN label as presentation only.
5. **AGT-101 inputs.** The errata (`13` l.75) adds a drawdown from the 52-week high and the RBA cash-rate direction as rule inputs. ch.07 (`07` l.39) uses only SMA200, vol percentile and the 5-session fall, and says the RBA direction is "information, not used in the rule." Ch.07 wins; confirm.
6. **Regime exit hysteresis wording.** "Hysteresis applies only when **leaving** a state (3 sessions)" (`07` l.39) does not say whether 3 means three consecutive sessions meeting the exit condition. **[CHECK]**.
7. **"Cost-infeasible" label vs UX label set.** ARN-094 (`05` l.128) requires the label "Cost-infeasible at this seed". UXN-060 (`16` l.37) says the validation label set is exactly ARN-086's and "no other label text MAY be invented." Decide whether ARN-094 is a validation label, a separate flag, or both.
8. **ARN-094 round-trip cost.** The spec does not say which cost profile or slippage defines the round-trip cost of a A$600 trade. **[CHECK]**.
9. **ARN-093 kill-switch statistics.** "Forward win rate vs the backtest distribution" and "forward CIF below the backtest 90% lower bound once estimable" name no test. The α spending (α/2^k over looks) differs from ARN-086's (0.10 ÷ L)/2^k with no reason given. `killswitch_max_looks_per_year` is "set each year from the measured trade rate" (`05` l.127; ch15 l.54) with no default and no named editor.
10. **60-session window.** VAL-103 (`10` l.131) uses "no kill-switch event … in the last 60 sessions." No key exists.
11. **One-open-row scope.** ARN-080 (`05` l.114) says one open row per (family, rule version, code). AT-17 (`14` l.38) says "one-open-row-per-code ledger rule." The narrower AT wording would merge rule versions. Implement ARN-080's scope; confirm.
12. **"Real ASX data" for null runs.** AT-17 needs "random-signal nulls on real ASX data" (`14` l.38). Staging never calls ASX (NFR-040; DAT-122; BLD-024), and TST-115 puts AT-17 on staging recorded data (`10` l.150). Which store holds the real-data slice for the nulls is not stated. **[CHECK]**.
13. **AT-17 pass vs evidence run.** The engine checks are the M4 exit (BLD-022, `12` l.61). The second paragraph of AT-17 is the evidence run after DAT-125. Decide whether M4 exits on the engine checks only and whether the evidence run carries as a later task.
14. **Bootstrap B level.** ARN-081 uses "20 ÷ level used"; AT-17 uses "20 ÷ smallest level tested" (`14` l.38). The two differ when a test uses a larger level. Confirm which applies to the size checks.
15. **Trial budget formula.** ARN-085 (`05` l.119): "new budget = 20 − (accesses already made × share of the new validation window that overlaps the old one), rounded up." Define "accesses" and "share" (fraction of entries, or of sessions). **[CHECK]**.
16. **Which α applies in VAL-110 (i).** ARN-087 (i) says "Bonferroni within the trial budget" (α_i = 0.0025 at m = 20), while ARN-081 and ARN-086 use α ÷ L. The spec does not say whether both apply together or one replaces the other. Also ARN-087 (ii) says "α_i ÷ L". **[CHECK]**.
17. **Block length circularity.** ARN-081 defines block length as the p75 realised holding period, and ARN-082 freezes it "measured once … before the default layout." A new lineage has no realised holdings before its first replay. Define the first measurement (e.g. the replay's own holding periods) and state that it is frozen. **[CHECK]**.
18. **Development split for early Decision Cards.** AGT-110 requires the scenario table on the development split (`07` l.66). ARN-082 defers splits when development is < 252 sessions (`05` l.116). Specify what a Decision Card shows before the first lineage split exists (suggested: "insufficient history").
19. **CIF and NAV interval methods.** ARN-053 mentions "exact / Aalen–Johansen" for cohort intervals (`05` l.87). ARN-071 requires 90 % intervals on CIFs and on E[NAV] − seed (`05` l.104), but no interval method is given for either. **[CHECK]**.
20. **Zero-edge benchmark.** ARN-071 (`05` l.104) recomputes the zero-drift benchmark per (family, rule version). ch.15 has `zero_edge_trials` 20,000 (l.180) and `zero_edge_seed` (l.181) under PRD-020, which this extract did not read. Confirm the method.
21. **Lineage definition.** "Lineage" is used throughout ARN-081…087 and ch.15 (`active_lineages_L`, l.41) but is not defined in ch.05. Ch.15 says active = "has a live or challenger version not retired." Confirm whether a lineage is a family, a family × variant, or a family × rule version chain.
22. **Keys for M4 parameters not in ch.15.** ATR(20), RSI periods, SMA(5)/SMA(200) for F4, the 126-session return window, the 20-session ADV and volume windows, the 10-session short-interest window, and the 1,260-session regime lookback are fixed in text (`07` l.39, l.42, l.57) and not keyed. Add them as B or — keys, or confirm they are fixed.
23. **Thesis-breaker catalogue.** AGT-110 requires 3–5 machine-checkable thesis-breakers per card (`07` l.66). The spec gives only the errata examples (`13` l.77: "guidance downgrade announcement", "close below announcement-day low", "short interest +2 pp in 10 sessions"). The keyword-based breakers (AGT-111 amber, `07` l.67) have no list. A per-family catalogue is needed for AT-16.
24. **Break-even move and cost estimate.** AGT-110 (`07` l.66) requires a "cost estimate and break-even move" with no formula. **[CHECK]**.
25. **Insider/flow data timing.** AGT-105 (`07` l.36) gives "unknown" until notice PDFs are fetched. The PDF queue sits behind the ASX priorities (DAT-122, `06` l.68), and parsing runs in a Vercel route. Confirm whether the PDF pipeline is an M2 or M4 deliverable. Also, DAT-125a says the ASIC archive depth is [VERIFY].
26. **Production agents off.** BLD-024 (`12` l.62) keeps A2–A8 disabled in production until the build passes. The spec does not say when A2–A5 switch on in production, or whether AT-14 (full night) runs only on staging.
27. **Batch 3 milestone.** See §4: D-077 says batch 3 is M4; `12_build_plan.md` l.53 puts A6 in M6. **[CHECK]**.
28. **Ledger record entity.** DAT-150 (`06` l.108) lists `signal`, `decision_card`, `trial_counter`, `calibration_report` and `bakeoff_result`, but no `signal_ledger` row, lineage record, split record, or statistics result. ARN-082 requires "a versioned record" for splits, and ARN-085 a trial ledger. Confirm the entities.
29. **Golden fixtures for AT-15.** AT-15 needs "a golden scenario" per family (`14` l.36). No fixture set is named. TST-102 defines one dataset (≈ 20 codes × 3 years) for the simulator (`10` l.138). Specify whether AT-15 uses it or a family-specific set in the private fixtures repo (SEC-110).
30. **Replay compute budget.** Rolling starts every 5 sessions over ~6 years, times 25 executions and the controls, have no measured estimate. ARN-100 (`05` l.131) gives budgets; AT-17 requires a measured report (`14` l.38). No target is set for the rolling-start engine itself. DAT-140 (`06` l.102) requires a local snapshot in the Actions job.
31. **LLM bake-off timing.** LLM-040 (`03` l.46) requires a bake-off before a model is assigned to any role, and TST-111 (`10` l.147) names "before role assignment." M4 assigns R2 summaries (A2) and optional R4 (A4). **[CHECK]** whether the bake-off gates M4 or M5.
32. **ARN-049 milestone.** The 5× reality display (`05` l.81) has no milestone in `12_build_plan.md`. DAT-011 (`06`) sets the AU cap at 5× (ASIC). ch.13 FIX-061 (`13` l.41) says the ASIC CFD order "runs to 23 May 2027" and must be re-verified. M3_design §6 #19 says "M4/M6." **[CHECK]**.
33. **Scorecard milestones.** ARN-073 (Sentinel scorecard) depends on A1 (M5). ARN-077 (email headline scorecard) depends on the email job (M5). ARN-075 (LLM-role scorecard) has one line and no definition (`05` l.108). Assign each explicitly.
34. **Decision Card UI.** AT-16 is an M4 test on stored cards. The Decision Card screen (UX-041, `09` l.75) and the scenario table disclosure (UXN-100, `16` l.55) are M7 (§12.3 row M7). The "Why?" panel (UXN-102, `16` l.63) needs LLM budgets (M4 or M7 [CHECK]).
35. **Insider score weight.** ch.13 (`13` l.76) says "weight 5%" for AGT-105. ch.07 (`07` l.36) gives a score in [−1, +1] with no portfolio weight. Confirm that the errata weight is withdrawn.
36. **Sector median for F2.** F2 requires "P/E below the median of its GICS sector (sector from the price-source profile …)" (`07` l.53). The price-source profile has no GICS field in the data layer (`06` §6.3). Confirm the sector source for AU or accept the F2-no-fundamentals path.
37. **Benchmark index and C1 code.** The benchmark is the S&P/ASX 200 (`06` §6.2). C1 is "S&P/ASX 200 ETF [VERIFY code]" (`06`). M3 stores `c1_etf_code` as a placeholder (D-076). Owner input is needed before C1 trades (M3, not M4).
38. **Order cancellation at fill.** F3's cancellation (`07` l.54: "order cancelled at fill if next open gaps ≥ +8%") and ARN-021 fill rules (`05` l.49) are in the M3 engine. Confirm that batch 2b creates the F3 order with the gap condition attached.
39. **Two-candidate sizing.** FAM-001 (`07` l.59) says "split deployable cash 50/50" for two legs. ARN-003 (`05` l.23) says the second position opens only if both legs can meet the parcel. The two rules agree but leave the 50/50 split unsized in the M3 engine. Confirm that M3 sizing (D-072) already does this.
40. **Half-size and parcel.** "Half size … applies only if the half still meets the parcel; otherwise no entry" (FAM-001 l.59). Confirm this is implemented in batch 2b.
41. **`reentry_block` vs stop exits.** FAM-002 (`07` l.60) blocks re-entry after a stop for 10 sessions. ARN-080 (`05` l.114) says the live rule applies. The F4 "CS" exit does not set a stop; confirm the block applies only to IS stops.
42. **Calibration report.** VAL-101 (`10` l.129) requires a stored calibration report for any probability. ch.07 has no probabilities. Confirm that no M4 number is a probability (AT-16 requires none).
43. **Sentinel materiality in F6.** The errata (`13` l.92) uses "Sentinel materiality ≥ 2 positive" as a class. ch.07 F6 (`07` l.57) does not. Covered by item 3.
44. **Survivorship share definition.** ARN-082 (`05` l.116) counts codes with ≥ 3 announcements in the previous 60 sessions. Confirm that "announcement" means the DAT-125 metadata list, which is backfilled from M2.

## 6. Out of scope for M4 (later milestones)

| Item | Milestone | Source |
|---|---|---|
| Sentinel A1, alert tiers, pre-open re-check (ARN-020a), thesis-breaker evaluation (AGT-111), alert email (AGT-115), ARN-073 Sentinel scorecard, AT-18…AT-21 | M5 | `12` l.52; `07` l.16, l.27–31, l.67–68 |
| Picks/factor back-end (AGT-112, AGT-113, ARN-095) | M5/M6 | `16` (ch.16 intro) |
| A6 Daily Review & Learning, ARN-060…069 (attribution, comparisons, lessons, Lane A/B, challengers, α-investing ARN-063 L2, batch 3 unless §4 says otherwise), AGT-040 | M6 | `12` l.53; `05` l.91–100 |
| A7 Critic and checks AGT-041…043 (including the six deterministic checks and force-apply) | M6 | `07` l.71–74 |
| KB rules, knowledge archive, lesson grades (L0–L3), challengers' lifecycle | M6 | `08` (not read); `12` l.53 |
| UI pages: Home, Picks, Market, Strategies, News, Reviews; UX-040/041 Decision Card screen; UX-017 evidence notice; UXN-100/102/120–122 explain panels; UXN-057/060 badges; UXN-052/053 leaderboard sparklines | M7 | `12` l.54; `09` l.59, l.74–75; `16` l.36–37, l.55, l.63, l.159–161 |
| Calibrated probabilities (VAL-101 for any "confidence %"), AT-27 check | M7 (UI) / later | `10` l.129; `14` (AT-27) |
| Owner-facing LLM Usage page (LLM-051) | M7 / M8 | `03` l.60 |
| Restore tests and staging E2E day (TST-106, TST-108), security tests (TST-107) | M1/M8 | `10` l.142–143 |
| Full release gate, go-live (AT-28…AT-31) | M8 | `12` l.55; `14` |
| IN and US markets (AT-M1…AT-M5; MKT-102; INR/USD cost profiles; ARN-049 SEBI rules) | M9, M10 | `12` l.56–57; `06` §6.2 |
| Evidence-run labels that depend on DAT-125 backfill completion (BLD-022) | After M4 engine checks | `12` l.61; `14` l.38 |
| Live paper trading start (BLD-030), after M8 | M8+ | `12` l.68 |

## 7. Coverage estimate

Spec lines read or cited in this extract: about 800 of the 2,736 spec lines in `spec/` (about 29 %). Fully read: `07_agents.md` (110), `03_llm_and_token_policy.md` (71), `15_configuration_reference.md` (220), `12_build_plan.md` (90). Partly read: `05_paper_trading_arena.md` (about 90 lines of §5.7–5.12 plus AC; ARN-000…054 and §5.1–5.6 are M2/M3 and were read only as needed for M3's hand-over), `10_nfr_testing.md` (about 50 lines, the VAL and TST rows), `14_system_acceptance.md` (about 20 lines, AT-10…AT-18 and §14.4), `13_review_errata_and_addenda.md` (about 35 lines, errata for the M4 IDs), `06_data_layer.md` (about 60 lines), `09_ui_ux.md` (about 15 lines), `16_ui_next_level.md` (about 20 lines, the M4-adjacent items only). Decision log D-069…D-077 and `docs/M3_design.md` §1 and §6 were read in full.

Not read: `00`, `01`, `02`, `04`, `08`, `11`, the rest of `09` and `16`, and `PRD-020` (for the zero-edge benchmark). Those are outside the M4 extract scope (§5 item 20 flags the PRD-020 dependency).

Requirement rows in §2: 126 ID-keyed rows (including the AT-14…AT-17 rows) and 6 family rows (F1–F6). Items flagged **[CHECK]**: 24 lines.

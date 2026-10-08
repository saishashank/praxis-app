# Chapter 07 — Agents, Signals, Strategy Families and the Coverage Matrix  (v2.0, session 10)

_v1.0 rewrote the imported draft; v1.1 applies the session-9 review fixes. Chapter-13 IDs AGT-101…120 and FAM-101/102 live here. Requirements only — no code. [PROPOSED] values are configuration with bounds (Ch. 15)._

## 7.0 Principles
- **AGT-001 Deterministic first.** Agents are deterministic programs; LLMs only in the Ch. 03 roles and never compute numbers, choose trades or change configuration (LLM-001, LLM-035, ARN-090).
- **AGT-011a (s9) No LLM path to trades.** Everything read by the Strategy Lab, the rule interpreter, filters (ARN-011) and thesis-breakers — materiality, event category, event polarity, F6 inputs — MUST be the **rule-derived** value. LLM-adjusted values are stored in separate fields and used only for alert routing and text.
- **AGT-002** Every output is a stored record with schema version, input references, agent version, market and timestamp. **(s13)** LLM-based outputs also store provider, model ID and fallback depth (0 = first choice; 'rules-only' when no model was used).
- **AGT-003** One implementation per agent, parameterised by market profile (DAT-010).
- **AGT-004** An agent failure never stops others; downstream steps run on the latest complete inputs and mark outputs `partial`.
- **AGT-120** "Data Layer" is a pipeline (Ch. 06), not an agent.

## 7.1 Agent roster and timing (AU times per PLT-073)
| # | Agent | When | Main outputs | LLM role |
|---|---|---|---|---|
| A1 | **Sentinel** | Worker cron every minute; ASX polled every 4 min in announcement hours per the slot schedule (DAT-122), other sources every minute; every 15–30 min outside hours (active markets only) | New items, rule materiality/polarity, alerts (AGT-115), thesis-breaker hits (AGT-111); invokes the 09:55 pre-open re-check route (ARN-020a) | R1 via Vercel route for items on held/watch-listed codes or rule materiality ≥ 2 (alert text only) |
| A2 | **Company & Sector Research** | Batch 2 (18:10) | Event records (§7.3.1), insider/flow scores (AGT-105) | R2 summaries (text only) |
| A3 | **Macro & Regime** | Batch 2 | Regime (AGT-101), macro calendar | R2 optional note |
| A4 | **Candle & Pattern** | Batch 2 | Indicators, validated patterns | R4 optional, gated (AGT-033) |
| A5 | **Strategy Lab** | Batch 2, after books close (ARN-060) | Signals, Decision Cards, next-open orders, controls | none |
| A6 | **Daily Review & Learning** | Batch 3 (18:40) deterministic; 19:10 wording | Attribution, comparisons, lessons, plan (ARN-060…069) | R3 wording |
| A7 | **Critic** | 19:10 | Deterministic checks + worded concerns (AGT-041) | R3 from a different provider/model (LLM-010) |
| A8 | **Scribe** | Assembles 19:10–19:45; the **email job** sends at 20:00 | Evening Review, dashboard summaries | R5 narrative |

## 7.2 Sentinel (A1)
- **AGT-010 (s9)** Polls only enabled sources (DAT-120); ASX requests follow the slot schedule and rate token of DAT-122; ≤ 40 new items processed per invocation, remainder carried to the next minute; one batched database write per invocation; per-minute state in the database (never Workers KV) (PLT-075).
- **AGT-011 (s9) Rule materiality** (0–3): 3 = price-sensitive announcement or trading halt/suspension/exchange query for a **held** code, or takeover/scheme for any tracked code; 2 = price-sensitive announcement for a watch-listed or candidate code, results, guidance change, capital raising, director on-market trade; 1 = other announcements for tracked codes, macro releases; 0 = otherwise. R1 may propose ±1 in the separate `materiality_llm` field (AGT-011a).
- **AGT-012** The Sentinel never places or changes orders except cancelling at the pre-open re-check (ARN-020a).
- **AGT-013** Scored per ARN-073.
- **AGT-015 (s9) Tracked codes** = all codes in U1–U3 of the latest universe snapshot plus any held code.
- **AGT-014 (s9) Held and watch-listed.** *Held* = open position of a live execution E01–E12 of an active market (controls and challengers never raise alerts). *Watch-list* = codes with a family signal (taken or not) in the last 20 sessions plus Owner-added codes (Owner only, with expiry ≤ 90 days).

## 7.3 Research, macro, patterns (A2–A4)
### 7.3.1 Event records (A2)
- **AGT-020 (s9)** Each announcement of a tracked code becomes an event record: code, published time, **day 0** (ARN-020), category by rules (results, guidance up, guidance down, contract/customer win, capital raising, director trade, substantial-holder change, takeover target, takeover bidder, halt/suspension, exchange query, dividend change, management change, other), price-sensitive flag, day-0 abnormal return (stock return − benchmark return on day 0), day-0 volume ratio, and **polarity** by rules: + for guidance up, contract win, takeover target; − for guidance down, capital raising, exchange query, halt; for results and others: sign of the day-0 abnormal return when |AR| > 2%, else 0. R2 may add a text summary; LLM categories/polarity are stored separately (AGT-011a). **(s13)** Returns are simple close-to-close returns; benchmark = the market profile's regime index (DAT-010).
- **AGT-105 (s9) Insider & flow score** in [−1, +1] = sum, clipped: +0.5 net director on-market buying in the last 30 sessions / −0.5 net selling; +0.25 new substantial holder or increase / −0.25 decrease. (Short interest is **not** in this score; it is F6 class (d) and a Decision Card line, so it is never counted twice.) Uses notice **publication** times (DAT-001). Where notice PDFs are not yet fetched (DAT-122), the score is `unknown` (not 0); replays without insider history run F6 as the labelled variant "F6-no-insider" (ARN-082). Used by F6 and Decision Cards only.

### 7.3.2 Regime (A3)
- **AGT-101 (s9)** Daily per market, from the benchmark: close vs its 200-session SMA; 20-session realised volatility (st. dev. of daily log returns) percentile vs the trailing 1,260 sessions. States: **SHOCK** if the 5-session benchmark fall > 7% or vol percentile > 95 — entered **immediately**; **RISK-OFF** if close < SMA200 and vol percentile > 70; **RISK-ON** if close > SMA200 and vol percentile < 50; otherwise **NEUTRAL**. Hysteresis applies only when **leaving** a state (3 sessions). The central-bank rate direction is shown as information, not used in the rule. The regime tags every signal/trade and gates entries per §7.4; a cohort's regime is the state on its start date, used for cohort-level reporting only; Critic check AGT-041 (2) uses each row's entry-date tag **(s11)**.

### 7.3.3 Indicators and patterns (A4)
- **AGT-030 (s9) Definitions** (on adjusted closes/highs/lows derived per DAT-002): SMA(n) simple mean of the last n closes including today; ATR(20) and RSI(2), RSI(14) with **Wilder** smoothing; 6-month return = close / close 126 sessions ago − 1, percentile within tier; **250-session high** = today's close ≥ max(close of the previous 249 sessions); volume ratio = today's volume ÷ mean volume of the **previous** 20 sessions; ADV = mean traded value (close × volume) of the previous 20 sessions; day-range position = (close − low) ÷ (high − low) (0.5 if high = low).
- **AGT-031 (s9)** Candlestick patterns (v1 candidates: bullish engulfing, hammer, morning star, piercing line — standard TA-Lib definitions) are detected deterministically. A pattern that has PASSED (ARN-074) may replace the RSI condition in F4's entry ("close > SMA200 and a PASSED bullish pattern at the close"); until then patterns are informational only.
- **AGT-032 (s9)** Indicator values match the reference implementation **TA-Lib** (Wilder variants) on the golden dataset to 1e-6 (TST-101).
- **AGT-033 (s9)** The optional R4 vision reader may influence nothing unless its pattern labels agree with A4 on ≥ 90% of ≥ 200 labelled charts (LLM-060); until then output is "illustrative" text.

## 7.4 Strategy families v1 (all [PROPOSED], grade L0, label UNVALIDATED)
_Common: signals after the close for next-open fills (ARN-020/021); exits are tagged `intraday_stop` (IS) or `close_signal` (CS) (ARN-021); stops are recomputed at each close and active from the next session; sizing per FAM-001; ARN-094 cost-feasibility labelling applies._

| Family | Universe | Entry (all must hold) | Exits (first to trigger) | Regime gate | Rank score |
|---|---|---|---|---|---|
| **F1 Trend / breakout** | U1 (+U2 opt-in) | 250-session high; volume ratio ≥ 1.5; 6-month return in top 20% of tier; tier ADV filter | IS: initial stop entry − 2×ATR; IS: trailing stop 3×ATR below highest close since entry; CS: 40 sessions held and return < +5%; CS: **hard maximum hold** 120 sessions | No entries in RISK-OFF/SHOCK | 6-month return percentile |
| **F2 Quality-value with catalyst** | U1–U2 | Fundamentals where available and point-in-time (DAT-170): positive trailing earnings, P/E below the median of its GICS sector (sector from the price-source profile; median over U1 codes with data), net debt/EBITDA < 2; **and** a + polarity results/guidance-up event with day-0 AR ≥ +3% in the last 5 sessions | IS: entry − 2.5×ATR; CS: − polarity guidance event, or close below event-day low; CS: 60 sessions | No entries in SHOCK | Event AR |
| **F3 Event drift** | U1–U2 | + polarity price-sensitive event (results, contract, guidance up, takeover target) with day-0 AR ≥ +4% and day-0 volume ratio ≥ 2; order cancelled at fill if next open gaps ≥ +8% above day-0 close | IS: event-day low; IS: trail 2.5×ATR after +10%; CS: 20 sessions | No entries in SHOCK | AR × volume ratio |
| **F4 Mean reversion / validated patterns** | U1 | Close > SMA200 and (RSI(2) < 10 or RSI(14) < 30); no − polarity event in the last 3 sessions; patterns only if PASSED | CS: close > SMA5; CS: 10 sessions; IS: entry − 2×ATR | All; half size in SHOCK (subject to parcel, ARN-024) | Lowest RSI(2) |
| **F5 Small/mid-cap discovery** | U2–U3 (ARN-011 mandatory) | Volume ratio ≥ 3 **with** a + polarity price-sensitive event on day 0; day-0 AR ≥ +3% and close > prior close; day-range position ≥ 0.75; tier ADV/price minimums | IS: entry − 2.5×ATR, capped at −20%; IS: trail 3×ATR; CS: volume ratio < 0.5 for 3 sessions; CS: − polarity event; CS: 30 sessions | No entries in RISK-OFF/SHOCK | Volume ratio |
| **F6 Multi-agent consensus** | U1–U2 | Agreement of ≥ 3 of 4 **evidence classes** on the same code, at least one being (a) or (b): (a) technical signal F1 or F4; (b) event signal F2, F3 or F5 (one event counts once); (c) insider/flow score ≥ +0.5 (known, not `unknown`); (d) short interest fell ≥ 2 pp over 10 sessions | IS: entry − 2×ATR; CS: 20 sessions; plus the earliest exit of any contributing family (a)/(b) | No entries in RISK-OFF/SHOCK | Number of classes, then insider/flow score |

- **FAM-001 (s9) Sizing.** Deployable cash per ARN-024a. One candidate: buy the largest whole number of shares within deployable cash and the participation cap, if the value ≥ the marketable parcel (ARN-024). Several candidates: take the top-ranked; open a second only if both legs can each be ≥ the parcel after costs (then split deployable cash 50/50); ties break by higher ADV. "Half size" (F4 in SHOCK) applies only if the half still meets the parcel; otherwise no entry.
- **FAM-002** A code exited by a stop cannot be re-entered by the same execution for 10 sessions.
- **FAM-003** 2×/−50% are execution NAV thresholds (ARN-051/052), never position exits.
- **FAM-101** Ideas that don't fit a family (dividend/ex-date capture, sector rotation on rate expectations, growth + analyst upgrade) are Lane-B hypotheses.
- **FAM-102** Rules needing data unobtainable at $0 are `BLOCKED-DATA` and skipped, never approximated by an LLM.

## 7.5 Decision Cards, thesis-breakers and alerts
- **AGT-110 (s9) Decision Card.** Every signal that becomes an order has a card: market, code, family/execution, rule version, regime, rules fired with values, rank score, evidence with sources (events with polarity, insider/flow score or `unknown`, data-quality and first-seen flags), thesis-breakers (3–5 machine-checkable conditions), exit plan with IS/CS tags, cost estimate and break-even move, and a **scenario table = 10th/50th/90th percentiles of this family's rule version's net trade outcomes on development-split replay** (ARN-071) (conditional on the signal, including stops, time exits and costs), with n shown; if n < 30 it shows "insufficient history". No probabilities, no LLM numbers. Every scenario table includes a standing footnote with the development-split n and the as-of roll date **(s11)**. Signals not taken also get cards (for attribution). **(s13)** Data-quality flags are exactly: first-seen, assumed-time, quality-suspect, survivorship-exposed, stale-data.
- **AGT-111 (s9)** Thesis-breakers are evaluated nightly and at the pre-open re-check. Status is reported as: **green** = no thesis-breaker triggered; **amber** = at least one thesis-breaker's monitored value is within 20% of its trigger threshold, or a keyword-based thesis-breaker is awaiting confirmation **(s11)**; **red** = at least one thesis-breaker triggered. A red (triggered) thesis-breaker **cancels pending buys** and raises an alert; for held positions the exit is created by the next nightly cycle and filled at the following open (ARN-020a); a nightly hit fills at the next open (CS) **(s11)**.
- **AGT-115 (s9) Alert tiers** (held per AGT-014): P0 = held position with weight ≥ 10% of its execution's NAV and rule materiality 3, or a halt/suspension of a held code; P1 = held below that weight with materiality ≥ 2, or watch-list item with materiality 3; P2 = everything else. P0 emails go to the Owner only, use **template text only** (no LLM wording; LLM text stays in-app), the **first P0 is sent immediately** and only follow-ups within 5 minutes are batched; capped per EML-020. P1/P2 in-app and digest.

## 7.6 Learning, critique and reporting (A6–A8)
- **AGT-040** A6 implements ARN-060…069.
- **AGT-041 (s9) Critic checks.** For every lesson ≥ L1 and every challenger, A7 runs six checks **(s11)**: (1) sample size (n and effective N meet ARN-063/ARN-082 minimums); (2) regime dependence — on the same rows and the same (already counted) access as VAL-110 (i) for challengers, and on development rows only for lessons, the per-trade excess is computed separately for each regime (using each row's entry-date regime tag per ARN-061 **(s11)**, not the cohort's start-date regime) with ≥ 30 rows; the check **fails** if the point estimate is negative in at least half of those regimes, otherwise the by-regime table is shown; (3) stress costs (VAL-110 (iv) for challengers; for lessons the same absolute-expectancy check on the development split); (4) data issues (quality flags, first-seen differences, survivorship coverage, TST-109 audit for the inputs); (5) luck (VAL-110 (i) for challengers; for lessons the ARN-063 L2 test on the later development third — lessons never touch validation/holdout); (6) parameter bounds — the promotion is rejected if any parameter falls outside its lower/upper bounds defined in Ch. 15 **(s11)**. **Checks 1–6 are deterministic**; the LLM only words concerns and alternative explanations.
- **AGT-042 (s9)** A failed deterministic check blocks Lane-A application of that lesson and Lane-B promotion of that challenger. The Owner may instead **force-apply** the change (KB-050, audit-logged): this is not a promotion — the rule version's label resets to UNVALIDATED and it is shown as "forced by Owner". LLM-worded concerns never block; they are shown to the Owner.
- **AGT-043** A8 writes the review from stored data only (EML-014).

## 7.7 Coverage matrix
| Data / signal family | Source | Produced by | Consumed by | Families |
|---|---|---|---|---|
| EOD prices, ADV, volume ratio | DAT-103 | pipeline, A4 | A5, A6 | all |
| Universe and tiers | DAT-020 | pipeline | A5, A1 | all |
| Corporate actions, dividends | DAT-220 | pipeline | simulator, A4 | all (NAV) |
| Indicators | prices | A4 | A5 | F1, F4, F5, F6 |
| Validated candle patterns | prices | A4 | A5 | F4 |
| Events (category, polarity, AR) | announcements + prices | A2 | A5, A1 | F2, F3, F5, F6 |
| Halts, suspensions, queries | announcements | A1, A2 | order re-check, filters, alerts | all |
| Capital raisings, placements | announcements | A2 | ARN-011 | F5 filter, all |
| Director trades, substantial holders | announcement PDFs | A2 | AGT-105 | F6, cards |
| Short interest | ASIC | pipeline, A2 | AGT-105, F6 (d) | F6, cards |
| Fundamentals (PIT) | DAT-170 | pipeline | A5 | F2 |
| Regime | benchmark | A3 | A5, A6 | gates; AGT-041 (2) |
| Macro calendar, FX | RBA/ABS | A3 | A8 | — |
| Headline sentiment (LLM) | news | A2 | text only | none (stored, not used in rules) |
| Controls C1–C3 | prices | A5 | A6 | — |
- **AGT-130** Every entity in DAT-150 carrying market information appears here or is listed as "stored, not used"; kept in sync (TST-110).

## 7.8 Orchestration
- **AGT-050** Steps follow PLT-073 with its deadlines; each step checks its predecessor's completion marker and otherwise runs on the latest complete inputs, marking outputs `partial`.
- **AGT-051** AU orders are final before the 19:45 marker; IN/US orders are created after their own closes and reported in the next 20:00 review.

## Acceptance criteria — Chapter 07
- **Given** all LLMs are off, **then** signals, orders, cards and review numbers are produced (AGT-001).
- **Given** R1 raises an item's materiality from 1 to 2, **then** no F6 vote, filter or thesis-breaker changes (AGT-011a).
- **Given** an F3 candidate whose next open is ≥ 8% above the day-0 close, **then** the order is cancelled at fill (§7.4).
- **Given** an execution with A$600 and two F1 candidates, **then** only the top-ranked is bought (FAM-001).
- **Given** a −25% gap day closing near its high with 3× volume, **then** F5 does not enter (AR and close > prior close fail).
- **Given** a held code is halted, **then** a P0 alert fires and no fill occurs while halted.
- **Given** a challenger failing deterministic check 5, **then** it is not promoted; an Owner force-apply is possible and resets the label to UNVALIDATED (AGT-042, KB-050).
- **Given** a SHOCK trigger day, **then** the regime is SHOCK that day (no hysteresis on entry).
- **Given** indicator outputs on the golden dataset, **then** they match TA-Lib to 1e-6 (AGT-032).
- **Given** a family with n = 12 replay trades, **then** its cards show "insufficient history" instead of scenarios (AGT-110).

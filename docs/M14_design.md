# M14 design — Returns and validation (V2)

_Opus (architect), 2026-10-30. Replaces the earlier draft, which was written without reading the code. Inputs: `docs/M14_requirements.md`; V2 ch. 10 §10.V2.2–§10.V2.6, ch. 12 (BLD-045/046), ch. 14 (AT-43…AT-46), ch. 15 V2 keys, Owner decisions O-43…O-50, O-53, O-69, O-73; v1 ch. 05/07/08 where V2 is silent. Code read on `build` at c2f0f46 (M8.1 done). Decisions are numbered D-213…D-252 (§4); they are recorded, not asked, and go into the single V2 PR description._

## 1. Scope

**In M14.** Everything in §10.V2.2–§10.V2.6 that is not already shipped:
- Returns: FAM-004 stop-distance cap, FAM-005 cost gate, FAM-006 second-position limits, FAM-007 ex-date stop, ARN-106 exit ablation, ARN-107 one-tick slip, ARN-108 parameter neighbourhood, ARN-109 settlement for statistics. Also the small items in the same section: FAM-008 (already v1 behaviour, test only), FAM-009 (`abstain_shock` label) and the F5 universe change (O-49). See D-213.
- Validation: VAL-112…116, KB-081 pre-registered challengers, the O-46 variant cap, and the O-45 amendment (sleeve tests not charged).
- Data: DAT-232…237.
- Events: AGT-135…138.
- LLM: LLM-071…075.

**Already done in M8.1 (reuse, do not redo).** DAT-231 vendor actions (`src/lib/data/vendorActions/`, migration 0015, `vendor_action`); GL-02 `known_at` (0016); GL-05 `first_ingested_at` (0017); GL-03 `resizeEntryAtFill` in `src/lib/arena/sizing.ts`; GL-10 total-return benchmark in `src/lib/picks/benchmark.ts` (this is DAT-235, so DAT-235 needs only a check that every comparison uses it, §2.4); LLM-070 roster in `src/lib/llm/roster.ts`.

**Out of M14.** CTX-* (M15; the CTX-022a matched-setup form of the cost gate needs the Cortex, so M14 builds the family-median form, D-214); M15 sample-size numbers (VAL-113 says M15 publishes them); LLM-076 local classifier (optional, D-252); Committee, steelman and evidence packs (M11/M12) — M14 builds only the router mechanisms they will use; M16/M17; India/USA.

**Hard rules.** All M14 trading and learning code is deterministic: no clock, no `Math.random`, every PRNG is `deriveRngSeed(master, scope)`, every iteration sorted. Live (batch 2b/3) and replay call the same pure functions (AGT-003). No LLM output is read by trading or learning code (the AT-32 property M11 will test). No new account, key, paid service or npm dependency. One migration, 0018, additive and nullable only.

**Goldens that legitimately change (D-249).** Each re-pin lands in the commit that causes it, with the D-number in the message.

| Golden | File | Why it changes |
|---|---|---|
| AT-12 golden digest | `tests/arena/replay.test.ts` `GOLDEN_DIGEST` | The 3-year world has a dividend at session 120; FAM-007 changes an IS stop fill on an ex-date if one is near the level. Re-pin only if it moves. |
| Replay runner and stats digests | `tests/replay/runner.test.ts`, `tests/replay/replayStats.test.ts`, `tests/coverage/replayStatistics.test.ts` | FAM-004 blocks wide-stop candidates; F5 drops U3; ARN-109 switches replay cohort statistics to conservative settlement; DAT-232 corrects event volume ratios; AGT-138 reclassifies "guidance maintained" titles; DAT-237 removes duplicate events. |
| Cohort parity | `tests/replay/cohortParity.test.ts` | Must stay green (live = replay); its expected rows change for the same reasons. |
| Family worlds (AT-15) | `tests/agents/acceptanceM4.test.ts`, `tests/agents/families/*` | Only if a world's stop distance is over 12% or its F5 code is U3. |
| L2 alpha tables | `tests/learning/*alpha*` | VAL-116 replaces the halving rule. |
| LLM mock fixtures | `tests/fixtures/llm/recorded/**` | LLM-073 datamarking changes every prompt that carries untrusted text, so prompt hashes change. |

AT-32 (V2, M11) is not built yet; M14 must not add any read of LLM tables from trading or learning code. AT-42 (M8.1) must stay green.

## 2. Design per requirement

Names below are real files on `build`. "New" marks a file to add. Keys are in §2.7.

### 2.1 Returns: sizing, costs and exits

**Where entries are chosen today.** Live: `entriesFor` in `src/lib/agents/batch2b.ts` (ranked → re-entry block → quality gate → `legFor` → `planLegs`). Replay: `entriesFor` inside `replayCohorts` in `src/lib/replay/cohortReplay.ts` (same steps, in memory). Both use `rankedCandidates`, `planLegs`, `sizingEnvFor` from `src/lib/agents/candidates.ts`. Signals come from `runFamilies` (`src/lib/agents/families/index.ts`), shared by batch 2b, the signal ledger (`src/lib/replay/ledger.ts`) and the cohort replay. Card reason words are checked by a regex in `src/lib/agents/cards.ts` (line 60).

**FAM-004 stop-distance cap (D-216).**
- New `src/lib/agents/families/stopCap.ts`: `stopDistance(c: Candidate, refPriceMicro)` = (ref − `initialStop(c.stopSpec, ref)`) / ref, exact Rational, using `initialStop` from `families/exits.ts`; ref = the D close on the fill basis (same price `sizingEnvFor` uses).
- `families/index.ts`: after all families including F6 are evaluated, any candidate whose distance is above `max_stop_distance_pct` moves to `blocked` with reason `skipped_stop_distance`. This beats F5's own `f5_stop_cap_pct` (20%). Because it is inside `runFamilies`, the signal ledger, the cohorts and the live night all see the same result, and the card is written with the reason.
- Bump `FAMILY_AGENT_VERSION` to `families-2` (`families/constants.ts`). Rule versions (F1.v1…) do not change: the cap is an execution-wide entry rule, not a parameter of a lineage.
- Tests: distance exactly 12% passes; 12.0001% blocks; F5 with a 20% cap and 15% distance blocks; F6 checked on its own stop.

**FAM-005 cost gate (D-214, D-215).**
- New `src/lib/agents/costGate.ts`:
  - `costGateTable(rows)`: from closed signal-ledger rows of the development split, the median gross return per (family, rule version, variant). Gross is the existing `ledger_row.gross_num/gross_den` (before brokerage and slippage, `economicsOf` in `src/lib/replay/returns.ts`), so costs are not counted twice. Fewer than 30 rows (`cost_gate_min_rows`) gives "unmeasured".
  - `roundTripCost(profile, advMicro)`: 2 × brokerage of the execution's cost profile at the fixed notional A$600 (`feeFor`, `src/lib/arena/costs.ts`) + 2 × `bucketBpsFor(adv)` (`src/lib/arena/slippage.ts`). At P5 this gives 1.67% fees and 1.87–4.07% with slippage, as the spec's reference figures.
  - `passesCostGate(median, cost, k)`: median ≥ k × cost, exact.
  - `loadCostGateTable(db, market)`: live loader. It reads the same rows as `loadScenarioInput` in `cards.ts` (the AGT-110 scenario table) plus the gross columns.
- Applied in `src/lib/agents/entryGates.ts` (new, below) for E executions only. Not applied to the signal ledger (it is the evidence the medians come from) and not to C2/C3 controls (they copy the taken entries). Skip reason `skipped_cost_gate`; unmeasured passes with card flag `cost_gate_unmeasured`.
- Replay: `CohortReplayOptions.costGate?: CostGateTable`. The runner builds it from its own ledger and the lineage's `dev_end_d` (WP3). Without a table every signal is "unmeasured", so the cohort-parity golden nights (no split) stay as they are.
- Test (spec example): gross 3%, bucket cost 2%, k = 2 → skipped.

**FAM-006 second-position limits (D-217, D-218).**
- In `entryGates.ts`: the "first" position is any open position of the execution plus the first leg taken the same night. A second candidate passes only if its industry differs from the first's and the Pearson correlation of 60 daily simple returns of adjusted closes (`CodeFacts.closesAdj`, on D's basis) is ≤ `second_position_max_corr`. If it fails, it gets `second_position` and the next-ranked candidate is tried. `planLegs` keeps its FAM-001 rule (both legs must fit, else the top one alone).
- Industry: new optional `CodeFacts.industry` (WP0 adds the field). WP6 fills it from `instrument_class` (manual CSV, finer classes) when present, else `instrument.industry` (the ASX file's GICS industry group). No free, licence-clean GICS sub-industry source exists (§6), so the industry group is the proxy. Null or the placeholder values ("Class Pend", "Not Applic") count as unknown, and then only the correlation test applies (flag `industry_unknown`). Too little history for a correlation means only the industry test applies (flag `corr_unknown`).
- Not applied to controls (they skip when the code is held, as today).

**One entry pipeline for live and replay.** `entryGates.ts` exports `selectEntries(ranked, ctx)`. It is pure and returns the ordered eligible legs plus a reason per skipped candidate. It applies, in order: cost gate → second-position → FAM-009. `batch2b.ts` and `cohortReplay.ts` call it between the quality gate / re-entry steps and `planLegs`. New reason words go into the `cards.ts` regex (WP0): `skipped_stop_distance`, `skipped_cost_gate`, `second_position`, `abstain_shock`.

**FAM-008 (D-220).** Already true: an entry order lives for one open (filled, cancelled or expired) and is never resubmitted. M14 adds an AT-43 assertion only.

**FAM-009 (D-220).** In `selectEntries`: a half-size candidate (F4 in SHOCK, `Candidate.halfSize`) when deployable cash < 2 × the marketable parcel (`MIN_MARKETABLE_PARCEL_MICRO`) gets `abstain_shock` instead of today's `rejected:parcel`. The outcome is unchanged (no entry); only the label differs.

**F5 universe (O-49, D-221).** `evaluateF5` in `families/rules.ts` uses `f5_default_universe` (default U2; today it is U2+U3). A U3 run is emitted only when `FamilyOptions.f5StressU3` is set (replay only), as variant `F5-U3-stress`. It is descriptive, never traded, never validated.

**FAM-007 ex-date stop (D-219).**
- `fillIntradayStop` (`src/lib/arena/fills.ts`) gets an option `exDividendMicro`. On the ex-date session the trigger tests use open + dividend and low + dividend against the level. A gap fill stays at open − slippage. A level fill is at (level − dividend) − slippage − 1 tick, floored as in D-184. There is no permanent re-base; from the next session the raw level applies.
- New `src/lib/arena/exDividend.ts`: `exDividendOn(actions, code, d, cutoffOfPrevSession)`. It sums the confirmed `cash_dividend`/`special_dividend` corporate actions with ex-date d and `known_at` (GL-02) no later than the cut-off of d − 1. It uses the same records that credit the dividend (`corpActions.ts`). There is no `vendor_action` fallback: the replay snapshot has no vendor table, so a fallback would break replay = live.
- Call sites: `closeBooks.ts` (lines ~687, ~723), `replay/returns.ts` (~319, ~429, ~442), `picks/track.ts` (~195) belong to WP2; `cohortReplay.ts` (~871, ~969, ~1216) belongs to WP1. The sleeve (`sleeve.ts`) is unchanged.
- CS close-level rules (`close_below_level`) are close signals, not stops, and are unchanged.

**ARN-106 exit ablation (D-222).**
- New `src/lib/replay/exitAblation.ts`: `timeStopOnly(plan: ExitPlan)` keeps only the family's unconditional time exit (CS `time_stop` with `minReturn === null`: F1 `max_hold`, F2–F6 `time_stop`). It drops initial stops, trails and other CS rules.
- `replay/ledger.ts`: new `LedgerOptions.exitTransform`, applied to each candidate's plan before `walkPosition`. The second pass reuses the first pass's family outputs through the existing `familyOutput` hook, so `runFamilies` is not run twice.
- Computed in a new weekly learning stage `robustness` (new `src/lib/learning/robustnessStage.ts`) on the development split of each lineage. Output: `replay_stat` metric `exit_ablation` (n, mean and median net, hit rate, mean sessions held, for both rule and comparator).
- Trailing-stop variants: in `challengerGenerator.ts`, a winner whose changed key is a trail key (`f1_trail_atr`, `f3_trail_atr`, `f3_trail_after_pct`, `f5_trail_atr`) is dropped when its development mean net is not above the comparator's. The next candidate is tried. Nothing is charged for a dropped candidate (a development replay is not a trial).

**ARN-107 one-tick slip (D-223).** New `src/lib/replay/sensitivity.ts`: `oneTickAdverse(rows)` re-prices each closed row with one more adverse tick per side (`tickFor`, `src/lib/money/tick.ts`), recomputes brokerage with `feeFor`, and keeps the exits (they depend on prices, not on fills). It is descriptive: `replay_stat` metric `slip_one_tick` beside the ARN-083 stress figure. Same stage.

**ARN-108 parameter neighbourhood (D-224).** The `robustness` stage evaluates `candidateSteps(family, incumbent, [])` (the generator's existing ±1 grid step, 10% of the range) for each lineage's incumbent every week, and for each challenger once when it enters `replay`. Each neighbour reports n, mean net, its one-sided 90% lower bound under P5 (the ARN-081 bootstrap with the lineage's frozen block) and the absolute-gate result. A version is labelled "fragile" when it passes the absolute gate and at least one neighbour fails it. Output: `replay_stat` metric `stability`. The development view used by the generator (`weeklyStages.ts` `DevelopmentView.evaluate`) gains `meanNet` and `netLower90`; both share one memo.

**ARN-109 settlement for statistics (D-225).** `runner.ts` passes `cohortParams: () => ({ settlementMode: settlement_stats_mode })` (default `conservative`) to `replayCohorts`. In `full`/`evidence` mode it runs a second cohort pass with the other mode and writes the same statistics under scope suffix `:matched` (sensitivity). Live books stay `matched` (ARN-025 default); nightly live-cohort figures in batch 3 carry the label "live books, matched settlement".

### 2.2 Validation and learning loop

**VAL-112 error budget (D-226, D-227, D-228).**
- New `src/lib/stats/errorBudget.ts`: `validationLevelFor({ mode, w0, priorTests, legacy })`.
  - `alpha_spending` (default): Foster–Stine as in `src/lib/learning/alphaInvesting.ts`, but with payout 0, so it is pure spending. W₀ = `val_fwer_per_lineage`. After k tests W_k = W₀ / 2^k and α_k = W_k / (2 + W_k), so Σα ≤ W₀ and the family-wise error per lineage is ≤ 0.05.
  - `fixed`: today's `validationLevel(alpha, m, L)` from `stats/gates.ts`.
- k = the validation tests already on this lineage's split version: `validation_access` + `pattern_test` rows of the trial ledger (`stats/splits.ts` `trialCounts`). It is a pure function of the ledger: no new table, and the trial ledger is unchanged. Generated challengers still count toward the m = 20 budget (ARN-085) and toward DSR N; they spend α only when tested.
- A new split version (roll) starts a new pool, with W₀ scaled by the share of the rolled budget (`rolledBudgetAtRoll` / m).
- `evaluateVal110` (`stats/val110.ts`) gets a required `priorTests` input and takes its level from `validationLevelFor`. VAL-110 (ii) uses the same level. Holdout confirmation keeps `holdoutLevel` (0.05 ÷ L), as VAL-112 says. Callers: `replay/runner.ts` (`evidence`, WP3) and `learning/challengerEvidence.ts` (WP4).
- `bh_fdr` is refused by the key's validator in V2 (D-227).
- O-45: `evaluateLeverage` results are descriptive and write no trial row (check the runner; remove the row if one is written).

**VAL-113 power arithmetic (D-229).** New `src/lib/stats/power.ts`: `requiredRows({ effect, sd, level, power: 0.8, neffRatio })` = max(100, ⌈((z₁₋α + z_power)·sd/effect)² ÷ neffRatio⌉), with the level from `validationLevelFor`. The existing `minimumDetectableEffect` already takes the level, so VAL-110 output changes with VAL-112. `PATTERN_TEST_ORDER` = engulfing, piercing, harami, morning star, hammer, in `replay/scorecards.ts`. A pure `bullishHarami` detector is added to `agents/patterns.ts` but is not wired into `PatternFlags`, cards or families until M15 publishes the sample sizes (otherwise every card JSON would change now).

**VAL-114 daily rank quality (D-232).**
- New `src/lib/agents/families/rankScore.ts`: `rankScores(family, inputs, params)` gives a scalar score for every code of the family's tiers on D where the rank key is computable. The keys are the ones in `rules.ts` (F1 RS percentile, F2/F3/F5 event AR or volume ratio, F4 −RSI(2), F6 its first rank key), and entry thresholds are not applied. Event families score only codes with an eligible event group. The same file holds the KB-081 rank variants `composite3` (equal-weight z-scores of 126-session momentum, minus 20-session volatility, and volume trend) and `volScaled` (score ÷ 20-session volatility).
- New `src/lib/stats/rankIc.ts`: Spearman IC of the D scores against the close(D+1)→close(D+2) return minus the U1 median of the same return, on split-adjusted closes. A day with fewer than 10 scored codes is skipped. Summary: circular block bootstrap (`stats/bootstrap.ts`) with 21-session blocks (`rank_ic_bootstrap_blocks` = monthly), B = 2,000, seed scope `rank_ic:<lineage>`, giving the median IC, mean IC, 90% interval and n.
- Nightly: batch 3 (`src/lib/agents/batch3.ts`) adds stage 6. For D′ = two sessions before D it rebuilds D′'s inputs with `loadDayInputs` (read only), computes the IC and inserts a `rank_ic_daily` row (source `live`). It then writes the bootstrap summary as `replay_stat` metric `rank_ic`.
- History: a weekly learning stage `rankIc` (new `src/lib/learning/rankIcStage.ts`) backfills `rank_ic_daily` (source `replay`) from `SnapshotWorld.familyInputs(d)`. Rows are insert-or-ignore on (market, family, rank_variant, d); a parity test checks live = replay on overlapping days.
- Descriptive only. Lane B reads it only as a screening figure for the KB-081 rank challengers (`rank_variant` = `composite3` / `vol_scaled`).

**VAL-115 minimum backtest length (D-230).** New `src/lib/stats/minBtl.ts`: MinBTL(N, SR*) = [(1−γ)·Z⁻¹(1−1/N) + γ·Z⁻¹(1−1/(N·e))]² / SR*² years (Bailey, Borwein, López de Prado and Zhu 2014; γ = Euler–Mascheroni), with MinBTL(1) = 0. SR* = `minbtl_target_sharpe` (1.0, fixed). The spec's [VERIFY] is handled by a known-answer test: N = 45, SR* = 1 gives about 5.0 years (the paper's example). N = the lineage's cumulative trials over all split versions. Length = development sessions ÷ 252. The label is "too short" until length ≥ MinBTL. Written by the `robustness` stage as `replay_stat` metric `min_btl`.

**VAL-116 lesson alpha pool (D-231).** In `alphaInvesting.ts`: α_j = `l2_alpha_spend_fraction` × W (default 0.1) instead of W/(2+W). The cost stays α_j/(1−α_j) and the rejection payout is unchanged (`l2_alpha_payout`). `readPoolState` returns `exhausted` when α_j < `l2_alpha_exhausted_level` (0.005); `alphaStep` refuses to run then. Stored pools continue from their stored W (the `alpha_wealth` trigger chain is unchanged).

**KB-081 pre-registered challengers (D-233, D-234, D-235).**
- New `src/lib/learning/preRegistered.ts` holds the fixed list. Origin `owner`, because O-46 is the Owner's decision; the challenger's note cites "KB-081 / O-46".

  | Family | Challengers | Mechanism |
  |---|---|---|
  | F1 | return window 252; skip-month U2-only; three-factor composite rank | `f1_return_window_sessions` = 252; `f1_momentum_variant` = `skip_month_u2`; `f1_rank_variant` = `composite3` |
  | F3 | drift window 40; drift window 60; price-based surprise (AGT-137) | `f3_time_exit` = 40 / 60 (upper bound raised to 60); `f3_surprise_mode` = `day0_ar` |
  | F4 | 5-session U2 reversal; vol-scaled rank; unscaled control arm | `f4_entry_variant` = `reversal5_u2`; `f4_rank_variant` = `vol_scaled`; control = a copy of the incumbent registered as its own challenger |
  | F6 | director sale weight 0.25 (AGT-136) | `insider_score_weights.director_sale` = 0.25 |

  F2 has none (fundamentals BLOCKED-DATA) and F5 has none (its U3 run is a stress variant). F1's 20-session incumbent window is the 20 of "20/40/60", so it is not registered again.
- The weekly `preregistered` stage creates the next ones in list order as `max_challengers` slots free up. Each one is charged a `challenger` trial at creation (`createChallenger` already charges every origin). The director trade-type split is listed as BLOCKED-DATA: the stored data has no trade type, so it is not created and not charged.
- O-46 cap (`challengerLifecycle.ts`): at most 3 challengers per family per calendar quarter that change a stop, trail or sizing key; otherwise refused with `variant_quarter_cap`.
- The structural switches are enum B keys whose defaults reproduce v1 exactly, so nothing changes until a challenger sets them. `ruleSchema.ts` learns enum B keys (WP0). `candidateSteps` already skips non-numeric keys, so the generator never steps them.

### 2.3 Data

**DAT-232 split-adjusted volume (D-236).** Indicators already use split-adjusted volume (`adjustBars` in `candidates.ts` multiplies volume by the later split ratios; `forwardLedger.ts` and `snapshotWorld.ts` do the same). ADV and the tier median use raw close × raw volume, which a split does not change. The gap found: event day-0 volume ratios (`events.ts` `buildEvents`, line ~423) use raw volumes, so a split inside the 20-session window distorts F3/F5 `vol_ratio_ppm`. Fix: pass the same split ratios (`splitsKnownOn`) into the event builder and adjust volumes there. New `scripts/data/split-frequency.mjs` (read only) measures split and consolidation days in the stored M2 data (count per year, share of codes, share of 20-session windows touched). The numbers go into the AT-45 report.

**DAT-233 adjustment factors (D-237).** Migration 0018 adds nullable `adjustment_factor.factor_kind` (`price` | `split`) and `ref_close_micro`. The corporate-action engine (`src/lib/data/corporateActions/engine.mjs`, `rules.mjs`) writes both. A dividend (price) factor is used only when its stored reference close equals the raw close of the session before the ex-date; otherwise the action is queued for the Owner with reason `ref_close_mismatch` and not applied. `adjusted.ts` returns `priceFactor` and `splitFactor` separately beside the product. Legacy rows (NULL kind) take their kind from the action type. No backfill, so history replays identically.

**DAT-234 index-change events (D-238).** New table `index_change` (0018). It is loaded by `src/lib/data/referenceData.ts` (WP8) from a CSV: code, index, add/delete, announced date, effective date, source. `evaluateF3` excludes an event group when its code has an index change announced or effective within ±1 session of day 0 (`index_change_window_sessions`). The card is blocked with reason `index_change` and the event is tagged on the card. The facts reach the rules as `CodeFacts.indexChanges` (filled in `loadDayInputs` and `SnapshotWorld`). The snapshot gains an `index_changes` table (`snapshotCore.mjs`). No automated fetch is built (§6).

**DAT-235 benchmark.** Done in M8.1 (`picks/benchmark.ts`). M14 adds one test: every comparison reader (picks vs market, zero-edge display, Strategies) uses the total-return series, not `^AXJO` price.

**DAT-236 licence register and universe sources (D-239).**
- Migration 0018:
  - updates `asx_listed_companies`: `owner_ref` = `O-23b` and a permitted-use text that states its own terms;
  - updates `rba`: copyrighted, derived numbers only with the source named;
  - inserts two alternative universe sources with status `disabled` (no fetcher): `wikidata_asx` (CC0) and `wikipedia_asx200` (CC BY-SA 4.0, about 200 codes), terms [VERIFY];
  - inserts register rows for the manual files `index_changes_manual` and `industry_map_manual`.
- `scripts/ci/licence-register.mjs` parses 0018 too and gains `SOURCE_FACTS` entries, and `docs/source-licence-register.md` is regenerated.
- New `scripts/data/universe-from-wikidata.mjs` turns a downloaded export into the listed-companies CSV shape that `universe/parse.mjs` accepts. It reads a local file only; no network in CI.
- Manual uploads: a "Data files" card on the Configuration page (Owner only) with three uploads — listed companies (the existing `importUniverse` path with source `manual`, the same parser and shrink guard), index changes and industry map. These are data uploads, not config edits, so D-174 (read-only configuration) stands.
- Before building, check that the code which accepts O-23 still enables both ASX rows when `owner_ref` reads O-23b (grep for `"O-23"`).

**DAT-237 announcement dedup (D-240).**
- Exact: `src/lib/sentinel/ingest.ts` (the route the Worker posts to; the Worker does not parse items, so it is unchanged) writes `announcement.content_hash` = sha256(market | code | normalised title | published date) on insert (0018, nullable). Sentinel assessment skips an item whose hash is already present for that code in the last 5 sessions, so there is no second alert.
- Near: new `src/lib/agents/announcementDedup.ts`, an in-house MinHash (128 seeded hash functions, word 3-shingles of the normalised title). Same code, within `dedup_window_sessions` (5), Jaccard ≥ `dedup_minhash_threshold` (0.85) → duplicate of the earlier item.
- `buildEvents` in `events.ts` runs `dedupAnnouncements(visible)` (exact, then MinHash) before building events, so a duplicate gives no event row. The function is pure and runs on what is visible at D's cut-off, so live and replay agree without storing a flag.
- Only titles are stored (no full text), so the comparison uses titles.

### 2.4 Events and agents

**AGT-135 exchange query (D-241).** The polarity stays −1. Migration 0018 adds nullable `event.category_detail` (`query_response` | `guidance_maintained`) and recreates `event_guard_update` so the new column is immutable too. In `EVENT_RULES_V1` (`events.ts`) the "query" rule splits: titles such as "response to ASX (price) query" or "aware letter response" get `category = exchange_query`, `category_detail = query_response`. The reversal flag is computed when facts are read (`families/facts.ts`): the sign of the day0→day0+1 close return is the opposite of the day-0 AR sign, available only from day0 + 1. It is shown on the card; it is not a rule input. `EVENT_RULE_VERSION` = `events-v2`. Stored v1 rows keep their version (append-only); replays rebuild history with v2.

**AGT-136 director trades (D-242).** The weight stays at v1 (0.5). `insiderFlow.ts` reads an optional `director_sale` weight (default = `director_net`, so v1 is unchanged), used for net director sales. The challenger sets 0.25 (KB-081 table). The on-market vs option-exercise split is BLOCKED-DATA.

**AGT-137 price-based surprise (D-243).** `f3_surprise_mode = day0_ar`: the F3 trigger is any price-sensitive event group with day-0 AR ≥ `f3_event_ar_min_pct` and no negative-category member, and the surprise sign is the AR sign; the v1 category list is ignored. The drift windows 20/40/60 are the KB-081 F3 challengers.

**AGT-138 guidance maintained (D-241).** A new rule placed before guidance-up/down catches reaffirmed, maintained, unchanged or reiterated guidance titles: `category = other`, `category_detail = guidance_maintained`. Polarity follows the AR (the v1 rule for `other`), as the spec asks.

### 2.5 LLM layer (`src/lib/llm/`)

Today no role routes citations or labels in production (R6 is M11; `category_llm` is never written). M14 builds the mechanisms and tests them with fixtures.
- **LLM-071 (D-244).**
  - New `jsonSchema.ts`: a small subset (type, properties, required, enum, items, minItems, maxLength, additionalProperties false) with `validate(schema, value)` and `withCitationEnum(schema, ids)`.
  - `RouteRequest` gains `schema?` and `citationIds?`. The router passes `responseSchema` in `ProviderRequest`.
  - `providers.ts` live provider: Groq gets `response_format: json_schema` strict; Gemini gets `responseMimeType` + `responseSchema` (unsupported keywords stripped); this happens only when the roster entry has `strictSchema: true` [VERIFY per model]. App-side `parse` + `validate` always run, so an out-of-enum citation is rejected even if the provider ignores the schema.
- **LLM-072 (D-245).** New `labels.ts` `enumLabel(value, allowed)`: exact, case-sensitive match after JSON decode, with no trim, fold or substring. The bake-off parsers in `bakeoff.ts` use it. A static test fails if a label parser in `src/lib/llm/` or `src/lib/sentinel/` uses `includes`/`startsWith`/`toLowerCase` on a model label.
- **LLM-073 (D-246).** New `datamark.ts`: in DATA blocks, untrusted text has each whitespace run replaced with U+02C6, with a fixed marker so prompt hashes are deterministic. `buildPrompt` (router.ts) applies it and says so in the instruction line. The injection phrase filter still runs first. Add ≥ 10 hostile, datamarked items to `tests/fixtures/llm/golden-zz/injection.json`; the bake-off threshold (100% injection resistance) is unchanged. Re-record the mock fixtures.
- **LLM-074 (D-247).** The budget check reserves tokens for the first call and one repair before the first call. `RouteRequest.check?` returns `{ ok: false, field }`, and the repair prompt names that field (the name comes from our schema, so it is trusted). There is never a second repair. Grounding failures are still not repaired.
- **LLM-075 (D-248).** `RosterEntry.knowledgeCutoff` (YYYY-MM or null, from the model card, [VERIFY] with `checkedOn`). New `assertWindowAfterCutoff(provider, model, windowStartD)` for M11/M12 test windows. Every hypothesis an LLM proposes is a counted trial through `createChallenger` (none exist yet; the test pins it). The generated roster doc shows the cut-off.

### 2.6 Data and migration 0018 (`db/migrations/main/0018_m14.sql`, D-250)
All additive or nullable; no table rebuild; no backfill.
1. `adjustment_factor` + `factor_kind TEXT CHECK (NULL or 'price'|'split')`, + `ref_close_micro INTEGER CHECK (NULL or > 0)`.
2. `event` + `category_detail TEXT CHECK (NULL or 'query_response'|'guidance_maintained')`; drop and recreate `event_guard_update` with the column added to the "must not change" list.
3. `announcement` + `content_hash TEXT`; index `(market, code, content_hash)`.
4. New `index_change` (market, code, index_name, kind CHECK add|delete, announced_d, effective_d, source, loaded_at; PK (market, code, index_name, kind, effective_d)), append-only triggers.
5. New `instrument_class` (market, code, industry, source, as_of, loaded_at; PK (market, code, as_of)), append-only.
6. New `rank_ic_daily` (market, family, rank_variant, d, n, ic REAL, source CHECK live|replay, computed_at; PK (market, family, rank_variant, d)), append-only.
7. `source_register`: the updates and inserts of §2.3 DAT-236 (the history triggers log them).

The `-- +down` section reverses each step, as 0015–0017 do. The trial ledger, `alpha_wealth`, `ledger_row` and `replay_stat` are unchanged; robustness, stability, MinBTL and rank-IC summaries are `replay_stat` rows.

### 2.7 Configuration keys (`src/lib/config/keys.ts`, typed in `src/lib/agents/params.ts`)

| Key | Default | Bounds | Edit | Ref |
|---|---|---|---|---|
| max_stop_distance_pct | 12 | 6–20 | O | FAM-004, O-47 |
| cost_gate_k | 2.0 | 1.5–3.0 | O | FAM-005 (same key as CTX-022a) |
| second_position_max_corr | 0.6 | 0.3–0.9 | O | FAM-006 |
| val_error_budget_mode | alpha_spending | fixed \| alpha_spending (bh_fdr refused, D-227) | O | VAL-112, O-43 |
| val_fwer_per_lineage | 0.05 | 0.01–0.10 | O | VAL-112 |
| l2_alpha_spend_fraction | 0.1 | 0.05–0.25 | O | VAL-116, O-44 |
| rank_ic_bootstrap_blocks | monthly | monthly \| weekly | fixed | VAL-114 |
| f5_default_universe | U2 | U1 \| U2 \| U3 | O | O-49 |
| settlement_stats_mode | conservative | conservative \| matched | O | ARN-109, O-48 |
| dedup_minhash_threshold | 0.85 | 0.7–0.95 | O | DAT-237 |
| cost_gate_min_rows | 30 | — | fixed | FAM-005 (D-214) |
| second_position_corr_sessions | 60 | — | fixed | FAM-006 |
| l2_alpha_exhausted_level | 0.005 | — | fixed | VAL-116 |
| minbtl_target_sharpe | 1.0 | — | fixed | VAL-115 (D-230) |
| rank_ic_min_codes | 10 | — | fixed | VAL-114 (D-232) |
| rank_ic_bootstrap_replicates | 2000 | — | fixed | VAL-114 |
| dedup_window_sessions | 5 | — | fixed | DAT-237 (D-240) |
| index_change_window_sessions | 1 | — | fixed | DAT-234 (D-238) |
| f1_return_window_sessions | 126 | 126–252 | B | KB-081 |
| f1_momentum_variant | v1 | v1 \| skip_month_u2 | B | KB-081 |
| f1_rank_variant, f4_rank_variant | v1 | v1 \| composite3 \| vol_scaled | B | KB-081 |
| f4_entry_variant | v1 | v1 \| reversal5_u2 | B | KB-081 |
| f3_surprise_mode | category | category \| day0_ar | B | AGT-137 |
| f3_time_exit (v1 key, bound) | 20 | 10–**60** (was 40) | B | KB-081, AGT-137 |
| insider_score_weights.director_sale | = director_net | 0–1 | B | AGT-136 |

The Configuration page lists them automatically (read-only, D-174). Raising `f3_time_exit`'s upper bound changes `maxHoldingUpperBound("F3")`, so only splits created later get the longer purge; the frozen F3 split keeps its purge of 60 (40 + 20), which still covers a 60-session hold.

### 2.8 UI
- **Strategies, one strategy page** (`src/app/(app)/strategies/[execution]/page.tsx`): a new "Robustness" section (new `Robustness.tsx`; loader `src/lib/ui/loaders/robustness.ts` reading the newest `replay_stat` rows by scope, like `zero_edge` in `strategyViews.ts`). It has four tables:
  - exit ablation (rule vs time-stop only);
  - one-tick slip beside the P3 + 50% stress figure;
  - stability (±1 step per key, with a "fragile" chip);
  - rank quality (median IC, 90% interval, n), plus the MinBTL line ("too short" until met) and the error budget (α level for the next test, tests so far, lesson pool status).
  It is labelled "descriptive — not a finding". Owner and Editor see it, and masking follows AT-02 / O-54 (no execution or family ids for non-Owners). Empty state: "Not measured yet".
- **Decision Card** (`src/lib/ui/loaders/cardParts.ts`): plain words for the new skip reasons and flags, the event detail ("Response to an ASX query", "Guidance maintained") and the reversal flag.
- **Configuration page**: the "Data files" card (§2.3).

## 3. Work packages

Builders (Sonnet) each work in their own git worktree off `build` after WP0 has merged. Opus reviews every line of WP1, WP2, WP3 and WP4 (money, look-ahead, statistics).

**WP0 — orchestrator foundation (serial, first, about 2 h; the orchestrator owns these files for the whole milestone and serialises later edits to them):**
- migration 0018;
- `src/lib/config/keys.ts` (all §2.7 keys, labels, the bound change, enum validators) and `src/lib/agents/params.ts` (typed fields);
- `src/lib/agents/families/ruleSchema.ts` (enum B keys in `FAMILY_PARAM_KEYS`, schema loader);
- `src/lib/agents/families/types.ts` (optional `CodeFacts.industry`, `CodeFacts.indexChanges`, `EventFact.categoryDetail`, `EventFact.reversedNextClose`; `FamilyOptions.f5StressU3`);
- `src/lib/agents/families/constants.ts` (`families-2`);
- `src/lib/agents/schema.ts` (detail and reason constants);
- `src/lib/agents/cards.ts` (reason regex, flag vocabulary);
- `src/lib/learning/weeklyRun.ts` and `src/lib/replay/learningMode.ts` (register the stages `robustness`, `rankIc` and `preregistered` with no-op stubs);
- signature-only stubs, each handed to one package afterwards: `src/lib/stats/errorBudget.ts`, `src/lib/agents/costGate.ts`, `src/lib/arena/exDividend.ts`, `src/lib/agents/families/rankScore.ts`, `src/lib/data/referenceData.ts`, `src/lib/stats/robustnessTypes.ts` (the JSON shapes of the new `replay_stat` metrics);
- the `exDividendMicro` option on `fillIntradayStop` (accepted, ignored);
- `docs/07_decision_log.md` (D-213…D-252) and `docs/test-map.md` rows.

**WP9 — integration (serial, last, orchestrator):** merge order; a single final re-pin of any golden that the combined packages moved (§1 table); the AT-43…AT-46 reports; `docs/M14_exit_evidence.md`; BUILD_SETUP §9.

| WP | Title | Files owned (new files marked +) | Depends on |
|---|---|---|---|
| WP1 | Entry gates (FAM-004, FAM-005, FAM-006, FAM-008, FAM-009) | `src/lib/agents/families/index.ts`, +`src/lib/agents/families/stopCap.ts`, +`src/lib/agents/entryGates.ts`, `src/lib/agents/costGate.ts` (from stub), `src/lib/agents/batch2b.ts`, `src/lib/replay/cohortReplay.ts` (entries, plus the FAM-007 option at its three stop calls), `tests/agents/entryGates.test.ts`+, `tests/agents/costGate.test.ts`+, `tests/agents/stopCap.test.ts`+, `tests/replay/cohortParity.test.ts` | WP0; WP2 for FAM-007 semantics (stub until then); WP6 fills `industry` (tests build facts directly) |
| WP2 | Ex-date stops and adjustment factors (FAM-007, DAT-233, DAT-235 check) | `src/lib/arena/fills.ts`, `src/lib/arena/closeBooks.ts`, `src/lib/arena/exDividend.ts` (from stub), `src/lib/replay/returns.ts`, `src/lib/picks/track.ts`, `src/lib/data/corporateActions/engine.mjs` + `.d.mts`, `src/lib/data/corporateActions/rules.mjs` + `.d.mts`, `src/lib/data/adjusted.ts`, `tests/arena/fills*.test.ts`, `tests/corporateActions/*`, `tests/arena/replay.test.ts` (re-pin if moved), `tests/picks/benchmarkUse.test.ts`+ | WP0 |
| WP3 | Replay robustness and runner (ARN-106, ARN-107, ARN-108, ARN-109; runner wiring of FAM-005 and VAL-112) | `src/lib/replay/runner.ts`, `src/lib/replay/cli.ts`, `src/lib/replay/ledger.ts`, +`src/lib/replay/exitAblation.ts`, +`src/lib/replay/sensitivity.ts`, +`src/lib/learning/robustnessStage.ts`, `src/lib/learning/weeklyStages.ts`, `src/lib/learning/challengerGenerator.ts`, `tests/replay/runner.test.ts`, `tests/replay/replayStats.test.ts`, `tests/learning/robustness.test.ts`+, `tests/learning/challengerGenerator.test.ts` | WP0; WP1 (`costGateTable`); WP4 (`validationLevelFor`; stub until then) |
| WP4 | Validation statistics (VAL-112, VAL-113, VAL-114, VAL-115, VAL-116, O-45) | `src/lib/stats/val110.ts`, `src/lib/stats/gates.ts`, `src/lib/stats/errorBudget.ts` (from stub), +`src/lib/stats/power.ts`, +`src/lib/stats/minBtl.ts`, +`src/lib/stats/rankIc.ts`, `src/lib/agents/families/rankScore.ts` (from stub), `src/lib/learning/alphaInvesting.ts`, `src/lib/learning/lessons.ts`, `src/lib/learning/challengerEvidence.ts`, `src/lib/agents/batch3.ts`, +`src/lib/learning/rankIcStage.ts`, `src/lib/agents/patterns.ts`, `src/lib/replay/scorecards.ts`, `tests/stats/*` (new files), `tests/learning/alpha*.test.ts`, `tests/agents/batch3*.test.ts` | WP0 |
| WP5 | Events and announcements (AGT-135, AGT-138, DAT-232, DAT-237) | `src/lib/agents/events.ts`, `src/lib/agents/families/facts.ts`, +`src/lib/agents/announcementDedup.ts`, `src/lib/sentinel/ingest.ts`, +`scripts/data/split-frequency.mjs`, `tests/agents/events*.test.ts`, `tests/agents/announcementDedup.test.ts`+, `tests/sentinel/ingest*.test.ts`, `tests/fixtures/agents/events/**` | WP0 |
| WP6 | Family variants, reference-data wiring and pre-registered challengers (O-49, DAT-234 rule, AGT-136, AGT-137, KB-081, O-46 cap) | `src/lib/agents/families/rules.ts`, `src/lib/agents/families/context.ts`, `src/lib/agents/insiderFlow.ts`, `src/lib/agents/candidates.ts`, `src/lib/replay/snapshotWorld.ts`, `src/lib/data/backfill/snapshotCore.mjs` + `.d.mts`, `src/lib/data/backfill/snapshotLoad.mjs` + `.d.mts`, `src/lib/learning/challengerLifecycle.ts`, +`src/lib/learning/preRegistered.ts`, `tests/agents/families/*`, `tests/agents/acceptanceM4.test.ts`, `tests/learning/preRegistered.test.ts`+, `tests/learning/challengerLifecycle.test.ts` | WP0; WP4 (`rankScore` variants); WP8 (`referenceData` readers; stub until then) |
| WP7 | LLM hardening (LLM-071…075; AT-46) | `src/lib/llm/router.ts`, `src/lib/llm/providers.ts`, `src/lib/llm/roster.ts`, `src/lib/llm/bakeoff.ts`, `src/lib/llm/injection.ts`, +`src/lib/llm/jsonSchema.ts`, +`src/lib/llm/labels.ts`, +`src/lib/llm/datamark.ts`, `tests/llm/**`, `tests/fixtures/llm/**`, the generated LLM roster doc | WP0 |
| WP8 | Reference data, licence register and UI (DAT-234 loader, DAT-236, Strategies and card UI) | `src/lib/data/referenceData.ts` (from stub), `src/lib/data/universe/import.ts`, `src/lib/data/universe/handler.ts`, `scripts/ci/licence-register.mjs`, `docs/source-licence-register.md` (regenerated), +`scripts/data/universe-from-wikidata.mjs`, `src/app/(app)/config/page.tsx`, `src/app/(app)/config/actions.ts`, +`src/app/(app)/config/DataUploads.tsx`, +`src/lib/ui/loaders/robustness.ts`, `src/app/(app)/strategies/[execution]/page.tsx`, +`src/app/(app)/strategies/[execution]/Robustness.tsx`, `src/lib/ui/loaders/cardParts.ts`, `tests/loaders/robustness.test.ts`+, `tests/data/referenceData.test.ts`+, `e2e/m14-*.spec.ts`+ | WP0 (row shapes from `robustnessTypes.ts`; UI tests use seeded rows, not other packages) |

Waves: WP0 → {WP2, WP4, WP5, WP7, WP8} in parallel, with WP1, WP3 and WP6 starting at the same time against the stubs → WP1/WP3/WP6 merge after their dependencies → WP9. Each package runs the full local gate, reads the whole gate output before pushing, and checks remote CI after the push (memory: gate-before-push, check-remote-ci). Effort is about 2–3 h each; WP4 and WP6 are the largest (about 3 h). If either runs long, split WP4 into 4a (VAL-112/113/115/116) and 4b (VAL-114 + batch 3), and WP6 into 6a (rules, facts wiring, snapshot) and 6b (pre-registration and the cap). The file lists split cleanly along those lines.

## 4. Decisions (recorded; spec defaults; listed in the V2 PR)

- **D-213** M14 scope is §10.V2.2–§10.V2.6 less what M8.1 shipped; FAM-008, FAM-009, the F5 universe (O-49) and the O-45 amendment are included because they sit in the same sections and are small; LLM-076 and all CTX-* items are not.
- **D-214** FAM-005 is built in its family-median form, the only form possible before the M15 Cortex: the median of development-split gross returns per (family, rule version, variant) from the signal-ledger rows behind the AGT-110 scenario table; with fewer than 30 rows the gate is not applied and the card says `cost_gate_unmeasured`.
- **D-215** The cost-gate round trip is 2 × the execution's brokerage at A$600 plus 2 × the ARN-032 bucket bps of the signal's 20-session ADV; the gate applies to E executions only, never to the signal ledger or the controls.
- **D-216** FAM-004 runs inside `runFamilies`, after F6, on the stop distance at the reference price; candidates over the cap are blocked as `skipped_stop_distance`; the agent version becomes `families-2`; rule versions do not change.
- **D-217** FAM-006's "first" position is any held position plus the first leg of the night; the test is a different industry and a 60-session return correlation ≤ the limit; unknown industry falls back to correlation only, missing history to industry only; controls are exempt.
- **D-218** No free, licence-clean GICS sub-industry source exists; the ASX file's GICS industry group is the proxy, and a manual CSV (`instrument_class`) may supply finer classes.
- **D-219** FAM-007 uses the confirmed cash/special dividend known by the cut-off before the ex-date, only on that session and only for IS triggers (open + dividend and low + dividend); it does not re-base the level, it has no vendor fallback (to keep replay = live), and CS level rules and the sleeve are unchanged.
- **D-220** FAM-008 is already v1 behaviour and gets a test; FAM-009 relabels the SHOCK below-two-parcels case `abstain_shock` with the same outcome.
- **D-221** F5 trades U2 only (`f5_default_universe` = U2); U3 runs only in replay as the descriptive variant `F5-U3-stress`.
- **D-222** The ARN-106 comparator keeps only the family's unconditional time exit; it is computed weekly on the development split; a trailing-stop challenger is proposed only if its development mean net beats the comparator's.
- **D-223** ARN-107 adds one adverse tick per side to the same ledger rows after the fact, with brokerage recomputed and exits unchanged; it is descriptive and has no random draw.
- **D-224** ARN-108 uses the generator's ±1 grid step on every numeric B key, weekly for incumbents and once per challenger; a version is "fragile" when it passes the absolute gate and any neighbour fails it; the label is descriptive.
- **D-225** Replay cohort statistics use conservative settlement, with matched as a sensitivity in full/evidence runs; live books stay matched.
- **D-226** VAL-112 is Foster–Stine with zero payout per (lineage, split version), W₀ = 0.05, α_k = W_k/(2+W_k) with W_k = W₀/2^k after k validation or pattern tests; it is computed from the trial ledger, with no division by the number of lineages for VAL-110 (i)/(ii), and the holdout level is unchanged.
- **D-227** `val_error_budget_mode` implements `fixed` and `alpha_spending`; `bh_fdr` is refused in V2 because the spec does not define an FWER-safe sequential form.
- **D-228** Sleeve and leverage tests (ARN-084 as amended by O-45) are descriptive and write no trial row.
- **D-229** Power planning uses the VAL-112 level and a floor of 100 rows; the pattern test order is fixed as in VAL-113; the harami detector is added but not wired into cards until M15.
- **D-230** MinBTL follows Bailey et al. 2014 with SR* = 1.0, N = the lineage's cumulative trials and length = development sessions ÷ 252; a known-answer test (N = 45 → about 5 years) stands in for the [VERIFY].
- **D-231** VAL-116 spends 10% of the pool per test and marks it exhausted when the next level would be < 0.005; existing pools continue from their stored wealth.
- **D-232** The VAL-114 cross-section is every code with a computable family rank score (event families: codes with an eligible event group; entry thresholds not applied), at least 10 codes, Spearman against the D+1→D+2 excess over the U1 median, with a 21-session block bootstrap (B = 2,000, 90% interval); it is computed nightly in batch 3 for D−2 and backfilled from replay.
- **D-233** The KB-081 set is mapped as in §2.2 (F1 ×3, F3 ×3, F4 ×3, F6 ×1), origin `owner` under O-46, released as challenger slots free and charged at creation; the director trade-type split is BLOCKED-DATA; `f3_time_exit`'s upper bound becomes 60.
- **D-234** At most 3 challengers per family per calendar quarter may change a stop, trail or sizing key (O-46); further ones are refused as `variant_quarter_cap`.
- **D-235** The KB-081 structural switches are enum B keys (plus `f1_return_window_sessions` and `director_sale`) whose defaults reproduce v1 exactly; the generator never steps enum keys.
- **D-236** DAT-232: indicators already use split-adjusted volume; event day-0 volume ratios are fixed to use it too; ADV stays raw value (unchanged by a split); the split-day frequency is measured by script and reported in AT-45.
- **D-237** DAT-233 adds `factor_kind` and `ref_close_micro`; a dividend factor whose reference close does not match the stored close is queued, not applied; legacy rows take their kind from the action type.
- **D-238** Index changes come from a manual, fixture-tested CSV (`index_change`); an F3 group is excluded when an add or delete is announced or effective within ±1 session of day 0; no automated fetch until a free source's terms are verified.
- **D-239** DAT-236: Wikidata (CC0) and the Wikipedia S&P/ASX 200 list (CC BY-SA 4.0) are recorded as disabled alternatives with [VERIFY] terms and a converter script; the ASX list row cites O-23b; RBA is "derived numbers, source named"; the manual uploads sit on the Configuration page as data, so D-174 stands.
- **D-240** Exact dedup is a content hash at the ingest route the Worker calls (the Worker itself is unchanged); near-dup is an in-house MinHash on titles (128 hashes, 3-shingles, Jaccard ≥ 0.85, same code, 5 sessions); a duplicate makes no event, live and replay alike.
- **D-241** AGT-135/138 use a new nullable `event.category_detail` instead of new categories (no rebuild of a forever table); query polarity stays −1; guidance maintained is `other` with AR polarity; the next-close reversal is a display flag; events become `events-v2`.
- **D-242** AGT-136 keeps 0.5 and adds an optional `director_sale` weight for the 0.25 challenger; the trade-type split is BLOCKED-DATA.
- **D-243** AGT-137 `day0_ar` mode: any price-sensitive group with day-0 AR ≥ the F3 minimum and no negative member, sign from the AR.
- **D-244** LLM-071 uses an in-house JSON-schema subset (no new dependency); strict provider modes only where the roster marks support; app-side validation always runs; citation IDs become a per-request enum.
- **D-245** LLM-072 labels match exactly (case-sensitive, no trim or fold); a static test forbids fuzzy matching in label parsers.
- **D-246** LLM-073 datamarks untrusted text by replacing whitespace runs with U+02C6 (fixed marker); the mock fixtures are re-recorded; at least 10 hostile datamarked items are added to the bake-off injection set.
- **D-247** LLM-074 reserves tokens for the first call and one repair up front; the repair names the failing field; there is never a second repair.
- **D-248** LLM-075 stores a dated knowledge cut-off per roster model, adds a test-window guard for M11/M12, and pins that any LLM-proposed hypothesis is charged as a trial.
- **D-249** The goldens in §1 may be re-pinned, each in the commit that moves it, citing its D-number; a final combined re-pin happens in WP9.
- **D-250** Migration 0018 holds only the additive and nullable changes in §2.6.
- **D-251** The Strategies "Robustness" section is descriptive, visible to Owner and Editor, and masked per O-54.
- **D-252** LLM-076 (optional local classifier) is not built in M14.
- **D-253** FAM-004 "logged as `skipped_stop_distance`" is met by the night's stored day candidates, written by batch 3's forward-ledger sync (`forwardLedger.ts` `putDayCandidates`, `blocked` with its reason), as for every family block since v1; a blocked candidate gets no card (corrects §2.1).
- **D-254** AT-44's trial-ledger lineage carries 3 KB-081 pre-registered challengers, the most any one family has (F1, F3, F4 three each, F6 one; D-233), and 10 others, so the 13 / 9 / 3 = 25 counts hold (corrects §5 "4").
- **D-255** No family has a separate sizing parameter (sizing is an Owner key), so the AT-44 "sizing variant" is a stop variant (`f1_initial_stop_atr`); the quarter cap counts stop and sizing changes together (`STOP_SIZING_KEY`), and the 4th is refused.
- **D-256** A code that cannot open tonight (a disposal across the next session; in live also a quality-gate `code_blocked`) stays eligible for its own reason but is not the FAM-006 first leg, in batch 2b and in the cohort replay alike.
- **D-285** Reference data is point-in-time by its `loaded_at` (DAT-234, FAM-006): `loadIndexChanges` and `loadIndustryMap` add `loaded_at <= the decision cut-off of d`; the snapshot's `index_changes` and `industry` rows carry `loaded_at` (optional, null = always known) and `SnapshotWorld` applies it per night, so a CSV uploaded later never changes a past night. Known limit: `instrument.industry` (the ASX group) has no time column and no history, so it is read as the current value on every night; migration 0018 is not extended for it.
- **D-286** One replay memo per weekly run (key `family|version|canonicalJson(params)`, `replayOf` in `weeklyStages.ts`) serves the challenger generator, the challenger entries and the robustness stability neighbours; the `rankIc` stage computes only the sessions without `rank_ic_daily` rows and summarises the stored series.
- **D-287** The exact-hash announcement dedup (D-240) counts a same-hash earlier row only within `dedup_window_sessions` (5) sessions of the later one, so a yearly repeated announcement is assessed normally.

## 5. Acceptance mapping (reports in `docs/test-reports/AT-4x.md`)

All fixtures are synthetic ZZ codes (no real data in the public repo, SEC-110). Tests live in `tests/acceptance/v2/at4x.test.ts`.

**AT-43 Sizing and cost gates** → `docs/test-reports/AT-43.md`. Fixture `tests/fixtures/m14/at43World.ts`: one night, about 12 ZZ candidates.

| Clause | Proof |
|---|---|
| Skip reasons logged (FAM-004/005/006) | Candidates with stop distances 8%, 12% and 15% (and an F5 at 15% with its 20% cap) → `skipped_stop_distance` only for those over 12%. Four ADV buckets (≥ A$5M, A$1–5M, A$250k–1M, < A$250k) with an injected cost-gate table: gross 3% vs 2% cost at k = 2 → `skipped_cost_gate`; gross 5% → passes; 20 rows → `cost_gate_unmeasured`. Two candidates of the same industry → the second gets `second_position`; a different industry with correlation 0.8 → skipped; 0.4 → taken. |
| No order violates the cap, gate or limits | Scan of every `arena_order` row in live (batch 2b on a migrated test DB) and in replay (`replayCohorts`) for the same night: same orders (parity); none over the cap, under the gate, or a same-industry/high-correlation pair. FAM-008: the order expires after one open and is not resubmitted. FAM-009: a SHOCK half-size with cash < 2 parcels → `abstain_shock`. |
| Time-stop comparator and ±1 table for every family | The `robustness` stage on the small snapshot fixture `tests/fixtures/replay/ledgerWorld.ts` (extended so that every family F1–F6 has a lineage split and development rows) → `exit_ablation` and `stability` rows exist for F1…F6, and a planted fragile version carries the label. |

**AT-44 Rank quality and error budget** → `docs/test-reports/AT-44.md`. Fixture `tests/fixtures/m14/at44CrossSections.ts`.

| Clause | Proof |
|---|---|
| IC detects a planted edge | 500 sessions × 60 codes, seeded; next-day excess = 0.002 × rank z-score + noise → the 90% interval excludes 0. A null twin (no edge) → the interval contains 0. |
| VAL-112 level as the Owner chose | The levels follow W₀/2^k for k = 0…; Σα ≤ 0.05; `fixed` mode reproduces v1's 0.05/20/6. |
| Every hypothesis or variant is in the trial ledger | A lineage with 25 trials across two split versions (a roll after the 20th): 13 challengers (including 4 KB-081 pre-registered and 1 sizing variant), 9 validation accesses, 3 pattern tests → 25 `trial_ledger` rows; the levels follow the spending sequence on each split; a 4th stop/sizing variant in a quarter is refused (`variant_quarter_cap`). |
| Also | The VAL-115 known answer (N = 45 → 5.0 ± 0.05 years, "too short" label) and the VAL-116 exhausted status. |

**AT-45 Data additions** → `docs/test-reports/AT-45.md`. Fixtures: the M8.1 vendor-action fixtures in `tests/ingest/` (reuse), plus new `tests/fixtures/m14/split-day.json` and `tests/fixtures/m14/index_change.csv`.

| Clause | Proof |
|---|---|
| DAT-231 vendor rows without an extra request | Reuse the M8.1 test: one mocked Yahoo call → `vendor_action` split and dividend rows. |
| Split-adjusted volume ratio | A 2-for-1 split 10 sessions before day 0 → event and indicator volume ratios equal the hand value on adjusted volume; the raw ratio is shown to differ. The split-frequency script output (derived counts only) goes in the report. |
| Index change excluded from F3 and tagged | An F3-qualifying results event on a code added to an index the same day → blocked with `index_change`, the tag is on the card, and the same code without the CSV row is taken. |
| Also | DAT-233 (reference-close mismatch queued), DAT-237 (an exact repost and a near-duplicate title on the next day → one event), AGT-135/138 details and the reversal flag. |

**AT-46 LLM hardening** → `docs/test-reports/AT-46.md`. Fixtures in `tests/fixtures/llm/`.

| Clause | Proof |
|---|---|
| Retired models absent from every route | Reuse the M8.1 roster test: no route resolves a `retired` id. |
| An out-of-enum citation is impossible | A schema with `citationIds` ['E1','E2'] → the provider request body carries the enum (Groq and Gemini shapes); a mock answer citing 'E9' is rejected app-side and then repaired once. |
| A hostile pack causes no instruction following | A datamarked hostile pack through the mock provider and the bake-off injection category → 100% pass; the prompt shows the marker. |
| A fuzzy label is rejected | A classifier answer "bullish-ish" → the parse fails and the result is rules-only; the static test passes. |
| Also | LLM-074 reservation and the field-named repair; the LLM-075 window guard. |

## 6. Risks and research

| Item | Status | Design response |
|---|---|---|
| GICS sub-industry per ASX code | GICS is owned by S&P and MSCI; no free licence-clean per-code sub-industry list is known. The ASX file has the industry group only. | D-218: use the industry group as the proxy, add a manual `instrument_class` CSV, and let correlation do most of the work. |
| Index-change dates (DAT-234) | S&P DJI publishes rebalance notices but their reuse terms are not confirmed; aggregator sites are commercial. Cannot be confirmed offline. | D-238: manual CSV plus a fixture-backed loader; record the source and [VERIFY] terms in the register; no fetcher. The F3 exclusion works on whatever rows are loaded. |
| Alternative universe sources (DAT-236) | Wikidata (CC0; coverage of small caps uncertain) and the Wikipedia S&P/ASX 200 list (CC BY-SA 4.0; 200 codes only). Terms and coverage need a web check at build time. | D-239: register both as `disabled`, add the converter script, keep the manual CSV upload; the ASX fetch can be switched off with no loss, because instruments are never deleted. |
| Provider strict-schema support (LLM-071) and cut-offs (LLM-075) | Per-model support and cut-off dates come from provider pages and must be dated. | Roster flags default to `null`, which means no strict mode; app-side validation always applies. |
| MinBTL formula [VERIFY] | Taken from the primary paper as remembered; pinned by a known-answer test. | If the paper check differs, fix `minBtl.ts` and the test only; it is descriptive. |
| Golden churn | Many replay digests move at once (§1). | Re-pin per package with reasons; WP9 does the final combined re-pin and the cohort-parity check. |
| Batch 3 run time (VAL-114) | One extra `loadDayInputs` per night. | D-201/D-203 put a day's load at seconds; the stage is timed and degrades (skips the IC row) instead of failing batch 3. |
| FAM-007 next-day trigger | Without a re-base, a stop just under the post-dividend price can still trigger the next session. | Spec-literal (ex-date only); noted in the AT-43 report; any re-base would be a later spec change. |

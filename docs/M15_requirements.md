# M15 requirements — Cortex calibration

Delta specification extract from `Requirement/v2/spec/17_praxis_cortex.md` (v7, frozen 2026-10-22, O-68), ch. 12 V2 (M15 row, BLD-046), ch. 14 V2 (AT-50…AT-55), ch. 15 V2 (CTX keys), `docs/28_cortex/_design_freeze.md` and `tools/m15/PLAN.md`; continues from M14 on `build`.

## Scope

M15 is the third V2 milestone (BLD-046: M8.1 → M14 → **M15** → M16 → M17 → M11-lite → M13-lite → M12). It builds the Cortex: the single nightly procedure L0–L4 (CTX-010…014) that replaces the v1 entry path for all 12 books, and the calibration programme that decides which families may trade (CTX-050, CTX-053). Chapter 17 governs; where an angle file differs, the chapter wins (OI-61).

M15 has two halves that must compute angles identically:
- **App side** (this repo, public): the nightly Cortex in batch 2b/3, the schema, the shared angle and statistics library, the Cortex page, the card additions, config keys, acceptance tests on synthetic ZZ fixtures.
- **Offline side** (`Requirement/v2/tools/m15/`, private, PLAN.md WP1–WP8): the same angle code run over the local history extract to produce passports, ledger cells, the map, the replay evidence and the calibration report. Nothing from it enters the public repo except code and family-level statements the spec names (see "Data constraints").

Marks: **app** = build in app code · **offline** = offline computation on local history · **staging** = staging-only (forward data) · **deferred** = deferred or out, with the spec's reason.

### Definitions (CTX-001…003)
| ID | Plain words | Mark |
|---|---|---|
| CTX-001 | One nightly procedure per book: candidates with a calibrated p and expected net, exits, sizing, an explicit abstain with its reason; deterministic at the point of action (ARN-102). | app |
| CTX-002 | No "certain/guaranteed/will/99%" wording anywhere; two frequency labels only ("allowed to trade (weak test)", "live-tested (strict test)"); the across-lineage luck figure is shown beside the ledger. | app |
| CTX-003 | LLMs give enumerated labels and tracked opinions only; never an order. | app (staging for the organs) |

### Data and point-in-time (CTX-010, CTX-050 data part, CTX-051)
| ID | Plain words | Mark |
|---|---|---|
| CTX-010 | L0 integrity: cut-off is a `published_at` filter at 18:10 Melbourne; one known-time rule per source class (Yahoo D bar = close + p95 measured latency, US index = D+1 09:00, RBA/FRED = publication date, untimed backfill = +1 session); immutable input manifest per night; empty action feed = unknown; null `adj_close` rejected; late D bar = abstain-all night; no rule disabled in replay; as-of truncation test TST-109 on every feature. | app + offline (WP1 truncation helper) |
| CTX-050 (data) | Adjustment method: OHLC × cumulative split factor, dividends as a separate factor, volume × split ratio; split frequency published; survivorship haircut pre-registered and shown with/without; Turso holds one row per code per night of active-angle features plus passports and ledger rows; nightly job in the public repo (O-62) with a quota-degrade abstain-all rule. | offline (method) + app (storage, degrade rule) |
| CTX-051 | No free announcement archive: the 24 announcement-dependent angles and the text labels are forward-only (`candidate` in replay, measured from the M8.1 staging deploy); F3, F5, F6 can be allowed only through live shadow data; untimed rows never calibrate entries. | deferred (O-64: stay $0) |

### Angles (CTX-011, CTX-030…035)
| ID | Plain words | Mark |
|---|---|---|
| CTX-011 | 100 angles per code and sector; orientation +1 = favourable to a long entry, fixed in the passport before results; outputs in [−1, 1] rank-standardised nightly, or a flag, or a bucket; six score clusters (momentum, low-volatility, liquidity, event, quality, sentiment); risk, regime, calendar and meta angles are gates only. | app + offline (shared code) |
| CTX-030 | Passport per angle: id, definition, orientation, cluster, inputs, history fields, evidence grade, IC with CI at own horizon and 5/20/60, by regime, cost, failure modes, status, ledger charges. | offline (values) + app (table, page) |
| CTX-031 | One market-level trial ledger: every cell logged at computation before its result is opened; "measured" under BH q = 0.10 (PRDS) with split-half sign agreement; activation is a counted VAL-112 trial per lineage; one validation access per angle per frozen split. | offline (WP4) + app (table, nightly cells) |
| CTX-032 | Decay is a monitor: rolling live IC per angle, `watch` label after two low blocks, no weight change; retirement only via a counted challenger. | app |
| CTX-033 | Distinctness: residualise on sector, beta and size; rank correlation ≤ 0.6, VIF ≤ 5, partial IC ≥ 0.5 × raw; publish loadings and the effective number of independent angles; cap same-factor cluster weight at `cluster_weight_max`. | offline (WP4/WP6) + app (page) |
| CTX-034 | Design freeze and holdout: split dates recorded before measurement (done, `_design_freeze.md`); the only clean holdout is the live paper period. | done (record exists); app enforces split access |
| CTX-035 | Random-angle null (live score above the 95th percentile of ≥ 1,000 matched random sets); placebo (≥ 50 shuffled replays allow ≤ 0.35 families + 1.35 SE); MDEs at n_eff 100/150/300 published. | offline (WP6) + app (page) |

Angle inventory from `angles_D1…D10.md` (100 angles): 24 carry `History: needs the ASX announcement archive` and are `candidate` (A-D2-07, all of D3, A-D4-04, A-D5-10, A-D6-02/06/07/08, A-D8-04/05/06, A-D9-02/03, A-D10-05/06). The rest are computable from price, volume, index, ASIC shorts, RBA/FRED and the calendar, except where an angle names `needs_data` (fundamentals D4, free float A-D2-08, options A-D6-04, attention A-D6-09): those stay `candidate` too. D7, D9 and D10 are gates and meta checks, most of which already exist as v1 rules (FAM-004/005/006, ARN-108, kill switch).

### Measurement and ledger (CTX-012 outcome model and intervals)
| ID | Plain words | Mark |
|---|---|---|
| CTX-012 (outcome) | Target = realised net outcome under the family's real exits and all costs, on out-of-fold, purged, time-blocked matched setups of the development split; setup key = family rule × score band × volatility bucket × liquidity tier. | offline (WP5) |
| CTX-012 (intervals) | Stationary block bootstrap (block ≥ 120 sessions, purged and embargoed at the max hold); `n_eff` per statistic = R·u/D_s, undefined below 10 blocks; gate cell needs ≥ `cell_min_blocks` blocks and ≥ 60 setups. | offline + app (shared stats code) |

### Score, map and gates (CTX-012 score/map, CTX-013, CTX-020…028, CTX-015…017, CTX-043/044)
| ID | Plain words | Mark |
|---|---|---|
| CTX-012 (score, map) | Eligibility: any undefined angle → ineligible ("warming up"); S = equal-weight mean of cluster means over a fixed K; p = Platt logistic on S standardised within family; slope pooled across {F1,F4}, {F2,F3,F5,F6}, F7 alone, own intercept per family (≥ 60 outcomes, pool n_eff ≥ 100); isotonic only at n_eff ≥ 1,000; refit on any change to the active set, weights, caps or thresholds. | offline (fit) + app (apply, refit guard) |
| CTX-013 | One ordered gate list (12 steps) with id and plain label per failure, then ranking and sizing; open-time checks are a second list. | app |
| CTX-014 | Next-open limit orders, a Decision Card per order, an abstain record per cash-holding book, shadow decisions for families not allowed. | app |
| CTX-020 | Candidate set = family universe passing L0, eligibility and ARN-011. | app |
| CTX-021 | Economic gate: lower one-sided 90 % block-bootstrap bound of mean net on the pre-registered pooled top-3 cell > 0, ≥ 60 setups, regime fail-closed (≥ 30 setups with mean ≥ 0); p_be and p are card diagnostics; live update at n_eff_live 150. | app (gate) + offline (cells) |
| CTX-022 | Rank by shrunk mean net ÷ median realised loss within volatility bucket; ties by L_real, disagreement, ADV. | app |
| CTX-022a | Cost per order = 2 × (fee + half-spread by tier + slippage per fill); `cost_gate_k` is a diagnostic; tier table with the ADV floor per parcel. | app |
| CTX-022b | Gap-risk cap: stop distance + setup gap95 ≤ `max_loss_pct`; stops from the fill; setups that would not have filled are excluded; entry gap cap at the open. | app + offline (same fill model) |
| CTX-023 | Disagreement d > 0.4 → abstain; every blocked set scored as would-have trades; gate demotion only when its blocked set's lower bound > 0 with power ≥ 0.8; shadow arm with limits off per allowed book. | app |
| CTX-024 | Exits are rules: thesis-breakers, family exits, liquidity exit, event-date exits, ex-date credits, TERP for entitlements with no rights value, stop ratchet (re-base only under CTX-015), no forced tightening in SHOCK. | app (mostly exists in arena) |
| CTX-025 | Sector tilt in shadow until a pre-registered sector IC test passes; GICS industry group from the ASX list, point-in-time from first snapshot. | app (shadow log) |
| CTX-026 | Portfolio limits across 12 books: 2 books per code, NAV share per code 20 %, per industry group 35 %; drift blocks new entries only. | app |
| CTX-027 | Deployable cash = settled cash net of the entry fee, T+2; A$500 parcel floor; stall predicate unchanged (ARN-071); stall rate published. | app + offline (stall rate) |
| CTX-028 | 09:55 re-check and at-open checks; limit = min(close × (1 + gap cap), stop ÷ (1 − stop cap)); fill at open if open ≤ limit, at limit if low ≤ limit, else unfilled in both arms; cancelled when the re-check cannot run. | app + offline (same formula) |
| CTX-015 | Corporate-action candidate/confirmed states from ASX notices with a ratio; two-basis stop rule while unconfirmed; disconfirmation test; freeze loss limit 25 %; re-base before the ratchet; ledger invariant. | app (forward data); replay limitation noted (Q5) |
| CTX-016 | Halt vs suspension classifier; halt marked at last trade ≤ 5 sessions, reopen-gap exit; suspension declining mark counted as a loss, outcome class feeds calibration. | app |
| CTX-017 | One regime table (ch. 07 §7.4); regime angles are gates only. | app (exists: regime.ts) |
| CTX-043 | Event polarity needs keyword and |AR0| ≥ max(2 %, 1.5 σ); verifiable categories only; U2/U3 entries only from parsed results/guidance on D+2 with EOD persistence. | app (forward data; fixtures AT-56) |
| CTX-044 | Promotion flag: move signature or notice-and-move count; 20 sessions; exchange query opens a review item only; zeroes positive event/volume contributions only. | app (forward data; fixtures AT-56) |

### Replay L0–L4 with controls, DSR and PBO (CTX-050 steps)
| Item | Plain words | Mark |
|---|---|---|
| Full replay | L0–L4 on the development split with the v1 cost model, matched controls (ARN-080), DSR > 0 at 90 % and PBO < 0.5 (M4 stats), parameter neighbourhood (ARN-108), time-stop comparator (ARN-106). | offline (WP5/WP6) using app code |
| Survivorship | Results with and without the pre-registered haircut; delisted-code count stated (none in the extract). | offline |
| Statements | Allowed-to-trade statements for F1 and F4 marked "live-tested pending (n_eff_live = 0)" with projected time to n_eff_live 100 and 150. | offline (text) + app (display) |

### Validation (VAL-112, VAL-113)
| ID | Plain words | Mark |
|---|---|---|
| VAL-112 | One confirmation access per angle per frozen split, alpha-spending per lineage (exists: `stats/errorBudget.ts`). | app (exists) + offline (single WP6 access) |
| VAL-113 | M15 computes and publishes the sample-size numbers at the real per-test level and effective N. | offline (report) |

### Report (CTX-050 last step, KB)
| Item | Plain words | Mark |
|---|---|---|
| Calibration report | Passports table, F1/F4 statements, operating-point simulations (calibrated / over-confident / null pass rates), stall rate per family, excluded-setup share, regime split per family, what was not computable and why (§17.12a rows). Lives in the KB; family-level only. | offline (WP7) + app (KB import, page link) |

### Cortex page (CTX-071, CTX-072, CTX-073)
| ID | Plain words | Mark |
|---|---|---|
| CTX-071 | Page sections: passports; ledger count and the luck figure; family status with numbers and MDEs; placebo result; NAV-at-risk report; abstentions by reason with the shadow-arm comparator and cash drag; sector tilt (shadow); cold-start status; opinion track; tick/cost table. | app |
| CTX-072 | Owner controls: kill switches, bounded parameter edits (each a charged trial that refits), force-apply under the CTX-060 guard, Owner items, golden-set labelling; no editing of reports or statements, no manual gate pass, no leaving shadow by hand. | app |
| CTX-073 | Melbourne time with DST offset; one glossary of the Cortex terms. | app |

### Card additions (CTX-070)
| ID | Plain words | Mark |
|---|---|---|
| CTX-070 | Fixed phrase table; gate ids, `n_eff`, "lower bound", "decile" banned on cards; opening sentence; "about 6 in 10 similar past setups" line with range and count; break-even at three cost levels; three reasons for and against in cluster words; "what would have stopped us"; regime; independent-sources line; abstain line. Masking (ROL-107) unchanged. | app |

### LLM organs (CTX-040…042, CTX-052, CTX-060)
| ID | Plain words | Mark |
|---|---|---|
| CTX-040 | Three enumerated text labels with a cited span, produced at ingest with `produced_at` and a manifest; shadow-only until the AR, paraphrase, golden-set (≥ 500 Owner-labelled) and incremental-information tests pass; unlabelled announcement = undefined feature. | staging (label production, shadow) |
| CTX-041 | Committee and steelman tracked for lift, hidden until `opinion_min_n`; never an L2 input. | deferred to M11-lite / M12 (the organs do not exist yet); M15 adds only the tracking hook |
| CTX-042 | LLM-proposed angles and challengers charged like any cell. | deferred to M11-lite / M13-lite (hypothesis generation is their scope) |
| CTX-052 | Warm-up in staging from the M8.1 deploy for every forward-only angle and both organs. | staging |
| CTX-060 | An opinion earns weight only after settled cases, lift, judge-stability and an Owner decision; refit guard on any weight/threshold/active-set change; force-apply cool-off 20 sessions, one per month. | app (refit guard) · deferred (opinion weight, needs M12) |

### Go-live gate and status (CTX-053…055, CTX-082)
| ID | Plain words | Mark |
|---|---|---|
| CTX-053 | Allowed to trade: own n_eff ≥ 200, Brier-skill lower bound > 0, CTX-021 passes with regime stability, slope shown with the over-confidence monitor (p hidden when the slope's upper bound is below the threshold); V2 goes live when F1 and F4 are allowed; statements marked "live-tested pending". | app (evaluation, status) + offline (evidence) |
| CTX-054 | Shadow mode: L0–L4 nightly, decisions and would-have outcomes written, no orders. | app |
| CTX-055 | Cold start sessions 1–20: F1 and F4 only, no refit except data-quality vetoes, "warming up" for undefined angles, abstain alarm > 95 % after session 20, population-stability check, nightly parity test. | app |
| CTX-082 | Live-tested statement per family from live outcomes at n_eff_live ≥ 150 (Brier, slope CI covers 1, intercept CI covers 0, net excess lower bound > 0, ECE with CI). | app (generator); publishable only later (deferred by data) |

Also pulled in by the M15 row: the §17.12a residual-risk measurements (operating-point simulation, stall rate, excluded-setup share, regime split, two-basis conflict count) and the AT-56 fixture list of ch. 17 (see "Acceptance").

## Acceptance tests (AT-50…AT-55; AT-56 fixtures)

| ID | Clause | Evidence that proves it |
|---|---|---|
| **AT-50** | Identical orders on two runs of a recorded night | Replay CLI run twice on the same snapshot: byte-identical `cortex_decision`, orders and cards (hash in the test report). |
| | Disabling every LLM organ changes no order | Same night with `committee_enabled`, steelman and text labels off vs on with recorded responses: identical orders (extends AT-32). |
| | Every text label has `produced_at`, a manifest and a validation record | Schema NOT NULL constraints plus a query over staging rows in the exit evidence. |
| | As-of truncation equality (TST-109) for every feature | Test that recomputes each active angle with history cut at each cut-off and compares to the stored row, on a synthetic ZZ world; the same helper run offline on the extract (WP1). |
| **AT-51** | Brier-skill lower bound > 0 and the over-confidence test for every allowed family | Per-family statistic rows with the bootstrap bound and the slope UB; the status table on the Cortex page. |
| | ECE reported with CI, not gated | ECE present in the statement rows; no gate reads it (static check). |
| | Placebo run allows ≤ 5 % of families | WP6 placebo output: mean allowed per run vs 0.35 + 1.35 SE; a unit test on a synthetic pipeline. |
| | Random-angle null above the 95th percentile | WP6 output for the live score; unit test with planted and null scores. |
| | MDEs published | MDE rows at n_eff 100/150/300 on the page and in the report. |
| **AT-52** | p_be fixture (G 10, L 6, C 2.5 → 53.1 %) as a diagnostic | Unit test of the break-even function and the card line. |
| | The 40/60 setup fails the gate | Fixture cell whose lower bound < 0 → gate 4 fails with its label. |
| | ATR 4 %/6 % pair with equal p ranks the lower-ATR name | Ranking unit test. |
| | Cost per order by tier (a A$0.20 U2 stock round trip in the stated band) | Cost table test from the tick table and tier half-spreads; the measured figure stated (see Q3). |
| | +9 % open against an 8 % cap cancels at the open | Fill-model test: limit = close × 1.08, open 1.09 × close, low above the limit → unfilled in both arms. |
| | No stop lowered except a confirmed re-base | Ratchet invariant test, including a confirmed 2-for-1 re-base. |
| **AT-53** | Passport fields: orientation, cluster type, history fields, measured value with CI at own horizon, regime split | Passport table columns NOT NULL where the spec requires; WP4 output validated by the same schema. |
| | Residualised (sector, beta, size) distinctness | Distinctness report rows per family active set; unit test on synthetic correlated features. |
| | Every cell logged before its result | Ledger cell row has `logged_at` < `result_at` enforced by a CHECK; offline writer does the same (WP4). |
| | Multiplicity rule applied | BH q = 0.10 under PRDS per CTX-031 (AT-53 says "BY"; see Q2). |
| **AT-54** | ≥ 10 review passes with the fixtures; last 3 clean | The 30 pass files in `docs/28_cortex/passes/` (done at spec time); M15 adds one statistician pass on WP4–WP6 (WP8). |
| | Allowed-to-trade statements for F1 and F4 marked "live-tested pending" | Statement rows with `n_eff_live = 0` and the label; shown on the page. |
| **AT-55** | Cards built from the phrase table with the ban list | Static test: every card string comes from the phrase table; a grep for banned words over rendered cards. |
| | Read-back by a non-technical reader | Five sample cards recorded in the exit evidence; the human read-back is listed in the V2 PR for the Owner (see Q18). |
| | Glossary complete | Glossary entries for every CTX-073 term; test compares the list. |
| **AT-56** | Fixtures (1)–(11): claimed-notice no entry, move-signature block, keyword-only polarity 0, US close unknown until D+1 09:00, disconfirmed split, unconfirmed split freeze and Owner alert, SHOCK day, two capped stop-outs → stall, halt vs suspension marks, cold-start "warming up", Monday sale / Tuesday buy refused, regime matrix | One synthetic ZZ world per fixture under `tests/fixtures/m15/`; each asserts the exact gate id and label. AT-56 is in the chapter's list but not in the ch. 14 gate; built anyway (Q12). |

## Configuration keys (ch. 15 V2 §15.9, CTX rows; ch. 17 §17.11)

| Key | Default | Bounds | Edit | Ref |
|---|---|---|---|---|
| cell_min_setups | 60 | 30–200 | O | CTX-021 |
| cell_min_blocks | min(20, 2 × history years) → 20 for the frozen split | 6–60 | O | CTX-012 |
| cortex_min_neff_trade | 200 | 150–400 | O | CTX-053 |
| rank_shrink_n0 | 60 | 20–200 | O | CTX-022 |
| cost_gate_k | 2.0 (exists, `keys.ts`) | 1.5–3.0 | O | CTX-022a (diagnostic), FAM-005 |
| max_loss_pct | 18 | 12–25 | O | CTX-022b |
| entry_gap_cap_pct | 8 | 4–12 | O | CTX-022b/028 |
| cortex_disagreement_max | 0.4 | 0.25–0.6 | O | CTX-023 |
| cluster_weight_max | 0.35 | 0.2–0.35 | O | CTX-012 |
| sector_tilt_margin_pp | 5 (shadow) | 0–15 | O | CTX-025 |
| max_books_same_code | 2 | 1–3 | O | CTX-026 |
| max_books_same_industry | 3 (reporting only) | 2–6 | O | CTX-026 |
| max_code_nav_share | 0.20 | 0.10–0.35 | O | CTX-026, O-61 |
| max_industry_nav_share | 0.35 | 0.2–0.5 | O | CTX-026 |
| freeze_max_loss_pct | 25 | 15–40 | O | CTX-015, O-63 |
| unresolved_freeze_sessions | 5 | 2–10 | O | CTX-015 |
| suspension_mark_policy | 100 % × 5, −10 pts / 5, floor 50 % | fixed | — (ch. 17) / O (ch. 15) | CTX-016 (see Q16) |
| persist_volume_mult | 2 | 1–5 | O | CTX-043 |
| pump_volume_mult | 4 | 3–6 | O | CTX-044 |
| pump_ar_pct | 8 | 5–12 | O | CTX-044 |
| promotion_flag_sessions | 20 | 10–40 | O | CTX-044 |
| abstain_alarm_sessions | 40 | 20–120 | O | CTX-023 |
| stale_universe_max_share | 0.10 | 0.02–0.25 | O | CTX-028 |
| opinion_min_n | 150 | 100–500 | O | CTX-060 |
| ledger_fdr_q | 0.10 (BH, PRDS) | 0.05–0.20 | O | CTX-031 |
| bootstrap_block_sessions | 120 | 60–250 | O | CTX-012 |

Every Owner edit of a CTX key is a charged trial and triggers a map refit (CTX-072). Keys the design adds (proposed, see Q1, Q6): `cortex_slope_hide_ub` 1.0 (0.5–1.0, O), `survivorship_haircut_pp` 1.5 (fixed; from the freeze record). Existing keys reused unchanged: `max_stop_distance_pct` (FAM-004), `val_error_budget_mode`, `val_fwer_per_lineage`, `rank_ic_bootstrap_blocks`, the LLM budget keys for label production.

## Data constraints

- **The history extract** `D:\Projects\Praxis\data\history\` (yahoo/, index/, asic/, rba/, fred/, meta/, and the WP outputs under m15/) is **never committed** anywhere; it is not even in the private data repo (RESUME, V2 workspace rule). SEC-110 (a): the public repo holds no market data, announcements, recorded provider responses, decision cards, ledgers, backups or personal data; a CI check blocks data-like files outside the synthetic-fixture allowlist.
- **What may appear in the public repo:** the Cortex code and migrations; the angle library; synthetic ZZ fixtures (as in M14, `tests/fixtures/m14/*`); test reports with fixture numbers only; config defaults; the phrase table and glossary; the design and exit-evidence docs with **family-level** statements and counts only. CTX-050 places passports and ledger rows in Turso (the database), not in the repo; the calibration report is a KB item (CTX-050 "calibration report (KB)"), not a repo file. Therefore no passport IC values, cell statistics, map parameters or per-code numbers are committed: they are loaded into the database from the private side (Q11). Real tickers never appear in code, tests or docs.
- **Derived aggregates in reports:** the spec allows family-level frequencies in statements (CTX-053, CTX-082) and the page figures (CTX-071); DAT-124 limits personal-use-source content shown to non-Owners to derived numbers and our own summaries; ROL-107 masking still applies to any code on a card.
- **Licences named by the spec:** Yahoo EOD is personal-use only, under Owner risk acceptance O-26 (pending in the register); the ASX listed-companies file under O-23b, with two alternative universe sources to be recorded (DAT-236); RBA tables are copyrighted — derived numbers only with the source named (DAT-236); ASIC short positions are public data; FRED series carry their own terms (register row to be added by M15, DAT-101). The offline extract was fetched once for private research (PLAN.md; `refresh.mjs` user agent); nothing from it is redistributed. No paid archive (O-64).
- **Secrets:** none are needed by M15; the offline tools make no network calls except the refresh script, and no LLM calls (PLAN.md rules).

## What exists and what is missing

**Exists (M4–M14), reused by M15:**
| Piece | Path | Reuse |
|---|---|---|
| Trial ledger (append-only), lineages, splits, purge | `db/migrations/main/0008_agents.sql`, `src/lib/stats/splits.ts` | CTX-031 activation trials, VAL-112 access rows; the Cortex ledger cells are a new table beside it |
| Error budget (alpha-spending per lineage) | `src/lib/stats/errorBudget.ts`, `src/lib/learning/alphaInvesting.ts` | CTX-031 activation level |
| Circular block bootstrap, studentised test, MIN_INDEPENDENT_BLOCKS | `src/lib/stats/bootstrap.ts` | base for the stationary block bootstrap with per-statistic n_eff (new) |
| DSR, PBO, MinBTL, power, MDE, gates | `src/lib/stats/dsr.ts`, `pbo.ts`, `minBtl.ts`, `power.ts`, `gates.ts` | replay evidence (CTX-050), VAL-113 numbers, MDEs |
| Survivorship and delisting sensitivity | `src/lib/stats/survivorship.ts` | haircut reporting with/without |
| Rank IC (VAL-114), live and replay parity pattern | `src/lib/stats/rankIc.ts`, `src/lib/learning/rankIcStage.ts` | model for "live and replay call the same pure function"; angle IC at own horizon is new |
| Signal-ledger replay, matched controls, null runs, exit ablation, sensitivity, zero edge | `src/lib/replay/ledger.ts`, `controlLibrary.ts`, `nullRuns.ts`, `exitAblation.ts`, `sensitivity.ts`, `zeroEdge.ts`, `runner.ts` | L0–L4 replay with controls; ARN-106/108 comparators; placebo and random-angle null build on `nullRuns` |
| Snapshot world (point-in-time bars, confirmed splits) | `src/lib/replay/snapshotWorld.ts`, `snapshot.ts` | replay source; needs index, ASIC, macro and feature rows added |
| Fill model, costs, slippage, pre-open re-check, ex-dividend, corporate-action writer, invariants | `src/lib/arena/fills.ts`, `costs.ts`, `slippage.ts`, `preopen.ts`, `exDividend.ts`, `corpActions.ts`, `invariants.ts` | CTX-022a/022b/024/028 (limit formula and trade-through fill are new) |
| Entry gates (FAM-004/005/006/009), cost gate table | `src/lib/agents/entryGates.ts`, `costGate.ts` | replaced in order by CTX-013 for Cortex-governed books; FAM-005 family-median form stays as fallback (D-214) |
| Regime A3, indicators, events, insider flow, short interest, patterns | `src/lib/agents/regime.ts`, `indicators.ts`, `events.ts`, `insiderFlow.ts`, `shortInterest.ts`, `patterns.ts` | inputs for angles D1, D3, D5, D6; CTX-017 table |
| Decision Cards (schema v1, no probability, no free text) | `src/lib/agents/cards.ts`, `src/lib/ui/loaders/cards.ts`, `cardParts.ts` | CTX-070 extends the schema (v2) and the phrase table |
| Known-at and first-ingested stamps, vendor actions, adjustment factors, index changes, instrument class (GICS) | migrations `0015`…`0018`, `src/lib/data/*` | CTX-010 known-time rules, CTX-015 confirmation, CTX-025 sector map, DAT-234 exclusion |
| Config keys registry and verify | `src/lib/config/keys.ts` (only `cost_gate_k` of the CTX rows exists), `verify.ts` | add the CTX keys |
| Batch 2b/3 orchestration, night runs | `src/lib/agents/candidates.ts`, `batch2b.ts`, `batch3.ts`, `forwardLedger.ts` | the Cortex stage slots in before entry selection |
| Strategies "Robustness" loader (M14) | `src/lib/ui/loaders/robustness.ts`, `strategies.ts` | pattern for the Cortex page loader |
| Offline extract and coverage tools | `Requirement/v2/tools/m15/{pull_history,pull_asic,refresh,coverage,coverage_asic}.mjs` | WP1 reads their output; `lib/` does not exist yet |

**Missing (to build):**
- `src/lib/cortex/` (new): angle library (one module per domain, passport metadata as code), rank standardisation, clusters and score, eligibility, Platt map apply, gate list, ranking, limit-order formula, disagreement, shadow arm, abstain records, cold-start state, NAV caps, settled-cash gate, corporate-action state machine (two-basis), halt/suspension classifier, promotion flag, event polarity rules, input manifest, quota-degrade rule.
- `src/lib/stats/` additions: stationary block bootstrap with per-statistic n_eff, Platt fit, Brier skill, calibration slope/intercept with CI, ECE with CI, BH under PRDS, split-half sign test, distinctness (residualisation, VIF, partial IC), placebo and random-angle null drivers, matched-setup cells and the economic-gate bound.
- Migration `0019_cortex`: `angle_passport`, `cortex_feature_daily` (one row per code per night), `cortex_ledger_cell` (logged_at < result_at), `cortex_map` (per family rule version), `cortex_decision`, `cortex_abstain`, `family_status`, `corp_action_state`, `halt_state`, `promotion_flag`, `input_manifest`, `text_label` (staging), `cortex_statement`.
- Cortex page route under `src/app/(app)/` with its loader; Decision Card schema v2 fields and phrase table; glossary entries; Configuration page rows for the CTX keys with the charged-trial refit hook.
- Replay: snapshot additions (index, ASIC, macro, calendar), the Cortex replay driver that runs L0–L4 over `snapshotWorld`, TST-109 truncation test for angles, AT-50 determinism test.
- Text-label production in the ingest path (staging), with `produced_at`, manifest and the validation-record table.
- Import path for the offline artefacts (passports, cells, map, statements, report) into Turso, Owner-run like the DAT-125 backfill.
- Tests: `tests/acceptance/v2/at5x.test.ts`, fixtures `tests/fixtures/m15/`, test reports `docs/test-reports/AT-50…AT-56.md`.
- Offline: `tools/m15/lib/` (WP1–WP6), `_m15_calibration_report.md` (WP7), pass file (WP8).

## Open questions and recommended defaults (no Owner prompt; each becomes a decision from D-257)

| # | Ambiguity | Recommended default (spec basis) | Suggested wording |
|---|---|---|---|
| Q1 | Slope over-confidence threshold: CTX-053 hides p when the slope's 90 % upper bound is < 1.0; §17.12a and ch. 19 AT-64 say 0.7. | Chapter body governs: 1.0. Expose it as `cortex_slope_hide_ub` (default 1.0, bounds 0.5–1.0) so AT-64 and the page read one value; record the 0.7 mentions as superseded. | D-257: p is hidden when the slope UB < `cortex_slope_hide_ub` (1.0); §17.12a and AT-64 follow the key. |
| Q2 | Multiplicity: CTX-031 says BH at q = 0.10 under PRDS (pass 18 rejected BY); AT-53 says "BY applied". | BH under PRDS (CTX-031 is v7 body; AT-53 text predates pass 18). | D-258: "measured" is granted under BH q = `ledger_fdr_q` with the PRDS assumption stated; AT-53's "BY" reads as BH. |
| Q3 | Round-trip cost of a A$0.20 U2 stock: CTX-022a "about 7 %", AT-52 "≈ 4.5–5 %". | The formula is the requirement; the test asserts the formula with the tick and tier tables and records the resulting figure. | D-259: AT-52 checks the CTX-022a formula; the band in AT-52 is informational. |
| Q4 | FAM-005 (binding, family-median) vs CTX-022a (diagnostic) for the same key. | FAM-005 stays binding on the v1 path for a family in shadow (D-214 fallback); once a family is allowed, CTX-021 binds and `cost_gate_k` is a card diagnostic. | D-260: cost-gate binding depends on family status. |
| Q5 | CTX-015 corporate-action states need ASX notices; the extract has vendor splits only, and vendor-only ratios are not candidates. | Replay applies confirmed vendor splits as price adjustment (CTX-050 method) and lists CTX-015/016 as "not yet replayable" in the statement with their live trigger counts (CTX-010 provision). | D-261: corporate-action and halt states are forward-measured; the replay states the gap. |
| Q6 | `survivorship_haircut_pp` 1.5 pp per holding year is [PROPOSED, VERIFY] in the freeze record and absent from ch. 15. | Keep as pre-registered (changing it after measurement starts a lineage); a fixed key, results shown with and without. | D-262: haircut 1.5 pp/holding-year, fixed, with/without shown. |
| Q7 | Yahoo D-bar known time = close + p95 latency "measured on 10 nights [VERIFY]". | Measure from `first_ingested_at` (0017) on staging nights; until 10 nights exist, replay assumes the D bar known at the 18:10 cut-off when it exists in the snapshot (v1 behaviour) and the assumption is stated. | D-263: latency p95 measured in staging; interim replay rule stated. |
| Q8 | IC horizon: PLAN WP4 says "from the D+1 open"; VAL-114 uses D+1 close → D+2 close; CTX-030 wants own horizon and 5/20/60. | Passports: forward return from the D+1 open at horizons {own, 5, 20, 60} (CTX-030). VAL-114 rank IC unchanged. | D-264: angle IC measured from the D+1 open at four horizons; VAL-114 separate. |
| Q9 | Where the Cortex runs nightly. | A stage in batch 2b before entry selection (same GitHub Actions job, public repo, O-62), writing feature rows and decisions, then the existing sizing and order path; batch 3 scores would-have outcomes. | D-265: Cortex = batch 2b stage; no new workflow. |
| Q10 | Live books for families in shadow after the M15 deploy. | They abstain (CTX-053/054): decisions and would-have outcomes are written, no orders; the card shows the abstain line "family not yet allowed". | D-266: shadow families hold cash. |
| Q11 | Where the offline artefacts live and how they reach the app. | Private data repo under `Requirement/v2/docs/28_cortex/m15/` (family-level) plus `data/history/m15/` (per-code, never committed); an Owner-run import script loads passports, cells, map and statements into Turso; the public repo gets only the loader and schema. | D-267: calibration artefacts are private; import script, no numbers in the repo. |
| Q12 | AT-56 is in ch. 17 but not in the ch. 14 gate list. | Build the eleven fixtures; they are the cheapest proof of CTX-015/016/017/043/044/055/027. | D-268: AT-56 built and reported; gate unchanged. |
| Q13 | Text-label production cost (CTX-040) under the LLM budget. | Produce the three labels inside the existing A2 triage call for price-sensitive items only, within `llm_daily_budget_total`; shadow-only; no golden set until the Owner labels (listed in the PR). | D-269: labels ride the triage call; shadow; golden set is an Owner task after merge. |
| Q14 | CTX-041/042 need the Committee, steelman and hypothesis generation (M11/M12/M13). | Build the tracking table and the "never an L2 input" static check now; the organs arrive with their milestones. | D-270: CTX-041/042 hooks only in M15. |
| Q15 | Sector map is point-in-time from the first snapshot; history has today's list only. | Offline: today's GICS map is used for residualisation (CTX-033) and labelled "current map"; sector angles stay `candidate`; live map point-in-time from `instrument_class`. | D-271: sector angles candidate in replay. |
| Q16 | `suspension_mark_policy` is fixed in ch. 17 and Owner-editable in ch. 15. | Fixed (ch. 17 governs Cortex keys). | D-272: suspension mark policy fixed. |
| Q17 | GST on brokerage [VERIFY] in CTX-022a. | None, as `costs.ts` and v1 state; the card says so. | D-273: no GST added until a source is verified. |
| Q18 | AT-55 read-back needs a human. | The build records five sample cards and the phrase-table check; the Owner read-back is an item in the V2 PR description. | D-274: read-back at merge time. |
| Q19 | Opening-auction stagger and indicative pre-open price [VERIFY]; no intraday data at $0. | The 09:55 re-check (existing `preopen.ts`) plus the limit formula at the fill; no indicative-price check. | D-275: open-time checks = 09:55 re-check + limit fill. |
| Q20 | `cell_min_blocks` depends on history years. | 20 for the frozen development split (22 years → min(20, 44)); stored as a number with the formula in the key's note. | D-276: cell_min_blocks = 20. |
| Q21 | Luck figure on the page (≈ 52 % allowed, ≈ 30 % live-tested). | Computed from the family count and levels (1 − (1 − α)^k), never typed in. | D-277: luck figures computed. |

## Work packages

Offline side follows PLAN.md WP1–WP8 as written. App side (A1–A9) is ordered so that the shared code exists before the offline run needs it; items marked **shared** must be one implementation imported by both sides (the offline tools import the app's TypeScript via `tsx`, as `tools/m15/lib/*.mjs` wrappers, instead of a second implementation), so live and calibration compute angles identically (the AT-50 parity test depends on it).

| App WP | Content | Shares code with |
|---|---|---|
| A1 Data and point-in-time | Adjustment factors (CTX-050 method, exists in DAT-233), as-of truncation helper, known-time rules per source, input manifest, null-close rejection, universe tiers and liquidity tier, session calendar, sector map read. | **shared** with WP1 |
| A2 Angle library | 100 angle definitions as code with passport metadata (id, orientation, cluster, inputs, grid, status); price/volume/index/macro/calendar/ASIC angles computable; announcement and `needs_data` angles return `undefined` (candidate); nightly rank standardisation. | **shared** with WP2, WP3 |
| A3 Statistics | Stationary block bootstrap with per-statistic n_eff, Platt, Brier skill, slope/intercept/ECE with CI, BH-PRDS, split-half sign test, distinctness, matched-setup cells, economic-gate bound, placebo and random-angle drivers. | **shared** with WP4, WP6 |
| A4 Simulator parity | Limit-order fill (CTX-028), stop from fill, cost per order by tier, gap cap, settled cash T+2, stall, regime table, time-stop comparator and neighbourhood hooks, in `arena`/`replay`. | **shared** with WP5 |
| A5 Schema and nightly Cortex | Migration 0019; L0–L4 stage in batch 2b; gate list; ranking; shadow arm; abstain records; cold start; NAV caps; corporate-action, halt and promotion states; quota-degrade rule; batch 3 would-have scoring. | consumes A1–A4 |
| A6 Replay driver and tests | Cortex replay over `snapshotWorld` with index/ASIC/macro; TST-109 angle truncation; AT-50 determinism; AT-56 fixtures; synthetic ZZ worlds under `tests/fixtures/m15/`. | uses A1–A5; mirrors WP5 outputs on fixtures |
| A7 Page, cards, config | CTX-071 page and loader; CTX-070 card schema v2 and phrase table; glossary; CTX keys in `keys.ts` with the charged-trial refit hook; luck and MDE figures. | reads A5 tables |
| A8 LLM organs (staging) | Text-label production with `produced_at` and manifest; validation-record table; CTX-041 tracking hook; static check that no L2 code reads opinion tables. | — |
| A9 Import, statements, evidence | Owner-run import of WP4–WP7 artefacts; CTX-053 evaluation and `family_status`; statement generator (CTX-053 "live-tested pending", CTX-082 template); KB report item; test reports AT-50…AT-56; exit evidence; decision log D-257…. | consumes WP7 |

Order: A1 → A2 ∥ A3 → A4 → (offline WP1–WP6 can start once A1–A4 are on `build`) → A5 → A6 → A7 ∥ A8 → WP7/WP8 → A9. Each app WP: Sonnet builds, Haiku checks against the chapter section cited, Opus reviews the shared modules before the offline run reads them (measurement only after the freeze record is read, PLAN.md rules).

## Parent requirements

- V2 ch. 17 (CTX-001…082, §17.11 keys, §17.12a residuals, AT-50…56); ch. 12 V2 M15 row; ch. 14 V2; ch. 15 V2 §15.9.
- V2 ch. 10 (FAM-004…009, ARN-106…109, VAL-112…116, DAT-231…237); ch. 19 UXN-308/309 and AT-64 (consume the Cortex p; built in M17).
- v1 ch. 05 (ARN-010/011, ARN-020/021, ARN-032, ARN-071, ARN-080…086, ARN-102), ch. 06 (DAT-001, DAT-124, DAT-170), ch. 07 (AGT-003, AGT-011a, AGT-020, AGT-030, AGT-101, AGT-105, AGT-110, AGT-111, §7.4 families), ch. 10 (SEC-110, TST-109, TST-114).

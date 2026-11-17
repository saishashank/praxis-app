# M23 requirements: Cortex research and monitors (time-boxed)

Requirements extract for milestone M23 of the V3 build. Source: the V3 spec (read-only, `Requirement/v3/spec/`): ch. 12 (the M23 row, BLD-048…BLD-055, chiefly BLD-049 and BLD-051), ch. 22 (CXA-003…CXA-015, §22.3, AT-72…AT-75), ch. 14 (index rows AT-72, AT-74, AT-75 and the closing criterion), ch. 15 (§15.11.2 `llm_proposals_per_month`, §15.11.4), ch. 21 (VAL-120), ch. 23 (LLM-077 for CXA-007 and CXA-008), ch. 24 (UXN-318 as built in M21), ch. 26 (TST-137, TST-139), ch. 01 (PRD-033, PRD-042, PRD-045, PRD-046) and ch. 00 (D-930, D-934, D-942, D-949).

**SEC-110 rule for this file:** every line is an id with a paraphrase in the build team's own words; no spec sentence is copied. Code facts are cited as file:line in the tree at `bc247714` (branch `v3/m23-req`, M18…M22 done), read on 2026-11-17. Build decisions for M23 are numbered from **D-1600** in `docs/M23_design.md`.

## Scope

M23 is the last V3 milestone. It turns the Cortex's open research questions into pre-registered, one-look measurements with honest exits, builds the holdout registry as the single gate on every look, and turns the eight residual-risk rows of the Cortex into stored monitors with alarms. The estimate is **10 build-agent days, a hard time-box** (ch. 12): when it ends, every research item still open is reported INCONCLUSIVE and the V3 PR is opened (BLD-049). The exit is **AT-72**, **AT-74**, the series clause of **AT-75**, the angle-proposal half of **AT-73**, and one published report per research item with a verdict of PASS, NULL or INCONCLUSIVE; AT-32/AT-50, AT-67, AT-68 and AT-85 stay green on every CI run.

Five kinds of work:

1. **The registry**: one shared look gate (pre-registration hash first, one look, a second look refused and audited) used by every writer, old and new, and shown on the Cortex page (CXA-015).
2. **Monitors and meters**: the eight residual-risk monitors (CXA-010); forward n-progress meters with an automatic one-look evaluation when n is met (CXA-005, CXA-014, VAL-120).
3. **Research on history**: new edge sources (CXA-003) and the sector IC test (CXA-009), each pre-registered and looked at once on the build machine's history extract.
4. **Research on forward data**: the announcement-angle calibration trigger (CXA-004), the text-label paraphrase harness and warm-up measurement (CXA-008), LLM proposals in shadow (CXA-007), the SHOCK stop comparator (CXA-011).
5. **Records**: the survivorship haircut pre-registration and matched controls (CXA-012); F2 fundamentals per market and the AU source check (CXA-013).

## Hard constraints that apply to every M23 item

- **Research honesty (BLD-051, PRD-042, D-934, CXA-015).** Hypothesis, grid point, split and n are fixed and hashed before any computation; the hash is in the registry before the look; one look per lineage and market; the report is published whatever the result; nothing is re-tuned after a look; no item is extended past the time-box to reach a pass.
- **PRD-033 / AGT-011a / D-930.** No monitor, meter, proposal or research result creates, sizes, changes or cancels an order, a thesis-breaker or a rule, and none changes a weight, threshold, family status or the active set. A PASS only opens the existing CTX-053 path, shadow first.
- **AU byte-identical (A-20).** The three identity files (`tests/acceptance/v3/replay-hash.baseline.json`, `tests/market/au-constants.snapshot.json`, `worker/test/fixtures/au-slots.snapshot.json`) are never rewritten; every new nightly table is proven outside the replay hash by an AT-32 style complement proof (pattern `tests/acceptance/v3/at32Opinions.test.ts:38-58`).
- **IN and US off in production (AT-68).** Every new market-keyed table carries the guard triggers (`scripts/db/gen-market-guard.mjs:61-70` pattern); `markets_enabled` stays `["AU"]`.
- **PRD-045.** $0; Turso inside 20 % of the free plan; keyset reads with `rows-ok:` comments; no `OFFSET` (`tests/security/noOffsetPaging.test.ts`).
- **LLM spend inside the unchanged daily total.** `llm_daily_budget_total` stays 240,000; every model call goes through `createRouter` (`src/lib/llm/router.ts:174`) and the night seam (`src/lib/llm/nightlyLlm.ts:45`); production is rules-only while `llm_live_roles` is empty (LLM-077), so CXA-007 and the model half of CXA-008 do nothing live in production at the merge.
- **Private history stays private (SEC-110, MKT-112).** The history extract is read on the build machine by argument; only counts, statistics and hashes enter the repo.
- **No internal codes in Owner-read text (D-922).** No CXA id, lineage key or role code reaches a page or e-mail.
- **One PR (PRD-048, BLD-048).** M23 opens no PR of its own; when it ends the single "V3 build complete:" PR is opened.

---

## A. Build rules (ch. 12 V3)

- **BLD-049** M23 starts after M22 exits; its time-box is absolute; at its end every open research item becomes an INCONCLUSIVE report and the PR is opened. At most 3 Sonnet builders at once (orchestrator rule), never two on one file.
- **BLD-051** pre-registration with a hash in the `holdout_look` registry, one look, the report whatever the result.
- **BLD-053** BUILD_SETUP §9 "V3" rows after every task; "V3 PR opened" once the PR exists.
- **BLD-054** decisions D-1600 upward in `docs/M23_design.md`; `docs/V2_decisions.md` regenerated by `scripts/ci/decision-index.mjs`.
- **BLD-055** this extract → design → tests first → Haiku review → Opus acceptance of the **F** items → `docs/M23_exit_evidence.md`.

## B. The registry

### B.1 CXA-015 Holdout registry and refusal of a second look **F**
- **Asks.** One look per lineage (per market, MKT-112), recorded with lineage, date, pre-registration hash and verdict; a second look refused by code and audited (AT-72); the registry shown on the Cortex page; the F1.v2-mom SHADOW verdict and its gap definition stay as recorded (O-79). Key `holdout_looks_max` = 1, fixed (§15.11.4).
- **Current state.** Table `holdout_look` (`db/migrations/main/0039_m20_markets_data.sql:163-178`): PK (lineage, market), append-only, guarded; `verdict` is free text 1–32 with no vocabulary CHECK; no pre-registration column beyond the hash. Three writers, each with its own probe and `INSERT … ON CONFLICT DO NOTHING`: `src/lib/shortShadow/evaluate.ts:39-46,78-83` (lineage `short_shadow`, verdict `pass|fail`), `src/lib/regime/alt/evaluate.ts:43-50,114-119` (`regime_altinputs`, `pass|fail`), `src/lib/committee/trial.ts:416-428` (`committee_trial`, `PASS|FAIL|INCONCLUSIVE`; INVALID writes no look, `:412`). A refused second look returns a status and writes nothing (`shortShadow/evaluate.ts:52,83`); no audit row anywhere. No page reads the table. `holdout_looks_max` is not a key. An older, separate access ledger exists: `trial_ledger` (`db/migrations/main/0008_agents.sql:466-487`, kinds `validation_access|holdout_access|pattern_test|challenger|new_lineage`), used by `src/lib/stats/splits.ts:403-555`. The intraday stream (VAL-118) records its look as a Cortex ledger cell (`src/lib/intraday/evaluator.ts:90-100`), not in `holdout_look`.
- **Gaps.** No shared gate; no audit of a refusal; two verdict vocabularies; the pre-registration text is not stored with the hash (only compiled into code, e.g. `shortShadow/evaluate.ts:15-24`); offline research (the M15 F1.v2-mom look, `docs/M15_design.md:417-423`) has no path into the in-app registry; no Cortex page section.
- **Acceptance.** AT-72 (second look refused and audited; every look listed with its hash).

## C. Monitors and meters

### C.1 CXA-010 Eight residual-risk monitors
- **Asks.** Each of the eight §17.12a rows becomes a stored measurement with an alarm on the Cortex page: (1) promotion-flag hit rate and the U2/U3 event-entry net outcome against U1 by quarter, with a demotion signal when the live lower bound is below 0; (2) the permission operating point (pass rates by simulation, once per market at calibration); (3) the slope monitor (p hidden when the slope's upper bound is below 0.7); (4) two-basis conflicts per quarter; (5) the regime split per family with a "one regime only" label; (6) the lens-disagreement record (chosen option and reason, revisited after the first live-tested statement); (7) expected and realised stall rate per family, an Owner item when realised exceeds expected by `residual_monitor_alarm_pp` (5, fixed); (8) the share of setups the fill model excludes, per family. AT-74.
- **Current state.** No monitor, table or key (`residual_monitor_alarm_pp` absent from `src/lib/config/keys.ts`). Inputs exist: (1) `promotionStateAt`/`stepPromotion` (`src/lib/cortex/states/promotion.ts:211,225`, U2/U3 only `:287`), tiers `src/lib/data/universe/tiers.mjs:61`, state rows in `cortex_state` kind `promotion` (`0019_cortex.sql:250-257`); (2) `decideFamily`/`cellGate` and `GATE_DEFAULTS` (`src/lib/cortex/statusRules.mjs:15,37,74`); (3) `slopeHiddenFromUb` with `DEFAULT_HIDE_UB = 1.0` (`statusRules.mjs:14,66`), slope evidence in `family_status.evidence_json` (`statusRules.mjs:109-110`); (4) `twoBasisStop` (`src/lib/cortex/states/corpAction.ts:877`, `stopBasis "two_basis"` `:586,:682`); (5) `regimeStable` (`statusRules.mjs:55`), regime from the G09 trace (`src/lib/cortex/look.ts:85-88`), no "one regime only" label; (6) `disagreement`/`disagreementTest` (`src/lib/cortex/score/disagreement.ts:23,45`), G10 failures only in `cortex_decision.gate_trace_json` and `cortex_abstain` (`0019_cortex.sql:99-100,207-213`); (7) `stallCheck` (`src/lib/cortex/gates/settledCash.ts:126`, `STALL_SESSIONS` `:23`), arena predicate `src/lib/arena/terminal.ts:9-15`; (8) `fillRowRule` (`src/lib/cortex/economics/fillRow.ts:12`) maps fills only. Owner-item pattern: `app_log` warn "owner item: …" (`src/lib/cortex/stage.ts:1020-1032`).
- **Gaps.** Every measurement, its storage, alarm thresholds, and the page section.
- **[VERIFY].** Where an "expected" stall rate is recorded at calibration (monitor 7); which outcome status marks a fill-model exclusion (monitor 8). Checked at task start.

### C.2 CXA-005 Live-tested progress
- **Asks.** Rule unchanged (`n_eff_live ≥ 150`); the Cortex page shows each family's live n_eff progress and the projected date at the current trade rate.
- **Current state.** `lookAtFamily` records `n_eff_live` and `nEffLivePerSession` in the quarterly look (`src/lib/cortex/look.ts:136,247-259`); `LIVE_TESTED_MIN_NEFF = 150`, `DEFAULT_MIN_NEFF_TRADE = 200`, `projectSessions` (`statusRules.mjs:12,25,149`); `projectionSentence` projects only from zero (`:158-167`). The page's family table shows the development `n_eff` (`src/lib/ui/loaders/cortex.ts:305`), not the live one.
- **Gaps.** A per-family live progress figure against 150 and the trade floor, and a dated projection.

### C.3 CXA-014 Movers A1–A5, A8 meters and automatic one-look evaluation
- **Asks.** Unchanged shadow rule; an n-progress meter per mover rule; the one-look evaluation runs by itself on the night n is reached and is published; PASS opens the CTX-053 path, NULL keeps shadow.
- **Current state.** Movers built in M15 (D-740…D-755): parameters `src/lib/cortex/moversParams.ts:6-22`, gates `src/lib/cortex/gates/movers.ts:1-8`, store `src/lib/cortex/store/movers.ts` (A1 halt watch `:68-230`, A2 known dates `:253`, A1/A3 arming `:326-443`, A3 creep flags `:487-512`, A8 composite `:546-616`), A5 young-listing grid in `src/lib/cortex/angles/d1.ts:170,539,555`; tables in `db/migrations/main/0024_movers.sql` (`halt_watch` :38, `intraday_arm` :68, `sector_composite_daily` :90, `angle_forward_flag` :112). The M15 decisions fix the rules but **no forward n and no hypothesis per rule** (`docs/M15_design.md:390-405`). Nothing reads `angle_forward_flag` outside the store.
- **Gaps.** A pre-registered hypothesis and n per rule (none in the spec or M15: [PROPOSED] in the design), the meters, the evaluator.

### C.4 VAL-120 Intraday stream meter and evaluation
- **Asks.** Stream stays shadow until VAL-118 passes; an n-progress meter and the automatic evaluation on the night n is met, published on the Cortex page.
- **Current state.** Pre-registered hypothesis and cell (`src/lib/intraday/evaluator.ts:29,38`), sample floors 60 candidates and 60 sessions (`:23-24`); the evaluation already runs nightly from the evening review (`src/lib/review/routeHandler.ts:144-148`); one look per ledger cell, and a new charged cell per quarter after a failed look (`evaluator.ts:90-100`, D-670); state written only by `src/lib/config/streamState.ts:11`; the monthly alerts report shows the state (`src/lib/ui/loaders/alertsReport.ts:76`).
- **Gaps.** No meter on the Cortex page; the look is not in `holdout_look`; the quarterly fresh cell needs a registry treatment (design).

## D. Research on history (build machine, one look each)

### D.1 CXA-003 New edge sources **F** (statistics)
- **Asks.** At M23 start a fixed list of candidate lineages, one grid point each, development split only: earnings-announcement drift with parsed statements, index-inclusion anticipation, insider-cluster buying (≥ 2 director buys in 20 sessions), short-interest change, 52-week-high breakout with volume, low volatility; plus a cost/parcel sensitivity variant per lineage at a simulated A$5,000 parcel, labelled as a larger account and never live. Each lineage gets one holdout look: PASS (lower bound above 0 → CTX-053 path, shadow first) or NULL; the report lists every look; no re-tuning. AT-72.
- **Current state.** The M15 work found no usable edge after costs at the A$600 book; F1.v2-mom is shadow (`docs/M15_design.md:417-423`, O-79). No in-repo entry point evaluates a lineage on history; the M15 tools were private and imported app code. Reusable pieces: `src/lib/replay/controlLibrary.ts` (matched controls by tier and volatility decile), `src/lib/replay/sensitivity.ts`, `src/lib/arena/costs.ts` (`COST_PROFILE_CODES` `:32`, `feeFor` `:372`), `src/lib/stats/stationaryBootstrap.ts:345` (`bootstrapMean`), `src/lib/stats/multiplicity.ts:36`, `src/lib/cortex/survivorship.ts:51-76`, and the offline-by-argument pattern of `scripts/fixtures/recordFromHistory.mjs:1-10`. The history extract holds daily bars for the listed codes, the index series and ASIC short-position files; it holds no announcement history, no historical index-change list and no director-notice history. Angles touching each candidate: 52-week high A-D1-02/A-D1-03, volume at breakout A-D2-06 (`d1.ts:550,567`, `d2.ts:304`); low volatility A-D4-08 (`d4.ts:202`); short interest A-D6-01 (`d6.ts:87`, table `short_interest` `0008_agents.sql:61`); insider A-D3-09 (`d3.ts:252`, `insider_notice` `0008:83`); index change A-D6-02 (`d6.ts:120`, `index_change` from a manual CSV `0018_m14.sql:36-56`); earnings drift A-D3-05 (`d3.ts:176`), with no statement parser for AU. The FAM-005 notional is A$600 (`src/lib/agents/costGate.ts:57`); no A$5,000 simulation exists.
- **Data that cannot exist yet.** Earnings drift with parsed statements, index-inclusion anticipation and insider clusters have no history in the extract and the archive is forward-only (CTX-051): these three must exit **INCONCLUSIVE** with their pre-registration frozen and no look spent.
- **Gaps.** The pre-registered list, the evaluation engine, the offline runner, the registry path for offline looks, the never-live guard on sensitivity variants, the reports.

### D.2 CXA-009 Sector index series and IC test **F** (statistics)
- **Asks.** Per market, a nightly stored `sector_index` series (equal-weight and value-weight, U1 codes, by the classification group), point-in-time from the first snapshot and backfilled from the extract; a pre-registered monthly sector-IC test (an effect near 0.06 needs about 95 blocks) runs once the blocks exist, one look; the tilt stays shadow until it passes. Key `sector_index_weighting` equal (fixed). AT-75 series clause (hand-computed series values).
- **Current state.** No `sector_index`. Closest: `sector_composite_daily` (`0024_movers.sql:88-107`, equal-weight daily return per industry over the liquid set from the current map, writer `src/lib/cortex/store/movers.ts:553-598`). Industry per date: `instrument_class` (`0018_m14.sql:60-76`, append-only); scheme key fixed per market (`keys.ts:1622-1630`, `src/lib/market/fields.mjs:159-162`). No shares-on-issue or capitalisation data anywhere (A-D2-08 lists it missing, `d2.ts:4`). F7 "sector tilt" is shadow exposure only (`src/lib/cortex/night.ts:1077-1090`); D-462 measures excess against the market index because no sector series exists (`docs/M17_design.md:173`). Rank IC helpers: `src/lib/stats/rankIc.ts:31,67,107`.
- **Gaps.** Table, nightly writer, the weighting rule, the backfill, the test and its pre-registration.
- **Data limits.** Value weights need shares on issue, which no free source in the register provides; the backfilled history carries the current classification (static industry, CXA-012 D-285) and survivors only.

## E. Research on forward data

### E.1 CXA-004 Announcement-angle calibration trigger at 252 sessions
- **Asks.** When a market's archive holds ≥ 252 sessions of timed items, the nightly job runs the one pre-registered calibration of the 24 announcement angles and the three text labels (development = first 70 % of the archive; one holdout look) and publishes the report; until then the Cortex page shows "n of 252 sessions collected". No earlier look; no paid archive (O-64).
- **Current state.** `announcement_archive` (`0024_movers.sql:9-34`) written by `archiveStatements` (`src/lib/sentinel/archive.ts:70-104`, timing class `:40-57`); readers only `src/lib/cortex/store/movers.ts:255-298`. No session counter; no calibration code. The code has no list of "the 24": 22 registry angles carry the archive data marker (D3 ×10 `d3.ts:85-300`, A-D4-04, A-D5-10, A-D6-02/-06/-07/-08, A-D8-04/-06, A-D9-02/-03, A-D10-05/-06) and 28 list announcements among their inputs. Labels: `LABEL_ENUMS` (`src/lib/llm/textLabels.ts:35-39`), produced only in staging (`textLabelsEnabled`, `:55-60`).
- **Data that cannot exist yet.** The archive started with the V2 release (2026-11): about a year short of 252 sessions. Exit **INCONCLUSIVE** ("n of 252").

### E.2 CXA-008 Paraphrase harness and warm-up measurement
- **Asks.** Built: the golden-set page (done in M21), the paraphrase tone-shift test harness and the warm-up measurement on production announcements in shadow. Exit: once a market's golden set reaches `label_golden_min` (500, fixed) and the lower 90 % bound of agreement clears the threshold, one evaluation decides per label whether it adds information beyond the AR sign; PASS → the label enters that market's sentiment cluster per CTX-040; otherwise shadow, with the reason. AT-75 (the evaluation refuses below 500).
- **Current state.** `golden_label` (`0041_m21_owner_tools.sql:91-112`), `src/lib/labels/golden.ts:47-136`, page `src/app/(app)/cortex/labels/*` ("N of 500", `page.tsx:71`); `MIN_LABELS_FOR_EVALUATION = 500` is a constant (`src/lib/labels/store.ts:10`), `label_golden_min` is not a key. `label_validation` (`0019_cortex.sql:291-305`, kinds `paraphrase|ar_sign|golden|incremental`) holds only a `paraphrase_test: "pending"` placeholder (`textLabels.ts:224-227`). No agreement lower bound anywhere; `scripts/cortex/golden-spot-check.mjs:44-51` relabels the arena labels, not the CTX-040 ones. No warm-up code (CTX-052 appears in no source file).
- **Data that cannot exist yet.** 500 Owner labels per market (the Owner's pace) and a live R2 role (`llm_live_roles` empty). Exit **INCONCLUSIVE**.
- **[VERIFY].** The CTX-040 agreement threshold value (v1/V2 ch. 17), read at task start.

### E.3 CXA-007 LLM-proposed angles and challengers, shadow
- **Asks.** A monthly job asks one model role for at most `llm_proposals_per_month` (3, 0–10) proposals in the rule grammar, each with orientation, cluster and cited KB evidence; each is schema-validated, de-duplicated, charged as a counted hypothesis (VAL-112, LLM-075) and screened in shadow like any other (KB-076); none may change weights, thresholds or the active set. AT-73: 20 fixture proposals (valid, out-of-grammar, duplicate, hostile, weight change); only valid non-duplicates stored and charged; the weight change refused; AT-32 hash equal with the job on or off; no card or e-mail shows a proposal.
- **Current state.** Key registered, no reader (`keys.ts:1770-1777`). Grammar and validator for family rules: `src/lib/agents/families/ruleSchema.ts:856` (`validateRuleSpec`), docs generated by `scripts/learning/genRuleSchema.mjs`; there is no grammar for angles. Challenger lifecycle `src/lib/learning/challengerLifecycle.ts:6-7,345,455`. `trial_ledger` has no proposal kind (`0008_agents.sql:468-487`). `tests/acceptance/v3/at73Shared.test.ts:1-9` covers the M22 call proposals and names M23 for the angle half. M22 pattern to copy: `src/lib/experts/callProposals.ts` (`storeProposal` `:156`, injected model `ask`).
- **Data that cannot exist yet.** A live model: production is rules-only until the Owner lists a role after a PASS bake-off. The job is proven on fixtures; its research report exits **INCONCLUSIVE** (no proposals produced).

### E.4 CXA-011 SHOCK stop-tightening comparator
- **Asks.** A pre-registered comparator lineage per family, "tighten stops in SHOCK"; the rule returns to live only if the comparator's lower bound beats the current rule's at the one look; otherwise NULL. Counted under the quarterly variant cap (O-46).
- **Current state.** SHOCK entered same day, left after 3 sessions (`src/lib/agents/regime.ts:6-16,102,121`); SHOCK blocks entries and fires TB-REGIME but never moves a stop; the only stop move is the upward ratchet (`src/lib/cortex/states/corpAction.ts:899`). Variant cap `VARIANT_QUARTER_CAP = 3`, `stopVariantsThisQuarter` (`src/lib/learning/challengerLifecycle.ts:196-202,238,432-436`). No family simulator on history is in the repo (the M15 F1 tool was private).
- **Data that cannot exist yet.** Enough SHOCK-exposed holds: SHOCK sessions are rare. Expected exit **INCONCLUSIVE**.

## F. Records

### F.1 CXA-012 Survivorship haircut pre-registration and matched controls
- **Asks.** The pre-registered haircut is the delisted-code share per year times an assumed −50 % post-delisting loss [PROPOSED], published with and without, per market (IN measured on its delisted archive; US and AU early years assumed); matched controls where a market's point-in-time universe exists, else the report says "unmatched"; industry history from each market's first classification snapshot, earlier sessions labelled "static industry"; the director trade-type split stays BLOCKED-DATA for AU, not blocked for IN/US. Key `survivorship_loss_assumed_pct` 50 (30–80, fixed at pre-registration).
- **Current state.** Built in M20: `haircut`, `withAndWithout`, `reportCaveats` (`src/lib/cortex/survivorship.ts:14,51-76,101-122`), records for IN and US (`src/lib/market/seed/dataLimits.mjs:6-30`), docs `docs/cortex/data-limits-{IN,US}.md`; only tests call them. No AU record, no key, no "static industry" label (only a note at `src/lib/cortex/pit/types.ts:27`). Own snapshots: `universe_snapshot` (`0004_au_data.sql:83-100`); matched controls in `src/lib/agents/forwardLedger.ts:17-22` and `controlLibrary.ts`.
- **Gaps.** Key, AU record, the label, wiring into every M23 research report.

### F.2 CXA-013 F2 per market and the AU source check
- **Asks.** US: F2 calibratable from the first EDGAR snapshot, "F2-no-fundamentals" until then; IN: XBRL results if the terms pass DAT-101 [VERIFY], else BLOCKED-DATA; AU: BLOCKED-DATA unless a free point-in-time source passes DAT-101, with the check and its result recorded at M23.
- **Current state.** `F2_BLOCKED_DATA` and the no-fundamentals variant (`src/lib/agents/families/index.ts:42-52`, `rules.ts:249`); `fundamentals_source` AU blocked (`src/lib/market/seed/AU.mjs:73`), IN and US unverified (`IN.mjs:108`, `US.mjs:96`); the as-filed reader `src/lib/data/sources/us/companyFacts.ts:95-200`; IN and US records `docs/cortex/data-limits-IN.md` §3, `data-limits-US.md` §3. No AU record.
- **Data that cannot exist yet.** US snapshots in production (US is off) and a free AU point-in-time source (none known).

## G. Acceptance tests

| AT | What M23 must show | Ids |
|---|---|---|
| **AT-72** | synthetic planted-edge, null and short lineages → PASS, NULL, INCONCLUSIVE; a second look refused and audited; every look listed with its hash; the A$5,000 variant labelled and never able to trade | CXA-003, CXA-015 |
| **AT-73** (angle half) | the 20 fixture proposals; only valid non-duplicates stored and charged; weight change refused; complement proof equal on/off; no card or e-mail shows a proposal | CXA-007 |
| **AT-74** | fixture histories for the eight monitors give the stated values; demotion signal, slope hide and stall Owner item fire exactly at threshold; no monitor writes a book or rule | CXA-010 |
| **AT-75** (series clause) | the sector series of a fixture market matches hand-computed values; the label evaluation refuses below 500 (with the M20/M21 clauses kept) | CXA-009, CXA-008 |
| **AT-32/AT-50, AT-67, AT-68, AT-85** (kept) | identity files unchanged; every new table outside the replay hash; no market literal; new tables guarded; every new AT in the test map | all |
| ch. 14 closing rule | every research item has a published report, not a skipped or weakened test | all |

## H. Configuration keys (ch. 15 §15.11.4; one in §15.11.2)

| Key | Default | Bounds | Edit | Status in tree |
|---|---|---|---|---|
| sector_index_weighting | equal | equal / value | — (pre-registered) | absent |
| survivorship_loss_assumed_pct | 50 | 30–80, fixed at pre-registration | — | absent (constant `survivorship.ts:14`) |
| label_golden_min | 500 | fixed | — | absent (constant `labels/store.ts:10`) |
| residual_monitor_alarm_pp | 5 | fixed | — | absent |
| holdout_looks_max | 1 | fixed | — | absent |
| llm_proposals_per_month | 3 | 0–10 | O | registered (`keys.ts:1770`), no reader |

## I. Spec decisions that bind M23 (ch. 00 V3)

D-930 (no opinion order path), D-934 (time-boxed research, one look, honest exits, F1.v2-mom stands), D-942 (M23 last, time-box absolute), D-949 (calibration per market, never transferred), D-945 (alt inputs gate-only, shadow; already built in M22, its registry row joins B.1).

## J. [VERIFY] and [PROPOSED] items the spec marks for M23

1. CXA-012 haircut formula (delisted share × assumed −50 %) [PROPOSED].
2. CXA-013 IN XBRL terms pass DAT-101 [VERIFY] (M20 recorded the rule; the result is re-read at M23).
3. CXA-013 AU free point-in-time fundamentals source [the check itself is the M23 deliverable].
4. CXA-003 the A$5,000 parcel figure (a simulated size; labelled, never live).
5. CXA-009 effect size near 0.06 with about 95 blocks (an approximate design figure, not a threshold).
6. CXA-002 (a) measured 95th-percentile bar latency [VERIFY, M19/M20]; not reopened here.

Found while reading (design decides): the CTX-040 agreement threshold (E.2), the expected-stall source (C.1 item 7), the fill-exclusion status (C.1 item 8), the movers hypotheses and n (C.3).

## K. Gaps and conflicts found while reading (resolved in the design)

1. **Slope-hide threshold.** CXA-010 (3) hides p below an upper bound of 0.7; the code hides below 1.0 (`statusRules.mjs:14`), which is stricter, and changing it would alter AU status evidence.
2. **Monitor (1) "demotion" vs AT-74 "writes no book or rule".** A monitor cannot demote anything and stay read-only.
3. **"24 announcement angles".** The registry carries the archive marker on 22 angles; 28 list announcements as an input.
4. **Value-weighted sector index.** No capitalisation data exists at $0.
5. **Backfill into production.** A backfilled multi-year series is private-derived and costs Turso writes; the spec does not say where it lives.
6. **CXA-009 blocks vs holdout length.** Monthly holdout months after the M15 boundary are far fewer than 95.
7. **VAL-118 fresh quarterly cell vs one look per lineage.** D-670 opens a new charged cell after a failed look.
8. **Verdict vocabulary.** `pass|fail` and `PASS|FAIL|INCONCLUSIVE` in the same registry; CXA wants PASS/NULL/INCONCLUSIVE.
9. **Three of six CXA-003 lineages have no history** (announcements, index changes, director notices).
10. **Angle grammar.** CXA-007 asks for angle proposals in the rule grammar, which describes family rules; existing angles are code, so de-duplication against them is by identity, not by expression.
11. **Warm-up in production shadow** vs `textLabelsEnabled` being staging-only (`textLabels.ts:55-60`), and staging is gone (OPS-107).
12. **INCONCLUSIVE and the look.** The spec does not say whether an INCONCLUSIVE exit spends the lineage's one look.
13. **No research report template** exists (`docs/test-reports/` holds AT reports only).
14. **The time-box clock.** "10 days" with token-paced, parked sessions needs a counting rule.
15. **Holdout reuse.** The M15 holdout window was already looked at once for F1.v2-mom (another lineage); per-lineage looks are allowed, but the multiplicity grows.
16. **Proposal charge kind.** `trial_ledger` has no kind for a proposed hypothesis.
17. **AU delisted share unknown.** The AU extract holds survivors only, so the CXA-012 formula has no measured AU share.
18. **CXA-004 PASS effect.** The spec does not say how a passing angle changes status; the existing path is the Owner-run passport import.

## L. Not in M23

Switching any IN/US market on (Owner, MKT-111); listing a model role live (Owner, after a PASS bake-off); changing any family status, weight, threshold or rule version on a research PASS (the CTX-053 path is a later, reviewed step); a paid announcement archive (O-64); CXA-006 (done in M22 as AGT-148); CXA-001/CXA-002 (M19/M20); re-looking F1.v2-mom or switching its gap definition (O-79); any statement parser for AU results.

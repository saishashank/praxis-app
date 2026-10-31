# M15 design — Cortex calibration

Inputs: `docs/M15_requirements.md` (scope, AT-50…56, keys, Q1–Q21), spec ch. 17 v7 (frozen), `Requirement/v2/tools/m15/PLAN.md` (offline WP1–WP8), `docs/28_cortex/_design_freeze.md`. Continues from M14 (decisions to D-256). Decisions here start at D-257. Code read on `build` at bcab746 (review).

Roles (Owner 2026-10-30): Opus orchestrates; **Fable builds the Cortex core** (the "mind": angles, statistics, score, map, gates, offline measurement) and separately reviews architecture; Sonnet builds the plumbing (schema, nightly wiring, page, cards, config, import, LLM labels). A Fable review pass that did not write the code checks every core package before it merges.

## 1. Shape

One pure core, three callers:

```
src/lib/cortex/            pure, no DB, no clock, no network (inputs in, decisions out)
  pit/                     known-time rules, as-of view, input manifest, adjustment view
  angles/                  registry + one module per domain (d1…d10); passport metadata as code
  score/                   rank standardisation, clusters, eligibility, S, Platt apply, disagreement
  economics/               cost per order, limit formula + trade-through fill, gap cap, ranking (review)
  gates/                   CTX-013 ordered gate list, open-time list, NAV caps, settled cash
  states/                  corporate-action (two-basis), halt/suspension, promotion flag, event polarity, cold start
  night.ts                 runNight(inputs) → NightOutput
src/lib/stats/             + stationaryBootstrap, calibration, multiplicity, distinctness, nulls, cells, breakEven
src/lib/cortex/store/      (Sonnet) readers/writers for migration 0019 tables
callers:
  batch 2b stage           live night (src/lib/agents/batch2b.ts) → runNight → existing sizing/order path
  batch 2a fill            src/lib/arena/closeBooks.ts fills the limit order with the same fill function (review)
  replay driver            src/lib/replay/cortexReplay.ts: a CohortReplaySource over SnapshotWorld + a hook in replayCohorts (review)
  offline tools            Requirement/v2/tools/m15/lib/*.mjs → import the same TS via tsx; a HistorySource over the extract (review)
```

Rules for the core: integer micro-dollars and `Rational` for money (as `src/lib/money`); every random draw from `scopedPrng` (`src/lib/stats/rng.ts`) with a recorded seed; no `Date.now()` (the night's `d` and `cutoffUtc` come in); every function that reads a series takes an as-of index so TST-109 truncation can be asserted mechanically; every gate failure returns `{ gateId, label }` from one table (§3b).

Vocabulary used below (review): **book** = one live E cohort (`cohort` row of an E execution; 12 books = E01…E12); **session index t** = position of `d` in the market's session list; **InputKind** = one source class with one known-time rule (§3a).

## 2. Work packages

| WP | Builder | Content | Depends | Files owned |
|---|---|---|---|---|
| C1a | Fable | `cortex/pit`: `InputKind` registry with one known-time rule per class (CTX-010, §3a), `AsOfView` builder from plain arrays, as-of truncation helper for TST-109, input manifest hash, null-close rejection, late-bar abstain-all, quota-degrade predicate; `cortex/angles/registry.ts` (`AngleDef`, status rules, "activatable only when every InputKind has a live reader"), nightly rank standardisation; D7/D9/D10 entries registered as `gate_only` / `meta` with no `compute` (review: split from C1) | — | `src/lib/cortex/pit/**`, `src/lib/cortex/angles/{registry,types,d7,d9,d10}.ts`, `tests/cortex/pit/**`, `tests/cortex/angles/registry*.test.ts` |
| C1b | Fable | Angles D1, D2 (20 price/volume angles) as `compute(view, code, t)`; announcement and `needs_data` angles (A-D2-07, A-D2-08) registered `candidate` returning `undefined` (review: split from C1) | C1a | `src/lib/cortex/angles/{d1,d2}.ts`, `tests/cortex/angles/d1*.test.ts`, `d2*.test.ts` |
| C1c | Fable | Angles D5, D6-01 (ASIC shorts), D8 computable from price, AXJO, ASIC, calendar; macro (RBA/FRED) and US-index angles computable offline but registered with `inputs` the live app has no reader for (so never `active` live, §6); announcement angles `candidate` (review: split from C1) | C1a | `src/lib/cortex/angles/{d3,d4,d5,d6,d8}.ts`, `tests/cortex/angles/d[3-8]*.test.ts` |
| C2 | Fable | `stats` additions: stationary block bootstrap with per-statistic n_eff (R·u/D_s, undefined < 10 blocks), purge/embargo; Platt fit/apply, Brier skill, slope/intercept with CI, ECE with CI; BH under PRDS, split-half sign; distinctness (residualise on sector/beta/size, rank corr, VIF, partial IC, effective N); placebo and random-angle null drivers; matched-setup cells and the CTX-021 bound; break-even p. Builds on `bootstrap.ts` (`percentile`, `studentisedTest`, CSR layout) and `rankIc.ts` (`spearman`, `averageRanks`) | — | `src/lib/stats/{stationaryBootstrap,calibration,multiplicity,distinctness,nulls,cells,breakEven}.ts`, `tests/stats/m15/**` |
| C3a | Fable | `cortex/score` (eligibility, clusters, S, Platt apply with refit guard, disagreement) and `cortex/economics`: cost per order by tier (CTX-022a), limit formula + trade-through fill (CTX-028) as `fillEntryLimit` added to `src/lib/arena/fills.ts`, gap cap (CTX-022b), ranking (CTX-022), `p_be` (review: split from C3) | C1a, C2 | `src/lib/cortex/{score,economics}/**`, `src/lib/arena/fills.ts` (additive: `fillEntryLimit`, `limitPriceMicro`), `tests/cortex/{score,economics}/**` |
| C3b | Fable | `cortex/states`: corporate-action candidate/confirmed/disconfirmed with the two-basis stop (CTX-015), halt vs suspension classifier and marks (CTX-016), promotion flag (CTX-044), event polarity and U2/U3 D+2 persistence (CTX-043), cold start (CTX-055) (review: split from C3) | C1a | `src/lib/cortex/states/**`, `tests/cortex/states/**` |
| C3c | Fable | `cortex/gates` (the 12-step list of §3b, open-time list, NAV caps CTX-026, settled cash CTX-027) and `night.ts` (`runNight`: L0 → L1 → L2 → L3 → L4 per book, shadow arm CTX-023, abstain records, sector tilt shadow CTX-025, would-have scoring helper for batch 3) (review: split from C3) | C3a, C3b | `src/lib/cortex/gates/**`, `src/lib/cortex/night.ts`, `tests/cortex/{gates,night}/**` |
| P1 | Sonnet | Migration `0019_cortex.sql` (tables in §3), CTX keys in `keys.ts` + `docs/config-reference.md` + `AgentParams.cortex` in `params.ts`, `cortex/store` readers/writers, the charged-trial refit hook on CTX key edits (CTX-072), `INDEX_CODES` + GSPC/VIX under the existing Yahoo register row (D-290) (review) | §3 types | `db/migrations/main/0019_cortex.sql`, `src/lib/config/keys.ts`, `src/lib/agents/params.ts` (cortex block), `src/lib/cortex/store/**`, `src/lib/data/index/indexBars.mjs`, `tests/cortex/store/**`, `tests/db/0019*.test.ts` |
| P2 | Sonnet | Batch 2b Cortex stage (D-265) calling `runNight` once per night; family status decides orders vs shadow (D-266, D-280); `signal` + `decision_card` rows for live-arm orders (§3 note); abstain and shadow rows; batch 2a fill of `limit_micro` orders through `fillEntryLimit`; open-time list in `preopen.ts`; batch 3 would-have scoring (`cortex_outcome`), nightly parity test (CTX-055), abstain alarm; quota-degrade wiring (review) | C3c, P1 | `src/lib/agents/batch2b.ts` (stage hook), `src/lib/cortex/stage.ts`, `src/lib/agents/batch3.ts` (scoring hook), `src/lib/arena/closeBooks.ts` (fill hook), `src/lib/arena/preopen.ts` (open-time list), `tests/agents/cortexStage*.test.ts` |
| P3 | Sonnet | Cortex replay driver: `CortexReplaySource` over `SnapshotWorld` (+ snapshot tables `index_bars` for GSPC/VIX, `short_interest`, `macro_series`, calendar), `replayCohorts` hook for Cortex-governed entries and cross-book caps; TST-109 angle truncation test; AT-50 determinism; AT-56 fixtures (1)–(11) as TS-string ZZ worlds (M14 `tests/fixtures/m14/at43World.ts` pattern) (review) | C3c, P1 | `src/lib/replay/cortexReplay.ts`, `src/lib/replay/snapshot.ts` and `snapshotWorld.ts` (additions), `src/lib/replay/cohortReplay.ts` (hook only), `tests/fixtures/m15/**`, `tests/acceptance/v2/at50.test.ts`, `at56.test.ts` |
| P4 | Sonnet | Cortex page (CTX-071/072/073) + loader; Decision Card schema v2 and phrase table (CTX-070) with the ban list; glossary; the Configuration page shows the CTX keys through the registry (no `keys.ts` edit here) (review) | P1 (C3c for card fields) | `src/app/(app)/cortex/**`, `src/lib/ui/loaders/cortex.ts`, `src/lib/agents/cards.ts` (v2), `src/lib/cortex/phrases.ts`, `docs/glossary.md` (entries), `e2e/m15-cortex.spec.ts` |
| P5 | Sonnet | Text labels in the A2 classification call (CTX-040, staging, shadow; D-269); `label_validation` rows; CTX-041 `opinion_track` hook; static check "no L2 code reads opinion or label tables" (review: `src/lib/llm/labels.ts` already exists for LLM-072, so the new module is `textLabels.ts`) | P1 | `src/lib/llm/textLabels.ts`, `src/lib/agents/events.ts` (label hook only), `tests/llm/textLabels*.test.ts`, `tests/cortex/static/noOpinionReads.test.ts` |
| P6 | Sonnet | Owner-run import of offline artefacts (D-267); CTX-053 evaluator → `family_status`; statement generator (CTX-053 "live-tested pending", CTX-082 template); luck figure (D-277); AT-51…55 tests | C2, C3c, P1 | `scripts/cortex/import.mjs`, `src/lib/cortex/status.ts`, `src/lib/cortex/statements.ts`, `tests/acceptance/v2/at51…55.test.ts` |
| O1–O6 | Fable | Offline WP1–WP6 of PLAN.md as thin `tools/m15/lib/*.mjs` wrappers over C1–C3 (D-278): WP1 = `HistorySource` (the §3a `AsOfView` from the extract), WP2/3 = angle runs, WP4 = cells + passports, WP5 = `replayCohorts` through `cortexReplay.ts` over the `HistorySource`, WP6 = map + permission + nulls; outputs to `data/history/m15/`; one VAL-112 confirmation access in WP6 (review) | C1–C3 on `build` | private data repo only (Owner commits) |
| O7–O8 | Fable | Calibration report (WP7, KB item, family-level only) and the statistician pass (WP8, by a Fable reviewer that did not write O4–O6) | O1–O6 | private |
| W | Opus | Integration, goldens, AT reports AT-50…56, `docs/M15_exit_evidence.md`, §9 | all | docs |

Order: (C1a ∥ C2 ∥ P1) → (C1b ∥ C1c ∥ C3a ∥ C3b) → C3c → (P2 ∥ P3 ∥ P4 ∥ P5) → O1–O6 → P6 → O7/O8 → W. At most three builders at once (shared machine). (review: C1 and C3 were each too large for one agent; the split keeps file ownership disjoint.)

File-ownership rule (review): a file appears in exactly one WP above. `fills.ts` is C3a's (additive export only); `closeBooks.ts`, `preopen.ts`, `batch2b.ts`, `batch3.ts` are P2's; `cohortReplay.ts`, `snapshot*.ts` are P3's; `cards.ts` is P4's; `events.ts` is P5's; `keys.ts`, `params.ts`, `indexBars.mjs` are P1's. C3c reads `cards.ts` types but does not edit it: the card fields it needs are in `NightOutput` (§3a), and P4 maps them.

## 3. Schema (migration 0019, additive)

Conventions (review, from 0018 and 0016): every table `STRICT, WITHOUT ROWID` with a text PK; `_no_update` and `_no_delete` triggers raising `'append-only'`; date columns `GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`; JSON columns `CHECK (json_valid(...))`; money in integer micro-dollars; times ISO UTC; `d` the session date; `market` first in every PK. No table rebuild and no change to an existing CHECK (so `trial_ledger.kind` keeps its five values, see "activation" below). A `-- +down` that drops in reverse order.

| Table | Columns (PK bold) | Notes |
|---|---|---|
| `angle_passport` | **market, angle_id, version**, domain, cluster, orientation ∈ {1,−1}, kind ∈ score\|gate\|meta, inputs_json, history_fields_json, status ∈ candidate\|measured\|active\|watch\|retired, horizon_sessions, evidence_json, measured_json NULL, frozen_at NOT NULL | Values loaded by the import (D-267); the code registry is the source of definitions and a test asserts every registry id has a row after import. Append-only: a status change is a new version. (review: PK includes version) |
| `cortex_feature_daily` | **market, d, code**, features_json, flags_json, active_set_hash, manifest_id | **One row per code per night** (CTX-050 wording), `features_json` = `{angle_id: value\|null}` for the active set only; `flags_json` = `{angle_id: flag}`. (review: the draft's one row per angle would be ~60k rows a night.) Index `(market, d)`. |
| `cortex_ledger_cell` | **cell_id**, market, family, angle_id NULL, kind, spec_json, logged_at NOT NULL, result_at NULL, result_json NULL, split ∈ development\|validation, lineage_id NULL | `CHECK (result_at IS NULL OR logged_at < result_at)`; guard trigger as `corporate_action.known_at` (0016 l.12): `result_at`/`result_json` may go from NULL to a value **once**, nothing else may change. (review) |
| `cortex_map` | **market, family, rule_version, fitted_at**, params_json, active_set_hash, n_eff, pool, fit_split | `params_json` = `{a, b, s_mean, s_sd, K, clusters}`; latest `fitted_at` per (family, rule_version) wins. |
| `cortex_night` | **market, d**, status ∈ ran\|abstain_all, reason NULL, manifest_id, universe_n, bars_n, feature_rows, runtime_ms, active_set_hash, map_fitted_at NULL | The late-bar, quota-degrade and `map_missing` abstain-all record (CTX-010, CTX-050). (review: missing in the draft) |
| `cortex_decision` | **market, d, book_id, code, arm** ∈ live\|shadow, family, s REAL NULL, p REAL NULL, expected_net_micro NULL, rank_key TEXT NULL, limit_micro NULL, stop_micro NULL, qty NULL, gate_trace_json, first_fail_gate NULL, signal_id NULL, order_id NULL, card_id NULL, sector_tilt_json NULL, manifest_id | `book_id` = the E cohort id. `gate_trace_json` = ordered `[{gateId, pass, value}]`. Live-arm rows that become orders also get a `signal` row (see note). Index `(market, d, family, arm)`. (review: adds limit, stop, order link, sector tilt) |
| `cortex_outcome` | **market, d, book_id, code, arm**, fill_status ∈ filled\|unfilled\|cancelled, fill_micro NULL, fill_d NULL, exit_d NULL, exit_rule NULL, gross_micro NULL, net_micro NULL, outcome_class NULL, scored_at | Would-have outcomes of every live, shadow and blocked decision (CTX-023, CTX-054); written by batch 3 when the hold closes; insert-or-ignore. (review: missing in the draft; the economic gate's live sample reads it) |
| `cortex_abstain` | **market, d, book_id**, gate_id, label, detail_json | One per cash-holding book per night. `gate_id` from §3b. |
| `family_status` | **market, family, since_d**, status ∈ shadow\|allowed\|suspended, evidence_json, statement_id NULL, set_by ∈ import\|evaluator\|owner_kill | History rows, latest `since_d` wins. `family` ∈ F1…F7 (F7 shadow only; the v1 `signal.family` CHECK excludes F7, so F7 never reaches an order). |
| `cortex_state` | **market, code, kind** ∈ corp_action\|halt\|promotion, **from_d**, state, basis_json, source_ref NULL | One table for the three state machines; a state ends with a new row `state = 'none'` (no `to_d` update, keeps append-only). (review: replaces three tables with nullable `to_d`) |
| `input_manifest` | **manifest_id**, market, d, sources_json, schema_sha, row_counts_json, created_at | `manifest_id` = sha256 of canonical JSON of the rest. |
| `text_label` | **market, announcement_id, label_kind, model_id, produced_at**, value, cited_span, manifest_id NOT NULL, validation_id NOT NULL | Staging only by config. `label_kind` ∈ guidance\|event_confirm\|tone. (review: PK and NOT NULL validation per AT-50) |
| `label_validation` | **validation_id**, market, kind ∈ paraphrase\|ar_sign\|golden\|incremental, result_json, created_at | Written in the same transaction as the label (shadow labels get the paraphrase result). (review) |
| `opinion_track` | **market, opinion_id**, kind ∈ committee\|steelman, code, d, value_json, settled_d NULL, outcome_json NULL | CTX-041 hook only (D-270); batch 3 fills `settled_d` once (guard trigger as `cortex_ledger_cell`). (review) |
| `cortex_statement` | **statement_id**, market, family, kind ∈ allowed_weak\|live_tested, text, numbers_json, n_eff_live, created_at | Text comes from `statements.ts` templates only (CTX-072: not editable). |
| `arena_order` | + `limit_micro INTEGER NULL CHECK (limit_micro IS NULL OR limit_micro > 0)` | ALTER TABLE ADD COLUMN (additive, as 0016/0017). NULL = v1 order (fills at the open; F3 keeps `max_open_micro`). Set only for Cortex-governed orders. (review) |
| `source_register` | rows: `fred` (DAT-101, pending), `yahoo_index_us` note on the existing Yahoo row for ^GSPC/^VIX (D-290), the O-26 Yahoo note kept as pending | Through the existing history triggers (0004 l.270). |

Notes (review):
- **Cards need a signal.** `decision_card_insert_guard` (0008 l.317) requires `signal_id` to exist and `signal.family` is F1…F6 (0008 l.270). A live-arm Cortex order therefore writes a `signal` row first (`variant = 'cortex'`, `rule_version = '<family>.cortex.<map rule_version>'`, `rules_json` = the gate trace), then the card, then the order; shadow-arm and abstain rows write no signal. The `UNIQUE (market, d, family, rule_version, variant, code)` key keeps this idempotent.
- **Activation trials** (CTX-031) go to `trial_ledger` with `kind = 'challenger'`, `rule_version = 'cortex:<family>.<rule_version>'`, `variant = '<angle_id>@<version>'`; the per-cell log is `cortex_ledger_cell`. No new `kind` (the CHECK cannot be altered without a rebuild).
- **Append-only check in CI**: `tests/db/0019*.test.ts` runs up, inserts one row per table, asserts every UPDATE and DELETE aborts except the two guarded once-only columns, then down.
- **V1 unchanged by merge (D-280/281)**: with every `family_status` = shadow, batch 2b's `entriesFor` (`batch2b.ts:1043`) takes the same `rankedCandidates` pool as today and `closeBooks.ts` sees `limit_micro = NULL` on every order, so the fill path at `closeBooks.ts:596-640` is byte-for-byte the v1 path. The cohort parity test (`tests/replay/cohortParity.test.ts`) must stay green without re-pin; AT-50 "organs off/on" covers the rest.

## 3a. Interfaces the builders must share (C1a/C2 publish first; concrete shapes) (review)

All in `src/lib/cortex/types.ts` (C1a owns). Existing types are reused, not copied: `ViewBar`, `IndexViewBar` (`src/lib/agents/decisionView.ts:29-38`), `Bar` (`src/lib/arena/fills.ts:24`), `CodeFacts`, `Tier`, `Family`, `RegimeLabel`, `ExitPlan`, `StopSpec` (`src/lib/agents/families/types.ts`), `Micro`, `Rational` (`src/lib/money`), `Prng` (`src/lib/stats/rng.ts`), `CostProfile` (`src/lib/arena/costs.ts`), `CalendarRow` (`src/lib/data/calendar.ts`), `CorpActionRecord` (`src/lib/arena/corpActions.ts`), `IndexChangeFact`, `EventFact`.

```ts
// ---- point in time -------------------------------------------------------------------------
/** One source class = one known-time rule (CTX-010). The rule is data, never a branch in an angle. */
export type InputKind =
  | "bar_au"        // Yahoo D bar: known at close(D) + p95 latency (D-263 interim: at cut-off when present)
  | "index_au"      // ^AXJO close: as bar_au
  | "index_us"      // ^GSPC, ^VIX dated D: known D+1 09:00 Melbourne all year
  | "asic_short"    // as_of + 4 weekdays 23:59:59Z (reuse asicPublishedAt, src/lib/data/backfill/rules.mjs:301)
  | "macro"         // RBA/FRED: publication date per series from MACRO_SERIES (§6); untimed = obs date + 1 session
  | "announcement"  // published_at; untimed backfill = +1 session (GL-05 bound via first_ingested_at)
  | "corp_action"   // known_at (0016) else ex-date − 1 session for vendor rows
  | "calendar"      // trading_calendar rows: known at load
  | "sector_map";   // instrument_class / ASX list: as_of (D-271: current map offline, labelled)

export type KnownTimeRule = (row: { d?: string; asOf?: string; publishedAt?: string; knownAt?: string | null }) => string; // ISO UTC
export const KNOWN_TIME: Readonly<Record<InputKind, KnownTimeRule>>;

/** A point-in-time series of one code: raw bars and the split-adjusted view (adjustBars, candidates.ts:139). */
export type CodeSeries = {
  readonly code: string;
  readonly d: readonly string[];                 // session dates, oldest first, same length as the arrays below
  readonly raw: readonly ViewBar[];
  readonly adjClose: readonly bigint[];          // CTX-050 method: OHLC × cumulative split factor; dividends separate
  readonly adjVolume: readonly bigint[];         // volume × split ratio
  readonly divFactor: readonly number[];         // separate dividend factor (float, statistic only)
};

/**
 * Read-only view of the world truncated at session index `t` of `sessions`. Every accessor takes an
 * explicit `t` and returns only rows whose KNOWN_TIME <= cutoffUtc(sessions[t]). Built once per world by
 * `buildAsOfView(world)`; `at(t)` is a cheap handle. Enforced by construction: the handle holds `t` and the
 * accessors slice by t; TST-109 then rebuilds the view from arrays cut at t and asserts equal features.
 */
export type AsOfView = {
  readonly market: string;
  readonly sessions: readonly string[];
  readonly cutoffHhmm: string;                   // params.decisionCutoff ("18:10")
  cutoffUtc(t: number): string;                  // decisionCutoffUtc(sessions[t], cutoffHhmm)
  codes(t: number): readonly string[];           // universe codes with a bar on sessions[t], sorted
  tier(code: string, t: number): Tier | null;
  bars(code: string, t: number, count: number): readonly ViewBar[];     // last `count` raw bars with d <= sessions[t]
  adj(code: string, t: number, count: number): CodeSeries;              // adjusted on the basis known at cutoffUtc(t)
  index(indexCode: "AXJO" | "GSPC" | "VIX", t: number, count: number): readonly IndexViewBar[];
  shorts(code: string, t: number, limit: number): readonly { asOf: string; ppm: number }[];
  macro(series: string, t: number, count: number): readonly { obsD: string; value: number }[];
  events(code: string, t: number): readonly EventFact[];              // day0 <= sessions[t], published before cut-off
  corpActions(code: string, t: number): readonly CorpActionRecord[];  // known_at <= cutoffUtc(t)
  indexChanges(code: string, t: number): readonly IndexChangeFact[];
  industry(code: string, t: number): string | null;
  halted(code: string, t: number): boolean | null;
  regime(t: number): RegimeLabel;                                      // regimeSeries over index(AXJO) (regime.ts:128)
  calendar: readonly CalendarRow[];
  manifest(t: number): InputManifest;                                  // sources, schema sha, row counts up to t
};
export type InputManifest = { readonly manifestId: string; readonly d: string; readonly sources: readonly { kind: InputKind; rows: number; lastKnownAt: string }[]; readonly schemaSha: string };

/** The three producers of an AsOfView (one builder, three sources): */
// live:    src/lib/cortex/store/liveWorld.ts   (P1) reads through DecisionView (decisionView.ts:90) for one night: t = last
// replay:  src/lib/replay/cortexReplay.ts      (P3) from SnapshotWorld's maps (bars, index_bars, short_interest, macro_series)
// offline: tools/m15/lib/history.mjs           (O1) from the extract JSON (HistorySource)

// ---- angles ----------------------------------------------------------------------------------
export type AngleCluster = "momentum" | "low_volatility" | "liquidity" | "event" | "quality" | "sentiment";
export type AngleKind = "score" | "gate" | "meta";
export type AngleFlag = string;                                   // e.g. "at_high", "stale", "claimed"
export type AngleValue = number | { readonly flag: AngleFlag } | { readonly bucket: string } | undefined; // undefined = not computable (warming up / missing input)
export type AngleStatus = "candidate" | "measured" | "active" | "watch" | "retired";

export type AngleDef = {
  readonly id: string;                      // "A-D1-01"
  readonly version: number;
  readonly domain: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  readonly kind: AngleKind;                 // gate/meta angles never enter S (CTX-011)
  readonly cluster: AngleCluster | "regime" | "risk" | "calendar" | "meta";
  readonly orientation: 1 | -1;             // fixed before results (CTX-030)
  readonly horizonSessions: number;         // own primary horizon (hold): 20/60/126/250
  readonly warmupSessions: number;          // undefined before this many bars
  readonly inputs: readonly InputKind[];    // every kind it reads; the registry refuses `active` unless each has a live reader
  readonly grid: Readonly<Record<string, readonly number[]>>; // pre-registered grid points (CTX-034)
  readonly needsData?: string;              // "announcement archive" | "fundamentals" | ... → stays candidate
  /** Pure. Reads only through `view` at `t`. Absent for gate_only/meta entries that are existing v1 rules. */
  readonly compute?: (view: AsOfView, code: string, t: number, grid: Readonly<Record<string, number>>) => AngleValue;
};
export const ANGLES: readonly AngleDef[];                          // exactly 100 ids, asserted by test
export function rankStandardise(values: ReadonlyMap<string, number>, orientation: 1 | -1): ReadonlyMap<string, number>; // → [-1, 1] within the universe of one night, ties averaged (rankIc.ts averageRanks)

// ---- night ----------------------------------------------------------------------------------
export type FamilyStatusMap = Readonly<Record<Family | "F7", "shadow" | "allowed" | "suspended">>;
export type CortexMap = { readonly family: Family; readonly ruleVersion: string; readonly fittedAt: string; readonly a: number; readonly b: number; readonly sMean: number; readonly sSd: number; readonly K: number; readonly clusters: readonly AngleCluster[]; readonly activeSetHash: string; readonly nEff: number };
export type CellStat = { readonly cellKey: string; readonly n: number; readonly blocks: number; readonly nEff: number | undefined; readonly meanNet: number; readonly lower90: number; readonly lRealMicro: Micro; readonly gap95: Rational; readonly byRegime: Readonly<Record<RegimeLabel, { n: number; meanNet: number }>>; readonly excludedUnfilledShare: number };
export type BookState = { readonly bookId: string; readonly family: Family; readonly executionId: string; readonly positions: readonly { code: string; qty: bigint; costMicro: Micro; stopMicro: Micro; entryD: string }[]; readonly settledCashMicro: Micro; readonly navMicro: Micro; readonly costProfile: CostProfile; readonly sessionsSinceGoLive: number };

export type NightInputs = {
  readonly market: string;
  readonly d: string;
  readonly t: number;                              // index of d in view.sessions
  readonly view: AsOfView;
  readonly params: AgentParams;                    // existing, plus the CTX block (P1 adds `params.cortex`)
  readonly status: FamilyStatusMap;
  readonly maps: ReadonlyMap<Family, CortexMap>;   // empty → every book abstains `map_missing` (D-281)
  readonly cells: ReadonlyMap<string, CellStat>;   // key = family|band|volBucket|liqTier (CTX-021)
  readonly books: readonly BookState[];            // all 12 (CTX-026 caps span them)
  readonly states: readonly { code: string; kind: "corp_action" | "halt" | "promotion"; state: string; basis: unknown }[];
  readonly labels: ReadonlyMap<string, unknown>;  // text labels usable at the cut-off (shadow until CTX-040 passes)
  readonly kills: { readonly arena: boolean; readonly families: ReadonlySet<Family>; readonly sourcesOff: ReadonlySet<InputKind> };
  readonly prng: (scope: string) => Prng;
};
export type GateResult = { readonly pass: true; readonly value?: string } | { readonly pass: false; readonly gateId: GateId; readonly label: string; readonly value?: string };
export type Decision = { readonly bookId: string; readonly family: Family; readonly code: string; readonly arm: "live" | "shadow"; readonly s: number | null; readonly p: number | null; readonly expectedNetMicro: Micro | null; readonly rankKey: readonly Rational[]; readonly limitMicro: Micro; readonly stopMicro: Micro; readonly qty: bigint; readonly plan: ExitPlan; readonly stopSpec: StopSpec; readonly trace: readonly (GateResult & { gateId: GateId })[]; readonly card: CardFields };
export type CardFields = { readonly similar: { readonly p: number; readonly lo: number; readonly hi: number; readonly n: number } | null; readonly breakEven: readonly { c: number; pBe: number }[]; readonly reasonsFor: readonly AngleCluster[]; readonly reasonsAgainst: readonly AngleCluster[]; readonly wouldHaveStopped: GateId | null; readonly regime: RegimeLabel; readonly independentSources: readonly InputKind[]; readonly costPerOrderPpm: number };
export type Abstain = { readonly bookId: string; readonly gateId: GateId; readonly label: string; readonly detail: unknown };
export type NightOutput = {
  readonly status: "ran" | "abstain_all";
  readonly reason: "late_bar" | "quota" | "map_missing" | "universe_incomplete" | null;
  readonly manifest: InputManifest;
  readonly features: ReadonlyMap<string, ReadonlyMap<string, AngleValue>>;   // code → angle_id → value (active set only)
  readonly decisions: readonly Decision[];                                   // live arm, pass all gates, ranked, sized
  readonly shadow: readonly Decision[];                                      // shadow arm (families not allowed; CTX-026 off for allowed books)
  readonly blocked: readonly (Decision & { readonly firstFail: GateId })[]; // every blocked candidate, for would-have scoring
  readonly abstains: readonly Abstain[];
  readonly sectorTilt: readonly { bookId: string; sector: string; tiltPp: number }[]; // shadow (CTX-025)
};
export function runNight(inputs: NightInputs): NightOutput;   // pure; identical bytes for identical inputs (AT-50)

// ---- stats (C2) -------------------------------------------------------------------------------
export type Ci = { readonly point: number; readonly lo: number; readonly hi: number; readonly level: 0.9; readonly nEff: number | undefined };
// Every C2 function takes plain number[] (+ session index[] and code[] where blocks matter) and a Prng; returns a Ci or `{ undefined: reason }`.
```

Fixed rules for the shapes (review):
- `AsOfView` is the only way an angle sees data. A static test (`tests/cortex/static/pure.test.ts`) fails if `src/lib/cortex/{pit,angles,score,economics,gates,states}` or `night.ts` imports `@libsql/client`, `node:fs`, `node:net`, `Date` construction without an argument, or `Math.random` (D-279).
- TST-109: for every active angle and every t in a ZZ world, `compute(buildAsOfView(cut(world, t)), code, t)` must equal `compute(buildAsOfView(world), code, t)`; the same helper runs offline over the extract (WP1 output `_tst109.json`, family-level counts only in the report).
- Live `runNight` sees `t = sessions.length − 1`; the replay and offline drivers walk t forward. Nothing in `runNight` reads `view.sessions[t + 1]`; the `AsOfView` implementation throws on `t` beyond its truncation.

## 3b. The gate lists (CTX-013 order, with ids) (review)

`src/lib/cortex/gates/list.ts` exports `GATE_LIST` (this order, never re-sorted) and `GATE_LABELS` (the plain words of CTX-070; the only place they live). The open-time list extends `preopenDecision` (`src/lib/arena/preopen.ts:97`): its existing checks (halt, quality, asx_query, placement, thesis-breaker) stay first, the Cortex checks follow.

| # | gateId | Spec | Reads | Plain label (abstain line) |
|---|---|---|---|---|
| 1 | `G01_l0_veto` | CTX-010, D9 | night status, null `adj_close`, stale input (A-D9-01), known_at guard (A-D9-06), code data-quality flag | "the data for tonight were not complete" / "this company's prices were not reliable" |
| 2 | `G02_eligibility` | CTX-012 | any `undefined` in the scored set | "we do not have enough history on this company yet (warming up)" |
| 3 | `G03_family_status` | CTX-053 | `status[family] === "allowed"` | "this strategy is not yet allowed to trade" |
| 4 | `G04_economic` | CTX-021 | cell lower90 > 0, n ≥ cell_min_setups, blocks ≥ cell_min_blocks, regime fail-closed | "setups like this have not come out ahead after costs" / "not enough history" |
| 5 | `G05_cost` | CTX-022a | `cost_gate_k` × C vs cell mean gross — **informational**: always `pass`, value logged on the card | — |
| 6 | `G06_stop_cap` | FAM-004 | stop distance from `initialStop` ≤ `max_stop_distance_pct` (`families/stopCap.ts`) | "the stop would be too far away" |
| 7 | `G07_gap_cap` | CTX-022b | stop distance + cell gap95 ≤ `max_loss_pct` | "a bad overnight gap could cost more than we allow" |
| 8 | `G08_event_state` | D8, DAT-234, CTX-044, CTX-016, CTX-015 | sub-ids `8a_index_change` (fail-closed when the list is missing), `8b_promotion_flag`, `8c_halt_suspension`, `8d_unresolved_action`, `8e_event_date_veto` | "an index change / a promotion flag / a trading halt / an unresolved corporate action / a scheduled event is in the way" |
| 9 | `G09_regime` | CTX-017 | `REGIME_BLOCKED[family]` (`families/constants.ts:29`); F4 half size in SHOCK | "the market regime blocks this strategy tonight" |
| 10 | `G10_disagreement` | CTX-023 | d > `cortex_disagreement_max` | "the evidence disagreed too much" |
| 11 | `G11_portfolio` | CTX-026 | ≤ `max_books_same_code`, code NAV share, industry NAV share (drift blocks entries only) | "we already hold enough of this company / industry" |
| 12 | `G12_settled_cash` | CTX-027 | settled cash net of entry fee ≥ A$500 (`availableCash`, `arena/ledger.ts:380`; `MIN_MARKETABLE_PARCEL_MICRO`) | "the cash from the last sale has not settled yet" |

Then ranking (CTX-022: `cortex/economics/rank.ts`), then sizing through the existing `planLegs`/`sizeLeg` (`candidates.ts:677-707`) with resize-at-fill (`sizing.ts:269`).

Open-time list (`OPEN_LIST`, run at 09:55 in `preopen.ts` and again in `closeBooks.ts` at the fill): `O01_kill` (Owner switch, family kill), `O02_source_off`, `O03_shock_block`, `O04_stale_universe` (> `stale_universe_max_share`), `O05_gap_cap` (the limit formula at the fill), `O06_stop_gap95` (re-check with the stop referenced to the fill), `O07_recheck_missing` (no 09:55 run → cancel; supersedes `not_rechecked`, `closeBooks.ts:654`, for Cortex-governed orders only).

## 3c. One implementation: what is reused, extended, replaced (review)

| Concern | Existing | M15 | Live caller | Replay caller | Offline caller |
|---|---|---|---|---|---|
| Entry fill | `fillEntryAtOpen` (`fills.ts:101`), F3 cancel on `open ≥ max_open_micro` (`closeBooks.ts:611`, `cohortReplay.ts:1482`) | **extend**: `limitPriceMicro(closeMicro, stopMicro, gapCapPct, stopCapPct)` = min(close × (1 + gap), stop ÷ (1 − cap)) rounded down to the tick; `fillEntryLimit(env, qty, limitMicro)`: open ≤ limit → `fillEntryAtOpen` with the fill price capped at the limit; else low ≤ limit → fill at the limit (rule `limit`, new `FillRule` value, `slipMicro` 0); else `{status:"unfilled", reason:"limit_not_reached"}` (D-288) | `closeBooks.ts` when `arena_order.limit_micro` is set (P2) | `cohortReplay.ts` entry fill when `Candidate.limitMicro` is set (P3; new optional field on `Candidate`, absent = v1) | WP5 through `replayCohorts` |
| Cost per order | `roundTripCost(profile, adv)` (`costGate.ts:96`) = 2 × fee(A$600) + 2 × bucket bps | **add** `costPerOrder({profile, notionalMicro, priceMicro, tier, advMicro})` = 2 × (feeFor + halfSpreadPpm(tier, price) + slippage bps (`bucketBpsFor`)) with `HALF_SPREAD_PPM_BY_TIER` = max(tick/2 ÷ price, tier floor) [VERIFY, shown in the CTX-071 tick/cost table]; `roundTripCost` stays for the v1 FAM-005 path (D-260) | G05 value, card | same | WP5 |
| Regime | `regimeSeries`/`regimeForLast` (`regime.ts:128,145`), `REGIME_BLOCKED` (`families/constants.ts:29`) | **reuse** unchanged; `cortex/gates/regime.ts` reads `REGIME_BLOCKED` and adds F7 = strongest cluster's rule; a test asserts the table equals CTX-017 | G09 | `SnapshotWorld.familyInputs(d).regime` | WP3 (same function over the extract's AXJO closes) |
| Adjustment | `adjustBars` (`candidates.ts:139`), `splitsKnownOn` (`:89`) | **reuse**; `CodeSeries` built by one `buildCodeSeries(raw, splits, dividends)` in `pit/adjust.ts` that calls `adjustBars` and adds the dividend factor | live world | snapshot world | WP1 |
| Stops and exits | `initialStop`, `evaluateExit`, `walkPosition` (`families/exits.ts`, `replay/ledger.ts`) | **reuse**; CTX-024 ex-date credit exists (`fillIntradayStop` `exDividendMicro`, `fills.ts:131`); TERP and the ratchet re-base are new in `states/corpAction.ts` and applied by the caller before `evaluateExit` | 2b exits stage | cohortReplay | WP5 |
| Settled cash | `settlementDate`, `availableCash` (`arena/ledger.ts:314,380`) | **reuse** in G12 | books | cohort ledger | WP5 |
| Bootstrap | `circularBlockBootstrap` (`bootstrap.ts:34`) | **add** `stationaryBlockBootstrap` (geometric block lengths, expected 120, purge/embargo, per-statistic D_s) beside it; `MIN_INDEPENDENT_BLOCKS` stays for v1 | — | — | WP4/6 |
| Random signals | `randomSignalSource` (`nullRuns.ts:319`) | **pattern** for the random-angle null: `randomAngleSets(view, t, K, prng)` in `stats/nulls.ts` | — | — | WP6 |
| Would-have | `replayLedger` + `forwardLedger` (FAM-008) | batch 3 scores `cortex_decision` rows with `fillEntryLimit` + `walkPosition` into `cortex_outcome` (`stage.ts`, P2) | batch 3 | replay writes the same rows in memory | WP5 |

Replay hook (P3): `replayCohorts` (`cohortReplay.ts:559`) gets `CohortReplayOptions.cortex?: { night(d: string, books: readonly BookState[]): NightOutput; status: FamilyStatusMap }`. When set and a cohort's family is `allowed`, its `entriesFor` (`cohortReplay.ts:1484`) takes that family's `NightOutput.decisions` (already ranked and sized, with `limitMicro`) in place of `rankedCandidates(...)`; every other family runs the v1 path and the shadow rows are collected in a sink. `SnapshotWorld` stays the data source; `cortexReplay.ts` builds the `AsOfView` from its maps plus three new snapshot tables (`index_bars` already exists, `short_interest` and `macro_series` added to `snapshot.ts`). The offline WP5 uses the same `replayCohorts` over a `HistorySource` that implements `CohortReplaySource` + `AsOfView` from the extract, so the simulator is not a second implementation (D-278).

Live hook (P2): `batch2b.ts` after `runVersions` (`:1509`) and before the per-cohort loop (`:1548`): `ctx.cortex = await cortexStage(db, day, books)` → `runNight` once; `entriesFor` (`:1043`) branches on `status[family]`: allowed → the Cortex decisions as the pool (skip `selectEntries`, D-260) and `limit_micro` on the order; else unchanged. Abstain, shadow, feature and night rows are written in the stage's own transaction before the loop.

## 4. Decisions (spec defaults; listed in the V2 PR)

D-257…D-277 adopt Q1–Q21 of `docs/M15_requirements.md` as recommended there (slope UB key 1.0; BH-PRDS; AT-52 tests the formula; cost-gate binding by family status; corporate-action/halt states forward-measured; haircut 1.5 pp fixed; Yahoo latency measured in staging with the interim rule stated; angle IC from the D+1 open at four horizons; Cortex as a batch 2b stage; shadow families hold cash; artefacts private with an import script; AT-56 built; labels ride the triage call; CTX-041/042 hooks only; sector angles candidate in replay; suspension policy fixed; no GST; AT-55 read-back at merge; open-time checks = 09:55 re-check + limit fill; cell_min_blocks 20; luck figures computed). Further:

- **D-278** One implementation of every angle, statistic, fill and gate, in `src/lib/cortex`, `src/lib/stats` and `src/lib/arena/fills.ts`; the offline tools import them via `tsx` and add only file I/O. A second implementation anywhere is a defect.
- **D-279** The Cortex core is pure: no DB, clock or network inside `src/lib/cortex/{pit,angles,score,economics,gates,states}` and `night.ts` (static test, §3a).
- **D-280** Cortex-governed books replace the v1 entry path only for families whose `family_status` is `allowed`; every other family runs the v1 path as before (M14 gates) and the Cortex runs beside it in shadow. Until the import of the offline map, every family is `shadow`, so the live V1 behaviour is unchanged by merging M15 (§3 note).
- **D-281** Map parameters, passports' measured values and cells are data, loaded by the import; with no map loaded `runNight` abstains every Cortex book with `map_missing` and writes shadow rows only.
- **D-288** (review) Limit fill: a trade-through fills at the limit exactly, with no slippage beyond it (a limit order cannot fill worse than its limit); an open at or below the limit fills as v1 (`open + slippage`) capped at the limit. Both arms record `unfilled` when the low stays above the limit. The limit is rounded down to the tick grid.
- **D-289** (review) Quota-degrade rule: the stage records `abstain_all` with reason `quota` when its wall-clock exceeds `cortex_stage_minutes` (new key, default 20, bounds 5–60, O) or reason `universe_incomplete` when the share of universe codes without a D bar exceeds `stale_universe_max_share`. GitHub Actions minute balances are not readable from the job, so time is the proxy.
- **D-290** (review) `INDEX_CODES` gains `GSPC` and `VIX` from the same Yahoo source already registered (no new source, no new terms); known-time rule `index_us` = D+1 09:00 Melbourne. Until 60 live sessions exist, A-D5-08 is `measured` (offline) at most, never `active`.
- **D-291** (review) RBA/FRED have no live fetcher in M15 (a new network source needs an Owner-accepted register row; FRED is added as `pending`). Macro angles are computed offline and reported; they cannot be `active` live because `inputs: ["macro"]` has no live reader. They are not in the 12-step list (CTX-013 names regime = the CTX-017 table only); making a macro veto binding is a counted challenger later.
- **D-292** (review) Gate and meta angles of D7/D9/D10 that are existing v1 rules (FAM-004/005/006, ARN-108, kill switch, DSR/PBO) are registry entries with `kind: "gate" | "meta"` and no `compute`; their passports cite the existing module. They are never scored (CTX-011).
- **D-293** (review) Feature storage is one row per code per night with the active set as JSON (CTX-050 wording), not one row per angle.
- **D-294** Half-spread by tier (CTX-022a) has no intraday source at $0: `HALF_SPREAD_PPM_BY_TIER` = half a tick ÷ price with a floor per liquidity tier, the floors stated in `costs.ts` and marked "to verify" in the V2 PR; AT-52 records the resulting A$0.20 U2 round trip and compares it with the spec's band.
- **D-298** (C2 review B1, CTX-012/OI-15) `u` in `n_eff = R·u/D_s` is the same-code design-effect inverse from the statistic's own influence values, `u = min(1, Σψ² / Σ_c (Σ_{i∈c} ψ_i)²)`: it counts only the same-code correlation the calendar blocks miss and falls to the share of unique codes when all rows of a code move together. The literal "unique codes / rows" would cap `n_eff` at the code count and make `cortex_min_neff_trade` 200 unreachable for most families. For the Owner's review in the V2 PR.
- **D-299** (C2 review B2) `D_s` uses contiguous fixed blocks of `L = max(bootstrap_block_sessions, max hold)` over all rows; the purge and embargo at the maximum hold apply to the out-of-fold evaluation (`purgeEmbargo`), not to the batch-means ratio.
- **D-300** (C2 review S3) Logistic fits use step-halving; a slope interval with more than 0.5 % non-finite replicates is undefined, and an undefined slope interval counts as "p hidden" (CTX-053 fail-closed).
- **D-301** Break-even counts a gross return of exactly 0 as a loss (CTX-021 diagnostic; exact zeros are rare in micro-dollar nets).
- **D-302** (C1a review S2, CTX-010/OI-46) A manual DAT-234 index-change row without a `known_at` stamp is known one session after its announced date (effective date when no announced date): S&P/ASX announcements come after the close.
- **D-303** A-D10-06 (red team) is a `meta` entry until a counted challenger adds a red-team step to the CTX-013 list (the frozen chapter's list has none; OI-61).
- **D-304** The angle status word is `watch` (CTX-032 and this design); CTX-030's "watching" reads as the same state.
- **D-305** The D-290 rule "A-D5-08 at most `measured` until 60 live sessions" is enforced by the P6 status evaluator, not by the registry.
- **D-306** (C1a review) The purity test walks the transitive import closure; the split helpers in `candidates.ts` and `asicPublishedAt` in `rules.mjs` are reused by import and move to pure modules the day that scan fails. Offline TST-109 runs on a deterministic sample of about 20 cut-offs per year over a once-partitioned world; CI runs every cut-off on ZZ worlds. `adj()` is served from a per-code cache keyed by the split basis.
- **D-307** A Cortex trade-through fill at the limit (D-288) is written as `fill.rule = 'level'` with `arena_order.limit_micro` set; a fill at the open below the limit stays `'open'`. The 0007 `fill.rule` CHECK is not rebuilt (§3). `fillEntryLimit`'s `"limit"` rule is mapped by P2 (live) and P3 (replay) before any row is written.
- **D-308** The nightly index fetch adds `^GSPC` and `^VIX` (D-290) in P2's data-stage wiring; P1 only widened `INDEX_CODES`.
- **D-309** The CTX-072 charged-trial hook (`recordCortexKeyEdit`) is called from `updateConfig` in `src/lib/config/admin.ts`, wired by P4 with the Configuration rows. Until then an Owner edit of a CTX key is not charged; no CTX key is edited before M15 merges.
- **D-310** P1 schema choices accepted: refit marker = the newest `key_edit` ledger cell vs the newest `cortex_map.fitted_at`; extra CHECKs (abstain-all iff a reason; an Owner kill only suspends; F7 never allowed or live; a filled outcome needs price and date; result columns set once and together; a text label needs its validation row); per-night writers are insert-or-ignore, history tables insert strictly.
- **D-311** (C3a review) Cost per order = Σ over buy and sell of (fee + max(ARN-032 slippage per fill, tier half-spread floor)); the D-294 half-spread is a floor inside the per-fill slippage, not an added term, so the gate's cost equals what the simulator charges. A$0.20 U2 at A$500 → 7.0 % (CTX-022a "about 7 %"); A$10 U1 → 2.2–2.5 %. §3c's "bucket bps only" row is superseded.
- **D-312** AT-52's "≈ 4.5–5 %" is a pre-slippage figure left stale by the spec's pass 30; the test asserts the CTX-022a formula and records the band as superseded.
- **D-313** Angles in `watch` keep their weight in S (CTX-032 wins over CTX-012's "all its angles watching" wording); a cluster is empty only when it has no active or watch angle.
- **D-314** Rank keys, L_real and gap95 are floats (C2 statistics); §3a's `Rational` rank key and `CellStat` money fields are superseded by `number`.
- **D-315** (C1b review) A score angle returns 0 on nights its setup is absent (no breakout, not contracted, no event); `undefined` is reserved for warm-up and missing input, because CTX-012 makes an undefined score angle a night-long ineligibility.
- **D-316** A flag returned by a score angle (e.g. A-D1-03 `veto`, A-D2-03 `unstable`) is a null feature for the night: the code is ineligible (CTX-012); the flag is a veto, never a neutral drop from the rank.
- **D-317** One ATR(20) per code per night: every angle folds Wilder ATR over the same 250 bars (`ATR_HISTORY`); warm-ups follow.
- **D-318** Grid dimensions are the ones the compute reads; card-only thresholds are passport text, not charged ledger cells (CTX-031).
- **D-319** Flag-only angles (A-D1-04, A-D1-08) enter their cluster as rank-standardised 1/0 dummies at the cluster's equal weight (CTX-011). A-D1-01 horizon states are ±1; A-D1-04 uses H1 resumption only; A-D1-05 scores −dist inside the F4 gate and 0 outside; A-D1-10 is rs_sector over ≥ 5 universe members; A-D2-02 is ±1 at its one-sided limits; A-D2-09 is a cited gate with no compute; A-D2-10 is a risk gate; A-D2-07/08 stay candidate (needsData). Percentiles use v1's half-tie convention.
- **D-320** CTX-044 promotion zeroing is applied in the score layer to the positive event and volume contributions, never inside an angle.
- **D-321** (C3b review, CTX-015) Cortex corporate-action records carry provenance and status (`sources` from `evidence_json` and `add_source` notes; `status` pending/confirmed/rejected/reversed), filled by the P2 producer; pending rows are known at `first_ingested_at`, confirmed rows at `known_at`. A candidate needs status pending and an ASX announcement source; a data-layer re-base needs status confirmed and an announcement source; a confirmed row with only vendor or price sources never re-bases a Cortex stop; a row without provenance fails closed (no candidate, no re-base, an `unknown_provenance` state row and an Owner item).
- **D-322** The explained-move disconfirmation test runs from the first session after the break (two consecutive post-break failures); the freeze-loss limit and the notice-plus-price agreement run on the break session. AT-56 fixture 3b is re-read with −40 % on the break because the literal −50 % confirms by price and can never disconfirm — listed for the Owner in the V2 PR (ch. 17 is frozen).
- **D-323** A suspension ends on the delisting ex-date with outcome `delisted`; the caller books the position at the final policy mark; administration or liquidation books zero (ARN-026).
- **D-324** Unknown halt flags read as untraded (fail closed). `NoticeFacts` are derived from the notice record at ingest. U2/U3 persistence compares the index-adjusted D+1 return (the AR0 basis) with AR0/2. The warming-up rule applies in every cold-start phase.
- **D-325** Tonight's ATR(20) is the 250-bar fold of D-317 for every angle; angles that compare against past ATRs (A-D1-06, A-D1-07) read the past values from one Wilder fold seeded 60 bars before their window, so their warm-up is the window plus 60 sessions (about 312), not about 500 — a longer warm-up would make every code listed under two years ineligible for the whole Cortex (CTX-012).
- **D-326** (C1c review) Score-angle percentiles use the AGT-030 half-tie convention against prior points, the latest excluded; the regime-style percentiles (A-D5-08 VIX, A-D6-10 benchmark volatility) use AGT-101's convention (count ≤ over the prior 1,260 values excluding tonight, ÷ 1,260), one implementation with `regime.ts`.
- **D-327** D-318 applied to C1c: A-D5-01 has no grid (SHOCK challengers are passport text); A-D5-02 drops `narrow_threshold`; A-D6-01 drops `crowded_pct` and scores only (a crowded-and-rising veto is a future counted challenger). A-D6-03 `entry_k ≥ 2` and A-D8-03 `ex_offset 2` fire only on GL-02 `known_at` rows (vendor rows are known one session before the ex-date).
- **D-328** Market-wide gate computes (A-D5-02, A-D5-08, A-D5-09, A-D6-10, A-D8-07) are memoised per (view, t, grid); universe-looping score angles (A-D5-03/04/10, A-D6-08) get the same memo before they leave candidate.
- **D-329** D-315 applies to event angles: no event in the window scores 0 (A-D3-01/02/03/04/09, A-D4-04); `undefined` only when an event exists but its day-0 fact is missing.
- **D-330** Macro ids `RBA_F2_10Y` (and the cash rate) are registered in `MACRO_SERIES` with the F-table +1-session rule; [VERIFY] stays on the passport until a fetcher exists (D-291).
- **D-331** A-D6-10's breadth leg is the breadth-200 level (grid 0.05–0.2 as levels), a run-time choice against angles_D6's percentile wording. A-D4-05 includes special dividends and is rank-standardised universe-wide (CTX-011). The 100-id registry (`ANGLES` = D1…D10) is assembled in one wiring commit at the C1b and C1c merge.
- **D-332** (C3c review, CTX-020) The candidate set is the family's v1 universe tiers passing L0, eligibility and ARN-011 (U2/U3); a code outside the tiers is not a candidate and writes no row; an ARN-011 failure fails G01 with `arn011:<reasons>`. The Cortex replaces the v1 setup rule, not the universe or ARN-011.
- **D-333** A Cortex entry carries the family's v1 `ExitPlan` (`f1Plan`, `f4Plan` …) with the initial stop from the family's own parameter; a family whose plan needs inputs the night lacks fails G04 `rule_missing` until wired. Would-have scoring walks the same plan through `evaluateExit`.
- **D-334** A rule version without its pre-registered top-3 band edge is "not enough history" (G04 `band_missing`); no candidate is matched by default.
- **D-335** Both shadow arms apply the CTX-060 refit guard; the allowed book's shadow arm differs from live by G11 alone; a map-less night's shadow rows are G04 `map_missing` blocked rows.
- **D-336** `runNight` counts the bars dated D itself for the late-bar test and computes the stale share for `universe_incomplete`; only elapsed minutes come from the caller.
- **D-337** G12's plain label follows the sizing reason (settled cash, parcel, participation). **D-338** Gate 8e vetoes an event whose day 0 is D or the fill session; categories halt/suspension, exchange query, capital raising; 8a fails closed when the DAT-234 list is missing. **D-339** `card.similar` interval bounds are null until the import carries the Platt interval; a family under the slope monitor shows none.
- **D-340** Volatility buckets are ATR(20)/close with pre-registered edges 2 % and 4 %; `volBucketOf` is the one implementation for live cells and the offline builder. **D-341** The abstain record is the first failing gate of the live-arm candidate that got furthest in CTX-013 order (ties by code), with per-gate counts; only books with deployable cash ≥ A$500 get one. **D-342** Sizing uses full deployable cash, one slot per book per night by default; cross-book CTX-026 caps include tonight's earlier picks in book order. **D-343** F7 inherits the regime rule of its strongest cluster (F1's when unknown); the cold-start exclusion is a G03 failure `cold_start`.
- **D-344** (P3) A snapshot corporate-action row without the new `sources`/`status` columns reads as vendor-only and confirmed (adjusts prices, never a candidate or a Cortex re-base, D-321). Snapshot additions are additive: without the new data a snapshot is byte-identical (same sha).
- **D-345** In the replay, Cortex books are the base-group E cohorts (book id = cohort id); a Cortex order is skipped when a quantity-changing ex-date falls across the fill.
- **D-346** Cortex entries in the replay do not yet take matched controls (ARN-080); the offline replay (O5) must wire control matching for Cortex entries before any CTX-050 evidence is computed. Events, per-night states and dividends are absent from the snapshot replay (D-261) and are stated as such.
- **D-347** (P2) G11's NAV share is code exposure ÷ the whole arena's NAV across all 12 books (CTX-026); the live stage passes every arena book's NAV, leverage twins included. With 12 books of A$600 an A$500 entry is about 7 % of NAV.
- **D-348** The nightly stage advances the corporate-action, halt and promotion state machines for every universe code before `runNight` and writes the changed `cortex_state` rows; Owner alerts go to the existing Owner-items mechanism. A decision whose fill session has passed without a bar is scored `cancelled` (`no_fill_bar`).
- **D-349** (P2) The stage is on by default and an `allowed` family never falls back to the v1 entry path; a stage failure is logged and leaves v1 untouched. Gate 8a fails closed until the DAT-234 index-change list has been loaded at least once, so the go-live needs that upload. The P6 import writes matched cells as ledger cells of kind `matched_cell` and the per-family fields (`top3_min_s`, `family_mean_net`, `tiers`, `p_hidden`, `gain`, `loss`, `slots`) in `cortex_map.params_json`.
- **D-350** (O1, change control on the design freeze) The frozen split rule ("first session with ≥ 150 codes carrying a full OHLCV bar") counts traded bars only (volume > 0): the vendor emits zero-volume placeholder bars on ASX holidays in early years, so the rule realises on the first real trading session after the recorded date, one session later. The rule is unchanged; the realised date is corrected and the freeze record gets a change-control line (Owner commits the data repo). The offline loader also un-adjusts the vendor's split-adjusted OHLCV to the traded basis so the Cortex applies vendor splits itself, as live.
- **D-351** (P2 review) Cortex open-time cancellations are written as `preopen_result.reason = 'filter:open_<OpenId>'` and the same string in `arena_order.reject_reason`; the 0009 CHECK is not rebuilt.
- **D-352** Batch 2b order: v1 cohorts of non-allowed families first, then the Cortex stage, then allowed-family Cortex entries. The whole stage is time-boxed by `cortex_stage_minutes`; an overrun or exception logs a warning and the allowed families hold cash, so no stage outcome can delay or lose a v1 order.
- **D-353** Stage reads are bounded by code (the universe on D plus held codes) and by ex-date for action events; one staging night's stage runtime and row counts go into BUILD_SETUP §9 before the V2 PR.
- **D-354** Would-have scoring: unsized blocked rows are recorded `cancelled` in one set-based insert; only sized decisions walk bars; a decision fills only on the next trading day, otherwise `cancelled/no_fill_bar` (FAM-008).
- **D-355** The nightly state fold starts from the stored state in force at the window start; a code whose only input is an old stored state never gets a folded `none`. Provenance `status` is the latest known, not as-of — a stated TST-109 exception for nights inside a later-confirmed action's pending window.
- **D-356** An exception in the allowed-family entry path logs a warning and leaves that family in cash for the night; v1 families are unaffected. Allowed families open no C2/C3 matched controls in the live arena (D-260).
- **D-357** (P4) The Cortex page reads: `family_status.evidence_json = {n_eff, mde}`; ledger cells of kind `placebo` with result `{passed, null_pass_rate}` and kind `nav_at_risk` with result `{loss_95_pct, loss_worst_pct}`. P6 and the import write these. Owner controls on the page link to the existing writers (strategy switches, Configuration); there is no separate Cortex kill-switch action.
- **D-358** The luck figure (D-277) is computed as (ledger cells + Owner key edits) × `ledger_fdr_q`, shown as "Of N ideas tried, about X would look good by luck alone". Idle cash is abstain book-nights over abstain plus decision book-nights in the last 60 days; the shadow comparator is the count and total net of filled shadow outcomes (money to the Owner only).
- **D-359** Card schema v2 sits beside v1 (v1 cards render unchanged; a v1 card carrying the v2 block is rejected); the v2 block stores ppm integers and plain labels only, never a gate id; a v2 byte-for-byte rebuild check is P2's to add. The five sample cards in `tests/acceptance/v2/at55.test.ts` are the Owner read-back set (D-274).
- **D-373** (O3) Ledger cells are angle × horizon {own, 5, 20, 60} × regime {all, SHOCK, RISK-OFF, RISK-ON, NEUTRAL} at the default grid point; the remaining pre-registered points are logged and measured in a separate run once their angle values exist. An angle is `measured` only when its primary cell (own horizon, all regimes; h20 for gates with no horizon) is rejected under BH and agrees in sign across the two halves; never `active` here.
- **D-374** For gate and meta angles a flagged night counts as −1 (an unfavourable veto); a flagged score angle is a null feature (D-316); buckets are not ranked. Cross-sectional IC is undefined for market-wide gates, which are therefore tested later by the replay (WP5/WP6), not by IC.
- **D-375** Distinctness uses the current ASX sector map (D-271), a 250-session beta on ^AXJO, and log 20-session median dollar volume as the size proxy (the extract has no market capitalisation), on a deterministic sample of sessions. The measured set fails distinctness (overlapping momentum and liquidity angles); WP6 selects a distinct active subset.
- **D-376** Every re-run of the measurement is a new look: it is appended to the ledger with its own stamps, counted in the trial budget and in the luck figure; the import carries the latest run. Re-runs after results are known are avoided except to add pre-registered points.
- **D-377** (O4) The offline setup simulation covers F1 and F4 (the go-live set) with S over the measured score angles, K = 4 clusters (momentum, low volatility, liquidity, sentiment), an A$1,000 parcel capped at 1 % of ADV, the D-333 exit plans, the D-311 costs, and 20 matched controls per setup (same family, session, tier and volatility bucket, seeded). The builder's further choices O4-1…O4-8 (in the private run summary) are listed for the Owner in the V2 PR.
- **D-378** (coverage rule, decided on data availability, not on outcomes) An angle whose values are undefined over more than a third of the development sessions cannot be in a family's active scored set, because CTX-012 eligibility would void every code on those sessions; it stays measured and may be added once live history covers it. A-D6-01 (ASIC shorts, data from 2010) is therefore outside the active set for the calibration run. The re-run this requires is a counted look (D-376).
- **D-379** (O4 finding, for the Owner) On the first run neither F1 nor F4 had any cell passing the CTX-021 economic gate (mean net after costs negative; paired edge over matched controls about zero at family level). Unless the D-378 re-run or WP6 changes that, CTX-053 keeps every Cortex family in shadow and V2's go-live condition ("F1 and F4 allowed") is not met; the V1 strategies keep trading. This is stated in the V2 PR.
- **D-380** (O4 run 2 under D-378, the second counted look) With A-D6-01 out of the active set the development evidence doubled (2001–2021) and the result held: no F1 or F4 cell passes the CTX-021 economic gate; the cost per order at the A$1,000 parcel (about 1.6 %) exceeds the gross edge, and the top-score band beats matched controls by only 0.05–0.2 percentage points. The calibration therefore keeps every Cortex family in shadow (CTX-053) and V2's go-live condition is not met by M15; the V1 strategies keep trading, the Cortex keeps writing shadow decisions so live evidence accumulates, and the finding leads the V2 PR for the Owner. O5–O8 still run (replay with controls, map and placebo/random-angle nulls, statistician review) so the report states the evidence fully; no further re-runs are made to look for a passing cell.
- **D-446** (O5+O6, the full evidence; the builder's own choices O6-1…O6-8 are in the private run summary and listed for the Owner in the V2 PR) The import's CTX-053 evaluator assigns F1 and F4 `shadow`: Brier-skill lower bound ≤ 0 for both; F1 own n_eff below 200 and its slope monitor hides p; the CTX-021 bound negative; the live score beats pure random rankings but not random combinations of the measured angles; DSR fails for both, PBO passes for both; the ARN-108 neighbourhood is stable (no variant changes the verdict); placebo 50 runs allowed none (passed). ARN-106's time-stop comparator was not re-run (split by exit rule reported instead). No further searching (D-380).
- **D-461** (O8, independent statistician review by a Fable reviewer that wrote none of O3–O6; report private) Verdict: pre-registration PASS WITH NOTES, estimators PASS WITH NOTES, economic gate PASS, wording PASS WITH NOTES, nothing that changes the conclusion; no blocking finding. The family means, filled counts and the six pooled top-3 cells were recomputed from the per-setup records and match; every ledger cell has `logged_at < result_at`; the 2022–2025 validation window was never read. Corrections to D-380/D-446 and to the PR text: the second look grew the development evidence by about 41 % (not "doubled"); the paired top-band edge over matched controls is 0.04–0.23 pp; the placebo check only exercises the calibration arm (with a negative mean the economic gate cannot pass under a within-family shuffle); F1 beats random rankings only on the control edge, F4 on both statistics; the gate was well powered (detectable net edge about 0.3 pp F1 / 0.05 pp F4 per trade against about 1.6 pp cost), so the finding is "no economically usable edge at this account size and no detectable calibration skill", not "no information". Process notes for the PR: D-340 fixed volatility edges and D-298 u-definition were pre-measurement changes not entered in the freeze change-control table (entered now); the D-378 rule was adopted after run 1 was opened (declared, charged, and it lowered the best cell); decile band edges are cut in-sample; O6 had a mid-run patch after a stack overflow; the survivorship haircut (only lowers the figures) is shown in the O7 calibration report.
- Orchestrator (2026-10-30): the review's open points D-288 (no slippage beyond the limit), D-290 (GSPC/VIX under the existing Yahoo row) and D-294 are confirmed as written; the original review numbers D-282…D-287 were moved to D-288…D-293 because D-282…D-287 are M14 review fixes.

## 5. Acceptance mapping

AT-50 → P3 (`at50.test.ts`: twice-run byte identity of `cortex_decision`, orders and cards; organs off/on; TST-109 truncation on a ZZ world for every registry angle with a `compute`; label NOT NULLs through the 0019 schema test). AT-51 → C2 unit tests + P6 (`at51`): Brier-skill bound, slope UB, ECE not gated (static grep of `gates/**` for `ece`), placebo and random-angle null on synthetic pipelines, MDE rows. AT-52 → C2/C3a units + P6 (`at52`): p_be 53.1 %, the 40/60 cell fails `G04_economic` with its label, ATR 4 %/6 % ranking, `costPerOrder` table, +9 % open vs 8 % cap → `unfilled` in both arms through `fillEntryLimit`, ratchet invariant incl. a confirmed 2-for-1 re-base. AT-53 → P6 (`at53`): passport NOT NULLs, distinctness on correlated features, `logged_at < result_at` CHECK and the once-only guard, BH-PRDS. AT-54 → O8 pass + statement rows. AT-55 → P4 (`at55`): phrase-table static test, ban list grep over rendered cards, glossary completeness against the CTX-073 list. AT-56 → P3 (`at56.test.ts`, fixtures 1–11, each asserting the exact `gateId` and label). Reports in `docs/test-reports/AT-50.md` … `AT-56.md` with fixture numbers only.

CTX coverage check (review): CTX-001/002/003 → C3c, P4, P5; CTX-010 → C1a; CTX-011 → C1a–c; CTX-012 → C2, C3a; CTX-013/014 → C3c, P2; CTX-015/016 → C3b; CTX-017 → C3c (reuse); CTX-020/021/022/022a/022b/023 → C3a, C3c; CTX-024 → C3b (TERP, re-base) + existing exits; CTX-025 → C3c (shadow tilt), P4; CTX-026/027/028 → C3c, C3a, P2; CTX-030/031 → C2, P1, O4; CTX-032 → P2 (batch 3 rolling IC → `angle_passport.watch` via P6 evaluator); CTX-033/034/035 → C2, O6, P4; CTX-040 → P5; CTX-041/042 → P5 hook, deferred; CTX-043/044 → C3b; CTX-050 → O1–O6, P1 (storage), P2 (degrade); CTX-051/052 → registry status, staging; CTX-053/054/055 → P6, P2, C3b; CTX-060 → P1 (refit hook) + C3a (refit guard); CTX-070/071/072/073 → P4; CTX-082 → P6. Gaps the draft had and now has owners: CTX-032 decay monitor (P2 + P6), CTX-055 nightly parity and abstain alarm (P2), CTX-023 would-have outcomes table (P1 + P2), CTX-010 night record (P1 + P2), CTX-040 validation table (P1 + P5), CTX-041 tracking table (P1 + P5).

## 6. Point-in-time and run-time (review)

| Input | Point-in-time risk | Rule in `KNOWN_TIME` | Offline note |
|---|---|---|---|
| Yahoo D bar | latency unmeasured | D-263: at the cut-off when the bar exists in the night's snapshot; p95 measured from `first_ingested_at` on staging | same rule; the extract has no ingest stamps |
| ^AXJO | as bars | as `bar_au` | from `index/` |
| ^GSPC, ^VIX | US session D closes after Melbourne cut-off of D | known D+1 09:00 Melbourne all year (AT-56 fixture 3) | the extract's `index/` must be re-dated by this rule before any angle reads it |
| ASIC shorts | T+4 publication | `asicPublishedAt` (`rules.mjs:301`) | the extract's `asic/` carries `as_of` only; apply the same function |
| RBA/FRED | observation date ≠ publication date; FRED revises | `MACRO_SERIES[series].publishLag` (sessions) as a constant table in `pit/knownTime.ts`; RBA cash rate decision day 14:30 Melbourne (same day); RBA F-tables and FRED daily series = +1 session; untimed = +1 session | revisions unknown (no ALFRED vintages in the extract): stated in the passport's history fields |
| Announcements | none free | `published_at`, GL-05 bound | `candidate` only |
| Sector map | current list only | `instrument_class.as_of` live | D-271: current map, labelled; sector angles `candidate` |
| Calendar | offline calendar derived from ^AXJO bars | `trading_calendar` live | WP1 asserts equality with `trading_calendar` rows for 2020–2026 before use |
| Corporate actions | vendor-only ratios are not candidates | `known_at` live; vendor rows `ex_date − 1` | CTX-015 states forward-only (D-261) |

Run-time plan for the offline computation (review): ~2,000 codes × ~5,600 sessions = 11 M code-sessions. Per-code angle computation is O(n) with rolling windows: ~60 computable angles × 11 M ≈ 7×10⁸ steps, single-threaded Node ≈ 10–20 min. Storage: raw values per (angle, year) as `Float32Array` binaries (2,000 × 252 × 4 B ≈ 2 MB each, ~1,300 files ≈ 2.7 GB) with a JSON index; rank-standardised values as `Int16` (−10,000…10,000) ≈ 1.3 GB; never JSON per value. Rank standardisation: 5,600 nights × 60 sorts of 2,000 — seconds. Cells: ~1,800 cells × 2,000 replicates of a stationary bootstrap over ≤ 60k setups ≈ 2×10¹¹ adds → chunk per cell, write results as produced, expect 1–3 h; run in the background with `node --max-old-space-size=8192`. WP5 full L0–L4 replay over 22 years × 12 books: measure one run first (v1's 2020–26 replay is the reference); the placebo (≥ 50 runs) and the random-angle null (≥ 1,000 sets) re-run only the map + permission pipeline (WP6) on the stored setups table with shuffled outcomes or random angle sets — not the fills — which is what CTX-035 measures. Every WP writes to disk as it goes (PLAN.md rule).

## 7. Risks

| Risk | Mitigation |
|---|---|
| Look-ahead in an angle | `AsOfView` by construction + TST-109 truncation on every active angle in CI and offline. |
| Live/offline drift | D-278 single implementation; parity test on a ZZ world comparing `runNight` from batch 2b, the replay driver and the offline wrapper (same `NightOutput` bytes). |
| Over-fitting during calibration | Freeze record read first; ledger cells logged before results (CHECK + once-only guard); one validation access; placebo and random-angle null. |
| Run time offline | §6 plan; typed-array storage; cells and nulls on the setups table, not on re-fills. |
| Merging M15 changes live V1 | D-280/D-281; `limit_micro` NULL on every v1 order; cohort parity golden unchanged (§3 note). |
| Card FK and family CHECK | Live-arm orders write a `signal` row first; F7 never orders (§3 note). |
| Angles with no live reader go `active` | Registry refuses `active` unless every `InputKind` has a live reader (D-290/285). |

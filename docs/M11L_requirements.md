# M11-lite requirements: steelman and picks vs market (reflections optional)

Delta extract from `Requirement/v2/spec/12_build_plan_delta.md` (M11 row, BLD-041, BLD-046), ch. 01 V2 (PRD-029, PRD-030, PRD-033), ch. 03 V2 (R6, LLM-061 to LLM-065), ch. 07 V2 (AGT-131, AGT-133, AGT-133a, AGT-134), ch. 05 V2 (ARN-103, ARN-104), ch. 09 V2 (UXN-286 to UXN-288), ch. 14 V2 (AT-32 to AT-35, AT-37), ch. 15 V2 (LLM and steelman keys), ch. 17 (CTX-003, CTX-041) and Owner decisions O-42, O-69, O-73. Continues from M17 on `build`.

## Scope

M11-lite is the sixth V2 milestone (BLD-046: M8.1, M14, M15, M16, M17, **M11-lite**, M13-lite, M12). BLD-046 narrows M11 to: steelman and picks vs market; reflections optional. The Committee (A9, R7) is M12 and is not built here.

Marks: **build** = build in M11-lite. **exists** = already in code, reuse. **optional** = build last, only if budget remains (BLD-046). **deferred** = not in M11-lite, with the reason.

### Evidence pack (7.V2.1)
| ID | Plain words | Mark |
|---|---|---|
| AGT-131 | For each signal that gets a steelman, build a deterministic evidence pack with no LLM. It holds only data tonight's batch already used or stored: card fields and rules fired, regime, events with polarity, insider/flow score, factor rows, scenario percentiles with n, liquidity and cost buckets, data-quality flags, up to `evidence_pack_max_items` headlines with summaries and times. Every item has a stable evidence ID. Point-in-time (nothing after the decision cut-off). Stored with a content hash. | build |

### Steelman (7.V2.2, PRD-029)
| ID | Plain words | Mark |
|---|---|---|
| PRD-029 | Each new-order Decision Card and each published pick gets an evidence-cited bull case and bear case (text only). | build |
| AGT-133 | Up to `steelman_daily_cards` per night; orders first by rank score, then picks. One R6 call returns 2 to 4 bull and 2 to 4 bear points, each up to 40 words, each citing evidence IDs. Each bear point is tagged `monitorable` yes/no. Over the daily limit: "not written tonight (daily limit)". | build |
| AGT-133 (Critic) | A7 checks the steelman against the pack, using a different provider from the author (LLM-010). Unsupported points are hidden and logged. | build (A7 role code: see Exists and missing) |
| AGT-133a | `monitorable: yes` bear points appear in Owner `/review` as suggestions. Nothing is applied. The Owner may turn one into a thesis-breaker only through the rule-edit path, which resets the label to UNVALIDATED. Unanswered suggestions expire after `steelman_suggestion_expiry_sessions`. | build |
| CTX-003 / CTX-041 | Steelman output is an opinion: it is recorded in `opinion_track` (kind `steelman`), settled later with the outcome, scored for lift (VAL-111 style) and hidden from cards until `opinion_min_n` settled cases. It is **never** an input to L2, scoring, orders, sizing or lessons. Keep. | build (hook exists) |
| PRD-033 | No LLM output creates, sizes, changes or cancels an order, thesis-breaker or rule. | build (enforced by AT-32 and a static check) |

### LLM policy (ch. 03 V2)
| ID | Plain words | Mark |
|---|---|---|
| R6 Debater role | New role used by steelman. Bull and bear from different providers or families where possible. | build |
| R7 Committee judge | Used only by the Committee. | deferred (M12) |
| LLM-061 | New daily budget: R6 steelman up to 20,000 tokens; `llm_daily_budget_total` rises to 240,000 (VERIFY against free-tier limits). If limits cannot carry it, steelman cards shrink; v1 role budgets are never cut. Committee 40,000 is not used in M11-lite. | build |
| LLM-062 | New drop order: expert ingestion, Committee, company overviews, news summaries, steelman and card explanations, pick reflections, Evening Review (last). | build |
| LLM-063 | At least 50 R6 items added to the golden sets. R6 pass: citation validity >= 98 %, invented numbers 0, injection resistance 100 % on hostile packs. R7 items and the rating-parse threshold are for M12. | build (R6 part); deferred (R7 part) |
| LLM-064 | Evidence-only prompting. Every claim carries a valid pack ID. Numbers only if verbatim in the cited item. Invalid claims dropped; if over half are dropped, reject, repair once, then omit. | build |
| LLM-065 | Pack text is untrusted. No URLs, code or instructions in output; such output is rejected. | build |
| LLM-066 | Full call record per Committee call. | deferred (M12). Steelman calls still use the router's existing call log. |
| LLM-071 / LLM-073 | Constrained decoding with the citation enum; datamarking of untrusted text. | exists (M14: `jsonSchema.ts`, `datamark.ts`); reuse |

### Picks vs market (5.V2.1, PRD-030)
| ID | Plain words | Mark |
|---|---|---|
| ARN-103 | For every pick outcome, including missed picks (would-be window only), store market return over the exact holding window (fill-session open to exit session) and vs market = pick net return minus market return, in percentage points. Fixed at settlement, never edited. | build |
| ARN-104 | Picks track record adds per profile: median vs market, share of picks beating the market, n. n < 30 shows "insufficient history". Label "past paper picks, not a forecast". | build |
| UXN-288 | Each settled pick row shows "vs market +x.x pp" beside its net result; the summary sits on the track record. | build |
| GL-10 / DAT-235 | Benchmark is a total-return series with a basis label. | exists (`src/lib/picks/benchmark.ts`, M8.1); see Q2 |

### UI (ch. 09 V2)
| ID | Plain words | Mark |
|---|---|---|
| UXN-286 | Decision Card section "Strongest case for / against": two short lists, evidence chips scroll to the cited row; standing caption "AI-written from the evidence on this card. Not advice; not a forecast."; collapsed on phones; viewer masking replaces codes in text; rules-only mode says "not available tonight". | build (slot exists, see below) |
| UXN-287 | Owner-only "Suggestions" group in `/review`: card link, bear point, cited evidence, actions "Open rule editor" and "Dismiss"; dismissals audited. | build |
| UXN-291 (part) | Owner switches `steelman_daily_cards` and `pick_reflection_enabled` on the Configuration page, audited. `committee_enabled` is not shown. | build (the two keys); deferred (Committee switch, M12) |

### Reflection (7.V2.4)
| ID | Plain words | Mark |
|---|---|---|
| AGT-134 | When a pick settles, A6 writes one reflection up to 80 words in R3, grounded in the stored pick record, outcome, vs market, breaker history and steelman points. Says which stored points the outcome agreed with. No cause the data does not support. Stored on the pick record and in monthly pick notes under "Unproven notes". Never an input to lesson grades, Lane A or Lane B. | optional (last package) |
| UXN-288 (reflection) | "Looking back (AI-written)" under the settled row. | optional |

### Deferred or out
| Item | Why |
|---|---|
| A9 Committee, R7, VAL-111 test, ARN-105, UXN-289/290, `committee_*` keys, AT-36 | M12, last and only if budget remains (BLD-046). |
| M12 start gate (BLD-041) | M12 may start only after >= 10 production nights of steelman with citation validity >= 98 %. M11-lite must record nightly validity so this can be read. |
| Steelman or reflection text on emails, picks emails or alert emails | Not in spec; keep LLM text out of e-mails (AT-62 says alert e-mails carry no LLM text). |
| Any use of steelman or reflection as a signal | PRD-033, CTX-041. |

## Acceptance tests and evidence

| ID | Pass condition (spec) | Evidence that proves each clause |
|---|---|---|
| AT-32 No LLM path (steelman and reflection part) | Replay one recorded day with V2 LLM features on (recorded responses) and off: orders, fills, thesis-breakers, rule versions, picks, Lane A/B inputs byte-identical. Static check: no trading or learning code reads steelman, reflection or opinion tables. | (a) Vitest double replay with recorded R6/R3 responses, byte compare of the listed outputs. (b) Extend the existing static guard `tests/cortex/static/noOpinionReads.test.ts` to the new tables and modules. (c) Committee part of AT-32 runs in M12. |
| AT-33 Steelman grounding | 30 recorded packs with planted out-of-pack claims, numbers and hostile announcement text: every shown claim cites an in-pack ID; 0 invented numbers; 0 URLs or instructions; planted claims dropped; Critic flags applied. | Fixture set of 30 packs (ZZ codes) with recorded model replies; assertions on shown claims, drop log, more-than-half rejection and one repair, Critic hiding. Reuse `grounding.ts` tests. |
| AT-34 Suggestions not applied | A monitorable bear point appears in `/review` (Owner only); no thesis-breaker changes; dismissal audited; expires after the configured sessions. | Vitest + page test per role (Editor and Viewer see nothing); before/after rule and breaker tables equal; audit row on dismiss; expiry by session count. |
| AT-35 Picks vs market | Fixture picks incl. a missed pick, a gap-stop exit and a dividend in the window: market return and vs market match hand values to 0.01 pp; cannot be edited after settlement. | Hand-calculated expected table in the test; update/delete refused by trigger test (as `pick_outcome_guard_update`); basis label test. |
| AT-37 Degradation (steelman part) | Chain exhausted or V2 budget spent: steelman "not available"; reflections queued; drop order per LLM-062; v1 role budgets untouched; e-mail notes budget state. | Router test with exhausted chain and a spent R6 budget; budget test that R1/R2/R3/R5 allowances do not change; Evening Review text still written; e-mail note asserted. Committee `skipped_budget` part runs in M12. |
| LLM-063 bake-off (R6) | Citation validity >= 98 %, invented numbers 0, injection resistance 100 %. | `bakeoff.ts` run on >= 50 R6 items; report saved under `docs/test-reports/`. No model is assigned to R6 until it passes. Free-tier runs only. |
| BLD-041 gate evidence | Steelman has run >= 10 production nights at validity >= 98 %. | A nightly validity row stored; shown on the Cortex or System Health page for the Owner. Cannot pass before go-live; recorded as "pending production" in exit evidence. |

## Configuration keys (ch. 15 V2 section 15.9)

| Key | Default | Bounds | Edit | Ref | State in code |
|---|---|---|---|---|---|
| llm_daily_budget_total | 240,000 (was 150,000) [VERIFY] | 150,000 to 300,000 | O | LLM-061 | exists at 150,000 with bounds 75,000 to 225,000 (`keys.ts` line 1488): change default and bounds (Q3) |
| llm_budget_r6_steelman_daily | 20,000 | 0 to 40,000 | O | LLM-061 | missing |
| evidence_pack_max_items | 25 | 10 to 40 | O | AGT-131 | missing |
| steelman_daily_cards | 8 | 0 to 20 | O | AGT-133 | missing |
| steelman_suggestion_expiry_sessions | 10 | 5 to 30 | O | AGT-133a | missing |
| pick_reflection_enabled | true | bool | O | AGT-134 | missing (add; used only if the optional package is built) |
| opinion_min_n | 150 | 100 to 500 | O | CTX-060 | exists (`keys.ts` line 1165) |
| committee_*, llm_budget_committee_daily, llm_budget_experts_daily | n/a | n/a | n/a | M12 / M13 | deferred |

New keys need the keys.ts rows, `params.ts` wiring, the config reference (`docs/config-reference.md`) and the existing key-parity tests.

## Constraints

- **LLM budget:** steelman uses R6 only, within 20,000 tokens a day; reflection uses R3 within its existing 25,000; the Critic call counts against the V2 total. v1 role budgets are never reduced (LLM-061). Order of cuts per LLM-062. Pre-call reservation uses the existing `budget.ts` accounting (its `Role` type is R1, R2, R3, R5 only, so R6 must be added).
- **Decision path:** nothing in the trading, ranking, sizing, breaker, lesson or Lane code may read steelman, reflection or opinion tables (AT-32). Suggestions go through the Owner rule-edit path only.
- **$0:** free-tier models only; no paid call; no new paid vendor. If verified free limits cannot carry 240,000, reduce steelman cards first, never v1 roles.
- **SEC-110:** public repo gets code, tests with ZZ codes and synthetic packs only. No real tickers, prices, history extract, model replies from real runs, or Owner data. V2 spec chapters stay in the private data repo; do not copy them into `praxis-app` (this file cites IDs only).
- **Masking (ROL-107):** codes inside steelman and reflection text are masked for Viewers before display.
- **Safety wording:** captions "AI-written from the evidence ... not advice; not a forecast". No "certain/guaranteed/will" wording (CTX-002). "Past paper picks, not a forecast" on the vs-market summary.
- **Time zone:** the steelman job runs inside the Melbourne-time batch; report times to the Owner in Melbourne time.
- **No look-ahead:** packs are point-in-time; never run steelman on past dates in replays except with recorded responses for AT-32.

## What exists and what is missing

| Need | Exists (path) | Missing |
|---|---|---|
| Decision Card slot | `src/app/(app)/cards/[id]/Steelman.tsx` (renders "The case against" from `{text}`), `src/lib/ui/loaders/cards.ts` (`steelman: null`, "no source stores it yet") | Two-list for/against view with evidence chips, caption, phone collapse, masking, "not available tonight"; a loader reading the stored steelman (UXN-286) |
| Evidence pack builder | Card fields in `src/lib/agents/cards.ts`, `decisionView.ts`, `events.ts`, `insiderFlow.ts`, `costGate.ts`; `src/lib/cortex/pit/` point-in-time views | Pack builder, evidence IDs, content hash, table (AGT-131) |
| LLM router and roles | `src/lib/llm/router.ts`, `roster.ts`, `budget.ts` (R1, R2, R3, R5), `grounding.ts` (LLM-034), `injection.ts`, `datamark.ts`, `jsonSchema.ts` (citation enum), `bakeoff.ts`, `labels.ts`, `store.ts` | R6 role, roster rows, R6 budget, claim-level citation validator (drop, over-half reject, one repair), A7 Critic pass with a different provider, LLM-062 drop order, R6 golden items |
| Opinion hook (CTX-041) | `src/lib/llm/textLabels.ts` (`buildOpinion`, `recordOpinion`, `settleRecordedOpinion`); `src/lib/cortex/store/labels.ts` (`opinion_track`, kind `committee` or `steelman`); table in `db/migrations/main/0019_cortex.sql`; `opinion_min_n`; `tests/cortex/static/noOpinionReads.test.ts`; Cortex angle text in `src/lib/cortex/angles/d10.ts` | Call `recordOpinion` from the steelman writer; settle steelman opinions when the order or pick settles (batch 3 hook); lift read stays hidden until `opinion_min_n` |
| Picks outcomes | `pick_outcome` (`db/migrations/main/0010_learning.sql`: state, entry/exit, `net_ppm`, immutable guard trigger); `src/lib/picks/track.ts`, `store.ts`, `success.ts`, `nightly.ts` | `pick_market` figures (market return, vs market, basis) stored once at settlement incl. missed picks; migration (next number after 0019; check at build) |
| Benchmark series | `src/lib/picks/benchmark.ts` (total-return series, basis label, `loadBenchmarkSeries`-style reader); no consumer yet outside tests | Window return from the series, vs-market arithmetic in exact integer money, settlement hook |
| Picks pages | `src/app/(app)/picks/` (`PickCard.tsx`, `TrackRecordBody.tsx`, `track-record/`, `data.ts`) | "vs market" on settled rows, ARN-104 summary with n < 30 rule, "Looking back" slot (optional) |
| Owner review | `src/app/(app)/review/` (`page.tsx`, `ReviewForm.tsx`, `actions.ts`) | Suggestions group, dismiss action with audit, expiry job (UXN-287, AGT-133a) |
| Config | `src/lib/config/keys.ts`, `src/lib/agents/params.ts` | Five new keys; budget total default and bounds change |
| Nightly job | Batch 2b/3 in `src/lib/agents/` (`batch2b.ts`, `batch3.ts`) | Steelman stage after cards are final; Critic stage; queue for budget-short nights |
| Blueprint model | `docs/architecture/architecture.json`, `spec_map.yaml` (M16 CI check) | Add the new tables, modules and spec IDs so the completeness check stays green |

## Open questions and proposed decisions

All are decided by the spec's recommended default (O-73: no prompts). Proposed decisions continue from D-401 for this milestone.

| ID | Question | Spec default / proposal |
|---|---|---|
| D-401 | Build order and size of the milestone | Order: packs, R6 role and bake-off, steelman and Critic, card UI, opinion hook, vs market, `/review` suggestions, optional reflection. Reflection (AGT-134) last, only if budget remains (BLD-046). Committee, R7, VAL-111 and their keys stay in M12. |
| D-402 | Benchmark basis for ARN-103 (spec 5.V2.1 says price return; the later Owner decision O-51 / GL-10 says total return) | Use the total-return series from `benchmark.ts` with its basis label; where vendor dividends do not yet cover the window, show "Price only". The pick side is the existing pick net result. The newer decision wins; record it. |
| D-403 | Which "orders" get a steelman (AGT-133 says every new-order Decision Card) | Orders first by rank score, then picks, up to `steelman_daily_cards` (8). |
| D-404 | Which steelman statement is stored as the CTX-041 opinion | One opinion per card: value = bull and bear point count plus the surviving `monitorable` count; outcome settled at the order or pick close. Tracked for lift only; never an L2 input. |
| D-405 | Critic provider rule when only one provider is healthy | Critic must differ from the author; if impossible, skip the steelman for that card (shows "not available tonight"), as the strict reading of LLM-010. |
| D-406 | `llm_daily_budget_total` default and bounds | 240,000 with bounds 150,000 to 300,000 per ch. 15 V2; Committee and Expert shares exist in the total but stay unused until M12 and M13. Verify free-tier limits at build time (LLM-021); if not carried, cut steelman cards first. |
| D-407 | Suggested thesis-breaker expiry | Counted in sessions, default 10, per `steelman_suggestion_expiry_sessions`. |
| D-408 | What a missed pick shows for vs market | The would-be window return only; label "missed, not bought"; excluded from the "share beating the market" count but included in n only if filled (proposal; spec lists missed picks for storage only). |
| D-409 | Where steelman text is kept | New append-only tables `steelman_pack` and `steelman_point` (pack hash, points, citations, Critic flags, model IDs, state), plus `pick_market`; never joined by trading code. |
| D-410 | Production readiness measure for BLD-041 | Store nightly citation validity and count of nights; show on System Health. M11-lite exit is staging-green; the 10-night production count is "pending go-live". |

## Work packages

Sonnet builds. Fable reviews every package marked R (touches the LLM budget or the decision path). Haiku may run the checks.

| WP | Content | Depends on | Review |
|---|---|---|---|
| WP1 | Config keys (five new, total budget default and bounds), `params.ts`, config reference, key-parity tests | none | R (budget) |
| WP2 | Migration and store: `steelman_pack`, `steelman_point`, `pick_market` (append-only guards) | none | R (decision path: confirm no trading reader) |
| WP3 | Evidence pack builder (AGT-131) with IDs, hash, point-in-time cut, tests | WP2 | |
| WP4 | R6 role in roster, budget accounting and drop order (LLM-061/062); router tests for exhaustion (AT-37 part) | WP1 | R (budget) |
| WP5 | Citation validator and steelman writer (AGT-133, LLM-064/065, enum schema, over-half reject, one repair), Critic pass, batch stage; AT-33 fixtures | WP3, WP4 | R |
| WP6 | R6 bake-off items (>= 50) and report; no model assigned until pass | WP4 | R (budget) |
| WP7 | Opinion hook calls (record at write, settle in batch 3); extend static no-read guard; AT-32 double replay | WP5 | R (decision path) |
| WP8 | Card UI for/against with chips, caption, collapse, masking, empty states (UXN-286); loader | WP5 | |
| WP9 | `/review` Suggestions, dismiss audit, expiry (UXN-287, AGT-133a); AT-34 | WP5 | R (can touch the rule-edit path) |
| WP10 | Picks vs market: window return, settlement hook, immutable figures, picks pages and ARN-104 summary (ARN-103/104, UXN-288); AT-35 | WP2 | |
| WP11 | Nightly validity row and System Health line (BLD-041 evidence); Blueprint model and spec map update; exit evidence file | WP5, WP10 | |
| WP12 (optional) | Pick reflection (AGT-134) on R3, `pick_reflection_enabled`, "Looking back" slot, monthly note section; never read by learning code | WP7, WP10 | R |

## Parent requirements

PRD-029, PRD-030, PRD-033; AGT-131, AGT-133, AGT-133a, AGT-134; LLM-010, LLM-034, LLM-061 to LLM-065, LLM-071, LLM-073; ARN-095, ARN-103, ARN-104; UXN-286 to UXN-288; CTX-003, CTX-041, CTX-060; BLD-041, BLD-046; GL-10 (O-51); O-42, O-69, O-73; AT-32 to AT-35, AT-37.

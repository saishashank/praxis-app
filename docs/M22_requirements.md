# M22 requirements: LLM features and the Expert Library, full

Requirements extract for milestone M22 of the V3 build. Source: the V3 spec (read-only, `Requirement/v3/spec/`): ch. 12 (the M22 row, BLD-048…BLD-055), ch. 23 (LLM-077…LLM-081, DAT-248…DAT-250, §23.4, AT-80, AT-81), ch. 21 (§21.1, §21.2, §21.3 AGT-147, §21.6 AGT-148, AT-76, AT-79), ch. 22 (CXA-007 and AT-73, read for the shared proposal test only; CXA-015 for the look registry), ch. 14 (index rows), ch. 15 (§15.11.2, §15.11.3), ch. 00 (D-930, D-936…D-939, D-945, D-946), ch. 01 (PRD-033, PRD-039…PRD-048). Ids the M22 row points into and that V3 does not redefine are read from the V2 spec: ch. 03 (R6/R7, LLM-061…LLM-066), ch. 05 (ARN-105, VAL-111), ch. 07 (AGT-132, AGT-134), ch. 08 (DAT-228…DAT-230, LLM-067…LLM-069, KB-075), ch. 09 (UXN-288…UXN-291, UXN-296), ch. 10 (LLM-071…LLM-076), ch. 14 (AT-36, AT-39), ch. 15 (the Committee and Expert Library keys), ch. 17 (CTX-041, CTX-060).

**SEC-110 rule for this file:** every line below is an id with a paraphrase in the build team's own words; no spec sentence is copied. Code facts are cited as file:line in the tree `D:\Projects\Praxis\wt-m22-req` (branch `v3/m22-req`, `build` at `8b65abc6`, M18…M21 done), read on 2026-11-17. Build decisions for M22 are numbered from **D-1400** in `docs/M22_design.md`.

## Scope

M22 turns the LLM features that V2 built mock-only into gated, bake-off-controlled routes, builds the Committee trial and pick reflections that V2 deferred, and completes the Expert Library (polling, discovery, licence checks, structured calls, the parked clusters). The estimate is **9 build-agent days** (ch. 12). The exit is **AT-76** (the M22 part), **AT-79**, **AT-80**, the regime clause of **AT-81**, and the call-proposal half of **AT-73**, with AT-32/AT-50, AT-36, AT-39, AT-67, AT-68 and AT-85 kept green on every CI run.

Five kinds of work:

1. **LLM routes**: the live-role factory and its bake-off gate, the words phase, per-role tiers, the Workers AI adapter (disabled) and the local MiniLM classifier (shadow).
2. **Opinions**: the Committee trial (built, gated, off), pick reflections, the opinion lift meters and the promotion-request record.
3. **Expert Library**: polling and discovery behind licence checks, the monthly licence job, structured-call proposals and the re-screen of the 57 parked clusters.
4. **Regime and intraday, off or shadow**: FRED and prediction-market regime inputs in shadow, the whole-market intraday sweep (off), and the two data stubs.
5. **Configuration**: the §15.11.3 keys plus the V2 Committee and Expert Library keys that no milestone has registered yet.

## Hard constraints that apply to every M22 item

- **PRD-033 / AGT-011a / D-930.** No model output may create, size, change or cancel an order, a thesis-breaker or a rule. Every opinion, proposal and shadow reading is data that nothing on the trading side reads.
- **AU byte-identical (A-20).** AT-32/AT-50 replay hash and the three identity files (`tests/acceptance/v3/replay-hash.baseline.json`, `tests/market/au-constants.snapshot.json`, `worker/test/fixtures/au-slots.snapshot.json`) are never rewritten. The Worker slot table therefore gains no slot (`worker/test/auSlots.test.ts:22-35` compares every slot and the dispatchable workflow list).
- **IN and US off in production (AT-68).** Every new market-keyed table carries the 0035/0036 guard triggers (`scripts/db/gen-market-guard.mjs`); production `markets_enabled` stays `["AU"]`.
- **PRD-045.** $0; Turso within 20 % of the free plan; keyset reads with `rows-ok:` comments; no `OFFSET` (`tests/security/noOffsetPaging.test.ts`).
- **LLM spend inside the existing guards.** `llm_daily_budget_total` stays 240,000 (`src/lib/config/keys.ts:2154-2160`); every new call goes through `createRouter` (`src/lib/llm/router.ts:169`), whose budget check (`:289-301`), injection filter (`:200`), datamarking (`:115-121`), schema validation with one repair (`:306-358`) and grounding (`:342-346`) apply unchanged.
- **No secrets anywhere.** LLM keys live only in GitHub environment secrets; none on Vercel (LLM-077).
- **No internal codes in Owner-read text (D-922).** `npm run test:internal-codes` (M21) covers every new string; role names such as R6 never reach a page.
- **No staging; e2e only in CI** (PRD-046). Every Playwright spec is verified by the CI run.
- **Committee gated (BLD-041, D-938).** The switch stays refused until 10 steelman nights at 98 % citation validity (`src/lib/config/switchGuards.ts:15-31`, M21).
- **Research honesty (BLD-051, CXA-015).** Every measurement M22 adds is pre-registered (hypothesis, split, n, hash) before any computation, takes one look recorded in `holdout_look` (`db/migrations/main/0036_m20_markets_data.sql:163-169`), and publishes its result whatever it is.
- **One PR (PRD-048).** M22 opens no PR; decisions are listed for the single V3 PR.

---

## A. Build rules (ch. 12 V3)

- **BLD-049** M22 starts after M21 exits; at most 3 Sonnet builders at once in this milestone (orchestrator rule), never two on one file.
- **BLD-051** pre-registration and one look for every M22 measurement (bake-offs, the Committee trial, the regime inputs, the MiniLM comparison).
- **BLD-053** BUILD_SETUP §9 "V3" rows after every task.
- **BLD-054** decisions D-1400 upward in `docs/M22_design.md`; `docs/V2_decisions.md` regenerated by `scripts/ci/decision-index.mjs`.
- **BLD-055** this extract → design → tests first → Haiku review → Opus/Fable acceptance of the **F** items → `docs/M22_exit_evidence.md`.

## B. LLM routes (ch. 23 §23.1)

### B.1 LLM-077 Live-role factory and bake-off gate **F** (injection)
- **Intent:** one factory decides, per role, whether a live provider may be used; the answer is yes only when the Owner has listed the role in `llm_live_roles` and the newest bake-off report for that role is a PASS for a model that is in the roster. Run the R6 and words bake-offs in M22 against the free roster with the hostile set; a FAIL keeps the role rules-only with the reason in the report.
- **Current state:** production builds rules-only routers with no providers in three places: `src/lib/arena/cli.ts:389-400` (`rulesOnlyLlm`, words phase), `src/lib/steelman/cli.ts:46-60` (`rulesOnlySteelmanLlm`), and the bake-off harness (`src/lib/llm/bakeoff.ts:558`). The only live-adapter caller is `src/lib/llm/bakeoffCli.ts`. Roles in code are R1, R2, R3, R5, R6 (`src/lib/llm/budget.ts:7-8`); there is no R7. The roster (`src/lib/llm/roster.ts:100-271`) has no tier field and was checked on 2026-10-29. The bake-off scores a candidate PASS only when every category passes (`bakeoff.ts:625-626`; report summary `:726`), though each category's own pass is already computed per row (`categoryPass`, `:654-658`, stored at `:688`); categories are triage, faithfulness, json_validity, refusal, injection, classifier, steelman (`:22-43`); there is no words or judge category. `scripts/llm/bakeoff-review.mjs:13-14` lists reports and says the key arrives in M22. The workflow `llm-bakeoff.yml` is dispatch-only, runs only on `release` and checks out the approved production commit (SEC-108 c, `:38-70`). Past runs: D-177, D-180, D-182 (no model passed).
- **Keys:** `llm_live_roles` (default empty list; values from R1…R7 and words; each needs a PASS).
- **Acceptance:** AT-80 (empty list → no provider call in a recorded night; a listed role without a PASS stays rules-only and the health line says the bake-off has not passed; hostile item causes no instruction following).

### B.2 LLM-078 Workers AI adapter (disabled)
- **Intent:** add Cloudflare Workers AI as one more provider behind the same router, with its own daily neuron budget and the same schema path, so it inherits every defence; it stays off until the Owner does the set-up.
- **Current state:** live adapters exist for Google, Groq and OpenRouter only (`src/lib/llm/providers.ts:112-125`); M21 proved there is no Workers AI route (`tests/acceptance/v3/at76.test.ts:75`, `it.todo("M22")`).
- **Keys:** `llm_budget_workers_ai_daily` (default 0 = off; 0–10,000 neurons).
- **Acceptance:** AT-80 (budget 0 → no request), AT-77 (Workers AI off in a fresh configuration).

### B.3 LLM-079 Local MiniLM classifier (shadow)
- **Intent:** an optional, offline, CPU-only sentence-embedding classifier for announcement category and materiality, trained on the rule labels and the Owner golden set, compared every night against the rule classifier with the agreement published; it may only ever feed alert routing and wording, never filters, F6 or breakers. Model files are pinned by hash.
- **Current state:** nothing exists; the rule classifier is AGT-011 (Sentinel); golden labels arrive through the M21 labelling page (`golden_label`, `db/migrations/main/0038_m21_owner_tools.sql:91`).
- **Keys:** `minilm_enabled` (default off).
- **Acceptance:** AT-80 (shadow changes no filter, vote or breaker; AT-32 hash; agreement published).

### B.4 LLM-080 Per-role tiers
- **Intent:** each roster model gets a size tier and each role a preferred tier with a fallback order; the router uses the cheapest tier that passed that role's bake-off; the drop order is untouched.
- **Current state:** `RosterEntry` has no tier (`roster.ts:72-92`); the router walks `cfg.chain` or the registered order (`router.ts:176-184`).

### B.5 LLM-081 Words phase
- **Intent:** the nightly words phase (card reasons and review prose) goes through the factory and stays rules-only until its own bake-off passes; plain words with no internal codes and strategies by name are a pass criterion.
- **Current state:** `wordsDay` (`src/lib/learning/wordsStage.ts:281-420`) takes an injected `WordsLlm` with an R5 router and an R3 router factory (`:43-49`); the CLI always injects rules-only (`arena/cli.ts:564`). The D-922 scan exists (`scripts/ci/internal-codes.mjs`, M21 D-1325).

## C. Opinions (ch. 21 §21.1, §21.6; V2 ch. 03/05/07/09)

### C.1 AGT-145 Committee trial (M12), built, gated, off **F** (statistics)
- **Intent:** build the V2 Committee completely: nightly shortlist, bull, bear and risk statements (R6) and a judge rating (R7) over the evidence pack, full call records, the pre-registered permutation test, the trial page and the switch, proven with recorded-day fixtures in CI. The switch-on gate of BLD-041 is unchanged and ratings stay hidden during the trial.
- **V2 ids it pulls in:** AGT-132 (shortlist of the top new signals that passed filters, ties by code; one round; no effect on trading; forward only, never on past dates or in replays), LLM-066 (store prompt hash, pack id, provider, model id and version, parameters, raw response, parsed result; keep for the trial plus 12 months), VAL-111 (versioned pre-registration before the first rated night; within-night label permutations; pass needs sample, p and cost conditions; judge-model change splits the report; PASS/FAIL/INCONCLUSIVE; the Committee switches itself off after a result), ARN-105 (outcomes from the signal ledger at the family exit or the horizon), UXN-289 (trial page under Strategies › Experiments for Owner and Editor, Viewer masked), UXN-290 (no rating on cards, picks or e-mails during the trial), UXN-291 (audited Owner switches), LLM-010 (bull and bear from different families where possible; the judge is never the bear's model), LLM-063/064/065 (bake-off items, evidence-only claims, no URLs or instructions in output).
- **Current state:** `committee_enabled` exists with its M21 guard (`keys.ts:1737`, `switchGuards.ts:15-31`); no Committee code, table or page; `opinion_track.kind` already allows `committee` (`0019_cortex.sql:339`); the evidence pack exists (`src/lib/steelman/pack.ts:42`); the signal ledger is `ledger_row` (`0008_agents.sql:496`, forward rows by `src/lib/agents/forwardLedger.ts`); the drop order lists `committee` with no cap (`src/lib/llm/dropOrder.ts:9-31`).
- **Keys (V2 ch. 15, not yet registered):** `llm_budget_committee_daily` 40,000 (0–60,000), `committee_shortlist` 3 (0–5), `committee_horizon_sessions` 20 (5–60, frozen at trial start), `committee_trial_sessions` 126 (63–252, frozen), `committee_min_settled` 150 (100–500, frozen), `committee_permutations` 20,000 (5,000–100,000, fixed), `committee_call_record_retention_months` trial + 12 (6–36).
- **Acceptance:** AT-76 (switch refused until the gate; with it on in a recorded-day CI run the AT-36 synthetic trial behaves as V2 says), AT-36 (random labels not significant; correlated labels PASS; an edited pre-registration INVALID with an alert; a judge change with a sign flip never PASS; past-date run refused; ratings never shown).

### C.2 AGT-146 Pick reflections
- **Intent:** one grounded note per settled pick, written by R6 within the V2 budgets and first in the drop order, a monthly "Unproven notes" section in the Evening Review, and writes only to `pick_reflection`; rules-only production shows "not available tonight" and the path is mock-proven in CI.
- **V2 ids:** AGT-134 (at most 80 words, grounded in the publication record, the outcome and vs-market figure, the thesis-breaker history and the steelman points), UXN-288 ("Looking back (AI-written)" under the settled pick).
- **Current state:** `pick_reflection` table exists, append-only and market-guarded (`0021_steelman.sql:165-186`, `0035_m19_market_guard.sql:840-851`); no writer and no reader in `src/`; `pick_reflection_enabled` is on by default (`keys.ts:1402`); the drop order gives reflections no cap of their own (`dropOrder.ts:28-30`). V2 ch. 03 said R3; V3 says R6 (conflict, see the design).
- **Acceptance:** AT-76 (reflections write only `pick_reflection`, queue under budget, AT-32 hash identical with reflections on and off).

### C.3 AGT-148 Opinion measurement and promotion request
- **Intent:** keep measuring lift for every opinion kind with an n-progress meter; when a kind meets the CTX-060 bar (enough settled cases, measured lift, stable across two judge versions) write one Owner item saying a new spec version and an Owner decision are needed. No approve button; nothing else changes. A static test shows no trading, sizing, breaker or rule-version writer reads any opinion table.
- **Current state:** `opinion_track` rows exist for the steelman (`src/lib/steelman/opinion.ts`, `src/lib/cortex/store/labels.ts:140-190`); `opinion_min_n` 150 (`keys.ts:1189`); no lift meter and no Owner-item table (Owner items are `app_log` warnings today, e.g. `src/lib/cortex/stage.ts:1020-1031`).
- **Acceptance:** AT-73 (opinion and proposal tables have no path to trading; shared static test), AT-32 extended.

## D. Expert Library, full (ch. 21 §21.2; V2 ch. 08)

### D.1 KB-082 Polling and discovery **F** (security: third-party fetch)
- **Intent:** build the polling job (feeds, YouTube channel feeds, own-site pages with robots honoured, conditional requests, daily caps), discovery of new experts, R1 triage and R2 extraction, and the Sources page, and run the AT-39 fetch clauses in CI on fixture feeds. A source is fetched only when its licence row says enabled or owner-accepted-risk; every seed source starts unchecked and is not fetched. X stays manual paste.
- **V2 ids:** DAT-228 (daily poll, weekly discovery, caps, R1 triage then R2 extraction of positives, per-host limits, honest User-Agent), DAT-229 (candidates from co-mentions and allowed search APIs, red-flag checks, Owner approval, tracked cap), DAT-230 (poll frequency from the scorecard), LLM-067 (R1 triage, R2 extraction into a schema with spans not stored), LLM-068 (own budget, dropped before the Committee; the queue waits), LLM-069 (a person checks every extracted claim), UXN-296 (discovery candidates page with approve, dismiss, snooze).
- **Current state:** the fetch rules are built and network-free (`src/lib/kb/fetchRules.ts:1-12`, `pollFeeds` at `:202`, robots `:37-64`, validators `:85-88`); M13-lite deferred the job, discovery, priority, extraction and the page (D-510, `docs/M13L_design.md:10`); `expert` rows may change status and `poll_json` only (`0022_experts.sql:36-44`); the register has eight expert channel rows, three `pending` and five manual-only `disabled` (`scripts/ci/licence-register.mjs:66-129`, D-522); the seed is private and not imported in production (D-654).
- **Keys:** `expert_poll_items_daily` 150 (M21, `keys.ts:1762`); V2 keys not yet registered: `llm_budget_experts_daily` 30,000 (0–60,000), `expert_extract_daily` 20 (0–60), `expert_tracked_max` 150 (20–300).
- **Acceptance:** AT-79 (caps, robots and conditional requests honoured; unchecked or no sources not fetched), AT-39 (fetch clauses).

### D.2 KB-083 Expert source licence checks
- **Intent:** a monthly job records, per expert source, the terms link, robots status, whether automated summarising is allowed (yes, no, unknown) and the date, and sets the source's status; unknown means headline and link only. The build runs the first check for every seed source and records the results as [VERIFY]; the Owner's acceptances go into the PR.
- **Current state:** `expert.licence_status` is about regulatory registration, not terms (`0022_experts.sql:23-24`, D-520); `source_register` has `pending/enabled/disabled` and no accepted-risk value (`0004_au_data.sql:244-254`); no per-expert-source licence store.
- **Acceptance:** AT-79 (the monthly job records statuses).

### D.3 KB-084 Structured expert calls
- **Intent:** a call gets code, direction, date, horizon and price basis either typed by the Owner in the review form or proposed from the stored summary by R1 extraction; a proposal is tracked only after the Owner confirms it with one click. The 28 seed calls are re-extracted as proposals; settlement tracks confirmed calls only.
- **Current state:** `expert_call` is append-only and needs a `call` claim (`0022_experts.sql:434-458`); no seed call was structured enough to import (D-543); settlement is `settleCalls` (`src/lib/experts/calls.ts:186`); the review queue is `src/app/(app)/reviews/experts/queue/` (`page.tsx`, `QueueForm.tsx`, `actions.ts`).
- **Acceptance:** AT-79 (a proposal is not tracked until confirmed), AT-73 (proposal path shares the no-path test).

### D.4 KB-085 Parked technique clusters **F** (validation)
- **Intent:** re-screen the 57 parked clusters: each is either written as a new structural rule (the grammar gains relative-to-sector comparison, multi-session persistence counts and cross-series ratios, each a schema-versioned addition documented in `docs/rule_schema.md`) and then enters development screening with BH-FDR as a counted hypothesis, or stays parked with a one-line reason. Target at least 20 expressed; report the rest, never force.
- **Current state:** the rule schema is version 1 (`src/lib/agents/families/ruleSchema.ts:42`, loader check `:868-869`; `docs/rule_schema.md` generated by `scripts/learning/genRuleSchema.mjs`); a cluster is screenable only as a parameter set of F1…F6 (`src/lib/experts/fit.ts:1-3`); park reasons per D-515/D-606; `cluster` and its `family_fit_json` are append-only (`0022_experts.sql:107-136`); 3 of 60 clusters fit (D-571). Private seed tally (counts only, read 2026-11-17): of 60 clusters, 51 are end-of-day testable, 4 need new data, 4 are not testable, 1 needs intraday.
- **Acceptance:** AT-79 (each cluster expressed with its rule or parked with its reason; at least 20 expressed or the shortfall explained).

## E. Regime and intraday (ch. 23 §23.2, ch. 21 §21.3)

### E.1 DAT-248 FRED and prediction-market regime inputs, shadow
- **Intent:** macro series and public prediction-market probabilities on named macro events become regime gate and veto inputs only, never score inputs; they stay in shadow until the regime rule with them beats the rule without them on a pre-registered one-look test, and the Cortex page shows both readings meanwhile.
- **Current state:** the regime is deterministic from index bars (`src/lib/agents/regime.ts:1`, `regimeSeries` `:128`); FRED is a pending register row with no AU fetcher (`src/lib/data/schema.ts:189-196`) and `macro_series` rows with source `fred` are refused unless US is enabled (`0037_m20_macro_sources.sql`, `src/lib/data/sources/macroStore.mjs:1-10`); AU macro comes from the M18 RBA/ABS fetchers behind the Owner's `MACRO_FETCH` variable (D-973); no prediction-market source exists.
- **Keys:** `regime_altinputs_enabled` (default off; display both readings when on; gates only after the one-look pass).
- **Acceptance:** AT-81 regime clause (inputs change no gate while off and only gates, never scores, when on).

### E.2 DAT-249 social sentiment and DAT-250 real-time/Level-2, stubs
- **Intent:** both stay out with their recorded reason (terms, manipulability, no free licensed feed); nothing is built except a tested stub.
- **Current state:** the deferred-instrument stubs pattern exists (`src/lib/deferred/instruments.ts`, M21 ARN-124).

### E.3 AGT-147 Whole-market intraday sweep, off
- **Intent:** extend the M17 scan from catalyst-first codes to all U1/U2 codes in batches, only when the sweep switch is on and the batch quote endpoint is accepted in the register; budget per slot inside the existing quote budget, armed picks first.
- **Current state:** scan universe `src/lib/intraday/universe.ts:1-30`; scan `src/lib/intraday/scan.ts`; the batch quote endpoint was not adopted (`docs/M13L_design.md:383`); keys `intraday_sweep_enabled` and `intraday_sweep_requests_per_slot` exist with no reader (`keys.ts:1738-1746`, `at76.test.ts:76` todo).
- **Acceptance:** AT-77 (sweep off in a fresh configuration).

## F. Acceptance tests

| AT | What M22 must show | Ids |
|---|---|---|
| **AT-76** (M22 part) | AT-36 behaviour with the switch on in a recorded-day CI run; reflections write only their table, under budget; AT-32 hash equal with reflections on and off; the M21 `it.todo("M22")` lines replaced | AGT-145, AGT-146 |
| **AT-36** (V2, in the V3 gate) | synthetic trial: random labels, correlated labels, edited pre-registration, judge change with sign flip; past-date refusal; no rating on cards, picks, e-mails | AGT-145, VAL-111 |
| **AT-79** | fixture feeds honour caps, robots, conditional requests; unchecked/no sources not fetched; monthly licence job; proposal tracked only after confirm; 57 clusters reported, ≥ 20 expressed or explained | KB-082…KB-085 |
| **AT-39** (fetch clauses) | items recorded with link, title, time, our summary; disallowed page not fetched; conditional requests; caps; hostile text inert | KB-082 |
| **AT-80** | empty live list → 0 provider calls in a recorded night; listed role without PASS → rules-only and "bake-off not passed"; Workers AI budget 0 → no request; MiniLM shadow changes nothing and publishes agreement; hostile item → no instruction following | LLM-077…LLM-081 |
| **AT-81** (regime clause) | alt inputs inert while off; gate-only when on | DAT-248 |
| **AT-73** (shared part) | proposals have no path to trading, cards or e-mails; the call-proposal fixtures (valid, incomplete, duplicate, hostile) stored only as proposals | KB-084, AGT-148 |
| **AT-77** (M22 clauses) | Workers AI disabled and the sweep off in a fresh configuration | LLM-078, AGT-147 |
| **AT-32/AT-50, AT-67, AT-68, AT-85** (kept) | identity unchanged; no market literal; new tables guarded; every new AT in the test map | all |

## G. Configuration keys

| Key | Default | Bounds | Edit | Source | State |
|---|---|---|---|---|---|
| `llm_live_roles` | empty | subset of R1, R2, R3, R5, R6, R7, words | O | LLM-077 | new |
| `llm_budget_workers_ai_daily` | 0 | 0–10,000 neurons | O (Owner set-up) | LLM-078 | new |
| `minilm_enabled` | off | on/off | O | LLM-079 | new |
| `regime_altinputs_enabled` | off | on/off | O | DAT-248 | new |
| `news_assess_per_run` | 40 | 20–200 | O | DAT-251 b | exists (M18, `keys.ts:337`) |
| `source_hosts` (+ asic.gov.au, ssrn.com) | list | — | fixed | DAT-253 | exists (M18) |
| `committee_enabled` | off | on/off, gated | O | AGT-145 | exists (M21) |
| `intraday_sweep_enabled`, `intraday_sweep_requests_per_slot` | off, 5 | on/off, 0–20 | O | AGT-147 | exist (M21); reader in M22 |
| `expert_poll_items_daily` | 150 | 0–500 | O | KB-082 | exists (M21); reader in M22 |
| `llm_budget_committee_daily` | 40,000 | 0–60,000 | O | LLM-061 | new (V2 key) |
| `committee_shortlist` | 3 | 0–5 | O | AGT-132 | new (V2 key) |
| `committee_horizon_sessions` | 20 | 5–60, frozen at start | O | ARN-105 | new (V2 key) |
| `committee_trial_sessions` | 126 | 63–252, frozen | O | VAL-111 | new (V2 key) |
| `committee_min_settled` | 150 | 100–500, frozen | O | VAL-111 | new (V2 key) |
| `committee_permutations` | 20,000 | 5,000–100,000 | fixed | VAL-111 | new (V2 key) |
| `committee_call_record_retention_months` | trial + 12 | 6–36 | O | LLM-066 | new (V2 key) |
| `llm_budget_experts_daily` | 30,000 | 0–60,000 | O | LLM-068 | new (V2 key) |
| `expert_extract_daily` | 20 | 0–60 | O | DAT-228 | new (V2 key) |
| `expert_tracked_max` | 150 | 20–300 | O | DAT-229 | new (V2 key) |

The role caps already registered (R1 60,000, R2 50,000, R3 25,000, R5 10,000, R6 20,000; `keys.ts:192-195,1394`) plus Committee 40,000 and Experts 30,000 sum to 235,000, inside the 240,000 daily total.

## H. Spec decisions that bind M22 (ch. 00 V3)

D-930 (measurement and a promotion record only, no order path) · D-936 (Workers AI as an adapter, disabled until the Owner's set-up) · D-937 (DAT-249/250 stubs) · D-938 (Committee gated by BLD-041; ratings hidden) · D-939 (licence-gated polling; seed sources start unchecked) · D-945 (alt inputs gate-only, shadow until a one-look pass) · D-946 (MiniLM shadow; alert routing and text only).

## I. [VERIFY] and [PROPOSED] items the spec marks for M22

1. LLM-077 roster refresh (the free roster after LLM-070) [VERIFY].
2. LLM-079 model size budget of at most 100 MB [VERIFY].
3. DAT-248 prediction-market terms (public read, free, no account) [VERIFY].
4. KB-083 first check of every seed source, recorded as [VERIFY] rows.
5. AGT-147 whether the accepted delayed-quote basis covers the batch endpoint [VERIFY].
6. KB-085 target of 20 expressed clusters [PROPOSED].
7. V2 `llm_daily_budget_total` against current free-tier limits [VERIFY] (carried from V2 LLM-061).

## J. Gaps found while reading (resolved in the design)

1. **Live bake-off vs the approved-commit rule.** `llm-bakeoff.yml` runs only the approved production commit (SEC-108 c), so the new words and judge categories cannot run live before the V3 merge; the R6 category already exists on that commit.
2. **No R7 and no Committee or Experts budget bucket** in `budget.ts` and `LlmParams` (`src/lib/agents/params.ts:351`).
3. **Reflection role:** V2 ch. 03 and D-496 say R3; V3 AGT-146 says R6.
4. **Worker slots are frozen** by the AU slot snapshot, so DAT-228's own 06:30 schedule and the monthly licence job need an existing dispatched workflow.
5. **Workers AI "binding"** assumes a Worker caller, but every router call runs in GitHub Actions.
6. **FRED for AU:** the spec says it is already fetched for AU; in the tree it is a pending row and its writes need US enabled.
7. **Opinion kinds:** `opinion_track.kind` allows only committee and steelman; reflections are written after the outcome, and proposed angles are M23.
8. **Per-expert licence rows vs SEC-110:** the public register cannot hold expert names or handles (D-654 name grep).
9. **The 57 clusters and 28 calls live only in the private seed**, which production has not imported.
10. **AT-32 complement proof:** `tests/acceptance/v2/at32Steelman.test.ts:55-70` hashes every table except a named own-set; new nightly opinion and shadow tables must join that set deliberately.
11. **D-922 vs role names:** health and configuration text must name roles in plain words.
12. **MiniLM training data:** no golden labels exist yet; rule labels exist only in production and the local history extract.

## K. Not in M22

CXA-007 LLM-proposed angles and the rest of AT-73 (M23); CXA-008 paraphrase harness and the golden-set threshold logic (M23); VAL-120 intraday meter (M23); any order path from an opinion (D-930); switching any role live in production (an Owner edit after a PASS); the Owner's seed import, register acceptances and Workers AI set-up (post-merge steps).

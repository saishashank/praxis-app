# M13-lite requirements: Expert seed import and screening

Delta extract from `Requirement/v2/spec/08_expert_library_delta.md` (draft V2-1, 2026-10-21; PRD-034…036, KB-071…080, DAT-227…230, LLM-067…069), ch. 09 V2 (UXN-292…296), ch. 12 V2 (M13 row, BLD-044, BLD-046), ch. 14 V2 (AT-39…AT-41), ch. 15 V2 (expert keys), Owner decisions O-64, O-69, O-73 (ch. 00 V2). Seed data: `Requirement/v2/docs/23_experts/` (100 experts, 350 claims in 5 batches) and `docs/24_expert_synthesis.md` (60 clusters K-001…K-060). Continues from M11-lite on `build`.

## Scope

M13-lite is the seventh V2 milestone (BLD-046: M8.1, M14, M15, M16, M17, M11-lite, **M13-lite**, M12). The ch. 12 row says: Expert seed import and screening; polling and discovery (DAT-228/229) deferred. It loads the researched experts, claims and clusters into the app once (Owner-run script), lets the Owner or an Editor check claims, screens testable clusters on the development split with BH-FDR, and proposes survivors as Lane B challengers. Nothing here can place an order (PRD-035).

Marks: **build** = build in M13-lite. **exists** = already in the code, reuse. **deferred** = not in M13-lite, with the reason.

### Principle and licensing (8.V2.1)
| ID | Plain words | Mark |
|---|---|---|
| PRD-034 | Popularity is not skill. Every expert method enters as an untested L0 hypothesis and earns weight only through screening, Lane B (KB-040, ARN-085, VAL-110) and forward labels. Standing comes from tested methods and calls, never reach. | build (rule enforced in model, ranking, UI) |
| PRD-035 | No expert content creates, changes or cancels an order, thesis-breaker or rule. A method trades only as a deterministic rule version (KB-010) that passes VAL-110. | build (guard plus AT-41 replay) |
| PRD-036 | Store per item: link, title, author, platform, time, own summary of 80 words or fewer, claims in own words. Never full text, transcripts or video. Quote 15 words or fewer, one per item. Each platform in the licence register (DAT-120) before automated use. Manual-only platforms: Owner pastes a link, only public metadata is read. | build (schema limits, import validator, register rows) |

### Data model (8.V2.2)
| ID | Plain words | Mark |
|---|---|---|
| KB-071 | Expert record: id, name, platforms and handles, home URLs, markets, focus tags, licence status, red flags with links, status (candidate/tracked/paused/retired), tier (core/discovered), audience size and date, polling settings, scorecard. Seed: about 100 core. | build (tables, seed import, markdown mirror under `knowledge/experts/`) |
| KB-072 | Source item record: expert, URL, platform, title, published_at, ingested_at, content hash, own summary, kind, extraction status. Idempotent on URL plus hash. | build for the table and the seed items; polling that creates new items is deferred |
| KB-073 | Claim record: type (method/event_link/call/risk_rule), plain statement, formalisation over the KB-010 vocabulary, claimed edge (labelled "claimed"), testability, cluster id, evidence grade (starts L0), status chain extracted to owner_checked to formalised to screened to challenger to promoted/rejected/parked. | build |
| KB-074 | Scorecard, deterministic and never LLM: claims per status, share of testable method claims passing screening and VAL-110, calls tracked vs market with luck check. Below `expert_min_scored` shows "not enough tested claims". Wording per VAL-101. | build |
| KB-075 | Technique clusters: same-meaning claims grouped, canonical formalisation, supporting and contradicting experts, external research evidence (supports/mixed/contradicts/none, with links). Proposed by an LLM (R2), confirmed by Owner or Editor. | build for seed clusters and confirm/merge actions; LLM cluster proposal deferred |

### Testing pipeline (8.V2.3)
| ID | Plain words | Mark |
|---|---|---|
| KB-076 | Weekly deterministic screening of each formalised, `testable_eod` cluster: fixed-notional signal ledger on the development split only (ARN-082), v1 cost model, matched C2 controls (ARN-081). No trial budget used. BH at `expert_screen_fdr` across the run. Reported descriptive (ARN-062 wording), grade at most L1. Ranked by lower 90 % bound of net excess over controls. | build (reuses `src/lib/stats/multiplicity.ts`, `splits.ts`, `cells.ts`) |
| KB-077 | At most `expert_challengers_per_week` top survivors proposed as Lane B challengers: of the closest v1 family when it fits, else a new lineage (FAM-101, own budget m = 20). Each is an ARN-085 trial, obeys KB-042 (8 challengers per market). Then v1 rules apply unchanged. | build (hooks into `src/lib/learning/challengerGenerator.ts` and lifecycle) |
| KB-078 | F7 "Expert consensus" proposed once at least `f7_min_clusters` clusters reach L2. Entry when 2 or more L2 clusters of different experts agree on a code at the same close. UNVALIDATED, challenger only. | build the proposal logic and gate; it cannot fire until 3 clusters are L2 (not before real forward data) |
| KB-079 | Monthly Owner report of `vocabulary_gap` claims: "N experts rely on indicator X". Adding an indicator is an Owner-approved build change. | build (report from seeded gaps; docs/24 lists them) |
| KB-080 | `call` claims on codes in an active market's universe are paper-tracked like picks (ARN-095 mechanics, vs market per ARN-103), scored into the scorecard, never traded. Other markets: stored only. | build the store and tracker if the ARN-095 forward ledger can be reused; else store only (see Q7) |

### Ingestion and discovery (8.V2.4)
| ID | Plain words | Mark |
|---|---|---|
| DAT-227 | Allowed automated channels (RSS/Atom, YouTube channel feeds, own-site pages if robots and terms allow); X, Instagram, TikTok, Facebook, LinkedIn manual-only. Each in DAT-120. | build the licence-register rows only (the sources are named, `status` not-in-use); no fetcher |
| DAT-228 | GitHub Actions polling job daily 06:30 Melbourne plus weekly discovery run; conditional requests; caps; R1 triage; R2 extraction. | **deferred** (ch. 12 M13-lite row; O-69: expert polling deferred) |
| DAT-229 | Weekly discovery of candidate experts (co-mentions, platform search), red-flag checks, Owner approval. | **deferred** (same row; also needs [VERIFY] quotas) |
| DAT-230 | Polling priority driven by scorecard. | **deferred** (nothing is polled). The priority function may be written as a pure function; not wired. |

### LLM use (8.V2.5)
| ID | Plain words | Mark |
|---|---|---|
| LLM-067 | R1 triage, R2 claim extraction (JSON schema, grounding LLM-034/064, untrusted text LLM-035/065), R2 cluster matches. | **deferred** (no new items to extract; the seed claims were extracted in V2-1 research). Reuse `src/lib/llm/grounding.ts` later. |
| LLM-068 | `llm_budget_experts_daily` 30,000 tokens, dropped before the Committee. | **deferred** (no LLM calls in M13-lite; key added with the polling milestone) |
| LLM-069 | A claim becomes `owner_checked` only after Owner or Editor confirms or edits it. Only `owner_checked` claims are formalised and screened. | build (queue UI, status guard in the screening query) |

### Pages (8.V2.6, ch. 09 V2)
| ID | Plain words | Mark |
|---|---|---|
| UXN-292 | Experts directory: name, platforms, focus, markets, status, claims by status, scorecard summary, red flag, last item date. Filters; sort by evidence, never by followers. Audience only on detail, "reach, not skill". | build |
| UXN-293 | Expert detail: profile, links, licence, red flags, items (our summary, link out), claims, clusters, scorecard with n and intervals, calls table. | build |
| UXN-294 | Techniques (clusters): statement, formalisation, experts for/against, external evidence grade with links, testability, screening result, challenger/promotion status. Category filter (candlesticks, chart patterns, trend/momentum, mean reversion, volume, events/news, macro, risk rules). | build |
| UXN-295 | Claims review queue (Owner/Editor): source link, confirm/edit/reject/merge, bulk confirm per expert. | build |
| UXN-296 | Discovery candidates (Owner): approve/dismiss/snooze, audited. | **deferred** (needs DAT-229). The `candidate` status exists in the model. |

## Acceptance tests

AT-39…AT-41 are the three tests listed for M13 in ch. 12. Pass conditions are from ch. 14 V2 and the ch. 08 acceptance list. The parts that need polling are marked.

| ID | Pass condition (spec) | Evidence for M13-lite |
|---|---|---|
| AT-39 Expert ingestion | Fixture feeds (RSS, YouTube feed, robots-disallow page, manual-only X link): items recorded with link, title, time, own summary, no full text; disallowed page not fetched; X metadata only after Owner paste; conditional requests; daily caps; hostile text does not alter extraction rules. | **Partly deferred.** Build and run the parts that need no fetcher: (a) schema test that no column can hold full text and summaries are limited to 80 words; (b) import test with a seed item holding a long body, asserts rejection; (c) idempotent re-import on URL plus hash; (d) registry test: X/Instagram/TikTok/Facebook/LinkedIn rows are manual-only. Feed, robots, conditional-request, cap and hostile-text clauses are deferred with DAT-228 and LLM-067; stated in the exit evidence and the PR list. |
| AT-40 Claims to screening | 40 fixture clusters with planted true/false edges on recorded data: only `owner_checked` claims screened; development split only; BH-FDR; planted-edge clusters rank top; no ARN-085 trial before a challenger proposal; at most 2 proposals per week; F7 only with 3 or more L2 clusters. | Full. (a) Synthetic ZZ fixture of 40 clusters with planted edges; (b) test that unchecked claims are skipped; (c) access spy: no validation or holdout row read (TST-109 pattern); (d) BH at q 0.10 applied once per run, rank order of planted edges; (e) trial ledger count unchanged until a proposal, then +1 each, max 2 per week; (f) F7 gate test with 2 and 3 L2 clusters. |
| AT-41 Scorecard and no trade path | High-reach expert with failed claims; low-reach expert with passing claims; tracked calls: directory order follows evidence; calls paper-tracked with vs market and luck check; AT-32 replay shows no order or rule difference from any expert data before a promotion. | Full for order and scorecard. (a) Directory sort test with the two fixture experts and "not enough tested claims" below `expert_min_scored` (2 scored claims); (b) calls tracked per Q7; (c) replay test: same inputs with and without expert tables give identical orders and rule versions (grep test that no module under `src/lib/arena` or `src/lib/agents` imports the expert module). |
| Seed import (extra, from this extract) | Not a spec AT; needed to prove the Owner-run import. | Dry-run and write tests on a synthetic seed folder: counts, rejects bad rows naming file and field, refuses a folder inside the repo, safe to re-run. Real counts recorded as numbers only in the exit evidence. |

Evidence files: `docs/M13L_exit_evidence.md`, test reports under `docs/test-reports/`.

## Configuration keys

From ch. 15 V2 (the expert block). Bounds are the spec's; format as in `src/lib/config/keys.ts` (no expert key exists yet).

| Key | Default | Bounds | Class | Rule | Mark |
|---|---|---|---|---|---|
| expert_min_scored | 10 | 5 to 50 | O | KB-074 | build |
| expert_screen_fdr | 0.10 | 0.05 to 0.20 | O | KB-076 | build |
| expert_challengers_per_week | 2 | 0 to 4 (within KB-042) | O | KB-077 | build |
| f7_min_clusters | 3 | 2 to 10 | O | KB-078 | build |
| expert_poll_items_daily | 150 | 0 to 500 | O | DAT-228 | deferred |
| expert_extract_daily | 20 | 0 to 60 | O | DAT-228 | deferred |
| expert_tracked_max | 150 | 20 to 300 | O | DAT-229 | deferred |
| llm_budget_experts_daily | 30,000 | 0 to 60,000 | O | LLM-068 | deferred |

`llm_daily_budget_total` 240,000 (ch. 15) already covers the 30k expert share; M13-lite spends none of it. Each added key needs its row in `docs/config-reference.md` (generated by `scripts/ci/config-reference.mjs`) and a test row. See Q9 for the deferred four.

## Licensing and data constraints

- **SEC-110.** Only `Requirement/v1/spec/` and the brand files may be copied into `praxis-app`. `docs/23_experts/` and `docs/24_expert_synthesis.md` stay in the private data repo. The public repo holds code, schema, the import script, a synthetic ZZ seed and docs of the format only. No expert name, handle, URL, claim text, cluster text, score or red-flag text from the real seed in any public file, test, fixture, log or PR text. Exit evidence shows counts only.
- **Import path.** An Owner-run script, same pattern as `scripts/cortex/import.mjs` (D-267): it takes a folder outside the repo, refuses one inside it, validates every file before writing, names file and field (never a value) in errors, prints counts only, is insert-or-ignore on keys, has `--dry-run`, and needs `TURSO_MAIN_URL` and `TURSO_MAIN_TOKEN`. The Owner (or an offline converter in the private data repo, like `tools/m15`) turns `docs/23` and `docs/24` into the artefact folder (format `praxis-expert-seed/1`).
- **Where the live data lives.** Expert tables in the main database (private by deployment). The markdown mirror under `knowledge/experts/` goes to the private data repo through the existing KB archive (`src/lib/kb/archiveCli.ts`, which only writes under `knowledge/` in the private repo), never to `praxis-app`.
- **PRD-036 limits in the seed.** Claims are paraphrases (the research notes say quotes were not used). Claimed edges are numbers stated by the author and labelled "claimed". Per-item summaries are 80 words or fewer, our own. Quotes are 15 words or fewer, one per item, or none. No transcripts or page text stored. Validator rejects over-long summary and any field larger than a set cap.
- **Licence register (DAT-120).** Add rows for each platform class in DAT-227 (RSS/blogs, YouTube feeds, expert own sites) as `not in use` with terms [VERIFY], and manual-only rows for X, Instagram, TikTok, Facebook, LinkedIn. The register is a migration seed (`source_register`, regenerated into `docs/source-licence-register.md` by `scripts/ci/licence-register.mjs`); a new migration adds the rows and the generated doc is re-run. Nothing is fetched in M13-lite, so nothing needs to be "in use".
- **Licence and registration status of experts** (ASIC, SEBI, SEC/FINRA, KB-071): `00_final_100.md` says no checks were done for AU/IN experts. M13-lite stores the field as "unchecked". Looking them up is a manual or later task (DAT-229 red-flag checks are deferred). Red flags in the seed are stored as text with source links; shown to Owner and Editor only; Viewer sees the red-flag icon (open question Q8).
- **$0 (O-64).** No paid source, API or LLM call. Screening uses recorded Praxis data only. No outside request at run time.
- **PRD-035 / no trade path.** Expert tables are read by the screening job and the pages only. Arena, orders, rules, thesis-breakers do not import them. A cluster reaches trading only as a Lane B challenger counted in ARN-085.
- **Role and masking.** Directory and detail: Owner, Editor, Viewer read per existing role table (`src/lib/auth/permissions.ts`); claims queue: Owner and Editor; scorecards and screening results are descriptive with the VAL-101 "not a forecast" line. Amounts in screening results are percentages, no money.
- **Fixtures.** Synthetic experts, ZZ codes, invented claims. Real names never in tests.

## What exists and what is missing

| Need | Exists (path) | Missing |
|---|---|---|
| Expert tables, claims, clusters | none (`grep` finds no expert module; only a label in `src/app/(app)/home/familyMap.ts` and a reference in `src/lib/cortex/angles/d10.ts`) | Migration `0020_experts.sql` (next after `db/migrations/main/0019_cortex.sql`; confirm the number at start), schema module under `src/lib/experts/` |
| Seed importer pattern | `scripts/cortex/import.mjs`, `import.d.mts`, `README.md`, tests in `tests/cortex` | `scripts/experts/import.mjs`, README, converter spec for `docs/23`/`docs/24` (private side) |
| Seed data | private: `Requirement/v2/docs/23_experts/00_final_100.md` (100 experts: 88 tracked, 12 reference), `claims_B1…B5.md` (350 claims: 81, 76, 67, 59, 67; fields id, type, statement, formalisation, vocabulary_gap, testability, claimed_edge, cluster_hint), `24_expert_synthesis.md` (60 clusters K-001…K-060 with category, canonical formalisation, supporting claims, evidence grade, priority; 8 claims unclustered; 32 clusters plainly `testable_eod`, more with variants) | A parser or converter into the artefact format; mapping of claim ids and cluster ids; item records from the "Sources fetched" lists (Q3) |
| Rule vocabulary (KB-010) | `src/lib/agents/families/ruleSchema.ts`, `src/lib/agents/indicators.ts`, `docs/rule_schema.md`, `src/lib/agents/families/rules.ts` | A path from a seed formalisation (prose in docs/24) to a rule over RULE_FIELDS; seed formalisations are not in schema form (Q4) |
| Screening statistics | `src/lib/stats/multiplicity.ts` (`benjaminiHochberg`), `splits.ts`, `cells.ts`, `bootstrap.ts`, `stationaryBootstrap.ts`; development view in `src/lib/learning/challengerGenerator.ts` (`DevelopmentView`); weekly runner `src/lib/learning/weeklyRun.ts`, `weeklyStages.ts`; config `comparisons_fdr_q` | A fixed-notional signal-ledger screener over the development split with C2 matched controls, an expert stage in the weekly run, access spy test |
| Challenger and trials | `src/lib/learning/challengerLifecycle.ts`, `challengerEvidence.ts`, `promotion.ts`, `ruleVersions.ts`; trial budget `trial_budget_per_lineage` in `src/lib/agents/params.ts`; `/strategies/ideas` page | Cluster to challenger proposal (new lineage vs closest family), weekly cap, KB-042 check, F7 lineage proposal gate |
| LLM grounding | `src/lib/llm/grounding.ts`, `injection.ts`, `budget.ts`, `roster.ts` (roles R1, R2, R3, R5) | Nothing needed now (LLM deferred) |
| Pages | Knowledge area is not in `src/lib/ui/nav.ts`; patterns in `src/app/(app)/strategies/*`, `cortex/page.tsx`, `src/components/ui/*`; loaders in `src/lib/ui/loaders/` | Nav entry (check ch. 16 V2 nav model), four pages UXN-292…295, loaders, actions for confirm/edit/reject/merge with audit |
| Roles | `src/lib/auth/permissions.ts` (owner, editor, viewer), `src/lib/auth/audit.ts` | Permission names for expert read and claim review |
| Licence register | `source_register` seeds in `db/migrations/main/0004_au_data.sql` and later, `scripts/ci/licence-register.mjs`, `docs/source-licence-register.md` | New migration rows for DAT-227 channels; regenerate the doc |
| KB markdown mirror | `src/lib/kb/documents.ts`, `mapping.ts`, `render.ts`, `archiveCli.ts` (writes only under `knowledge/` in the private repo) | `knowledge/experts/` document builders and mapping entries |
| Calls tracking | forward ledger `src/lib/agents/forwardLedger.ts`; ARN-095 and ARN-103 mechanics come from M11-lite (picks vs market) | Reuse or store-only (Q7) |
| Config keys | `src/lib/config/keys.ts` | Four keys (Section above); docs and tests |
| Decision log | `docs/07_decision_log.md` (last row D-252 in this file; M15/M16 decisions D-3xx are in their design docs) | New decisions D-421 onward |
| Polling job, feeds, discovery, LLM extraction | none | Deferred (DAT-228/229/230, LLM-067/068) |

## Findings from the spec

- Ch. 12 BLD-044 says M13 depends on M11 (evidence and citation machinery, budgets). With extraction deferred, M13-lite needs only M11-lite for the picks-vs-market tracker (ARN-103) if calls are tracked.
- The M13 row lists polling/discovery inside M13; BLD-046 defers DAT-228/229 (and O-69 defers expert polling). DAT-227 and DAT-230 and LLM-067…068 are not named by BLD-046; this extract defers them too because they exist only to serve polling and extraction.
- AT-39 is mostly about polling. M13-lite cannot meet it in full; ch. 14 lists it in the go-live gate. Decision D-423 records the partial scope and the PR list shows it.
- Seed claims already carry a `status` of extracted only; LLM-069 requires a human to confirm. 350 claims is a large queue; UXN-295 offers bulk confirm per expert. Screening real clusters cannot start until the Owner confirms some (Q2).
- `docs/24` gives formalisations as prose with TA-Lib names and parameter ranges, not as KB-010 `spec_json`. Only clusters whose inputs exist in the vocabulary can be screened; the document lists vocabulary gaps (section "Vocabulary gaps", about line 845).
- Cluster counts: 60 clusters; by category: risk/sizing 11, trend/momentum 10, macro/regime 9, fundamentals/value 8, chart patterns 6, volume 3, mean reversion 3, events/news 3, candlesticks 3, calendar 3 (two plus one calls). Many are `needs_new_data` or `not_testable`; they are stored but not screened.
- 28 claims are `call` type (counts from the batch files: B1 1, B3 8, B4 4, B5 15); K-058 holds them (KB-080).

## Open questions and proposed decisions

Recommended default = what the spec says or the nearest safe reading. Numbered from D-421.

| # | Question | Recommended default | Proposed decision |
|---|---|---|---|
| Q1 | Scope of M13-lite against the ch. 08 list. | Build KB-071…080 data model, pipeline and pages 292 to 295; defer DAT-227 fetchers, DAT-228/229/230, LLM-067/068, UXN-296, as the ch. 12 row says. | D-421: M13-lite builds the model, seed import, review queue, screening, challenger proposals, F7 gate, vocabulary report and calls store; polling, discovery, extraction, UXN-296 and the four deferred keys wait for a later milestone. Listed in the PR. |
| Q2 | Seeded claims: which status at import, given LLM-069 and the "no questions to the Owner" rule (O-73)? | Import every claim as `extracted`. Only `owner_checked` claims are screened (spec). Screening runs on fixtures in tests and on real claims once the Owner confirms them after merge. | D-422: no auto-confirm; seeded claims start `extracted`; the screening job simply finds nothing to do until some are confirmed. Staging shows an empty-but-correct state. |
| Q3 | Source items for the seed: the claim batches list the URLs "fetched" per expert, with no per-item summary. | Create a KB-072 record per listed URL with expert, URL, platform, title if known, `kind` from the claim, summary empty until a person or later job writes it. Never import text. Summary field is allowed null. | D-423: seed items hold link and metadata only; summaries are written later; PRD-036 holds. |
| Q4 | Seed formalisations are prose, not rule JSON. | The converter (private side) emits for each cluster a `rule_spec` only where a v1 vocabulary expression exists, reviewed by a Fable reviewer; others keep prose and `formalisation: null` with `vocabulary_gap`. Screening takes only clusters with a valid `rule_spec` (validated by `ruleSchema.ts`). | D-424: only clusters with a schema-valid `rule_spec` are screened; the rest are parked with the reason; count published in the exit evidence. |
| Q5 | Screening engine reuse: fixed-notional signal ledger, C2 controls, ARN-082 development split. | Build on `challengerGenerator.ts` `DevelopmentView` and `stats/cells.ts`; read through the one development-only accessor; add a test spy that fails on validation or holdout reads. | D-425: one `ExpertDevView` accessor, development split only; the weekly run gets an expert stage after the comparisons stage. |
| Q6 | Seed `status`: 12 `reference` experts in `00_final_100.md`, but KB-071 status set is candidate/tracked/paused/retired. | Add a flag `reference` (historical, never polled) as a boolean `no_feed`; keep status `tracked` or `retired` as the spec lists. No polling exists anyway. | D-426: `no_feed = true` for reference authors; status values unchanged. |
| Q7 | KB-080 calls tracking: does M11-lite deliver the ARN-095/103 tracker? | If the forward picks-vs-market ledger exists at M13-lite start, reuse it for `call` claims on active-market codes. If not, store calls and show "tracking starts when picks-vs-market exists"; no new tracker is built. Most calls are about non-AU markets (B5), so they are stored only. | D-427: calls reuse the M11-lite tracker or are stored only; no separate tracker. |
| Q8 | Who sees red flags and licence status of named people? | Owner and Editor see the text and links; Viewer sees an icon only. Texts are neutral, carry a source link and a date; no unsourced flag stored (defamation risk). Licence status stored as "unchecked" at seed. | D-428: red-flag text needs a source link or is rejected at import; Viewer sees icon only. |
| Q9 | Add the four deferred config keys now? | No. Add only the four used keys; the deferred four come with their milestone to avoid unused keys failing the config-reference and unused-key checks. | D-429: four keys now (expert_min_scored, expert_screen_fdr, expert_challengers_per_week, f7_min_clusters). |
| Q10 | Where do the expert pages go in navigation? | Under the existing Knowledge/Strategies area per ch. 16 V2 nav; if no Knowledge tab exists, a "Experts" entry beside Strategies, Owner and Editor only for the queue. Check `src/lib/ui/nav.ts` and ch. 16 at the work-package start. | D-430: nav follows ch. 16; no new top-level tab beyond what ch. 16 shows. |
| Q11 | AT-39 partial: does the go-live gate accept it? | Record the partial clauses as deferred with DAT-228 in the PR list for the Owner. | D-431: AT-39 deferred clauses listed in the PR description. |
| Q12 | The seed contains named real people, some with red flags. Is a public-repo test allowed to name them? | No. Tests use synthetic names; the real seed lives only in the private folder and the database. | D-432: SEC-110 applied to expert data; a grep test over `tests/` and `src/` checks for no real seed names (list kept in the private repo, run by the Owner-side converter, not in CI). |
| Q13 | F7 proposal before any cluster is L2. | Build the gate and the proposal code; it stays dormant (zero L2 clusters at start). | D-433: F7 lineage code ships dormant; AT-40 tests it with fixtures. |
| Q14 | Cluster to family mapping when the rule fits F1 to F6 (KB-077). | Use `docs/24` "Closest v1 family" per cluster as a hint; confirm by the schema (does the `rule_spec` fit the family's conditions); otherwise new lineage with m = 20. | D-434: closest-family hint from the seed; a fit test decides. |

## Recommended work packages

Small packages. Sonnet builds each; a Fable reviewer checks WP1, WP3 and WP4 (licensing, privacy, import), the others get the normal test gate. WP1, WP3 and WP7 are high risk (privacy, licence, trade path).

| WP | Content | Depends | Tests / evidence |
|---|---|---|---|
| WP1 Schema and licence rows | Migration for expert, source_item, claim, cluster, claim_cluster, scorecard view, screening_run, screening_result; PRD-036 limits (summary 80 words, no body column); licence-register rows for DAT-227 channels and manual-only platforms; regenerate `docs/source-licence-register.md`; four config keys with docs. HIGH RISK (licensing). | none | AT-39 (a)(d) clauses; schema tests; config-reference check. |
| WP2 Domain layer | `src/lib/experts/` types, status machine for claims (extracted to owner_checked to formalised to screened to challenger), scorecard (KB-074, pure, deterministic), "not enough tested claims" rule, vocabulary-gap report (KB-079). | WP1 | AT-41 (a); unit tests; property test on status transitions. |
| WP3 Seed import script | `scripts/experts/import.mjs` (+ `.d.mts`, README) in the Cortex importer pattern; format `praxis-expert-seed/1`; validators (PRD-036 caps, red-flag needs source, outside-repo folder); synthetic ZZ seed under tests; private-side converter spec for `docs/23`/`docs/24`. HIGH RISK (privacy, SEC-110). Fable reviews. | WP1 | Seed-import tests (dry run, rejects, idempotent, refuses in-repo folder); grep test of no real names. |
| WP4 Screening engine | Development-only accessor, fixed-notional signal ledger, C2 controls, cost model, BH at `expert_screen_fdr`, ranking by lower 90 % bound, descriptive wording, grade cap L1; expert stage in the weekly run. Fable reviews the split access. | WP1, WP2 | AT-40 (a to d) with 40 planted clusters; access spy test. |
| WP5 Challenger proposals and F7 gate | Weekly cap, family fit test, new lineage, ARN-085 trial charge on proposal only, KB-042 check; F7 gate and proposal code (dormant). | WP4 | AT-40 (e)(f); lifecycle tests. |
| WP6 Pages and review queue | UXN-292 directory, 293 detail, 294 techniques, 295 queue with confirm/edit/reject/merge and bulk confirm, audit events, role checks, loaders, e2e at desktop and phone width. UXN-296 not built. | WP2 (WP4 for results) | AT-41 (a); Playwright; role tests; Viewer sees no red-flag text. |
| WP7 No-trade-path guard and calls | Import-graph test that arena and agents modules do not import `src/lib/experts`; replay equality test (AT-32 style); calls store plus tracker reuse (Q7); KB markdown mirror (`knowledge/experts/`) through the existing archive. HIGH RISK (PRD-035). | WP2, WP5 | AT-41 (b)(c). |
| WP8 Exit | Full AT-39 (partial), AT-40, AT-41 run; Owner-run import dry-run on the real seed folder if the Owner has placed it (counts only), otherwise a recorded "not yet imported"; decisions D-421 onward into the log; `docs/M13L_exit_evidence.md`; BUILD_SETUP section 9 under "V2". | all | Exit evidence; deferred list for the PR. |

Suggested order: WP1; then WP2 and WP3 in parallel; then WP4; then WP5, WP6, WP7; then WP8.

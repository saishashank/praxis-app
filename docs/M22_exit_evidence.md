# M22 exit evidence: LLM routes, opinions, Expert Library and shadow readers (V3)

Design: `docs/M22_design.md`. Requirements: `docs/M22_requirements.md`. The section headings below are the exit checklist of the design (section "Exit checklist"). This file was completed by task Z2 on the branch `v3/m22-z` (head `a6389fa5` plus this commit: `build` with every M22 task merged, plus Z1's integration wiring). **"to be filled at push"** marks the only values that need a push and a CI run. **Every Playwright spec was written against the seed states and the page registries and was NOT run locally**: a Next production build fails inside `wt-*` worktrees (the node_modules junction), so each e2e spec (`e2e/m22-committee.spec.ts`, `e2e/m22-sources.spec.ts`) is verified by the CI `e2e` job only. Times are Melbourne time. The test counts below were observed on 2026-11-17 at head `a6389fa5`, one folder at a time on a shared machine (a file that timed out was rerun alone).

## §0 Gate

The CI run that proved M21 green on `build` before the first M22 task (D-1400): run **44024571945** on commit `432a4df3`, all green. The final CI run on the pushed head: **to be filled at push**.

## §1 Tasks

Merge commits are `git log --merges --oneline bc247714~30..HEAD` of this branch, oldest first (a task without a merge line was committed straight onto the integration branch). The decision ranges are the lines in `docs/M22_design.md`.

| Task | Commit or merge | Decisions | Test files (main ones) |
| --- | --- | --- | --- |
| A1 migration 0039, guard region, pending register rows, nav labels, seed states **F** | `2f40f8a2` (branch head `v3/m22-a1`; Opus accepted) | D-1444 | `tests/db/0039_m22_llm_experts.test.ts`, `tests/acceptance/v3/at32Opinions.test.ts`, the pin tests |
| A2 keys, budget buckets, drop order, guard registry, nightly seam **F** | `977d0758` (Merge M22 A2 into A1; branch `d423b462`; Opus accepted) | D-1410, D-1411, D-1445 | `tests/config/{m22Keys,switchGuards}.test.ts`, `tests/llm/{budgetBuckets,dropOrder,nightlyLlm}.test.ts` |
| L1 factory, bake-off index, tiers, routes health line **F** | `126c1fd1` (branch `v3/m22-l1`; Opus accepted) | D-1401 to D-1404, D-1408, D-1462 | `tests/llm/factory.test.ts`, `tests/llm/bakeoffIndex.test.ts`, `tests/acceptance/v3/at80Routes.test.ts` |
| E1 licence job and first check | `87d01120` | D-1430, D-1431 | `tests/experts/licence/*`, `scripts/experts/licence-check.test.mjs` |
| C1 Committee engine **F** | `4f482462` (Opus accepted) | D-1417 to D-1419, D-1465 to D-1469 | `tests/committee/{shortlist,debate,judge,night,cli}.test.ts`, `tests/security/committeeBoundary.test.ts` |
| L3 Workers AI adapter | `1ca44326` | D-1413, D-1477 | `tests/llm/workersAi.test.ts`, `tests/acceptance/v3/{at80WorkersAi,at77WorkersAi}.test.ts` |
| L2 bake-off categories, golden sets, role verdicts, roster refresh **F** | `0380929f` (branch `v3/m22-l2`; Opus accepted) | D-1404 to D-1407, D-1409, D-1486, D-1487 | `tests/llm/{bakeoff,goldenSets}.test.ts`, `tests/acceptance/v3/at80Hostile.test.ts` |
| E2 polling, discovery, extraction, Sources page **F** | `a062f8d0` (Opus accepted) | D-1429, D-1432 to D-1434, D-1480 to D-1483 | `tests/experts/poll/*`, `tests/acceptance/v3/at79Fetch.test.ts`, `e2e/m22-sources.spec.ts` |
| C3 pick reflections | `23c400b5` | D-1424, D-1425 | `tests/steelman/reflect.test.ts`, `tests/acceptance/v3/at76Reflections.test.ts` |
| L5 MiniLM shadow | `e1448f80` (without the runtime pin, D-1510) | D-1414 to D-1416, D-1500, D-1501 | `tests/llm/minilm/*`, `tests/acceptance/v3/at80MiniLm.test.ts` |
| C2 VAL-111 trial, page, AT-36 **F** | `a03fc018` (Opus accepted) | D-1420 to D-1423, D-1498 | `tests/committee/{trial,prereg,page}`, `tests/acceptance/v3/at76Trial.test.ts`, `e2e/m22-committee.spec.ts` |
| E3 structured-call proposals | `556201f8` | D-1435, D-1505, D-1506 | `tests/experts/{callProposals,confirmCall}.test.ts`, `tests/acceptance/v3/at79Calls.test.ts` |
| L4 nightly wiring and keys **F** | `896f57e0` (Merge branch `v3/m22-l4` into `v3/m22-a1`; Opus accepted) | D-1412, D-1417, D-1511 to D-1515 | `scripts/arena/signals.stages.test.mjs`, `tests/acceptance/v3/at80Night.test.ts`, `tests/security/secretStores.test.ts` |
| C4 opinion meters, promotion request, shared AT-73 | `9016c743` | D-1427, D-1428, D-1517 to D-1520 | `tests/opinions/*`, `tests/security/opinionBoundary.test.ts`, `tests/acceptance/v3/at73Shared.test.ts` |
| E4 grammar v2, expressions, re-screen **F** | `1dc47324` (Opus accepted, with D-1533) | D-1436 to D-1438, D-1522 to D-1526 | `tests/agents/families/ruleSchemaV2.test.ts`, `tests/experts/{ruleEval,expressedScreen,import}.test.ts`, `tests/acceptance/v3/at79Clusters.test.ts` |
| E5 alt regime inputs, sweep, stubs | `bc247714` | D-1439 to D-1443, D-1527 to D-1531 | `tests/regime/alt/*`, `tests/intraday/sweep*`, `tests/acceptance/v3/{at81Regime,at77Sweep}.test.ts` |
| Z1 integration wiring (health lines, opinion meters stage, call proposals in the experts job, generated files) | `a6389fa5` | D-1534 to D-1540 | `tests/health/controlRoom.test.tsx`, `tests/acceptance/v3/at76.test.ts` |
| Z2 reports, private dry runs, exit evidence (this commit) | this commit | none new | `docs/test-reports/AT-{36,39,73,76,77,79,80,81}.md` |

**Opus review notes.** Every **F** task (A1, A2, L1, L2, L4, C1, C2, E2, E4) was reviewed by the orchestrator (Opus) and accepted. The orchestrator's own fixes after the reviews are decisions of their own:

- **D-1510**: the L5 merge leaves out the `onnxruntime-node` pin and its lock-file regeneration (nothing can load the runtime until a model fingerprint and a trained head exist; it fails closed when absent).
- **D-1513**: the three model-key secret names are NOT in `arena-signals.yml`; the production job stays equal to its stored copy until the Owner approves the edit (section 8).
- **D-1532**: both trial steps in the night take the night's own arguments, so the date check and the replay refusal apply, and a trial step that is off or has no trial prints nothing.
- **D-1533**: the AT-22 annotation-boundary check reads every file under `src/lib/llm` recursively (it failed on the new `minilm/` folder).

## §2 Identity

- AT-32 and AT-50: `tests/acceptance/v3/replay-hash.baseline.json` is **not rewritten**; `git diff 8b65abc6 HEAD --stat` over the three identity files (`replay-hash.baseline.json`, `tests/market/au-constants.snapshot.json`, `worker/test/fixtures/au-slots.snapshot.json`) is **empty** on this branch. Test run: `replayHash.test.ts` and `tests/acceptance/v2/at50.test.ts`: 14 tests in 2 files, pass
- `tests/acceptance/v3/at32Opinions.test.ts`: the own-set is the steelman's own tables plus exactly **eight** M22 tables (the Committee's, the promotion request, the MiniLM shadow, the alt-input regime reading and its points); every other table, the five other 0039 tables included, stays in the hash. Rows written into the eight tables leave the dump of every other table byte for byte as it was and the combined hash equals the AT-32 baseline; a control row in a hashed table changes exactly that table's hash (the complement is not vacuous). The on-versus-off stage writers (Committee, trial, MiniLM shadow, regime reading, meters, reflections) are in `M22_STAGE_WRITERS`. Test run: 3 tests in 1 file, pass; AT-68 (`at68.test.ts`): 18 tests in 1 file, pass
- AU constants and slot snapshots are unchanged (the empty diff above); AT-68 (`tests/acceptance/v3/at68.test.ts`, the 0039 tables guarded) and `npm run test:market-literals` (0 hits in 0 files, 127 allowed, 1378 scanned) hold.

## §3 LLM routes

- **Fresh-configuration defaults** (`tests/config/m22Keys.test.ts`, `tests/acceptance/v3/at80Routes.test.ts`): `llm_live_roles` empty; `llm_budget_workers_ai_daily` 0; `llm_budget_committee_daily` 40,000; `llm_budget_experts_daily` 30,000; `committee_enabled` off; `intraday_sweep_enabled` off (5 requests a slot).
- **Factory truth table** (`tests/llm/factory.test.ts`, D-1401): a live chain only when the role (or `words`) is in `llm_live_roles`, the index has a PASS for the role, every chain model is in the PASS list, routable, not training on prompts and has its key; every other case, and any read error, returns the rules-only router with a reason. Only `factory.ts` and `bakeoffCli.ts` construct a live provider (static test, `tests/security/liveProviderSites.test.ts`).
- **The live bake-off (D-1406): not run (D-1534).** It would run on the production commit, which lacks the V3 harness, and writes to the live database. So the index `src/lib/llm/bakeoffIndex.generated.ts` holds **no PASS**, every role is rules-only and 0 provider requests are made with all keys present (`at80Routes`, `at80Night`). The words and Committee-judge verdicts read "not run live". The Owner dispatches it (section 8). Report: `docs/test-reports/AT-80.md`.
- **Roster refresh** (`docs/llm-roster.md`, D-1407): the provider pages were re-read on **2026-11-17** (the earlier read was 2026-10-29); the Workers AI rows are `unverified` with no role; no paid model is added.
- **Budget**: D-1410: the five role caps plus the Committee and experts buckets sum to **235,000** inside the unchanged **240,000** total (60,000 + 50,000 + 25,000 + 10,000 + 20,000 + 40,000 + 30,000); the V2 [VERIFY] of the total against free-tier limits is recorded with the roster refresh.
- Tests: `AT-80` counts in `docs/test-reports/AT-80.md`.

## §4 Committee and reflections

- **AT-36 i to iv** (`tests/acceptance/v3/at76Trial.test.ts`, report `docs/test-reports/AT-36.md`): (i) random outcomes give no PASS and p above 0.05; (ii) approved signals that beat rejected ones by 6 % pass, the look is written once (`holdout_look`, lineage `committee_trial`) and the Committee switches itself off through the audited path; (iii) a second pre-registration version after the first rated night ends the trial INVALID with an alert, no look, switch off; (iv) a sign-reversed judge-model segment with n at or above 50 is not a PASS, and the unflipped data passes (not vacuous). Interim rows are labelled "interim, not a result".
- **Pre-registration record shape** (`tests/committee/prereg.test.ts`, D-1420): version 1, written on the first Committee night before any rating, with the frozen horizon, sessions, minimum settled, permutations, the cost threshold, the statistic's definition and its sha; the four frozen keys are refused by the switch guard while a trial runs.
- **Forward-only refusal**: a past date, a future date and a replay flag are refused by the step, the command line and the engine.
- **Ratings stay hidden** (D-1423): a static test over the loaders and templates and a rendered check; only the trial page reads a rating.
- **Reflections on versus off** (`tests/acceptance/v3/at76Reflections.test.ts`): the stage writes only its own tables; the hashed complement is equal on and off, also on a rules-only night (a `not_written` row only), with a non-vacuity check.
- **Stated limit (D-1498, listed)**: a pick still open at the horizon is left out of the trial's sample (the ledger holds no mark at the horizon and none is invented).

## §5 Expert Library

- **AT-39 fetch clauses**: proven by `tests/acceptance/v3/at79Fetch.test.ts` (a to h) and `tests/experts/poll/*` with a fake `fetch` (`docs/test-reports/AT-39.md`, "M22 update"). `tests/kb/fetchRules.test.ts`, which the M13-lite list named, does not exist in this tree.
- **Private dry runs, counts only** (D-1431; the seed is outside the repository, nothing was copied, no name, handle, URL or path is written anywhere in the repository):
  - *Licence first check*: 100 experts (all `tracked`, tier `core`); the seed carries no handle and no home address, so **0 sources, 0 checked, 0 not fetched, 0 requests**; by status: enabled 0, no 0, unchecked 0. `licence-check.json` (empty results) was written beside the seed and left there. The check needs source addresses from the Owner (section 8).
  - *Call proposals* (the 28 seed calls): **28 call claims; 0 complete, 23 incomplete** (missing: code 23, direction 15, date 21, horizon 23), **5 not trackable**; 0 already structured; nothing written.
  - *Cluster expressions*: `express-check.mjs` could not run: the seed is format 1 and has no `expressions.json` (the script refuses with "the seed needs format 2"). The 60 clusters are 3 with a family fit and **57 parked**, all 57 "not yet addressed"; so the target of 20 expressed is not met and is reported, not forced (D-1437). K-ids by outcome: none yet (the importer's own dry run: 100 experts, 23 red flags, 275 items, 60 clusters, 347 claims, 976 claim-item links, 375 claim-cluster links, 0 calls).
  - *Why the format-2 runs are short*: the converter side (private) has not produced a format-2 manifest, `licence-check.json` from real addresses, `call-proposals.json` or `expressions.json` yet. A format-1 seed refuses the `licence-check.json` the first-check script writes, so the Owner re-runs the converter to format 2 (section 8) before importing.
- **Name grep** (D-1431, D-654): the 100 expert names (and 0 handles; names of at least 4 characters) were searched, ignoring case, over every tracked file of the repository with `git grep -F`: **0 matches**. Re-run on the final tree: **0 matches** (tracked and untracked files, this commit's documents included)
- **Synthetic proof** (`at79Clusters`): the fixture reports 24 expressed against the target of 20, a shortfall is reported with reasons and never fails the check, and an unaddressed cluster is never counted as a pass.
- **Stated limit (D-1537)**: expressed clusters stay skipped as `no_rule_data` in production; the production adapter from the snapshot world to a rule data source is not built (a listed follow-up). The fitted clusters run as before.

## §6 Shadow and off items

- **MiniLM** (`tests/acceptance/v3/at80MiniLm.test.ts`, D-1500, D-1501): the head is **untrained** (`trained: false`, empty weights), the lock `model.lock.json` has `sha256: null` and `sizeBytes: null` (the model file was not fetched in the build; cap 100,000,000 bytes, D-1414), `onnxruntime-node` is **not** in `package.json` (D-1510), so the switch guard refuses "on" and the stage writes nothing and prints nothing (it runs only when `models/minilm/model.onnx` and `vocab.txt` exist, D-1514). Shadow on versus off equals outside its own table on the AT-32 world; the agreement figure is published when on. The use of MiniLM beyond shadow is not built (D-1416).
- **Alt-input regime readings** (`tests/acceptance/v3/at81Regime.test.ts`): no outside source is accepted in production, so the readings are `unavailable` and equal the base; only `regime_alt_reading` and its points move; the display switch changes display only.
- **Sweep off** (`tests/acceptance/v3/at77Sweep.test.ts`): `intraday_sweep_enabled` off; with it on and no accepted batch-endpoint register row the universe is unchanged, nothing is planned and the switch is refused. No batch fetcher exists (D-1531).
- **DAT-249 and DAT-250**: stubs in `src/lib/deferred/sources.ts`, rejected with reasons, checked 2026-11-17; no fetcher, host, register row or key exists (D-1442).

## §7 Constraints

| Constraint | Evidence |
| --- | --- |
| Turso at or under 20 % of the free plan | every new statement is a key probe or a bounded keyset read with a `rows-ok:` comment: **115** `rows-ok` lines across the files M22 added or changed in `src/` and `scripts/` (`git diff 8b65abc6 HEAD`); the health wiring adds nine short single-row reads and the statement budget of `tests/health/controlRoom.test.tsx` goes from 91 to 100 (the row budget, 600, is unchanged, D-1535); the measured Usage figure after the deploy: Owner, read-only |
| Zero `OFFSET` | `tests/security/noOffsetPaging.test.ts`: 4 tests in 1 file, pass; the only `OFFSET` text in the M22 diff is comments that say "no OFFSET" |
| LLM budget sum | 235,000 inside the unchanged 240,000 (section 3) |
| Schema pin 39 | `tests/backup/core.test.ts` (version 39), `tests/db/0039_m22_llm_experts.test.ts` |
| No staging path, `ASX_LIVE` off, $0, no secret | no staging workflow touched; no workflow, secret table or `secretStores.ts` row was changed by Z (D-1540); no paid model; no new key value anywhere; gitleaks on the remote run: to be filled at push |
| `worker/` untouched | `git diff 8b65abc6 HEAD --stat -- worker` is **empty** |
| Decision index, config reference, architecture regenerated | `node scripts/ci/decision-index.mjs --check` (exit 0; 993 decisions in `docs/V2_decisions.md`), `node scripts/ci/config-reference.mjs --check` (84 tags = 84 rows, doc current), `node scripts/architecture/generate.mjs --check` (up to date: 571 elements, 673 edges), the register document (`scripts/ci/licence-register.mjs --check`) and the rule schema document (`docs/rule_schema.md`) regenerated by Z1; all re-run on the exit tree |
| Market literals at 0 | `npm run test:market-literals`: 0 hits in 0 files outside the allow-list (127 allowed, 1378 scanned) |
| AU identity | section 2 |
| No internal code in Owner-read text | `npm run test:internal-codes`: 0 hits outside the allow-list (48 allowed, 353 files scanned) |

## §8 Owner steps for the PR

From D-1540, D-1449 and every decision marked "listed" in the design. After the merge, the Owner:

1. **Dispatches `llm-bakeoff.yml` on `release`** with the named Groq candidates (GPT-OSS 120B, GPT-OSS 20B, Qwen 3.8 27B; no training on prompts, dated; `store = true`), then runs `node scripts/llm/bakeoff-index.mjs --write` and commits the index (D-1406, D-1534); then adds any passing role to `llm_live_roles` (D-1449, D-1402: the words phase is gated by `words` alone; R3 or R5 listed alone change nothing).
2. **Adds the three model keys to the production signals step**: `GROQ_API_KEY`, `GOOGLE_AI_API_KEY`, `OPENROUTER_API_KEY` (from the production environment secrets) to the `env:` of the signals step of the production job of `arena-signals.yml`, and re-stores the lock with `node scripts/ci/prod-job-lock.mjs --write`; the two tests that hold the keys-only-where-allowed rule change with the approved edit (D-1513, D-1540, D-1412). Until then no key reaches the night and the night is rules-only.
3. **Workers AI** (if wanted): sets the secrets (token, account id), adds the rotation row, sets `llm_budget_workers_ai_daily` above 0 and wires the budget (`spentNeuronsToday`, D-1512, D-1413, D-1540); it is unavailable until a bake-off gives a role to its roster rows.
4. **MiniLM** (if wanted): pins `onnxruntime-node` exactly (1.31.1 was chosen, D-1500; add with `npm install --package-lock-only --ignore-scripts`), pins the model fingerprint and size in `model.lock.json` after the first fetch in the fixtures lane, and trains a head (`scripts/llm/minilm-train.mjs`) from the golden labels; the guard refuses "on" until all three hold (D-1414, D-1501, D-1510, D-1514, D-1540). Labels for the golden set (`label_golden_min`) are needed before the one `minilm_vs_rules` look (D-1416).
5. **Removes the stale Vercel rotation row** for the model keys (the table, the guide, `rows.json` and the smoke checks; D-1412 says the keys are not used in Vercel, D-1513, D-1540).
6. **Imports the expert seed in format 2**: the converter adds `licence-check.json` (from real source addresses; the current seed has none, so the first check found 0 sources), `call-proposals.json` and `expressions.json`, then `scripts/experts/import.mjs <folder>` (D-1431, D-1435, D-1437, D-1523); then accepts or rejects sources on the licence page and the Sources page (D-1449). The ≥ 20 expressed clusters target is reported, never forced.
7. **Accepts register rows if wanted**: the prediction-market sources (D-1530: the Owner supplies each event's https address), FRED and the batch-quote endpoint (D-1443, D-1531: the sweep stays off until the row is accepted); the experts job rides on the nightly maintenance dispatch (D-1429).
8. **Reads the Committee trial caveat (D-1498)**: picks still open at the horizon are left out of the trial's sample; the trial page shows `unsettled` and `late` counts. The Committee switch stays off until 10 nights qualify.
9. **Reads the other listed items**: the meters and the promotion request (D-1517 to D-1520: an earned opinion needs a new spec version and an Owner decision), the reflections written by the Case-writing role (D-1424), the macro series carry context only (D-1528), the expressed-cluster production adapter is a follow-up (D-1537), the V2 [VERIFY] of the 240,000 total (D-1410), and the shadow-only use of MiniLM (D-1416).
10. **Checks that the LLM secrets exist in the production environment** (D-1449).

## §9 BUILD_SETUP section 9 (rows for the orchestrator to write)

- "V3 current milestone": **M22 done** (written after the final CI run on the pushed head is green: to be filled at push).
- "V3 last step done / next step": **M22 exit / M23 requirements extract**.
- Notes to carry: the M21 gate run 44024571945; the final M22 CI run (to be filled at push); the live bake-off not run (D-1534); the Owner steps of section 8; the private seed is format 1 with no source addresses (first check found 0 sources).

## §10 Not verified locally

Playwright cannot run in a `wt-*` worktree here, so `e2e/m22-committee.spec.ts` and `e2e/m22-sources.spec.ts` were written and listed but **not run**; CI is their only verification. Also CI-only: the production `next build` and the bundle budgets, gitleaks, Lighthouse and the full `npm test` suite (the orchestrator runs it after the merge).

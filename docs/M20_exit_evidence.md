# M20 exit evidence: India and the US, built and off in production (V3)

Design: `docs/M20_design.md`. Requirements: `docs/M20_requirements.md`. The section headings below are the exit checklist of the design (section "Exit checklist"). Each section is filled by the task or the orchestrator that owns it; **TBD** marks a value that depends on a stream that has not merged (IN1, US1), on the extract fill runs, or on the remote CI run. A section that still says TBD is not yet evidence. Stream S1 fills the rows it owns (tasks, switch-on, off in production, constraints, Owner steps).

## §0 Gate

The CI run id on `build` that proved M19 green before the first M20 merge (D-1126): TBD (orchestrator).

## §1 Extract

TBD (A1 and the orchestrator). Needs: the fill-run dates; the coverage report figures per source and market (codes, sessions, first and last date, the delisted share per year for IN, the "not pulled" lines with reasons); the `buckets.json` edges and the AU percentiles they match.

## §2 Tasks

| Task | Merge commit | Test files |
| --- | --- | --- |
| A2 follow-ups, migration 0036, Worker zones | TBD | `tests/db/0036_m20_markets_data.test.ts`, `worker/test/{localtime,slotZones,killSlot}.test.ts` |
| A1 extract tooling and coverage reports | TBD | `Requirement/v3/tools/m20/**` (data repo) |
| A3 source rows, hosts, report, calendars | TBD | `tests/data/{sourceRegister.m20,calendarRules.in,calendarRules.us,calendarEnable}.test.ts`, `tests/http/sourceHosts.test.ts` |
| A4 money engines per market | `3ac29dd5` (v3/m20-a4 merged into the S1 base) | `tests/markets/{in,us}/costs.test.ts`, `tests/arena/{slippage.markets,settlement.t1,seed.fx,profileParams}.test.ts` |
| A5 Cortex rule sets, as-filed reader, data limits, labels | TBD | `tests/markets/{in,us}/{categoryMap,bands,luld,asFiled}.test.ts`, `tests/labels/*.test.ts` |
| IN1 fetchers, batch 1, fixtures, AT-M, calibration | TBD | `tests/markets/in/*.test.ts`, `tests/market/isolation.test.ts` |
| US1 EDGAR, FINRA, halts, batch 1, fixtures, AT-M, calibration | TBD | `tests/markets/us/*.test.ts`, `tests/acceptance/v3/at70NoRequest.test.ts` |
| **S1 switch-on, rollback, projection, UI, e-mail, CI job, reports** | branch `v3/m20-s1` (merge commit TBD) | `tests/market/checklist.test.ts`, `tests/data/controls.switch.test.ts`, `tests/data/calendarEnabledMarkets.test.ts`, `tests/arena/closeBooks.kill.test.ts`, `tests/usage/projection.test.ts`, `tests/usage/projectionSection.test.tsx`, `tests/settings/marketSwitch.test.tsx`, `tests/email/perMarket.test.ts`, `scripts/arena/arena-close.workflow.test.mjs`, `scripts/ci/ci.workflow.test.mjs`, `scripts/ci/e2e-listing.test.mjs`, `scripts/e2e-day/recorded-day.test.mjs` |

Fable's review notes per **F** task (A2, A1 `buckets.mjs`, A4, A5, IN1 night, US1 night, S1 kill and projection): TBD (orchestrator).

## §3 Identity

AT-32 and AT-50 hashes equal the step-0 baseline (`tests/acceptance/v3/replay-hash.baseline.json`, not rewritten; `schemaSha` of the AU night unchanged, D-1116); the AU constants snapshot (`tests/market/au-constants.snapshot.json`) and the Worker slot snapshot (`worker/test/fixtures/au-slots.snapshot.json`) unchanged. S1 did not edit any of the three files; `replayHash`, `auConstants` and `worker/test/auSlots.test.ts` are green on the S1 tree (counts in the S1 report). The AU-only e-mail output is byte-identical (the M19 snapshots in `tests/email/templates.test.ts`, and `tests/email/perMarket.test.ts` proves the review and the brief unchanged with a second market off or data-only). Final values on the integrated exit tree: TBD.

## §4 Profile

IN and US field tables (values, `verify`, `verified_at`, `evidence_ref`), the completeness result per market, `profile_version = 2`: TBD (A3, IN1, US1). The switch-on checklist item `profile_complete` reads `loadProfile(code).completeness` (`src/lib/market/checklist.ts`).

## §5 Sources

The register rows per market with status and the verification date, the source-report summaries from the build machine, the hosts added, the EDGAR and FRED variable names (no value): TBD (A3, US1). S1: the rows are written on enable by `switchMarket` through `ensureMarketSources` (D-1128, D-1193) and read by the checklist item `licence_rows` (D-1191).

## §6 Off in production

| Item | Evidence |
| --- | --- |
| AT-68 reports unchanged | [test-reports/AT-68.md](test-reports/AT-68.md); the three proofs are green on the S1 tree (counts in the S1 report); `e2e/market-off.spec.ts` is unchanged |
| The switch cannot succeed in production | the production seed is refused `checklist_open` for IN and US (`tests/data/controls.switch.test.ts`); no code path sets `markets_enabled`, `market.enabled` or `PRAXIS_MARKETS_ENABLED` outside `switchMarket` and the scratch databases of the dev job |
| The dev variable does not leak | `PRAXIS_MARKETS_ENABLED` is on one step of the job `recorded-day-dev` and in no other `ci.yml` job, package script or Playwright config (`scripts/ci/e2e-listing.test.mjs`) |
| The 0036 trigger count | TBD (A2) |
| `recorded-day` production-shape and network-assertion outputs | TBD (CI run on the PR head) |
| `recorded-day-dev` outputs for IN and US | TBD (CI run on the PR head; needs the recorded sessions of IN1 and US1) |
| The production read-only check `SELECT code, enabled, mode FROM market` after the deploy | TBD (AU `1 full`, IN `0 off`, US `0 off`, from the maintenance route's run record) |

## §7 Acceptance

| AT | Report | Result |
| --- | --- | --- |
| AT-69 (IN) | `test-reports/AT-69.md` | TBD (IN1) |
| AT-70 (US) | `test-reports/AT-70.md` | TBD (US1) |
| **AT-71** switch-on and rollback | [test-reports/AT-71.md](test-reports/AT-71.md) | code and unit proofs green (S1 report); the Owner performs the switch after the merge |
| AT-38 | `test-reports/AT-38.md` | TBD (US1) |
| AT-75 (IN and US) | `test-reports/AT-75.md` | TBD (A5, IN1, US1) |
| AT-M-IN, AT-M-US (M1 to M5) | `test-reports/AT-M-IN.md`, `test-reports/AT-M-US.md` | TBD (IN1, US1: generated by `scripts/market/at-m-report.mjs`; the checklist item `at_m_evidence` reads `market_profile.evidence_recorded_at` and this listing in `docs/test-map.md`) |
| AT-68 | [test-reports/AT-68.md](test-reports/AT-68.md) | appended by S1 |
| AT-85 | [test-reports/AT-85.md](test-reports/AT-85.md) | the M20 line appended by S1 |
| AT-32 / AT-50 | existing reports | unchanged |

## §8 Constraints

| Constraint | Evidence |
| --- | --- |
| Turso at or under 20 % of the free plan | the projection for AU, IN and US (`/usage#projection`, `src/lib/usage/projection.ts`, hand-computed edges in `tests/usage/projection.test.ts`); the measured Usage figure on the production deploy: TBD (Owner, read-only) |
| Zero `OFFSET` | `tests/security/noOffsetPaging.test.ts` at zero exceptions; every S1 statement is a key probe or a bounded key-range read with a `rows-ok:` comment |
| No staging path, `ASX_LIVE` off, $0, no secret | no staging workflow touched; `worker/src/asx/*` not edited; no new provider; names only (`PRAXIS_EDGAR_CONTACT`, `FRED_API_KEY`) in `scripts/ci/env-names.mjs`; gitleaks on the remote run: TBD |
| Decision index, config reference, architecture regenerated | S1: `node scripts/ci/decision-index.mjs` (D-1190 to D-1199), `node scripts/ci/config-reference.mjs --check`, `node scripts/architecture/generate.mjs`; final run on the exit tree: TBD |
| Schema-count tests at 36, `history` paths absent | TBD (orchestrator on the exit tree; S1 adds no migration and no committed data) |
| Market literals at 0 | `npm run test:market-literals`: 0 (S1 report) |

## §9 Owner steps for the PR

1. The section 20.6 steps: the Owner performs the switch after the merge (Settings > Region & markets > Switch on a market); nothing in the build does (owner guide, "Switching on India or the US, and rolling back").
2. D-1094: set `PRAXIS_EDGAR_CONTACT` and `FRED_API_KEY` in the Owner store before switching the US on.
3. D-1096 and D-1191: decide each `pending` source of a market (accept or disable) as a status change in `src/lib/market/seed/{in,us}/sources.mjs`; without it the first step cannot be complete.
4. D-1100 and D-994: set `PRAXIS_MARKETS_ENABLED` by hand after a switch (the nightly mismatch alarm reminds).
5. D-1105: ten latency samples before `full`; D-1192: the RBA F11 series ids `FXRINR` and `FXRUSD` must be stored in `macro_series` for the activation day.
6. D-1129: deploy order of migration 0036 (approve the production deploy, then expect at most one tick window of `statement-error` incidents, or run the migration first); `deploy-production.yml` is not edited.
7. D-1098, D-1106, D-1108 (spec findings) and the S1 findings D-1191, D-1192, D-1194 (the open price when the market was off) and D-1195 (the Worker and host budgets): TBD (orchestrator lists them in the PR description).

## §10 BUILD_SETUP section 9

"V3 current milestone" = M20 done; "V3 last step done / next step" = M20 exit / M21 requirements extract: TBD (orchestrator, after the exit tree is green).

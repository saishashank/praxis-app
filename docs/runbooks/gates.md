# What runs where: CI, local and scheduled gates

V1-I15, D-796. One page so nobody assumes "green locally" or "green on the PR" means more than it does. Job names are those of `.github/workflows/ci.yml`.

| Check | Local (`npm run ...`) | PR (`ci.yml`) | Release PR to `release` | Elsewhere |
| --- | --- | --- | --- | --- |
| Format, lint, typecheck, unit tests (about 7.7k vitest cases) | `format:check`, `lint`, `typecheck`, `test` | job `app` (15 min limit) | same, plus `release-gate` needs it | none |
| Script suites (`node --test`, about 72 files) | `test:smoke` | job `app` | same | none |
| Real-fixture tests | skipped unless `PRAXIS_FIXTURES_DIR` has content | job `fixtures` (skipped when the private repo is unavailable) | the strict step fails if any is skipped (GL-09) | none |
| End-to-end, accessibility, readability, Lighthouse | `test:e2e` (needs a production build) | job `e2e` | same | `staging-e2e-day.yml` (Owner-dispatched, real staging) |
| Secret scan of history, bundle scan | `node scripts/ci/bundle-secret-scan.mjs` (after a build) | job `secrets` (gitleaks over the full history) | same | none |
| Worker typecheck, tests, dry-run deploy | `test:coverage:worker` | job `worker` | same | none |
| Python fetchers | none (pinned hashed set) | job `python` | same | none |
| Dependency audit (npm, pip) | `npm audit` | job `audit` | same | none |
| Coverage floors, diff coverage, test map, quarantine record | `test:coverage`, `test:diffcov`, `test:map` | job `coverage` | same | none |
| Workflow lint, env names, architecture model, decision index, config reference, repo hygiene, licence register | `test:architecture` (includes the decision index), `test:env-names`, `test:config-reference`, `test:hygiene`, `test:licences` | job `checks` | same | none |
| Mutation testing | none | not run | not run | `mutation.yml`, weekly (Saturday), `release` branch only |
| ZAP baseline | none | not run | needs a green staging scan within 7 days | `zap-baseline.yml`, staging, Owner-dispatched from `main` |
| Restore drill with a real key | none (the CI drill uses a throwaway key) | synthetic drill inside `app` | needs a drill within 120 days | `restore-drill.yml`, Owner-dispatched |
| Nightly suite | none | not run | needs 3 green nights, the newest within 24 h | `nightly.yml` |
| CI-minutes re-measure (TST-132) | none | not done (`docs/M4_exit_evidence.md`) | not done | open |

## Known asymmetries

- **Local green is not CI green.** The Linux jobs, the gitleaks history scan, the strict fixtures step and the e2e production build do not run in a plain `npm test`. After a push, read `gh run list` for the branch (all jobs), not only the local gate.
- **Timing-sensitive tests.** About 30 test files use fake timers or `Date.now`. `tests/quarantine.json` is empty today; a flaky test goes in that record with an expiry (TST-131) rather than being retried.
- **Timing assertions (R3-I4, D-820).** Three places assert a measured time or CPU budget and run in the required `app` and `worker` jobs: the Worker CPU budget (`worker/test/m5Slots.test.ts`, PLT-070: median under 5 ms and 8 ms against 10 ms), the default-size cohort replay under 60 s (`tests/replay/cohortReplay.test.ts`) and the quarterly live look (`tests/cortex/look.test.ts`, bounded by the 30 s test timeout). Their names start with `[timing]`. Locally they run once with no retry; in CI only (`CI=true`, set by GitHub Actions) each gets **one** retry, so one noisy shared runner does not turn the release gate red while a real slowdown, which fails twice, still does. The budgets and margins are unchanged and the measured median or seconds is logged on every run (`[timing] ...` lines in the job log), so a creeping trend stays visible. A test that needs more than one retry goes in `tests/quarantine.json`, not in a higher retry count. Find them all with `grep -rn "[timing]" tests worker/test`.
- **Release gate list.** `CI_REQUIRED_JOBS` in `scripts/ci/release-gate-core.mjs` now equals the `needs` list of the `release-gate` job (all nine jobs, including `audit`, `coverage` and `checks`); `scripts/ci/ci.workflow.test.mjs` fails if the two drift apart (D-796).
- **Real-key and staging evidence is Owner-run.** The ZAP scan, the real-key restore drill and the staging end-to-end day are dispatched by hand; the release gate only reads that they happened and how recently.

Related: `docs/test-map.md` (requirement IDs to tests), `docs/runbooks/rollback-v2.md`.

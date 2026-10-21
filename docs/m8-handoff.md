# M8 hand-off note

Written for the Owner at the end of the build (decision 36, BLD-040, BLD-012). Status date: 2026-10-21. Plain words; nothing here contains a secret, and none may be added.

## Where things stand

- The build is finished for every item an agent can do. Evidence: [M8_exit_evidence.md](M8_exit_evidence.md). One report per acceptance test, with what is proven and what waits for you: [test-reports/](test-reports/).
- Production is **data-only**. Nothing trades until you sign off in the app and switch AU to `full` (BLD-030).
- Nothing in staging or production has run any M8 code yet. Migrations main 0007 to 0012 and auth 0004 to 0006 are applied nowhere; they arrive with the release you approve (D-022).
- Every row marked "pending" in the exit evidence and the test reports is yours or staging's. The agent has not faked any of it.

## What you do next, in order

The step-by-step script, with screen names and checks, is [owner-guide/M8_go_live.md](owner-guide/M8_go_live.md). This list is only the order. The checklist at the top of the guide is where you tick things off.

1. **Section A (any time):** answer decisions 6, 10, 22, 34 and 42 in chat. Note that decision 10 changed: the model bake-off runs on production, not staging, and "no model passes" is a valid result. Work through the carried approvals listed in the exit evidence (licences, Stryker, the ZAP image digest and `ZAP_IMAGE_PINNED`, `TEST_IDENTITY_SECRET_STAGING`, the two deploy-file exceptions, the recorded fixtures day). Decide the ASX question (O-23) and the history backfill. Turn on the GitHub safety settings.
2. **Section B (P2, release):** review and merge the "Build complete:" pull request, merge the sync pull request, approve `deploy-production`. Add `release-gate` as a required check on `release`.
3. **Section C (P3, staging proof):** list the staging Worker slots, run the recorded trading day and the cold-start day, the rollback rehearsal, ZAP, three nightly runs, the build-phase restore drill, the bake-off spot check, AT-01 and the inbox checks. Tell the agent the results (pass or fail per item, never a secret).
4. **Section D (P4 and P5):** if the agent opened a "Build complete: go-live fixes" pull request, merge it and its sync pull request, then approve the deploy again. When this note is current, **pause the "Praxis build resume" scheduled task** so no unattended build session starts.
5. **Sections E to K (P6, one sitting of about two hours):** revoke the build token and remove the bot first; then rotate every secret in the order of the rotation table; smoke tests; the real-key restore drill; the $0 check; the walkthrough with the keyboard and screen-reader check; confirm your Google backup codes; sign off on `/ops/go-live`.
6. **Section L:** the same afternoon, on a trading day before 17:00: set `email_mode` to `incidents`, list the production go-live slots, turn on `dispatch_enabled` last, then set AU to `full`.
7. **Section M (P7):** read the first 20:00 Evening Review. If the night was quiet, set `email_mode` to `full`.
8. **Section N:** keep the emergency rotation page for a bad day.

## What the agent can still do (a later, short session)

The agent has no standing access after you revoke the build token. A later session can only start when you give it a **new short-lived token** and re-add the bot as a collaborator.

- **Copy the sign-off into the decision log (decision 34).** The in-app sign-off row is the record. A session reads it and writes one decision-log row in a pull request that you approve. It changes no code.
- **Fix defects (decision 42).** If the staging proof or the first days find a defect, the agent fixes it on `build` and opens one pull request titled "Build complete: go-live fixes" with its sync pull request. The release gate must be green before you merge. After go-live the gate is in `full` mode, so staging proof must be green on the exact commit.
- **Update the test reports** from the results you give it (pass or fail, date, who ran it). A row leaves "pending" only when a run is recorded.
- **Refresh the CI minutes table** (`node scripts/ci/minutes-table.mjs` on a read-only `gh api` answer; it needs no new token beyond the short-lived one).
- It never does a step that is yours: it does not revoke, rotate, approve a deploy, sign off, change a mode or see a secret.

After the session, revoke the token and remove the bot again.

## Where everything lives

| What | Where |
|---|---|
| Owner script for go-live and emergency rotation | [owner-guide/M8_go_live.md](owner-guide/M8_go_live.md) |
| Daily to yearly routine, incidents, rollback, Worker redeploy | [owner-guide/operations.md](owner-guide/operations.md) |
| Guide index | [owner-guide/README.md](owner-guide/README.md) |
| What is proven and what is pending | [M8_exit_evidence.md](M8_exit_evidence.md), [test-reports/](test-reports/) |
| Requirement-to-test map | [test-map.md](test-map.md) (generated check: `node scripts/ci/test-map.mjs`) |
| Every decision | [07_decision_log.md](07_decision_log.md) (M8: D-152 to D-161 and later) |
| Configuration values and their [VERIFY] dates | [config-reference.md](config-reference.md) |
| Data-source licences | [source-licence-register.md](source-licence-register.md) |
| Design and requirements for M8 | [M8_design.md](M8_design.md), [M8_requirements.md](M8_requirements.md) |
| Words used in the app and the docs | [glossary.md](glossary.md) |
| Setup and architecture | `README.md` in the repository root |
| Secret names and stores (names only) | `src/lib/security/secretStores.ts`; the rotation table in the guide is generated from it |
| Release gate | `node scripts/ci/release-gate.mjs`; also shown on `/ops/go-live` |
| Restore from a backup if GitHub is down | `scripts/restore/restore.mjs` and `scripts/restore/README.md` |
| Restore drill | workflow `restore-drill.yml` (modes `drill`, `restore`, `verify-removed`) |

## Open items you should know about

The complete list is in the exit evidence, section "Open / pending". The short version: the 16 pending licences keep the release gate closed until you approve them; the ZAP scan is skipped until you pin the image digest; the fixtures repo needs one recorded day; and the known limits you are accepting for go-live (decision 43) are listed there with their decision numbers.

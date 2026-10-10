# M1 exit evidence (AT-01, AT-02, AT-03, AT-04, AT-05a, AT-05b)

Status date: 2026-10-10. Branch `build`. Source rows: [spec/14_system_acceptance.md](../spec/14_system_acceptance.md) section 14.1. Test homes come from [TST-115](../spec/10_nfr_testing.md). Test files come from [test-map.md](test-map.md). "Unit" means the test runs in CI with no real services. Quoted check text has markdown bold removed and is trimmed with "…".

Overall: M1 exit is **not yet met**. Every AT row is partial or blocked. The automated parts that need no deployment are mostly in place. The real proofs need the deploy decision and the Owner's actions.

---

## AT-01 Sign-in matrix

**Requirement (verbatim, trimmed):** "Owner, Editor, Viewer sign in; non-allowlisted account refused with a neutral message; revoked user refused on next request; Google `sub` mismatch refused (s13) … With no ROL-107 acknowledgement row, Add-user is disabled with the hint 'Acknowledge sharing first'."

**Evidence now**
- Allowlist, sub binding, revocation and session_version: `tests/auth/allowlist.test.ts`, `tests/auth/session.test.ts`, `tests/auth/signout.test.ts`, `tests/auth/config.test.ts` (unit, test-map SEC-010 row).
- Add-user gate and hint: `tests/users/page.test.tsx`, `tests/users/service.test.ts` (test-map UX-111 row).
- Not verified: the neutral refusal wording has no test-map row, and a grep of `tests/auth` finds no check of the wording.

**Still needed**
- (a) Automated: a test that pins the neutral refusal text; a local end-to-end run of the three roles through the test-identity login on a local build (`tests/e2e` does not exist yet; TST-126).
- (b) Blocked on deployment: the same run against staging with staging test identities (TST-113).
- (c) Owner-executed: the real Google sign-in matrix with the three test accounts (Owner, Editor, Viewer, non-allowlisted) and a `sub` mismatch check. D-009 defers this to before go-live, but TST-115 names AT-01 as Owner-executed. **Decision needed:** whether M1 exit requires the real matrix now (TST-115 says yes).

**Status: partial** (blocked for the end-to-end and real-Google parts).

---

## AT-02 Role enforcement

**Requirement (verbatim, trimmed):** "Every action not allowed for a role in ROL-102a returns 403 for that role (automated with staging test identities); each refusal audit-logged; for masked users no code, company name, trade price, trade date, source link or name inside LLM text appears in any page or API response (UX-009) … A masked user never sees execution IDs (E01–E12), family codes (F1–F6) or company identifiers in any page or API response."

**Evidence now**
- Role × action matrix, unknown action Owner-only, 403 plus `auth.forbidden` audit: `tests/auth/permissions.test.ts`, `tests/auth/guard.test.ts`.
- Same-origin and rate-limit gates: `tests/http/gate.test.ts`, `tests/http/rateLimit.test.ts`.
- Route and action list matches the tested list (entry level only): `scripts/ci/route-coverage.mjs`, `scripts/ci/route-coverage.test.mjs`, `tests/routes/manifest.json`. Per-case role coverage is by review.
- Owner-only user, config and preference pages: `tests/users/actions.test.ts`, `tests/config/actions.test.ts`, `tests/preferences/actions.test.ts`.

**Still needed**
- (a) Automated: per-route tests for each role in the manifest, so the per-case check is automatic and not by review (TST-122). Masking of codes, company names, prices and dates for non-Owners (ROL-107, UX-009) has no test-map row and no test found; it must be built and tested. The masking work is a build task, not a deploy task.
- (b) Blocked on deployment: the 403 checks run against staging test identities on the deployed staging app.
- (c) None.

**Status: partial** (masking not built; staging run blocked).

---

## AT-03 Secrets hygiene

**Requirement (verbatim, trimmed):** "CI smoke test stages 1–2 pass in production (TST-115); secret scan of full git history clean; no secret in logs, DB or client bundle"

**Evidence now**
- Full-history gitleaks with a pinned, checksum-verified binary: `.github/workflows/ci.yml` (job `secrets`), `.gitleaks.toml`.
- Client bundle has no server-only secret names: `.github/workflows/ci.yml` (job `app`), `scripts/ci/bundle-secret-scan.mjs`, `scripts/ci/bundle-secret-scan.test.mjs`.
- Stage 1 prints no secret value and fails without a network call: `scripts/smoke/checks.test.mjs` (unit, mocked network).
- Stage 2 signed self-check: `tests/selfcheck/route.test.ts`, `scripts/smoke/stage2.test.mjs` (unit).

**Still needed**
- (a) Automated: a test that no secret reaches logs or the database (test-map SEC-104 row says not built); the CI check that blocks data-like files, email addresses and the Owner's name (SEC-110 a; not built). A text search for "email address" hit `scripts/smoke/checks.mjs`; the check must confirm it is prose and not an address.
- (b) Blocked on deployment: stage 2 in production needs the deployed skeleton and `APP_BASE_URL_PROD` (guide section C).
- (c) Owner-executed: the real stage 1 run for staging and production with real secrets (guide section F). Live proof is not in CI (test-map SEC-017 and D-024 rows).

**Status: partial.**

---

## AT-04 Backup and restore

**Requirement (verbatim, trimmed):** "Nightly main-DB and auth-DB backups present (auth via the encrypted Vercel export); the build-phase drill (in-run throwaway key pair, fresh staging backups) restores them into two throwaway Turso databases (main and auth, both deleted afterwards) within 4 h with matching checksums; the drill fails while the temporary token (l) remains; the real-key drill with cohort replay is part of AT-30"

**Evidence now**
- Dump, encrypt, retention and signed export route: `tests/backup/core.test.ts`, `tests/backup/exportRoute.test.ts`, `scripts/backup/run.test.mjs`, `scripts/backup/drill.test.mjs` (unit, test-map PLT-022 row).
- Synthetic restore drill in CI with a throwaway key and checksum comparison: `scripts/backup/drill.mjs` run from the `app` job in `.github/workflows/ci.yml` (D-046).
- Retention rules: `tests/maintenance/retention.test.ts`.

**Still needed**
- (a) Automated: the restore workflow into two throwaway Turso databases, with deletion afterwards and a failure while token (l) or the private-key secret exists (guide section I says it is built in a later task). The fail-while-present guard and the nightly watchdog check can be written and unit-tested now.
- (b) Blocked on deployment and Turso: a real nightly production backup (needs the production export route and the data repo), and the real Turso restore within 4 h.
- (c) Owner-executed: run the nightly backup by hand from `release` and confirm the drill prints PASS (guide section H). The real-key drill belongs to AT-30, not M1.

**Status: partial** (real-data parts blocked).

---

## AT-05a Deploy isolation and repo hygiene

**Requirement (verbatim, trimmed):** "A nightly archive/backup to the private data repo triggers no Vercel deployment and no code-repo workflow; the code repo contains no data-like files, email addresses or the Owner's name, fixture-test logs show only test ids and pass/fail, logs of a full nightly run contain no secret values, emails, prices, position/signal codes or third-party text, no Actions artifact or cache contains data, and a fork PR runs only synthetic tests with no secrets"

**Evidence now**
- Vercel git auto-deploy off: `vercel.json` (`git.deploymentEnabled: false`, D-013). No test file covers it.
- Nightly jobs are dispatch-only with `deployment: false`: `.github/workflows/backup.yml`, `.github/workflows/maintenance.yml`, `.github/workflows/smoke-test.yml` (D-023). Their workflow logic is "manual" in test-map.
- Backup caller prints no secret, URL or key: `scripts/backup/run.test.mjs`.
- Full-history secret scan: `.github/workflows/ci.yml` (job `secrets`).

**Still needed**
- (a) Automated: the data-like-file, email and Owner-name check (SEC-110 a); a log-content test for the maintenance and smoke runs (only the backup caller is covered); a CI check that no workflow uploads an artifact or cache with data; a check that the `pull_request` trigger in `ci.yml` cannot run secrets for forks (today this rests on a GitHub repo setting, not on a test).
- (b) Blocked on deployment: "no Vercel deployment and no code-repo workflow" can only be observed on a real nightly archive (needs the data repo and the Worker dispatch from M2).
- (c) Owner-executed: confirm GitHub settings from BLD-010 row 1 (fork PR approval for external contributors, Issues/Wiki/Projects off, secret scanning and push protection on, noreply commit email).

**Status: partial.**

---

## AT-05b Release control

**Requirement (verbatim, trimmed):** "A merge to `main` deploys only staging (app and Worker); production and deploy-production environment secrets are unavailable to jobs on any other branch; production deploys wait for the Owner's approval in GitHub; a merged but unapproved release runs nothing new in production jobs (they check out the last approved commit); the production Worker deploy job and every production workflow refuse any ref other than `release`; `release` is the default branch; … the production Vercel project builds no previews; the production auth-export route rejects any caller-supplied key; pushing an unapproved commit to `release` raises an S1 incident the same night (s13) With the GitHub API unreachable (mocked 503), the nightly deployed-commit check uses the DB-signed record (SEC-108 d) and raises an S1 incident on mismatch."

**Evidence now**
- Latest approved `deploy-production` commit lookup, with "awaiting first approval" and the bootstrap exception: `scripts/ci/approved-commit.mjs`, `scripts/ci/approved-commit.test.mjs` (test-map SEC-108 c, d row).
- Production-facing jobs use `deployment: false` and the approved-commit lookup: `.github/workflows/smoke-test.yml`, `maintenance.yml`, `backup.yml`.
- Production export route rejects a caller key: `tests/backup/exportRoute.test.ts`.
- Vercel previews off: `vercel.json` (D-013).

**Gaps**
- No `deploy-production` workflow exists. The guide (section E) says it is "pending your decision on the deploy workflows".
- No production Worker deploy job and no ref guard on production workflows.
- The nightly deployed-commit check, the DB-signed fallback and the S1 path are not built (test-map SEC-108 row lists only the lookup).
- No test for an unapproved push to `release`, or for a web-merged release versus an extra commit.

**Still needed**
- (a) Automated, no deployment needed: the nightly deployed-commit check, including the mocked 503 fallback to the DB-signed record and the S1 incident on mismatch; a unit test that every production workflow refuses any ref other than `release`.
- (b) Blocked on the deploy decision: the `deploy-production` and Worker deploy jobs; the "unapproved push raises S1 the same night" and "web-merged release passes" tests need a real release and a real approval.
- (c) Owner-executed: GitHub settings (environments, branch protection, `release` as default branch, Owner as required reviewer; BLD-010 rows 1, 16, 17); the first approval (guide section E); the pre-registered test incident under OPS-045 (spec chapter 11, not read for this report).

**Status: blocked.**

---

## Summary

| AT | Check (short) | Status | Blocked by |
|---|---|---|---|
| AT-01 | Sign-in matrix | partial | Staging deploy; Owner real Google matrix (D-009 vs TST-115) |
| AT-02 | Role enforcement, masking | partial | Masking not built; staging deploy |
| AT-03 | Secrets hygiene | partial | Stage 2 needs deploy; data-like check not built; Owner stage 1 run |
| AT-04 | Backup and restore | partial | Production export and data repo; Turso restore workflow not built |
| AT-05a | Deploy isolation, repo hygiene | partial | SEC-110 CI check not built; Owner GitHub settings |
| AT-05b | Release control | blocked | Deploy-workflow decision; nightly commit check not built; Owner approval |

## Owner actions that unblock M1 exit (in order)

0. **Deploy-workflow decision.** Needed for step 5 and AT-05b. Also decide whether the real AT-01 Google matrix is required for M1 exit (D-009 vs TST-115).
1. **Guide section A:** delete the misplaced secret copies (A1 to A3). Do not remove any name a workflow reads.
2. **Guide section B:** staging Vercel deploy token. The checklist marks it "on hold"; the section body has no hold note. Confirm with the build agent before doing it.
3. **Guide section C:** add `APP_BASE_URL_PROD` and `APP_BASE_URL_STAGING`.
4. **Guide section D:** approve and merge the two bootstrap PRs ("M1 bootstrap" into `main`, then the `sync/main-to-release` PR into `release`).
5. **Guide section E:** approve the first production deployment in GitHub (needs the deploy workflow from step 0).
6. **Guide section F:** run stage 1 on `main` (staging), then on `release` (production, approve `deploy-production`). Check the two `[TEST]` emails. Stage 2 runs after the skeleton is deployed.
7. **Guide section G (later in M1):** Worker dispatch tokens, Worker to Vercel HMAC, Worker Turso token, 2-step verification on Cloudflare and Turso.
8. **Guide section H:** run the nightly backup by hand from `release`; confirm `drill: PASS` and the `backup-<date>` release.
9. **Guide section J:** run nightly maintenance by hand from `release`; confirm the run record.
10. **Guide section K:** check `/health`, `/users`, `/usage`, `/config` and `/settings`.
11. **AT-01 Owner matrix:** run the sign-in matrix with the three Google test accounts, if step 0 requires it.
12. **Settings check:** confirm the GitHub and Vercel settings in BLD-010 rows 1 and 16 for AT-05a and AT-05b.

Guide sections I (decrypt, restore only) and L (break-glass, emergency only) are not needed for M1 exit.

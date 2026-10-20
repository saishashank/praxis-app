# Owner guide for milestone M8 (go-live)

## What this is

This guide takes you from "the build is finished" to "the first real trading day". You do every step in it. The build agent never does an Owner step, never sees a secret and never revokes or rotates anything. [BLD-040, SEC-101]

There are seven phases. The names P1 to P7 come from the M8 design note. [M8 design 2.1]

| Phase | Who | What happens |
|---|---|---|
| P1 Build | the agent | The agent finishes the code and opens one pull request titled "Build complete:". |
| P2 Release | you | You merge it, merge the sync pull request and approve the deploy. Production stays data-only. |
| P3 Staging proof | you, and the agent fixes defects | You run the staging tests and report the results. |
| P4 Final release | you | If a fix pull request exists, you merge it and approve the deploy again. |
| P5 Hand-back | the agent | The agent writes a hand-off note and stops. You pause its scheduled task. |
| P6 Sign-off | you | One sitting of about two hours. Revoke, rotate, restore drill, $0 check, walkthrough, sign-off. |
| P7 First trading day | the system | The cohorts open. You read the first Evening Review. |

Never paste a secret into chat, a file, an issue, a pull request or a log. Enter each secret only in the store the table names. [SEC-101]

The code repository is public. Use placeholders such as `<your Gmail address>` in your own notes. [SEC-110]

Where a screen name may have changed, the step says [VERIFY]. If a screen looks different, stop and ask the agent in a new session. Do not guess.

## Checklist

Tick each box when the section is done.

| ☐ | Section | What you do |
|---|---|---|
| ☐ | A | Before P2: confirm decisions and turn on the GitHub safety settings |
| ☐ | B | P2: merge "Build complete:", merge the sync pull request, approve the deploy |
| ☐ | C | P3: the staging proof, step by step |
| ☐ | D | P4 and P5: final release and hand-back |
| ☐ | E | P6, part 1: revoke the build token and remove the bot (do this first) |
| ☐ | F | P6, part 2: rotate every secret |
| ☐ | G | P6, part 3: smoke tests |
| ☐ | H | P6, part 4: the real-key restore drill |
| ☐ | I | P6, part 5: the $0 check |
| ☐ | J | P6, part 6: the walkthrough, the AT-26 check and the backup codes |
| ☐ | K | P6, part 7: sign off in the app |
| ☐ | L | Turn on email, the Worker slots, dispatch and AU `full` |
| ☐ | M | P7: the first trading day |
| ☐ | N | Emergency rotation (keep this for a bad day) |

---

## A. Before P2: decisions and settings

You can do this any time while the agent is still building. None of it blocks the agent. [M8 design 7, items 1 to 5]

**A1. Confirm or overrule five decisions.** Tell the agent, in chat, yes or no for each one. [D-152]

1. Decision 6: the emergency-rotation checklist is public and generic. It holds secret names and store names only. You may keep a private copy with account notes.
2. Decision 10: the model bake-off may end with no model passing. Then every role stays rules-only. That is a valid result. [LLM-041, LLM-050]
3. Decision 22: the dev-only tool StrykerJS may be installed for mutation tests. It never ships.
4. Decision 34: after go-live, a later build session copies your sign-off record into the decision log in a pull request that you approve.
5. Decision 42: if the staging proof finds defects, the agent may open one more pull request titled "Build complete: go-live fixes", with its sync pull request.

**A2. Carried approvals.** Each earlier milestone listed approvals it needs from you in its exit evidence (M3 to M7). Work through them with the agent. Examples are the cost and tick tables, the licence exceptions, the new dependencies and the label wording. [docs/M3_exit_evidence.md to docs/M7_exit_evidence.md]

**A3. The ASX decision (O-23).** Decide whether to accept the ASX risk.

- If you accept: you will set `asx_enabled`, `ASX_LIVE` and `ASX_USER_AGENT` at go-live (section L).
- If you decline: the announcements test AT-18 Part A and AT-21 cannot pass on production. Go-live then needs your written exception in the decision log. [M8 design 7, item 3]

The licence page lists the ASX acceptance date as "pending Owner" until you accept. [docs/source-licence-register.md]

**A4. History backfill.** Say whether go-live waits for the announcement backfill and the real-data null runs (AT-17), or record a dated re-deferral. [DAT-125]

**A5. GitHub safety settings.** Turn these on in your code repository. They are free for a public repository. [SEC-104, SEC-108 b]

1. Go to your code repository on GitHub. Select **Settings**.
2. Select **Advanced Security** (or **Code security**). [VERIFY screen name]
3. Turn on **Dependabot alerts**, **Secret scanning** and **Push protection**.
4. Under **Code scanning**, choose **Set up → Default** for CodeQL. Do not add a workflow file. [M8 design decision 39]
5. Select **Branches**. Check that `main` and `release` each have: a pull request required, 1 approval required, "Require approval of the most recent reviewable push", the status checks, no force-push, no deletion, and "Do not allow bypassing the above settings". [SEC-108 b]
6. Open Vercel. Open the production project, then **Settings → Deployment Protection**. Check it is on. [SEC-108 g, VERIFY screen name]
7. Write down the date you did this. The AT-29 report records the date only, not any value.

---

## B. P2: release (production stays data-only)

The agent opens the "Build complete:" pull request when every check is green. Read it before you approve. [D-022]

**B1. Review and merge "Build complete:".**

1. Go to your code repository on GitHub. Select **Pull requests**.
2. Open the pull request whose title starts with **"Build complete:"**. It goes from `build` into `main`.
3. Read the part called **Security-relevant changes**. It lists the changed workflow files, the changed secret names, the new dependencies, the new workflows you must approve and the new migrations. [SEC-107]
4. Open **Files changed**. Check these on purpose:
   - `.github/workflows/ci.yml` (the agent edits it only in this pull request),
   - the new workflow files,
   - the migrations: main `0007` to `0012` and auth `0004` to `0006`,
   - that no file holds an email address, a name or a secret value. [SEC-110 a]
5. Select **Review changes**, choose **Approve**, then **Submit**.
6. Select **Merge pull request**, then **Confirm merge**.
7. A merge to `main` deploys only staging. If `deploy-staging` asks for approval, open the run, select **Review deployments**, tick `deploy-staging` and select **Approve and deploy**. [OPS-041, VERIFY button label]

**B2. Merge the sync pull request.**

1. Open the second pull request. It has `sync/main-to-release` in the title and goes into `release`.
2. Read it the same way. Approve and merge it.

**B3. Approve the production deploy.**

1. Select **Actions**. Open the **Deploy production** run.
2. Select **Review deployments**. Tick `deploy-production`. Select **Approve and deploy**. [SEC-108 c]
3. Wait for the run to finish green. Do this in the same sitting as the merge. [BLD-010 row 18]

**B4. Migrations.** You do not run migrations. The deploy build applies any new ones, main first and then auth. [scripts/db/migrate.mjs] After the staging deploy and the production deploy, check three things:

1. The deploy run is green.
2. The app opens and you can sign in.
3. System Health shows no red "database" item. [VERIFY]

If a deploy fails at the migration step, do not retry in a loop. Stop and tell the agent the run number.

**B5. Add the release gate as a required check.** After this release, the new workflows exist on `release`. [M8 design 2.7]

1. Go to **Settings → Branches**. Open the rule for `release`.
2. Under required status checks, add **release-gate**. [VERIFY name]
3. Save.

Production is still data-only. Nothing trades yet. [BLD-024]

---

## C. P3: the staging proof

Staging has its own Worker, database and data. The staging Worker runs only in your test windows, so you turn its slots on and off by hand. [NFR-040]

Keep a list of results as you go: pass or fail per item, and the run number. Tell the agent the results at the end (C12). Never include a secret value.

**C1. Check the fixtures.** The staging run reads one recorded trading day from the private fixtures repository. [M8 design decision 31]

1. Open the fixtures repository. Check that it holds `recorded/au/<date>/` for one trading day, with five files: `bars`, `index`, `short`, `announcements` and `corporate_actions`.
2. Check that it holds the golden set for the bake-off: at least 50 items and at least 10 per category.
3. If either is missing, ask the agent for the local builder script. Run it on your own computer and commit the result to the fixtures repository yourself.
4. In your code repository open **Settings → Environments → `staging`**. Check it holds `FIXTURES_READ_TOKEN` and the test-identity secret is in the staging Vercel project as `TEST_IDENTITY_SECRET`. [SEC-017 (f-r), (c4)]

**C2. AT-28, the full-day run.** [AT-28, TST-106]

1. Open the staging app. Sign in as Owner. Select the gear menu, then **System health**.
2. In the **Worker slots** block, tick the go-live slots you want for the window, then confirm. Do this for staging only.
3. In **Data controls**, turn **Nightly dispatch** on for staging.
4. Set the AU market mode to **Full** on staging. Staging may switch freely. [M8 design 2.6]
5. In **Email controls**, set **Email mode** to **full**. On staging the email goes only to you.
6. If email stays on the test provider, ask the agent how to set `EMAIL_LIVE=1` for the window. Do not paste any value. [D-155]
7. Let the Worker run the evening pipeline on a real AU trading day.
8. After 20:45, go to your code repository, **Actions**, and run the workflow whose file is `staging-e2e-day.yml`. Use branch `main`. [VERIFY name]
9. Open the run summary. Every row of the deadline table must say pass. The table has times and step names only.
10. The System Health page also has a **Day timeline check** block with the same table. [VERIFY]

**C3. AT-28, the cold-start day.** This day uses an empty database. It is also your rehearsal of the database swap in OPS-040 step 3. [OPS-040, M8 design decision 8]

1. In Turso, create a new empty database for staging main data.
2. Create a token for it.
3. Enter the new address and token in every staging store: the Vercel staging project, the GitHub `staging` environment and the staging Worker. The names are in the table in section F, row (d). [SEC-017 (d)]
4. Redeploy staging (Vercel, then the Worker).
5. Run the same day as C2 again, including the checker run.
6. Every job must reach its marker. Each shows "no history" results. The first cohorts open from the next session.
7. Turn the staging slots and staging dispatch off when you are done.

**C4. Rollback rehearsal.** Time it. The target is under one hour. [OPS-042, OPS-050, NFR-004]

1. In Vercel, open the staging project, then **Deployments**. Open the previous good deployment. Select **Promote to Production** (this is "promote previous"). [VERIFY label]
2. In the Cloudflare account that holds the staging Worker, open the Worker, then **Deployments**. Roll back to the previous version. [VERIFY]
3. Check the app and the Worker work.
4. Go forward again: promote the newest deployment, and deploy the newest Worker version.
5. Write down the minutes it took.

**C5. ZAP.** Run the workflow `zap-baseline.yml` on staging, branch `main`. [VERIFY name] Open the summary. It lists rule names, risk and counts only. No High finding may be there. [AT-29, SEC-104]

**C6. Three nightly runs.** The workflow `nightly.yml` must be green three nights in a row, with no red run between. Either wait for its schedule or run it by hand on three evenings. [AT-31, D-152 decision 21]

**C7. Build-phase restore drill.** [TST-108, AT-04]

1. In Turso, create a short-lived platform token with the narrowest scope that can create a database. Choose the shortest expiry.
2. In your code repository open **Settings → Environments → `staging`**. Add it as the secret `TURSO_PLATFORM_TOKEN_TEMP`.
3. Go to **Actions → Restore drill → Run workflow**. Branch `release`. Set **mode** to `drill`, **environment** to `staging` and **key** to `throwaway`. [VERIFY]
4. When the run finishes, delete `TURSO_PLATFORM_TOKEN_TEMP` from the environment and revoke the token in Turso. The last step of the run stays red until you do.
5. Run it once more with **mode** `verify-removed`. It must end green.

**C8. Bake-off.** [TST-111, LLM-040]

1. Spot-check at least 10 golden-set items.
2. The `llm-bakeoff.yml` workflow has no staging variant, because staging holds no LLM keys. Run it on production: **Actions → LLM bake-off → Run workflow**, branch `release`. [D-155, VERIFY]
3. Fill the inputs: `candidates` (free models only), `trains` (providers that do not train on prompts), `checked` (the date you checked each one) and `store` ticked.
4. Open **Usage** (gear menu) and read the bake-off report.
5. Give a model a role only if it passed. If none passed, do nothing. Roles stay rules-only. [LLM-041]

**C9. AT-01, the Google sign-in matrix.** Use your three test accounts. [AT-01, TST-113]

| Account | Expected result |
|---|---|
| Owner | Signs in. |
| Editor | Signs in. Sees what an Editor may see. |
| Viewer | Signs in. Sees what a Viewer may see. |
| Not on the list | Refused with a neutral message. |
| A revoked user | Refused on the very next request. |

Also check this: with no sharing acknowledgement, **Add user** is disabled with the hint "Acknowledge sharing first". [ROL-107]

**C10. Inbox checks and the failure tests.** [AT-05, AT-20, EML-036]

1. Open your Gmail. Check that the staging test emails are in the inbox, not in spam. Check the sender and the subject start with "[STAGING]". [AT-20]
2. Go to **Actions → Watchdog → Run workflow**, branch `release`. Leave `slot` on `manual` and `deliberate_failure` off. Open the run. Check it is green or, if the review was late, that it sent the minimal review email. This is the forced watchdog run. [AT-20]
3. Run **Watchdog** again with `deliberate_failure` ticked. The run fails on purpose. Check that GitHub's failure email reaches your Gmail inbox, not spam. [NFR-006, BLD-010 row 16a]
4. The AT-05b test push is expected. It is a pre-registered test incident. It does not start the unapproved-release runbook (OPS-045). The agent tells you when it will happen. [AT-05b]
5. Check the SPF and DKIM result in the header of one received email. In Gmail open the email, then the three dots, then **Show original**. [EML-036]

**C11. Production-side checks after P2.** [M8 design 4, "All previous"]

1. Run the credential smoke test, stage 1 and stage 2, on production (section G tells you how). This is the AT-03 check that the old secrets still work.
2. Run the full-history secret scan: the `secrets` job of CI shows it.

**C12. Tell the agent.** In a new session, say pass or fail for each item with the run numbers. The agent updates the test reports and fixes any defect through decision 42. When you hear "all reports pass", go to D. [docs/test-reports/]

---

## D. P4 and P5: final release and hand-back

1. If a fix pull request exists, review and merge it the same way as in B1. Merge its sync pull request when the **release-gate** check is green. Then approve `deploy-production` again. [D-152 decision 42]
2. Wait for the agent's hand-off note, `docs/m8-handoff.md`. It says what is done, what waits for you and how to add the bot again later. [M8 design decision 36]
3. Pause the "Praxis build resume" scheduled task on the build machine. After this, no agent session runs. [CLAUDE.md]
4. Do not start section E until the note exists and the task is paused. The agent cannot push after you revoke the token.

---

## E. P6, part 1: revoke the build token and remove the bot (first)

Do this before any rotation. The bot's token is as powerful as the production secrets. If you rotated first, you would have to rotate again. [D-152 decision 1, BLD-010 row 18, SEC-108 e]

Choose a time between 10:00 and 16:00 Melbourne time on a weekday, or any time on a weekend. Stay out of the pipeline hours (17:30 to 21:00). Also stay away from the nightly approved-commit check at 11:40 UTC (21:40 or 22:40 Melbourne time, depending on the season). [M8 design 2.4]

1. Sign in to GitHub as the **bot** account.
2. Go to **Settings → Developer settings → Personal access tokens → Tokens (classic)**. [VERIFY screen names]
3. Select the build token. Select **Delete**. Confirm.
4. Sign out of the bot account.
5. Sign in as yourself. Go to your code repository, **Settings → Collaborators**.
6. Remove the bot. Confirm.
7. Open the private data repository and the private fixtures repository. Check the bot is not listed in either. [SEC-017 note, PLT-022a]
8. Open the sign-off page tick later: "The build access token is revoked and the build bot is removed". [AT-30]

---

## F. P6, part 2: rotate every secret

Work in this order. The table is generated from `src/lib/security/secretStores.ts`, so this page and the app use the same list. It holds names and stores only, never a value. [SEC-017, SEC-021, D-152 decision 26]

How to create a value:

- For the signing secrets (c1, c2, c3, c4, PII_HASH_KEY): use your password manager's generator. Make 64 characters from `0-9` and `a-f` (64 hex characters). The smoke test checks that shape.
- For tokens at a provider: create the new one first. Delete the old one after the smoke test passes. If the provider cannot keep two, enter the new value in every store at once.
- Copy a value straight from the provider page into the store page. Do not park it in a note, chat or a file.

<!-- secret-table:start (generated from src/lib/security/secretStores.ts) -->

Steps, in order:

| Step | What you do | Where |
| --- | --- | --- |
| 1 | Revoke the build token and remove the bot | GitHub |
| 2 | GitHub environment secrets (deploy, production, ci-fixtures) | GitHub |
| 3 | Turso tokens, one database at a time | Turso |
| 4 | Vercel production environment variables | Vercel |
| 5 | Cloudflare production Worker secrets | Cloudflare |
| 6 | Redeploy the same approved commit and the Worker | GitHub |
| 7 | Staging: every staging store, then redeploy staging | all |
| 8 | Smoke tests on staging and production | GitHub and System Health |
| 9 | Enter the new expiry dates | System Health |

Secrets, in the order you work through them:

| Order | Row | Secret | Action | Who issues it | Where it is entered (store, name, step) | Smoke check that proves it | Expiry date tracked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | (a) | Build-agent token (classic personal access token of the bot account) | Revoke | GitHub, bot account (you revoke it; you never issue a new one at go-live) | none (the build agent's own configuration) | Listed, no automatic check: Revoked, not rotated: nothing to test. Proof is the bot's token page showing no token, the bot removed from Collaborators, and the first sign-off tick. | Yes, up to 90 days |
| 2 | (c3) | Actions to Vercel signing secret (separate value per environment) | Rotate | You, with your password manager's generator (64 hex characters) | production: GitHub environment `production`: `ACTIONS_HMAC_SECRET_PROD` (step 2); production: Vercel project `praxis-app`, environment variables (Production): `ACTIONS_HMAC_SECRET` (step 4); staging: GitHub environment `staging`: `ACTIONS_HMAC_SECRET_STAGING` (step 7); staging: Vercel project `praxis-app-staging`, environment variables (Production): `ACTIONS_HMAC_SECRET` (step 7) | production: ACTIONS_HMAC_SECRET format (job production); staging: ACTIONS_HMAC_SECRET format (job staging); production: Stage 2 production: n/n passed (Stage 2 step: a signed call that the Vercel route accepts) | Yes, up to 1 year |
| 3 | (f) | Data-repo token (fine-grained, data repo only, contents read and write) | Rotate | GitHub, your account (fine-grained token, data repo only) | production: GitHub environment `production`: `DATA_REPO_TOKEN_PROD` (step 2) | production: GitHub read: data repo (job production) | Yes, up to 1 year |
| 4 | (f-r) | Read-only fixtures token (fine-grained, fixtures repo only, contents read) | Rotate | GitHub, your account (fine-grained token, fixtures repo only) | staging: GitHub environment `staging`: `FIXTURES_READ_TOKEN` (step 2); staging: GitHub environment `ci-fixtures`: `FIXTURES_READ_TOKEN` (step 2) | staging: GitHub read: fixtures repo (jobs staging and ci-fixtures) | Yes, up to 1 year |
| 5 | (g) | Cloudflare API token (Edit Workers; a separate account per environment) | Rotate | You, in Cloudflare: one token per account (production account, staging account) | production: GitHub environment `deploy-production`: `CLOUDFLARE_API_TOKEN_PROD` (step 2); staging: GitHub environment `deploy-staging`: `CLOUDFLARE_API_TOKEN_STAGING` (step 2) | production: Cloudflare API token (job deploy-production); staging: Cloudflare API token (job deploy-staging) | Yes, up to 1 year |
| 6 | (n) | Vercel deploy token (account token for command-line deploys) | Rotate | You, in Vercel (Account Settings, Tokens) | production: GitHub environment `deploy-production`: `VERCEL_TOKEN_PROD` (step 2); staging: GitHub environment `deploy-staging`: `VERCEL_TOKEN_STAGING` (step 2) | production: Vercel token (job deploy-production) | Yes, up to 1 year |
| 7 | (h) | Resend API key, production (sending only) | Rotate | You, in Resend (new key with Sending access, then delete the old key) | production: GitHub environment `production`: `RESEND_API_KEY_PROD` (step 2); production: Vercel project `praxis-app`, environment variables (Production): `RESEND_API_KEY` (step 4) | production: Resend test email (job production (one [TEST] email)); production: RESEND_API_KEY format (Stage 2 table and System Health) | Yes, up to 1 year |
| 8 | (i) | LLM API keys (one per provider) | Rotate | You, at each provider: Google AI Studio, Groq, OpenRouter | production: GitHub environment `production`: `GOOGLE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` (step 2); production: Vercel project `praxis-app`, environment variables (Production): `GOOGLE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY` (step 4) | production: Google AI key (job production); production: Groq key (job production); production: OpenRouter key (job production); production: Google AI key (Stage 2 table and System Health); production: Groq key (Stage 2 table and System Health); production: OpenRouter key (Stage 2 table and System Health) | Yes, up to 1 year |
| 9 | (pii) extra row | PII_HASH_KEY (keyed hash for personal data after retention; NFR-030) | Rotate | You, with your password manager's generator (64 hex characters) | production: GitHub environment `production`: `PII_HASH_KEY_PROD` (step 2); production: Vercel project `praxis-app`, environment variables (Production): `PII_HASH_KEY` (step 4); staging: GitHub environment `staging`: `PII_HASH_KEY_STAGING` (step 7); staging: Vercel project `praxis-app-staging`, environment variables (Production): `PII_HASH_KEY` (step 7) | production: PII_HASH_KEY format (job production); staging: PII_HASH_KEY format (job staging); production: PII_HASH_KEY format (Stage 2 table and System Health); staging: PII_HASH_KEY format (Stage 2 table and System Health) | No: The expiry list has no entry for this key yet, so no reminder is generated. Put a yearly reminder in your own calendar. Rotation does not re-hash old rows (SEC-017 s13). |
| 10 | (d) | Turso main-database tokens (one per environment per caller) | Rotate | You, in the Turso dashboard (new token per caller, then remove the old ones) | production: GitHub environment `production`: `TURSO_MAIN_TOKEN_PROD` (step 3); production: Vercel project `praxis-app`, environment variables (Production): `TURSO_MAIN_TOKEN` (step 4); production: Cloudflare Worker `praxis-sentinel` (production): `TURSO_MAIN_TOKEN` (step 5); staging: GitHub environment `staging`: `TURSO_MAIN_TOKEN_STAGING` (step 7); staging: Vercel project `praxis-app-staging`, environment variables (Production): `TURSO_MAIN_TOKEN` (step 7); staging: Cloudflare Worker `praxis-sentinel-staging`: `TURSO_MAIN_TOKEN` (step 7) | production: Turso DB round-trip (job production); staging: Turso DB round-trip (job staging); production: Turso main DB round-trip (Stage 2 table and System Health); staging: Turso main DB round-trip (Stage 2 table and System Health); production: TURSO_MAIN round trip (System Health, Worker secrets) | Yes, up to 1 year |
| 11 | (e) | Turso auth-database token (production and staging, separate) | Rotate | You, in the Turso dashboard | production: Vercel project `praxis-app`, environment variables (Production): `TURSO_AUTH_TOKEN` (step 4); staging: Vercel project `praxis-app-staging`, environment variables (Production): `TURSO_AUTH_TOKEN` (step 7) | production: Turso auth DB round-trip (Stage 2 table and System Health); staging: Turso auth DB round-trip (Stage 2 table and System Health) | Yes, up to 1 year |
| 12 | (c1) | Session secret and CRON_SECRET (random 64 hex characters) | Rotate | You, with your password manager's generator (64 hex characters) | production: Vercel project `praxis-app`, environment variables (Production): `AUTH_SECRET`, `CRON_SECRET` (step 4); staging: Vercel project `praxis-app-staging`, environment variables (Production): `AUTH_SECRET`, `CRON_SECRET` (step 7) | production: AUTH_SECRET format (Stage 2 table and System Health); production: CRON_SECRET format (Stage 2 table and System Health); staging: AUTH_SECRET format (Stage 2 table and System Health); staging: CRON_SECRET format (Stage 2 table and System Health) | Yes, up to 1 year |
| 13 | (c2) | Worker to Vercel signing secret (separate value per environment) | Rotate | You, with your password manager's generator (64 hex characters) | production: Vercel project `praxis-app`, environment variables (Production): `WORKER_HMAC_SECRET` (step 4); production: Cloudflare Worker `praxis-sentinel` (production): `WORKER_HMAC_SECRET` (step 5); staging: Vercel project `praxis-app-staging`, environment variables (Production): `WORKER_HMAC_SECRET` (step 7); staging: Cloudflare Worker `praxis-sentinel-staging`: `WORKER_HMAC_SECRET` (step 7) | production: WORKER_HMAC_SECRET format (Stage 2 table and System Health); staging: WORKER_HMAC_SECRET format (Stage 2 table and System Health); production: report delivered (System Health, Worker secrets) | Yes, up to 1 year |
| 14 | (j) | Google OAuth client secrets (two clients: production and staging) | Rotate | You, in Google Cloud Console (APIs and Services, Credentials), one client each | production: Vercel project `praxis-app`, environment variables (Production): `AUTH_GOOGLE_SECRET` (step 4); staging: Vercel project `praxis-app-staging`, environment variables (Production): `AUTH_GOOGLE_SECRET` (step 7) | production: Google OAuth client (Stage 2 table and System Health); staging: Google OAuth client (Stage 2 table and System Health) | Yes, up to 1 year |
| 15 | (m) | GitHub read token for release detection (fine-grained, code repo, read only) | Rotate | GitHub, your account (fine-grained token, code repo only; contents, actions and deployments read) | production: Vercel project `praxis-app`, environment variables (Production): `GITHUB_READ_TOKEN` (step 4) | production: GITHUB_READ_TOKEN (Stage 2 table and System Health) | Yes, up to 1 year |
| 16 | (b) | Worker dispatch token (fine-grained, code repo, Actions read and write) | Rotate | GitHub, your account (fine-grained token, code repo only) | production: Cloudflare Worker `praxis-sentinel` (production): `GITHUB_DISPATCH_TOKEN` (step 5) | production: GITHUB_DISPATCH_TOKEN (System Health, Worker secrets) | Yes, up to 1 year |
| 17 | (b-s) | Staging Worker dispatch token (separate value, same scope) | Rotate | GitHub, your account (fine-grained token, code repo only) | staging: Cloudflare Worker `praxis-sentinel-staging`: `GITHUB_DISPATCH_TOKEN` (step 7) | Listed, no automatic check: The staging Worker has no schedule outside a test window, so its self-check runs only then. Proof: the next staging test window shows GITHUB_DISPATCH_TOKEN as PASS on the staging System Health, or turn the staging slots on for a few minutes and read it there. | Yes, up to 1 year |
| 18 | (c4) | Staging test-identity signing secret (SEC-109) | Rotate | You, with your password manager's generator (64 hex characters) | staging: Vercel project `praxis-app-staging`, environment variables (Production): `TEST_IDENTITY_SECRET` (step 7) | staging: TEST_IDENTITY_SECRET format (Stage 2 table and System Health) | Yes, up to 1 year |
| 19 | (h-s) extra row | Resend API key, staging (the key that can email you from the whitelisted sender) | Rotate | You, in Resend (a separate key for staging) | staging: GitHub environment `staging`: `RESEND_API_KEY_STAGING` (step 7); staging: Vercel project `praxis-app-staging`, environment variables (Production): `RESEND_API_KEY` (step 7) | staging: Resend test email (job staging (one [TEST] email)); staging: RESEND_API_KEY format (Stage 2 table and System Health) | Yes, up to 1 year |
| none | (k) | Backup key pair (age): public key in two stores, private key offline only | Keep (not rotated) | You, offline (only on suspicion, OPS-037a) | production: GitHub environment `production`: `BACKUP_PUBLIC_KEY`; production: Vercel project `praxis-app`, environment variables (Production): `BACKUP_PUBLIC_KEY`; production: Your offline safe place (never on GitHub, Vercel or Cloudflare): `BACKUP_PRIVATE_KEY` | production: BACKUP_PUBLIC_KEY format (job production); production: BACKUP_PUBLIC_KEY format (Stage 2 table and System Health) | No: A key pair does not expire. It is replaced only if you suspect the private key was exposed (OPS-037a). |
| none | (l) | Temporary restore secrets: Turso platform token and the private backup key | Absent (delete after use) | You, in Turso (narrowest create-database scope, shortest expiry), only for a drill or restore | production: GitHub environment `production` (temporary): `TURSO_PLATFORM_TOKEN_TEMP`, `BACKUP_PRIVATE_KEY` | Listed, no automatic check: A secret that must NOT exist after use. Proof of removal: a Restore drill run with mode verify-removed ends green, and the nightly watchdog stays green (it fails while either secret is present). | No: Short-lived by design; delete both secrets and revoke the token the same day. |

<!-- secret-table:end -->

**F1. Step 1.** Done in section E.

**F2. Step 2, GitHub environment secrets.** [SEC-108 a]

1. Go to your code repository, **Settings → Environments**.
2. Open each environment the table names: `production`, `deploy-production`, `deploy-staging`, `staging` (only the secrets the table puts in step 2) and `ci-fixtures`.
3. For each name in step 2: select the secret, **Update**, paste the new value, **Update secret**.
4. Names ending `_PROD` live in `production` or `deploy-production`. Names ending `_STAGING` live in `staging` or `deploy-staging`.

**F3. Step 3, Turso.** [D-152 decision 26]

1. Open the Turso dashboard. Open the main database. Create a new token for each caller in the table, row (d). A caller is the Vercel project, GitHub Actions and the Worker.
2. Do the same for the auth database, row (e).
3. [VERIFY] Check whether Turso stops all old tokens of a database at once when you invalidate one. If it does, update every caller of that database in the same sitting, in steps 3 to 5, without a long pause.
4. Enter the GitHub copy of row (d) now (this is the exception to "GitHub first": the token must exist before you can enter it).

**F4. Step 4, Vercel production.**

1. Open the production Vercel project. Select **Settings → Environment Variables**.
2. For each name the table puts in step 4, edit the Production value and save. Do not touch the other environments.
3. Make the new values for rows (c1), (c2) and (j) first: (c1) and (c2) from your generator, (j) from Google Cloud Console (APIs and Services, Credentials, the production client, **Add secret**). Keep both redirect addresses unchanged. [PLT-035]
4. Row (m): create the new fine-grained token in GitHub (code repository only; Contents, Actions and Deployments: read). Enter it as `GITHUB_READ_TOKEN`.
5. Row (i): make a new key at Google AI Studio, Groq and OpenRouter. Enter the same value in GitHub (step 2) and in Vercel (step 4).

**F5. Step 5, Cloudflare production Worker.**

1. Sign in to the Cloudflare production account. Open **Workers & Pages**, then the production Worker `praxis-sentinel`.
2. Open **Settings → Variables and Secrets**. [VERIFY]
3. Edit the names the table puts in step 5. Use **Secret** type, not plain text.
4. Row (b): create the new dispatch token in GitHub (fine-grained, code repository only, Actions read and write).

**F6. Step 6, redeploy.** [OPS-040 step 3, OPS-050]

1. Redeploy the **same approved commit**, not a new one. In GitHub **Actions**, open the last approved **Deploy production** run and **Re-run all jobs**, then approve `deploy-production`. The approved-commit check stays green because the commit is the same. [SEC-108 c]
2. Confirm the Worker redeployed. Redeploying the Worker again is OPS-050: dispatch the Worker deploy workflow on `release`, then check the next minute's run record on System Health.
3. Everyone is signed out because row (c1) changed. This is expected.

**F7. Step 7, staging.**

1. Repeat steps 2, 3, 4 and 5 for staging: the GitHub `staging` environment, the Turso staging tokens, the Vercel project `praxis-app-staging`, the staging Worker `praxis-sentinel-staging` and the staging Cloudflare account. Use the table rows marked staging.
2. Row (c4) exists on staging only. Production must never hold `TEST_IDENTITY_SECRET`.
3. Row (b-s) is a separate token from row (b).
4. Redeploy staging (**Deploy staging**, then the Worker).

Steps 8 and 9 are the next two sections.

---

## G. P6, part 3: smoke tests

A rotation is done only when the smoke test passes for every rotated secret. [OPS-020, SEC-101]

**G1. Stage 1 on staging.**

1. Go to **Actions → Credential smoke test (stage 1) → Run workflow**.
2. Set **Branch** to `main` and **target** to `staging`. Run it.
3. Wait until every job is green. Check the `[TEST] Praxis credential smoke test (staging)` email in your inbox.

**G2. Stage 1 on production.**

1. Run the same workflow with **Branch** `release` and **target** `production`.
2. Approve `deploy-production` when it asks. This approval is for the smoke job only. It is not a deployment approval. [D-023]
3. Wait for green. Check the `[TEST]` email.

**G3. Stage 2.** It runs at the end of each stage 1 app job. It prints one line per secret with PASS, FAIL or PENDING. PENDING must not appear after go-live. [scripts/smoke/README.md]

**G4. The Worker check.** The Worker checks its own secrets after each deploy and once a day. Open System Health, **Worker secrets**. Every line must show PASS. For staging, read it in a test window. [SEC-101]

**G5. Read the table.** For each row in the table above, find its smoke check and tick it off. A row marked "Listed, no automatic check" has a written reason in the table. Follow what it says. Row (f) also needs one nightly backup run to prove write access: **Actions → Nightly backup → Run workflow**, branch `release`.

**G6. Enter the expiry dates (step 9).** [SEC-021]

1. Open **System health**. Find **Credential expiry dates**.
2. For each secret in the table with "Expiry date tracked: Yes", select it, enter the new expiry date, and save.
3. The date must be inside the maximum age in the table. Rows (h) and the staging Resend key share one entry: enter the earlier date.
4. `PII_HASH_KEY` has no entry in this list yet. Put a yearly reminder in your own calendar.
5. System Health lists every secret that expires in the next 60 days, and you get reminders at 30, 14, 7 and 2 days. [SEC-021]

Do not go on until every smoke check is PASS.

---

## H. P6, part 4: the real-key restore drill

This proves that a real backup restores, with your real key, into two empty throwaway databases. [TST-108, AT-30, AT-04, D-155]

The bot is gone, so the key can safely sit in GitHub for a short time. Do the whole drill in one sitting.

1. In Turso, create a new platform token. Choose the narrowest scope that can create a database. Choose the shortest expiry. [SEC-017 (l)]
2. In your code repository open **Settings → Environments → `production`**.
3. Add two secrets: `TURSO_PLATFORM_TOKEN_TEMP` (the new Turso token) and `BACKUP_PRIVATE_KEY` (your offline private key). Open your offline copy only for this step and copy straight across. [PLT-022b]
4. Go to **Actions → Restore drill → Run workflow**. Branch `release`. Set **mode** `drill`, **environment** `production`, **key** `real`, **backup** empty (latest), **targets** `both`. [VERIFY]
5. Wait. The target is under 4 hours. It decrypts in memory, creates two throwaway databases, restores both, checks counts and checksums, replays the check cohort, deletes both databases and prints PASS or FAIL. [NFR-004]
6. Read the summary. It shows table names, counts, PASS or FAIL and the elapsed time. It must show PASS for main and auth, and the check-cohort NAV must match.
7. Now **delete both secrets**: `TURSO_PLATFORM_TOKEN_TEMP` and `BACKUP_PRIVATE_KEY`, in the `production` environment.
8. In Turso, revoke the platform token.
9. The last step of the drill run is red until you do steps 7 and 8. This is on purpose. GitHub emailed you about the red run. [TST-108]
10. Run the workflow again with **mode** `verify-removed`. It must end green.
11. The nightly watchdog fails while either secret exists. It must stay green the next night. [SEC-017 (l)]
12. Write down the run number for the sign-off.

Never leave the private key in GitHub, and never put it on Vercel or Cloudflare. [PLT-022b]

---

## I. P6, part 5: the $0 check

Open the billing page of each provider below. Confirm that there is no charge, no card on a paid plan and no overage. [PRD-007, AT-30, D-152 decision 19]

| Provider | What to open | You expect |
|---|---|---|
| GitHub | Settings, then Billing and plans (your account) | Free plan. Actions minutes inside the free amount. No payment method for Actions. |
| Vercel | Account, then Billing and Usage | Hobby plan. No overage. No card. |
| Turso | Organisation, then Billing and Usage | Free plan. Storage and reads inside the limits. |
| Cloudflare, production account | Billing, and Workers usage | Workers Free. No paid add-on. |
| Cloudflare, staging account | Billing, and Workers usage | Workers Free. No paid add-on. |
| Resend | Settings, then Billing and Usage | Free plan. Sends inside the limit. |
| Google Cloud (OAuth clients) | Billing | No billing account linked, or $0 due. |
| Google AI Studio | Usage and billing | Free tier. No paid plan. |
| Groq | Billing and Usage | Free tier. No card. |
| OpenRouter | Credits and Activity | Only `:free` models used. No credit bought. |

The list comes from the providers in the code today. If the build later adds a provider, add a row here first. [src/lib/llm]

Tick: "The $0 check is done on every provider".

---

## J. P6, part 6: walkthrough, AT-26 and backup codes

Do the walkthrough on **production**, after the rotation and the drill. Production holds real data since M2. Some Arena pages show an empty state until the first trading day. That is expected. To see populated views, look at the staging E2E-day data. [D-152 decision 18]

**J1. The six tabs.** Open each one as Owner and look for anything odd: wrong text, a broken link, a number with no "Simulated" label, a stock code where a masked user must not see one.

| Tab | Check |
|---|---|
| Home | The page opens. The review summary and the system strip load. |
| Picks | The list and the track record open. Each pick has "Why this pick". |
| Market | The market page and a company page open. |
| Strategies | The leaderboard, the risk overview and tonight's trade ideas open. Empty states are fine. |
| News | The list opens. A source link opens in a new tab. |
| Reviews | The latest review opens. "Mark as read" works. |

**J2. The gear-menu pages.** Open each one.

| Page | Check |
|---|---|
| Settings | The page opens. The region and appearance pages open. |
| System health | All blocks load. The Worker slots block is there. |
| Usage | The meters and the bake-off report load. |
| Ops checklist | The weekly, monthly and quarterly rows show due dates. |
| Users & roles | The list shows the right users and roles. |
| Configuration | The values match the spec. |
| Data review | The queue opens. |

**J3. The AT-26 manual check.** Do this with the keyboard and a screen reader. [AT-26, UXN-270]

1. Use only the keyboard on the six tabs. Press Tab from the top of each page. Check that the first stop is "Skip to content".
2. Check the focus ring is always visible, and no page traps focus.
3. Open and close a dialog with the keyboard. Escape closes it and focus returns.
4. Turn on a screen reader (NVDA on Windows, VoiceOver on a Mac). Move through each tab. Check that headings, links and buttons are read with sensible names, and each chart has a text summary.
5. Write down any issue in plain words and tell the agent after sign-off, or fix it before if it blocks use.

**J4. Backup codes.** [BLD-010 row 13a]

1. Find your Google account backup codes in the place you keep them offline.
2. Check they are the current set. If you are not sure, create a new set in your Google account and store it offline.
3. Test one code once, as the recovery path. [OPS-040a]
4. Do this before you finish sign-off. After sign-off the bot and the token are gone.

---

## K. P6, part 7: sign off in the app

1. Open the production app as Owner. Go to `/ops/go-live`. [VERIFY: reachable from System health]
2. The page lists seven items. Tick each one only if it is true:
   - The build access token is revoked and the build bot is removed.
   - Every production secret is rotated and its smoke test passed.
   - The real-key restore drill is green and both of its secrets are deleted.
   - The $0 check is done on every provider.
   - The walkthrough of the six tabs and every gear-menu page is done.
   - The AT-26 manual keyboard and screen-reader check is done.
   - The Google backup codes are stored offline and were tested once.
3. The page also shows the release-gate result for the deployed commit. It must be a pass. [D-152 decision 25]
4. Type the exact phrase `SIGN OFF GO-LIVE`. Add a short note with no names or emails. Select to record the sign-off.
5. The page stores no secret, no name and no email. The sign-off changes no mode by itself. [D-157]

A later build session copies this record into the decision log. [D-152 decision 34]

---

## L. Switches: email, Worker slots, dispatch and AU `full`

Do this the same afternoon, on an AU trading day, before 17:00. Do it in this order. [D-152 decision 24, BLD-030]

1. Open **System health** on production.
2. In **Email controls**, set **Email mode** to `incidents`. [EML]
3. If you accepted the ASX risk (O-23): in **Data controls** accept it, then check `asx_enabled`, `ASX_LIVE` and `ASX_USER_AGENT` are set where section A3 said. The Worker fetches the listed-companies file only when both ASX rows are enabled. [DAT-120]
4. In **Worker slots**, tick every go-live slot, in time order, then confirm:
   - 07:01 alert flush, 08:00 morning email, 09:54 and 09:58 pre-open re-checks,
   - 10:00 monthly model bake-off (first Saturday),
   - 17:50 arena close, 18:10 arena signals,
   - 20:00 evening review, 21:00 evening review late run,
   - 22:15 knowledge-base archive, 23:30 history backfill, 23:45 price backfill, 00:15 replay.
   Backup, maintenance and ingest batch 1 always run. They are not in the list. [D-155]
5. In **Data controls**, turn **Nightly dispatch** (`dispatch_enabled`) **on, last**. It is the master switch.
6. Set the AU market mode to **Full**. Production refuses `full` unless the sign-off row exists and email is not off. [D-157]
7. The evening pipeline of this day opens the first cohorts. There are 253 with the shipped settings. They trade from the next session. [BLD-030]

---

## M. P7: the first trading day

1. The next AU trading day runs the normal pipeline. Check **System health** at about 20:00 for green rows.
2. Read the 20:00 Evening Review. It should arrive between 20:00 and 20:45. [EML-010]
3. If the night was quiet, set **Email mode** to `full` the next day. [D-152 decision 24]
4. When a later build session starts, add the bot again with a new short-lived token (90 days at most) so it can copy your sign-off into the decision log. [SEC-108 e, SEC-102]
5. From now on, follow `operations.md`. The monthly, quarterly and rotation reminders count from the sign-off date. [OPS-020, D-152 decision 48]

---

## N. Emergency rotation (keep this for a bad day)

Use this when a secret may have leaked. Start with the leaked secret only. Do not wait for a schedule. [OPS-037]

The steps are the same for every secret: **revoke at the issuer, replace in every store, run the smoke test, record**. The blocks below are generated from the same table as section F. They hold names and stores only. You may keep a private copy with your own account notes. [D-152 decision 6]

1. Do not ask anyone to paste the secret anywhere to check it.
2. Revoke or delete the old value at the issuer first.
3. Pick the block for that secret below.
4. After the last store, redeploy the app and the Worker if a Vercel or Cloudflare store changed (same approved commit).
5. Run the smoke test (section G) and check the row's check is PASS.
6. Record the incident: date, row letter, what you did. No values.
7. Look at the audit log and the provider's logs for use you did not make. [OPS-037]

**(a) The build token.** Delete it at GitHub as the bot account (section E, steps 1 to 4). Remove the bot as a collaborator. If the leak may have reached production, follow OPS-045 as well.

**(k) The backup key.** If you think the offline private key is exposed [OPS-037a]:

1. Make a new `age` key pair offline.
2. Add the new public key as `BACKUP_PUBLIC_KEY` in GitHub environment `production` and in the production Vercel project.
3. Run **Nightly backup** to make a fresh backup with the new key.
4. Remove the old public key from every store. Move the new private key to a new offline place.
5. Plan a full restore drill (section H) once the new key is checked.

**(l) A temporary restore secret still present.** Delete `TURSO_PLATFORM_TOKEN_TEMP` and `BACKUP_PRIVATE_KEY` from the `production` environment. Revoke the token in Turso. Run the drill with `verify-removed`.

**An unapproved production release (OPS-045).** Roll back production (see `operations.md`). Revoke the build token. Then rotate every production secret in the table, plus the staging dispatch token (b-s) and the staging Resend key. Bump every user's session version (changing row (c1) does this). Compare **Users & roles** with the list you expect. [OPS-045]

<!-- emergency-checklist:start (generated from src/lib/security/secretStores.ts) -->

**(b) Worker dispatch token (fine-grained, code repo, Actions read and write)**

1. Revoke or delete the old value at the issuer: GitHub, your account (fine-grained token, code repo only).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Cloudflare Worker `praxis-sentinel` (production): `GITHUB_DISPATCH_TOKEN`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: GITHUB_DISPATCH_TOKEN.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(b-s) Staging Worker dispatch token (separate value, same scope)**

1. Revoke or delete the old value at the issuer: GitHub, your account (fine-grained token, code repo only).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Cloudflare Worker `praxis-sentinel-staging`: `GITHUB_DISPATCH_TOKEN`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: no automatic check, see the table above.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(c1) Session secret and CRON_SECRET (random 64 hex characters)**

1. Revoke or delete the old value at the issuer: You, with your password manager's generator (64 hex characters).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Vercel project `praxis-app`, environment variables (Production): `AUTH_SECRET`, `CRON_SECRET`; Vercel project `praxis-app-staging`, environment variables (Production): `AUTH_SECRET`, `CRON_SECRET`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: AUTH_SECRET format; CRON_SECRET format.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(c2) Worker to Vercel signing secret (separate value per environment)**

1. Revoke or delete the old value at the issuer: You, with your password manager's generator (64 hex characters).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Vercel project `praxis-app`, environment variables (Production): `WORKER_HMAC_SECRET`; Cloudflare Worker `praxis-sentinel` (production): `WORKER_HMAC_SECRET`; Vercel project `praxis-app-staging`, environment variables (Production): `WORKER_HMAC_SECRET`; Cloudflare Worker `praxis-sentinel-staging`: `WORKER_HMAC_SECRET`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: WORKER_HMAC_SECRET format; report delivered.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(c3) Actions to Vercel signing secret (separate value per environment)**

1. Revoke or delete the old value at the issuer: You, with your password manager's generator (64 hex characters).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `production`: `ACTIONS_HMAC_SECRET_PROD`; Vercel project `praxis-app`, environment variables (Production): `ACTIONS_HMAC_SECRET`; GitHub environment `staging`: `ACTIONS_HMAC_SECRET_STAGING`; Vercel project `praxis-app-staging`, environment variables (Production): `ACTIONS_HMAC_SECRET`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: ACTIONS_HMAC_SECRET format; Stage 2 production: n/n passed.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(c4) Staging test-identity signing secret (SEC-109)**

1. Revoke or delete the old value at the issuer: You, with your password manager's generator (64 hex characters).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Vercel project `praxis-app-staging`, environment variables (Production): `TEST_IDENTITY_SECRET`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: TEST_IDENTITY_SECRET format.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(d) Turso main-database tokens (one per environment per caller)**

1. Revoke or delete the old value at the issuer: You, in the Turso dashboard (new token per caller, then remove the old ones).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `production`: `TURSO_MAIN_TOKEN_PROD`; Vercel project `praxis-app`, environment variables (Production): `TURSO_MAIN_TOKEN`; Cloudflare Worker `praxis-sentinel` (production): `TURSO_MAIN_TOKEN`; GitHub environment `staging`: `TURSO_MAIN_TOKEN_STAGING`; Vercel project `praxis-app-staging`, environment variables (Production): `TURSO_MAIN_TOKEN`; Cloudflare Worker `praxis-sentinel-staging`: `TURSO_MAIN_TOKEN`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Turso DB round-trip; Turso main DB round-trip; TURSO_MAIN round trip.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(e) Turso auth-database token (production and staging, separate)**

1. Revoke or delete the old value at the issuer: You, in the Turso dashboard.
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Vercel project `praxis-app`, environment variables (Production): `TURSO_AUTH_TOKEN`; Vercel project `praxis-app-staging`, environment variables (Production): `TURSO_AUTH_TOKEN`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Turso auth DB round-trip.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(f) Data-repo token (fine-grained, data repo only, contents read and write)**

1. Revoke or delete the old value at the issuer: GitHub, your account (fine-grained token, data repo only).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `production`: `DATA_REPO_TOKEN_PROD`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: GitHub read: data repo.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(f-r) Read-only fixtures token (fine-grained, fixtures repo only, contents read)**

1. Revoke or delete the old value at the issuer: GitHub, your account (fine-grained token, fixtures repo only).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `staging`: `FIXTURES_READ_TOKEN`; GitHub environment `ci-fixtures`: `FIXTURES_READ_TOKEN`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: GitHub read: fixtures repo.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(g) Cloudflare API token (Edit Workers; a separate account per environment)**

1. Revoke or delete the old value at the issuer: You, in Cloudflare: one token per account (production account, staging account).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `deploy-production`: `CLOUDFLARE_API_TOKEN_PROD`; GitHub environment `deploy-staging`: `CLOUDFLARE_API_TOKEN_STAGING`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Cloudflare API token.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(n) Vercel deploy token (account token for command-line deploys)**

1. Revoke or delete the old value at the issuer: You, in Vercel (Account Settings, Tokens).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `deploy-production`: `VERCEL_TOKEN_PROD`; GitHub environment `deploy-staging`: `VERCEL_TOKEN_STAGING`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Vercel token.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(h) Resend API key, production (sending only)**

1. Revoke or delete the old value at the issuer: You, in Resend (new key with Sending access, then delete the old key).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `production`: `RESEND_API_KEY_PROD`; Vercel project `praxis-app`, environment variables (Production): `RESEND_API_KEY`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Resend test email; RESEND_API_KEY format.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(h-s) Resend API key, staging (the key that can email you from the whitelisted sender)**

1. Revoke or delete the old value at the issuer: You, in Resend (a separate key for staging).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `staging`: `RESEND_API_KEY_STAGING`; Vercel project `praxis-app-staging`, environment variables (Production): `RESEND_API_KEY`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Resend test email; RESEND_API_KEY format.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(i) LLM API keys (one per provider)**

1. Revoke or delete the old value at the issuer: You, at each provider: Google AI Studio, Groq, OpenRouter.
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `production`: `GOOGLE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`; Vercel project `praxis-app`, environment variables (Production): `GOOGLE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Google AI key; Groq key; OpenRouter key.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(j) Google OAuth client secrets (two clients: production and staging)**

1. Revoke or delete the old value at the issuer: You, in Google Cloud Console (APIs and Services, Credentials), one client each.
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Vercel project `praxis-app`, environment variables (Production): `AUTH_GOOGLE_SECRET`; Vercel project `praxis-app-staging`, environment variables (Production): `AUTH_GOOGLE_SECRET`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: Google OAuth client.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(m) GitHub read token for release detection (fine-grained, code repo, read only)**

1. Revoke or delete the old value at the issuer: GitHub, your account (fine-grained token, code repo only; contents, actions and deployments read).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: Vercel project `praxis-app`, environment variables (Production): `GITHUB_READ_TOKEN`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: GITHUB_READ_TOKEN.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

**(pii) PII_HASH_KEY (keyed hash for personal data after retention; NFR-030)**

1. Revoke or delete the old value at the issuer: You, with your password manager's generator (64 hex characters).
2. Create the new value there. Never paste it into chat, email, notes or a ticket.
3. Enter it in every store, one by one: GitHub environment `production`: `PII_HASH_KEY_PROD`; Vercel project `praxis-app`, environment variables (Production): `PII_HASH_KEY`; GitHub environment `staging`: `PII_HASH_KEY_STAGING`; Vercel project `praxis-app-staging`, environment variables (Production): `PII_HASH_KEY`.
4. If a Vercel or Cloudflare store changed, redeploy the app and the Worker (same approved commit).
5. Run the smoke test and read: PII_HASH_KEY format.
6. Write the new expiry date on System Health and note the incident (date and row letter, no value).

<!-- emergency-checklist:end -->

---

## Where the test reports are

Each AT has its own page in `docs/test-reports/`. Record the result of each Owner step there through the agent. [BLD-040]

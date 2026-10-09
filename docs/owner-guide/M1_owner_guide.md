# Owner guide for milestone M1 (bootstrap)

## What this is

This guide covers the first build milestone, M1. In M1 the build agent deploys a small skeleton of the app and the Worker, and sets up the credential smoke test. You do the clicks in GitHub, Vercel and Cloudflare that only you can do. You do not write code and you never run Wrangler. Each section is a short numbered click-path. Each step names the spec rule it comes from in brackets. Where you are not sure of a screen name, the step says [VERIFY]. Never paste a secret into chat, a file, an issue or a log. [SEC-101](../../spec/10_nfr_testing.md)

The code repository is public. Anything you put in its settings, workflow logs or pull requests can be seen by others. Use placeholders such as `<your Gmail address>` in your notes. [SEC-110](../../spec/10_nfr_testing.md)

## Checklist

Tick each box when the section is done.

| ☐ | Section | What you do |
|---|---|---|
| ☐ | A | Before the first run: clean up misplaced secrets |
| ☐ | B | Staging Vercel deploy token (**on hold, see note in B**) |
| ☐ | C | Stage 2 needs the app address |
| ☐ | D | Approve the M1 bootstrap pull requests |
| ☐ | E | Approve the first production deployment |
| ☐ | F | Run the credential smoke test |
| ☐ | G | Still to do later in M1 |

---

## A. Before the first run: clean up misplaced secrets

Some secrets were stored in the wrong GitHub environment during M0. No workflow reads them from there, and each secret belongs only in the store named by [SEC-017](../../spec/10_nfr_testing.md). Delete the copies below. You do not need their values. [SEC-017, SEC-108 a, D-025]

Why: a secret should sit only where the workflow that needs it can reach it. Extra copies make it harder to rotate them safely.

**A1. Environment `deploy-production` and `deploy-staging`** [VERIFY screen names]

1. Go to your code repository on GitHub. Select **Settings**.
2. Select **Environments** in the left menu.
3. Select `deploy-production`.
4. Under **Environment secrets**, select each secret below and select **Remove secret**. Confirm.
   - `GOOGLE_AI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`
   - Every `RESEND_API_KEY_*`, `TURSO_AUTH_TOKEN_*`, `TURSO_AUTH_URL_*`, `TURSO_MAIN_TOKEN_*` and `TURSO_MAIN_URL_*` secret
5. **Keep** every `CLOUDFLARE_*` and `VERCEL_TOKEN_*` secret.
6. Go back to **Environments** and repeat steps 3 to 5 for `deploy-staging`.

**A2. Environment `production`**

1. Go to **Settings → Environments → `production`**.
2. Remove `CLOUDFLARE_ACCOUNT_ID_PROD`, `CLOUDFLARE_API_TOKEN_PROD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURSO_AUTH_TOKEN_PROD` and `TURSO_AUTH_URL_PROD`. Confirm each one.
3. Do not remove anything else from this environment.

**A3. Environment `staging`**

1. Go to **Settings → Environments → `staging`**.
2. Remove `CLOUDFLARE_ACCOUNT_ID_STAGING`, `CLOUDFLARE_API_TOKEN_STAGING`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURSO_AUTH_TOKEN_STAGING`, `TURSO_AUTH_URL_STAGING`, `GOOGLE_AI_API_KEY`, `GROQ_API_KEY` and `OPENROUTER_API_KEY`. Confirm each one.

[VERIFY] Check each name against the smoke test workflow before you delete it. A name that a workflow reads must stay.

---

## B. Staging Vercel deploy token

Why you need it: the `deploy-staging` job deploys the staging Vercel project. The production deploy token `VERCEL_TOKEN_PROD` stays in `deploy-production` only [SEC-017 (n)], so staging gets its **own, separate** token. [D-028]

1. Sign in to Vercel. Select your avatar at the top right, then **Account Settings → Tokens**. [VERIFY screen names]
2. Select **Create**. Name the token `praxis-deploy-staging`.
3. Set the expiry to one year or less. [SEC-021]
4. Copy the token value once. Do not paste it anywhere else.
5. Go to your code repository on GitHub. Select **Settings → Environments → `deploy-staging`**.
6. Select **Add environment secret**. Name it `VERCEL_TOKEN_STAGING`. Paste the value. Save.
7. Close the Vercel page. Do not keep the token in a note.

Accepted risk [D-028]: on the Hobby plan a Vercel token can act on the whole account, so this token could also reach the production project. The staging job names only the project `praxis-app-staging`, and it runs only for commits on `main`, which you review first. [SEC-108 b]

---

## C. Stage 2 needs the app address

Stage 2 of the smoke test checks the live app address. It needs the address of each app. Use the same value as `APP_BASE_URL` in the matching Vercel project. [VERIFY: no workflow in the repository reads these names yet; the names follow the naming rule in D-019]

1. Go to your code repository on GitHub. Select **Settings → Environments → `production`**.
2. Select **Add secret**. Name it `APP_BASE_URL_PROD`.
3. Paste the production app address, for example `https://<your production project>.vercel.app`. Save.
4. Go back to **Environments**. Select `staging`.
5. Select **Add secret**. Name it `APP_BASE_URL_STAGING`.
6. Paste the staging app address. Save.
7. Check that each value matches `APP_BASE_URL` in the Vercel project for the same environment. [SEC-017, D-019]

---

## D. Approve the M1 bootstrap pull requests

The build agent opens two pull requests at the same time. Approve and merge them in one sitting. [D-015, D-022, SEC-108 b, SEC-108 c]

1. Go to your code repository on GitHub. Select **Pull requests**.
2. Open the pull request titled **"M1 bootstrap: …"**. It goes from `build` into `main`.
3. Read the **Files changed** tab. Check that no file contains an email address, a name or a secret value. [SEC-110 a]
4. Select **Review changes**, choose **Approve**, then **Submit**. [SEC-108 b]
5. Select **Merge pull request**, then **Confirm merge**.
6. Open the second pull request. Its title starts with the sync branch name `sync/main-to-release`. It goes into `release`.
7. Read it the same way as step 3.
8. Select **Review changes**, choose **Approve**, then **Submit**.
9. Select **Merge pull request**, then **Confirm merge**.

The smoke test workflow only appears in the Actions list after this second merge. A workflow can only be started from the default branch, and the default branch is `release`. [TST-115]

---

## E. Approve the first production deployment

This is the first approval that lets production deploy. [BLD-011, SEC-108 c]

[VERIFY] The repository does not yet have a workflow named "Deploy production". The approval step below uses the GitHub screen that the build agent confirms. Until the first approved deployment, the app shows "awaiting first approval".

1. Go to your code repository on GitHub. Select **Actions**.
2. Select the run named **Deploy production** that the build agent started. [VERIFY name]
3. Select **Review deployments**.
4. Tick `deploy-production`. Select **Approve and deploy**. [VERIFY button label] [SEC-108 c]
5. Wait for the run to finish green.

[VERIFY] The credential smoke test's production job also uses `deploy-production` with no deployment record (decision D-023). An approval there does not count as a deployment approval. Use the approval on the real deploy run.

---

## F. Run the credential smoke test

The smoke test checks that each secret works. It never prints a secret value. It sends one test email from each app job, so you should get two `[TEST]` emails in total. [BLD-011, SEC-101, D-024]

First, the workflow file must be on the default branch. Confirm that section D is done before you start.

**Staging run (branch `main`)**

1. Go to **Actions**. Select **Credential smoke test (stage 1)**. [VERIFY name]
2. Select **Run workflow**.
3. Set **Branch** to `main`. Set **target** to `staging`. Select **Run workflow**.
4. Wait until every job is green. Open the log and read the check names. Each check shows PASS or FAIL. [VERIFY: the script prints PASS or FAIL only; there is no "PENDING" state in the code]
5. Check your inbox for one `[TEST] Praxis credential smoke test (staging)` email.

**Production run (branch `release`)**

6. Select **Run workflow** again. Set **Branch** to `release`. Set **target** to `production`. Select **Run workflow**.
7. When the `deploy-production` job waits, select **Review deployments**, tick `deploy-production`, and select **Approve**. [SEC-108 c]
8. Wait until every job is green.
9. Check your inbox for one `[TEST] Praxis credential smoke test (production)` email.

**If a check fails**

10. Read the short detail beside the failing check, for example `HTTP 401` or `missing`. Do not copy the value anywhere.
11. Open the secret named by that check in its store (GitHub environment, Vercel or Cloudflare). Re-enter the value from the provider. [SEC-017]
12. Run the workflow again for the same branch and target.

[VERIFY] Stage 2 is not part of these jobs. The workflow file says stage 2 is separate. It runs after the app is deployed, and it checks the Vercel self-check route and the Worker cron self-check. [BLD-011]

---

## G. Still to do later in M1

These steps come after the bootstrap. The build agent tells you when to start each one. [BLD-010 rows 3, 11, 13, D-006, D-018]

1. **Worker dispatch tokens (rows 3, D-006).** After the first Worker deploy, create two fine-grained GitHub tokens: one for production (b) and one for staging (b-s). Each has access to the code repository only, with Actions read and write, and an expiry of one year or less. Enter each one into the Cloudflare Worker secret for its environment, in the same step as you create it. [SEC-017 (b), (b-s)]
2. **Worker to Vercel HMAC (D-018).** The build agent generates the value. You enter it into the Worker and the Vercel project of the same environment in one step. Do not keep a copy. [SEC-017 (c2)]
3. **Worker Turso token.** Enter the Turso main-database token for each environment into the matching Cloudflare Worker secret. [SEC-017 (d)]
4. **2-step verification on Cloudflare and Turso.** Turn on two-step verification in each account. Check it under the account's security settings. [SEC-020]

---

## Where to find the rules

- Spec chapter 10 has the security and testing rules (SEC-017, SEC-101, SEC-108, SEC-110, TST-112, TST-133).
- Spec chapter 12 has the build plan and the M0 checklist (BLD-010, BLD-011, BLD-012).
- The M0 guide is in [M0_owner_guide.md](M0_owner_guide.md).

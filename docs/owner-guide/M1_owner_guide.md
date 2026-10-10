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
| ☐ | H | Nightly backup: what it does and how to run it by hand |
| ☐ | I | Decrypt a backup (only when restoring) |
| ☐ | J | Nightly maintenance: what it does and how to run it by hand |
| ☐ | K | Pages you can now use |
| ☐ | L | Break-glass recovery (emergency only) |

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

[VERIFY] The repository does not yet have a workflow named "Deploy production". That workflow is to be added (pending your decision on the deploy workflows). The approval step below uses the GitHub screen that the build agent confirms. Until the first approved deployment, the app shows "awaiting first approval".

1. Go to your code repository on GitHub. Select **Actions**.
2. Select the production deploy run that the build agent started. It is named **Deploy production**, which is to be added (pending your decision on the deploy workflows). [VERIFY name]
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

## H. Nightly backup

What it does: every night the app makes encrypted copies of both databases (the main database and the sign-in database) and stores them as release assets in the private data repository. Old copies are thinned out: 14 daily, 8 weekly and 12 monthly copies are kept. [PLT-022, PLT-022b, DAT-143, D-044, D-045]

Why: if the free database service changes or is lost, the copies let the app be rebuilt. The recovery goal is no more than 24 hours of lost data. [NFR-004]

In M1 the schedule is not running yet. The Worker starts this workflow every night from M2. Until then, run it by hand:

1. Go to your code repository on GitHub. Select **Actions**.
2. Select **Nightly backup** in the left list. [VERIFY name]
3. Select **Run workflow**. Set **Branch** to `release`. Select **Run workflow**. The workflow only runs on `release`, so any other branch will do nothing.
4. Wait for the `production` job to finish. Then wait for the `drill` job to finish.

What a green run means: both copies were written to the data repository, old copies were thinned out, and the run was recorded. [PLT-076]

If the run ends early with a message that a backup already succeeded today, that is correct. The workflow makes one backup per day. [PLT-076]

**Where to see the files**

1. Go to the private data repository on GitHub. Its name is `<your data repository>`. Select **Releases**. [VERIFY screen name]
2. Open the release named `backup-<date>`, for example `backup-YYYY-MM-DD`.
3. It holds two files: `main-<date>.ndjson.gz.age` (the main database) and `auth-<date>.ndjson.gz.age` (the sign-in database). Both are encrypted. You cannot read them without your offline key. [PLT-022b]

**The restore drill**

The `drill` job in the same workflow tests the backup code on small made-up databases. It makes its own throwaway key pair inside the run and deletes it afterwards. It uses no production data and no secrets. It must print `drill: PASS`. You never need your offline key for this job, so the real key never meets GitHub. [TST-108, D-046, SEC-108 f]

---

## I. Decrypt a backup (only when restoring)

Do this only when you are restoring, or in the monthly offsite check. Do it on your own computer, never on GitHub. Never upload the key file to GitHub, and never paste it into chat. [SEC-108 f, OPS-020]

1. Make a new, empty folder on your computer. Download the two `.age` files from the `backup-<date>` release into it. [VERIFY screen name]
2. Open a terminal in that folder. Use the key file from your USB stick or paper copy. Keep the path of the key file as a placeholder in your notes, for example `<path to your key file>`.
3. Run the decrypt command for each file:

   ```
   age -d -i <path to your key file> main-<date>.ndjson.gz.age > main-<date>.ndjson.gz
   age -d -i <path to your key file> auth-<date>.ndjson.gz.age > auth-<date>.ndjson.gz
   ```

4. Check that each `.gz` file is not empty. A non-empty file means the decrypt worked. [OPS-020]
5. Delete the decrypted `.gz` files and any unzipped copies when you have finished. Keep only the encrypted `.age` files. [PLT-022b]

**Full restore into a new database (OPS-040)**

A full restore is not a single command. Target time: no more than 4 hours, counted from when you start. [OPS-040, NFR-004] The steps, summarised from the spec:

1. Revoke any active build-agent access token. [OPS-040 step 0]
2. Add the offline private backup key and a temporary Turso platform token as secrets of the GitHub `production` environment. Use the narrowest scope and shortest expiry offered. [VERIFY scope and expiry options]
3. Run the **Restore database** workflow. Choose the backup and the target (main database, sign-in database or both). It decrypts the backup, imports it into a new Turso database, and checks the checksums. [VERIFY: this workflow is built in a later task]
4. In Turso, create the new database's tokens, one per caller. Enter each token and the new database address into the stores that the spec's SEC-017 table lists. Do not paste them into a workflow log. [OPS-040 step 3]
5. Redeploy the current production Vercel deployment and the Worker, so they pick up the new values. Use the same commit, so it passes the approval check. [OPS-040 step 3]
6. Delete the temporary token and the private-key secret. The workflow fails until both are gone. [OPS-040 step 4]
7. Run the credential smoke test and record the incident. [OPS-040 step 5, F]

---

## J. Nightly maintenance

What it does: once a night, the app tidies its own records. [DAT-142, NFR-030, D-043]

- Run records older than 180 days are deleted. Logs older than 30 days are deleted. Expired security nonces are deleted.
- 90 days after a user is removed, their email and name are replaced with a keyed hash that cannot be read back. Their IP address and browser details in the sign-in audit rows are cleared. The audit rows themselves stay. [NFR-030, D-043]

Manual run (until the Worker starts it in M2):

1. Go to your code repository on GitHub. Select **Actions**.
2. Select **Nightly maintenance**. [VERIFY name]
3. Select **Run workflow**. Set **Branch** to `release`. Select **Run workflow**.
4. Wait for the run to finish green.

Where to see the result: open the **System Health** page in the app. The run record shows whether maintenance ran for the day. [VERIFY where run records are listed]

---

## K. Pages you can now use

One line each. Menu names may differ slightly. [VERIFY menu names]

- **/health** (System Health): job freshness, recent run records and data freshness for each market. [PLT-061, UX-090]
- **/users** (Settings → Users & roles): add and revoke users. Record the sharing acknowledgement first. Until you do, the Add user button stays disabled. Default role is Viewer. [ROL-107, OPS-060, D-040]
- **/usage** (Usage): the free-tier meters for each service and each job. [OPS-034, D-042]
- **/config** (Configuration, Owner only): change settings. Every edit needs a reason, and every edit is logged. [D-047]
- **/settings** (personal): your theme, market, time format and alert settings. Every signed-in role can use it. [D-048, UX-110]

---

## L. Break-glass recovery (emergency only)

Use this only if you cannot sign in with your main Google account, and Google's own account recovery has failed. [OPS-040a, O-33, D-034]

Every use of the recovery address emails you and writes an audit event. Turning the flag on or off is a Vercel change, and a Vercel environment change needs a redeploy before it takes effect. [D-034]

1. Go to Vercel and open the production project. Select **Settings → Environment Variables**. [VERIFY screen names]
2. Add a variable named `OWNER_RECOVERY_ENABLED` with the value `true`. Set its environment to Production. Save.
3. Redeploy the production project, so the change takes effect. [VERIFY redeploy screen]
4. Sign in with the recovery Google address stored in `OWNER_RECOVERY_EMAIL`. Then follow the allowlist steps in OPS-040a step 3.
5. Straight after you have finished, delete `OWNER_RECOVERY_ENABLED` from Vercel. Save.
6. Redeploy the production project again, so the removal takes effect.
7. Record the recovery event in Settings. [OPS-040a step 4]

Note: the spec's OPS-040a step 2 names the recovery email variable. The decision log (D-034) uses the on/off flag above, and this guide follows D-034.

---

## Where to find the rules

- Spec chapter 10 has the security and testing rules (SEC-017, SEC-101, SEC-108, SEC-110, TST-112, TST-133).
- Spec chapter 12 has the build plan and the M0 checklist (BLD-010, BLD-011, BLD-012).
- The M0 guide is in [M0_owner_guide.md](M0_owner_guide.md).

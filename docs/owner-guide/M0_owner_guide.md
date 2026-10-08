# Owner guide for milestone M0 (set-up)

This guide shows you, step by step, how to set up the free accounts, repositories and secrets that the build agent needs. It follows the M0 checklist in the spec, [BLD-010](../../spec/12_build_plan.md#122-owner-prerequisites-milestone-m0).

## What M0 is

[M0](../glossary.md#m0) is the first milestone. You do the set-up. The build agent then builds the app in later milestones. You do not write code, and you never run [Wrangler](../glossary.md#cloudflare-worker). The spec does not give a time for M0. Work through it in short sittings.

Some facts you need before you start:

- The **code repository is public**. Anyone can see the code, the workflow files and the run logs. The **data** and **fixtures** repositories are private. [SEC-110](../../spec/10_nfr_testing.md)
- Your Gmail address is only ever stored in environment variables. Use it only where a step names it. [EML-005](../../spec/04_email_and_notifications.md)

## Golden rules

1. **Never paste a secret into chat, email, a GitHub issue, a file or a log.** A secret goes only into the store that the step names. [SEC-101](../../spec/10_nfr_testing.md)
2. **Use only the store named in the step.** The stores are a [GitHub environment](../glossary.md#github-environment), a [Vercel](../glossary.md#vercel) project environment variable, or a [Cloudflare Worker](../glossary.md#cloudflare-worker) secret. [SEC-017](../../spec/10_nfr_testing.md)
3. **There are no repository-level GitHub secrets.** Every secret lives in a GitHub environment. Do not add any secret under the repository's own "Secrets" page. [SEC-108 a](../../spec/10_nfr_testing.md)
4. **No payment card anywhere.** If a site asks for a card or a billing account, stop and ask the build agent. [PRD-007](../../spec/01_product_goals_and_scope.md), [BLD-010](../../spec/12_build_plan.md#122-owner-prerequisites-milestone-m0)
5. **Turn on [2-step verification](../glossary.md#2-step-verification) on every account.** This includes Google, GitHub, Vercel, Cloudflare (both accounts), Turso, Resend, Google Cloud and each LLM provider. [SEC-020](../../spec/10_nfr_testing.md)
6. **Do not invent names.** Where this guide says `<...>`, put in the name you chose. Do not put real names, email addresses or account IDs into any repository file.

## Checklist

Tick the box when a step is done. Click the row name to go to its steps. Rows 13a, 16, 16a and 16b are included.

| ☐ | Row | Item | Done by |
|---|---|---|---|
| ☐ | [1](#row-1-repositories-and-github-settings) | Repositories and GitHub settings | You |
| ☐ | [17](#row-17-release-branch) | Release branch | You |
| ☐ | [2](#row-2-bot-account-for-the-build-agent) | Bot account for the build agent | You (build agent gives the exact steps) |
| ☐ | [13](#row-13-two-step-verification) | 2-step verification on every account | You |
| ☐ | [5](#row-5-vercel-projects) | Vercel production and staging projects | You |
| ☐ | [10](#row-10-google-oauth-clients) | Two Google OAuth clients | You |
| ☐ | [13a](#row-13a-owner-google-account-recovery) | Owner Google account recovery | You |
| ☐ | [6](#row-6-turso-databases-and-tokens) | Turso databases and tokens | You |
| ☐ | [7](#row-7-cloudflare-accounts-and-tokens) | Cloudflare accounts and tokens | You |
| ☐ | [16](#row-16-vercel-production-settings) | Vercel production settings | You |
| ☐ | [16b](#row-16b-github-read-token-and-vercel-notifications) | GitHub read token and Vercel notifications | You |
| ☐ | [3](#row-3-worker-dispatch-tokens) | Worker dispatch tokens (created and entered in M1) | You |
| ☐ | [4](#row-4-data-repo-and-fixtures-repo-tokens) | Data repo and fixtures repo tokens | You |
| ☐ | [8](#row-8-resend-account-and-api-keys) | Resend account and API keys | You |
| ☐ | [9](#row-9-gmail-filter) | Gmail filter | You |
| ☐ | [12](#row-12-free-llm-keys) | Free LLM keys | You |
| ☐ | [11](#row-11-generated-secrets-and-backup-key-pair) | Generated secrets and backup key pair | You |
| ☐ | [15](#row-15-asx-confirmation-request) | ASX confirmation request (not blocking) | You |
| ☐ | [16a](#row-16a-github-failure-email-test) | GitHub failure email test | You |
| ☐ | [14](#row-14-google-test-accounts-deferred) | Three Google test accounts (deferred) | Deferred by Owner |
| ☐ | [18](#row-18-informed-consent-ticks) | Informed consent ticks | You |
| ☐ | [19](#row-19-plugins-and-mcp-servers) | Plugins and MCP servers on the build machine | Build agent |

## Where each secret goes

This table copies the secret list in [SEC-017](../../spec/10_nfr_testing.md). Use the store in the right-hand column and nowhere else. The names of the environment variables come from the build agent. [VERIFY with build agent]

| Letter | Secret (SEC-017 name) | Exact store | When |
|---|---|---|---|
| (a) | Build-agent token (bot account) | The build agent's own secret configuration. Never chat. | Build start (row 2) |
| (b) | Worker dispatch token, production | Production Cloudflare Worker secret | Create and enter in M1 (row 3, D-006) |
| (b-s) | Worker dispatch token, staging | Staging Cloudflare Worker secret | Create and enter in M1 (row 3, D-006) |
| (c1) | Session secret and `CRON_SECRET` | Vercel environment variables only, one set per environment | M0 (row 11) |
| (c2) | Worker to Vercel HMAC | Worker and Vercel environment of the same environment (separate value per environment) | M0 (row 11) for Vercel; Worker in M1 |
| (c3) | Actions to Vercel HMAC | GitHub environment `production` or `staging`, and Vercel environment of the same environment | M0 (row 11) |
| (c4) | Staging test-identity signing secret | Staging Vercel environment only | M0 (row 11) |
| (d) | Turso main-database tokens | Vercel environment, GitHub environment `production` or `staging`, and Worker. One per caller per environment. | M0 (row 6) |
| (e) | Turso auth-database token | Vercel environment of the matching project only | M0 (row 6) |
| (f) | Data-repo token | GitHub environment `production` | M0 (row 4) |
| (f-r) | Read-only fixtures token | GitHub environments `staging` and `ci-fixtures` | M0 (row 4) |
| (g) | Cloudflare API token | Production token: GitHub environment `deploy-production`. Staging token: GitHub environment `deploy-staging`. Never swap them. | M0 (row 7) |
| (h) | Resend API keys | Vercel environment and GitHub environment of the same name, one key per environment | M0 (row 8) |
| (i) | LLM API keys | Vercel environment and GitHub environment `production` | M0 (row 12) |
| (j) | Google OAuth client secrets | Vercel environment of its own environment | M0 (row 10) |
| (k) | Backup public key | GitHub environment `production` and production Vercel environment. The **private key stays offline only.** | M0 (row 11) |
| (l) | Temporary Turso platform token | GitHub environment `production`, temporary only | Not in M0. Only for restore and drills. [OPS-040] |
| (m) | GitHub read token for release detection | Production Vercel environment only | M0 (row 16b) |
| (n) | Vercel deploy token | GitHub environment `deploy-production` only | M0 (row 7) |

Also generated with row 11: `PII_HASH_KEY` ([NFR-030](../../spec/10_nfr_testing.md)) — production value in the production Vercel environment and GitHub environment `production`; a separate staging value in the staging stores (decision D-007). `OWNER_RECOVERY_EMAIL` (row 13a) is stored as a **secret** in GitHub environment `production` and the production Vercel environment (decision D-010).

---

## Row 1 Repositories and GitHub settings

You need [GitHub](../glossary.md#github) accounts. Use your own personal account for the Owner work. The bot account is separate (row 2). [BLD-010 r1]

Create three repositories:

1. Sign in to GitHub. Select the **+** at the top right, then **New repository**. [VERIFY screen names]
2. Name the first one `<code repo name>`. Set it to **Public**. This is the code repository. [BLD-010 r1, SEC-110]
3. Create `<code repo name>-data`. Set it to **Private**. This is the data repository. [BLD-010 r1]
4. Create `<code repo name>-fixtures`. Set it to **Private**. This is the fixtures repository. [BLD-010 r1, SEC-110 a]

On the **code repository** only, open **Settings** and do the following. [VERIFY screen names]

5. Under **General → Features**, untick **Issues**, **Discussions**, **Wiki** and **Projects**. [BLD-010 r1, SEC-110 d]
6. Under **Actions → General**, set **Fork pull request workflows from outside collaborators** to **Require approval for all external contributors**. [BLD-010 r1, SEC-110 d]
7. Under **Code security**, turn on **Secret scanning** and **Push protection**. [BLD-010 r1, SEC-104, SEC-110 h]
8. Set your commit email to your GitHub **noreply** address, so your personal email never appears in commits. [BLD-010 r1, SEC-110 e]

Create the environments. Go to **Settings → Environments → New environment**. Create these five, and add no secrets yet. [BLD-010 r1, SEC-108 a]

| Environment | Deployment branch rule | Other settings |
|---|---|---|
| `production` | `release` only | None |
| `staging` | `main` only | None |
| `ci-fixtures` | This repository's branches only, and `refs/pull/*/merge` [VERIFY pattern syntax] | Fork runs must not receive secrets (SEC-108 a) |
| `deploy-production` | `release` only | **Required reviewer = your GitHub account.** Turn **Prevent self-review** off. |
| `deploy-staging` | `main` only | None |

[VERIFY] Confirm that **Prevent self-review** is off on `deploy-production`, because you are both the reviewer and the approver. [BLD-010 r1]

Set up branch protection on `main` and `release`. Go to **Settings → Rules** (or **Branches**). Create one rule for each branch. [VERIFY screen names] Use these settings on both:

- Pull request required, with **1 approving review** [SEC-108 b]
- **Require approval of the most recent reviewable push** on [SEC-108 b]
- Required status checks. Add these only after the build agent tells you the check names. [VERIFY]
- Block force-pushes and deletions [SEC-108 b]
- Tick **Do not allow bypassing the above settings** [SEC-108 b]

Finish the `release` branch part after you complete [row 17](#row-17-release-branch).

Do not add any secret to **Settings → Secrets and variables → Actions → Repository secrets**. [SEC-108 a]

---

## Row 17 Release branch

The `release` branch is the one production uses. Production deploys only from `release`, after you approve the deployment. [BLD-010 r17, SEC-108 c]

1. Wait until the build agent has pushed the first commit to `main`. [VERIFY with build agent]
2. Create a branch named `release` from `main`. [BLD-010 r17]
3. Go to **Settings → General → Default branch**. Change it to `release`. [BLD-010 r16, PLT-071]
4. Go back to [row 1](#row-1-repositories-and-github-settings) and finish the branch protection on `release`.

---

## Row 2 Bot account for the build agent

The build agent works through its own GitHub account, called the bot account. You control this account. The build agent gives you the exact steps as a **separate step** when the build starts. Wait for that instruction. This section only shows the outline. [BLD-010 r2, SEC-102]

Outline:

1. Create a new GitHub account. Use a separate email address you control, `<bot email>`. Do not use your personal Gmail. Username: `<bot account username>`. [SEC-102]
2. Turn on 2-step verification for this account. [SEC-102, SEC-020]
3. Invite the bot to the **code repository only**, as a **Write** collaborator. Do not invite it to the data or fixtures repositories. [BLD-010 r2, SEC-102]
4. Create a **classic** personal access token with the scopes `repo` and `workflow`. Set its expiry to **90 days or less**. [SEC-017 a]
5. Put the token into the build agent's own secret configuration, as the build agent instructs. Never put it in chat, an issue or a file in the repository. [BLD-010 r2, SEC-101]

The bot can never approve its own work or approve a deployment. You are the only reviewer. [SEC-102]

Note the expiry date. You will need to renew the token before it expires. [SEC-021]

---

## Row 13 Two-step verification

Do this for every account as you create it. The list is: Google, GitHub, Vercel, Cloudflare (both accounts), Turso, Resend, Google Cloud, and each LLM provider. [SEC-020, BLD-010 r13]

For each account:

1. Open the account's **security** settings. The name is usually **Security** or **Two-step verification**. [VERIFY per site]
2. Turn on 2-step verification. Use an authenticator app. [SEC-020]
3. Save the backup or recovery codes **offline** (on paper). Never save them in a repository, a chat or a cloud document. [BLD-010 r13a]
4. Tick the account off in this list:

- ☐ Google (your personal account, see [row 13a](#row-13a-owner-google-account-recovery))
- ☐ GitHub (personal account)
- ☐ GitHub (bot account, see [row 2](#row-2-bot-account-for-the-build-agent))
- ☐ Vercel
- ☐ Cloudflare, production account
- ☐ Cloudflare, staging account
- ☐ Turso
- ☐ Resend
- ☐ Google Cloud
- ☐ Google AI Studio, Groq and OpenRouter (see [row 12](#row-12-free-llm-keys))

---

## Row 5 Vercel projects

Vercel hosts the web app. You need two projects, one for production and one for staging. Both are on the free Hobby plan. [BLD-010 r5]

1. Sign in to [Vercel](../glossary.md#vercel). Select **Add New… → Project**. [VERIFY screen names]
2. Choose **Import Git Repository** and select `<code repo name>`. Do not deploy yet. [BLD-010 r5]
3. Name the first project `<prod project name>`. This is production.
4. Repeat for a second project named `<staging project name>`. This is staging.
5. On **both** projects, open **Settings → Git**. Turn **automatic deployments** off for production. Turn preview deployments off on both. [VERIFY screen names] [BLD-010 r5, PLT-006]
6. Write down the assigned domain for each project. You need these for [row 10](#row-10-google-oauth-clients). Record them in your private notes, not in the repository. [PLT-035]

Deployments happen only through the approved GitHub jobs. Vercel does not deploy on its own. [PLT-006]

---

## Row 10 Google OAuth clients

Google sign-in uses two [OAuth clients](../glossary.md#oauth-client), one for production and one for staging. Each has its own redirect address. [BLD-010 r10, PLT-035]

1. Sign in to the [Google Cloud console](../glossary.md#google-cloud). Create a project named `<prod project name>`. Do not add a billing account. If Google asks for one, stop and ask the build agent. [BLD-010 r10, PRD-007]
2. Open **Google Auth Platform** (this is the newer name for OAuth consent). [VERIFY screen names]
3. Under **Branding**, fill in the app name `<app name>` and the support email, which is your Google address `<your Gmail address>`. [VERIFY]
4. Under **Audience**, choose **External**. Then choose **Publish app** so the status shows **In production**. [PLT-035, BLD-010 r10]
5. Under **Data access**, add only these scopes: `openid`, `email` and `profile`. [PLT-035]
6. Under **Clients**, choose **Create client**. Choose **Web application**. [VERIFY]
7. Add this exact redirect address: `https://<production host>/api/auth/callback/google`. Use the production Vercel domain from [row 5](#row-5-vercel-projects). [PLT-035]
8. Create a second client for staging with this redirect address: `https://<staging host>/api/auth/callback/google`. [PLT-035, SEC-017 j]
9. Copy each client secret straight into the Vercel environment variables of its own project. Do not paste it anywhere else. [SEC-017 j, SEC-101]

The app's public address is also written in the `APP_BASE_URL` setting. Record both domains in your private notes. [PLT-035]

---

## Row 13a Owner Google account recovery

If you lose your main Google account, you may need a break-glass recovery address. This section sets up that address. It is disabled until the documented recovery procedure enables it. [BLD-010 r13a, PLT-035, ROL-101a]

1. On your main Google account, turn on 2-step verification (see [row 13](#row-13-two-step-verification)). [SEC-020]
2. Create backup codes and save them offline on paper. [BLD-010 r13a]
3. Test one backup code once, then tell the build agent **where** they are kept (for example "printed, home safe") — never the codes themselves — so it can tick BUILD_SETUP row 5.2. To test one: sign out of Google, sign in, choose **Try another way → Enter one of your 8-digit backup codes** [VERIFY], then cross that code off (each works once). [BLD-010 r13a, O-38]
4. Choose a second Google address that you own and rarely use. Write it as `<recovery Google address>`. It must be different from your main account. [ROL-101a]
5. Store `<recovery Google address>` as `OWNER_RECOVERY_EMAIL` in GitHub environment `production` and in the production Vercel environment. [BLD-010 r13a]

Store it as a **secret** (not a plain variable) in both places, so it never shows in logs (decision D-010). [PLT-035, BLD-010 r13a]

Keep the recovery address out of chat. It is personal data. [NFR-030]

---

## Row 6 Turso databases and tokens

[Turso](../glossary.md#turso) holds the app's data. You need four databases: a production main database, a staging main database, a production auth database and a staging auth database. [BLD-010 r6, ROL-101a]

1. Sign in to Turso. Create the four databases. Use names like `<prod main db>`, `<staging main db>`, `<prod auth db>` and `<staging auth db>`. [VERIFY screen names]
2. For each **main** database, create one token for each caller that needs it: the Vercel app, GitHub Actions and the Worker. Use a read-only token where the caller only reads. [SEC-017 d] [VERIFY which callers are read-only]
3. Store each main-database token in the store named in [the secret table](#where-each-secret-goes). Each token goes only to the stores of its own environment. [SEC-017 d]
4. For each **auth** database, create one token. The production auth token goes to the production Vercel project only. The staging auth token goes to the staging Vercel project only. Workers and GitHub never hold an auth token. [SEC-017 e, ROL-101a]
5. Set each token's expiry to one year or less. [SEC-017 d, e]

---

## Row 7 Cloudflare accounts and tokens

You need **two** [Cloudflare](../glossary.md#cloudflare) accounts. One is for production. The other is a separate free account for staging. Cloudflare needs a different sign-in email for each account. [BLD-010 r7, SEC-017 g] [VERIFY]

1. Create or use your production Cloudflare account. Turn on 2-step verification. [BLD-010 r7, SEC-020]
2. Create a second, separate free Cloudflare account for staging, with the email `<staging Cloudflare email>`. Turn on 2-step verification. [SEC-017 g]
3. In **each** account, go to **My Profile → API Tokens → Create Token**. Use the **Edit Cloudflare Workers** template. [VERIFY screen names]
4. Limit each token to its own account and its own Worker, if the screen allows it. [VERIFY per-script scoping] [SEC-017 g]
5. Set the expiry to one year. [SEC-017 g]
6. Store the **production** token in GitHub environment `deploy-production`. Store the **staging** token in GitHub environment `deploy-staging`. Never put the production token in `deploy-staging`. [SEC-017 g, SEC-108 a]
7. Create a [Vercel](../glossary.md#vercel) deploy token. Go to Vercel **Account Settings → Tokens**. Choose the narrowest scope the screen offers. [VERIFY narrowest scope] [SEC-017 n]
8. Store the Vercel deploy token in GitHub environment `deploy-production` only. [SEC-017 n, BLD-010 r7]

The Worker is set up by the build agent. You never run Wrangler. [BLD-012]

---

## Row 16 Vercel production settings

Do these on the **production** Vercel project. [BLD-010 r16]

1. Open **Settings → Git**. Confirm that automatic deployment for production is **off**. Production is deployed only by the approved `deploy-production` job. [BLD-010 r16, SEC-108 c]
2. Turn **Git fork protection** on. [BLD-010 r16, SEC-108 g]
3. Open **Settings → Deployment Protection**. Choose **Standard Deployment Protection** and turn it on. [VERIFY screen name] [BLD-010 r16, SEC-108 g]
4. Open **Settings → Environment Variables**. For each production secret, tick only **Production**. Do not tick Preview or Development. [BLD-010 r16]
5. Turn preview deployments off on the production project. Use an **Ignored Build Step** for any branch other than `release`. The build agent will give you the exact command. [VERIFY with build agent] [BLD-010 r16, PLT-006]
6. Check that preview deployments are also off on the staging project (see [row 5](#row-5-vercel-projects)). [PLT-006]
7. The default branch must be `release` (see [row 17](#row-17-release-branch)). [PLT-071]

---

## Row 16b GitHub read token and Vercel notifications

1. In GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. [VERIFY screen names]
2. Set the resource owner to your personal account. Choose **Only select repositories** and pick `<code repo name>`. [SEC-017 m]
3. Set the permissions to **Read-only** for **Contents**, **Actions** and **Deployments**. [SEC-017 m]
4. Set the expiry to one year or less. [SEC-017 m]
5. Store the token in the **production Vercel environment only**. Do not store it anywhere else. [SEC-017 m, BLD-010 r16b]
6. Turn on Vercel's production-deployment emails. Go to Vercel **Account Settings → Notifications**. [VERIFY on Hobby] [SEC-108 b, NFR-006]

---

## Row 3 Worker dispatch tokens

The spec says you create these tokens in M0 and enter them in M1. The Worker is set up in M1. [BLD-010 r3]

**Do not create these two tokens yet.** You create each one during the M1 "Worker secrets" step and paste it straight into its Worker secret, so the value never has to be kept anywhere in between (decision D-006). The steps below are here so you know what is coming.

For **each** of the two tokens:

1. Create a fine-grained token, as in [row 16b](#row-16b-github-read-token-and-vercel-notifications). [SEC-017 b]
2. Choose **Only select repositories** and pick `<code repo name>` only. [SEC-017 b]
3. Set **Actions** to **Read and write**. [SEC-017 b]
4. Set the expiry to one year or less. [SEC-017 b]
5. Name them: one for production, which dispatches `release` (`<worker name>-prod`), and one for staging, which dispatches `main` (`<worker name>-staging`). [SEC-017 b, b-s]

The production token goes to the production Worker secret, and the staging token goes to the staging Worker secret. Enter them in M1, using the "Worker secrets" step the build agent gives you. [BLD-010 r3, SEC-017 b, b-s]

---

## Row 4 Data repo and fixtures repo tokens

1. Create a fine-grained token with **Only select repositories** set to `<code repo name>-data`. Set **Contents** to **Read and write**. Set the expiry to one year or less. [SEC-017 f] [BLD-010 r4]
2. Store it in GitHub environment `production` only. [SEC-017 f]
3. Create a second fine-grained token with **Only select repositories** set to `<code repo name>-fixtures`. Set **Contents** to **Read-only**. Set the expiry to one year or less. [SEC-017 f-r]
4. Store it in GitHub environments `staging` and `ci-fixtures`. [SEC-017 f-r]

The bot account must never reach the data repository. Do not invite the bot to it. [SEC-102]

---

## Row 8 Resend account and API keys

[Resend](../glossary.md#resend) sends the Owner's emails. [EML-001] [BLD-010 r8]

1. Sign up for Resend using **your Gmail address** (`<your Gmail address>`). The sender Resend provides can only deliver to the address that owns the account. [EML-003a]
2. Turn on 2-step verification. [SEC-020]
3. Create one API key for **production** and one for **staging**. Give each **sending access** only. [SEC-017 h] [VERIFY screen names]
4. Store the production key in the Vercel production environment and in GitHub environment `production`. [SEC-017 h]
5. Store the staging key in the Vercel staging environment and in GitHub environment `staging`. [SEC-017 h]
6. Add an environment variable named `OWNER_EMAIL` with the value `<your Gmail address>` in the same stores. Use the same names in each store. [BLD-010 r8, EML-005]

Resend's free plan has no card requirement for these steps. If it asks for a card, stop and ask the build agent. [PRD-007]

---

## Row 9 Gmail filter

This stops the Resend test emails going to spam. [EML-036, BLD-010 r9]

1. Open Gmail. Select the settings gear, then **See all settings**. [VERIFY screen names]
2. Open **Filters and Blocked Addresses**, then **Create a new filter**. [VERIFY]
3. In **From**, enter the Resend test sender address `<Resend test sender address>`. Check the current address in Resend's documentation. [VERIFY]
4. Choose **Create filter**. Tick **Never send it to Spam** and **Apply the label**. [EML-036]
5. Create a new label named `Investment AI` and select it. [BLD-010 r9]

---

## Row 12 Free LLM keys

The app uses free-tier keys from three providers. Turn on 2-step verification on each account (see [row 13](#row-13-two-step-verification)). [BLD-010 r12, SEC-020]

1. **Google AI Studio.** Sign in and choose **Get API key**. Create a key. [VERIFY screen names]
2. **Groq.** Sign in to the console. Open **API Keys** and create a key. [VERIFY]
3. **OpenRouter.** Sign in. Open **Keys** and create a key. [VERIFY]
4. Store each key in GitHub environment `production` and in the production Vercel environment. Staging uses recorded model responses, so it needs no key. [SEC-017 i, Ch. 03]

Do not add billing to any of these. [PRD-007]

---

## Row 11 Generated secrets and backup key pair

You generate these values on your own computer. The spec asks for Windows steps. [BLD-010 r11, SEC-017]

### Part A Get the official age tool

[age](../glossary.md#age-key-pair) is a free file-encryption tool. The backup key pair is made with it. [PLT-022b]

1. Open the official `age` release page on GitHub: `github.com/FiloSottile/age/releases`.
2. Download the Windows zip file for the latest release, `age-v<version>-windows-amd64.zip`. [VERIFY file name]
3. Find the official SHA-256 checksum on the same release page. [VERIFY where the checksum is published]
4. Open PowerShell in your Downloads folder. Run `Get-FileHash -Algorithm SHA256 .\age-<version>-windows-amd64.zip`.
5. Compare the two values character by character. If they do not match, delete the zip file and stop. Ask the build agent.
6. Make a new folder that no cloud service syncs, for example `C:\PraxisKeys\age`. Extract the zip there.

Never keep key files in Google Drive, OneDrive, Desktop or Downloads if those folders sync to a cloud service. [BLD-010 r11]

### Part B Make the backup key pair

7. In PowerShell, move to the age folder. Run `.\age-keygen.exe -o .\backup-key.txt`.
8. The public key starts with `age1`. It is also written in the file as a line starting with `# public key:`. [VERIFY output format]
9. Write the private key line (starting `AGE-SECRET-KEY-`) on paper. Put the paper in a safe place. [PLT-022b, SEC-017 k]
10. Copy `backup-key.txt` onto a USB stick. Keep the USB stick in a safe place away from your computer. [PLT-022b, SEC-017 k]
11. Store the **public** key only in GitHub environment `production` and in the production Vercel environment, as name `<backup public key name>`. [SEC-017 k]
12. Do not store the private key on GitHub, in Vercel, in a chat or in an email. [PLT-022b]

### Part C Offline encrypt and decrypt test

This test proves that the paper and USB copies work. Use dummy text only. [TST-108, BLD-010 r11]

13. Create a file `test.txt` containing the words `test only`.
14. Encrypt it: `.\age.exe -r <public key> -o test.txt.age test.txt`. Paste the public key in place of `<public key>`.
15. Decrypt it using the USB copy of the key, not the copy on the computer: `.\age.exe -d -i <USB drive letter>:\backup-key.txt -o test-out.txt test.txt.age`.
16. Compare the two files: `Get-FileHash test.txt, test-out.txt`. The two hashes must match.
17. Delete `test.txt`, `test.txt.age` and `test-out.txt`.
18. Delete `backup-key.txt` from the computer once the paper and USB copies are confirmed. Empty the Recycle Bin. [PLT-022b]

If the test fails, stop. Do not continue until the build agent helps you fix it. [TST-108]

### Part D Random values for each environment

The spec asks for random 32-byte values for these secrets. [SEC-017 c1, c2, c3, c4]

- **Session secret and `CRON_SECRET`** (c1): one set for **production** and one for **staging**. Store only in the matching Vercel environment.
- **Worker to Vercel HMAC** (c2): one value for production, one for staging. Store in the Worker and the Vercel environment of the same environment. The Worker copy is added in M1.
- **Actions to Vercel HMAC** (c3): one value for production, one for staging. Store in GitHub environment `production` or `staging`, and in the Vercel environment of the same environment.
- **Staging test-identity signing secret** (c4): staging Vercel environment only.
- **`PII_HASH_KEY`** (key for hashing old personal data, NFR-030): one value for production, stored in the production Vercel environment and GitHub environment `production`; one separate value for staging, stored in the staging Vercel environment and GitHub environment `staging` (decision D-007). [SEC-017, NFR-030]

Generate each value in PowerShell. Paste it straight into its store. Do not save it in a file:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
($b | ForEach-Object { $_.ToString("x2") }) -join ""
```

This prints 64 hex characters (32 random bytes); the app expects exactly this format (decision D-008). Generate a new value for each store. Never reuse a value between environments. [SEC-017 c2, c3]

---

## Row 15 ASX confirmation request

Send the ASX confirmation request by email yourself. It is not blocking. [BLD-010 r15, DAT-122]

[VERIFY] Ask the build agent for the text to send. The spec does not give the wording.

---

## Row 16a GitHub failure email test

GitHub sends an email when a workflow fails. This is the second alert channel. [NFR-006, BLD-010 r16a]

1. In GitHub, select your profile picture, then **Settings → Notifications**. [VERIFY screen names]
2. Under **Actions**, turn on email notifications for failed workflows. Set the address to `<your Gmail address>`. [NFR-006]
3. The build agent prepares a workflow that fails on purpose. Run it from the **Actions** tab. [BLD-010 r16a]
4. Check your Gmail inbox. You should receive the GitHub failure email. If it is in Spam, use the filter from [row 9](#row-9-gmail-filter). [NFR-006]
5. Tell the build agent the email arrived. Do not copy the email contents into the chat. [SEC-110 b]

Workflow logs are public. The failing workflow should show no secret or personal data. [SEC-110 b]

---

## Row 14 Google test accounts (deferred)

BLD-010 lists three Google test accounts as an M0 item. You have deferred this row until the build is complete. Do not create these accounts now. [BLD-010 r14, TST-113]

Until then, M1's AT-01 check runs automatically with staging test identities. The real Google sign-in check with these three accounts is queued as an Owner check before go-live (decision D-009). [TST-113, AT-01]

When you create them later, the accounts are: an Editor, a Viewer and a non-allowlisted account. Keep their passwords out of chat. [TST-113]

---

## Row 18 Informed consent ticks

Read each item below. Tick it only if you agree. Record your ticks in the decision log in the private data repository. [BLD-010 r18]

- ☐ Merging a release and approving its deployment are done in **one sitting**. [SEC-108 c]
- ☐ The **code repository is public**. Its code, workflow files and run logs are visible to anyone. [SEC-110]
- ☐ While the bot's token is valid, it has access equal to the production environment secrets. During build-phase drills, the temporary Turso token (l) is present next to the bot's token. [BLD-010 r18, SEC-108]
- ☐ The risk acceptances: ASX (O-23) and Yahoo (O-26). These may lead to the data sources being turned off (DAT-127). Provider accounts may also be suspended. [BLD-010 r18]
- ☐ The minutes projection (PLT-014a) and the soft ceiling of 3,000 minutes per month (PLT-014). [BLD-010 r18]

---

## Row 19 Plugins and MCP servers

The **build agent** does this, not you. It installs the Claude Code plugins and MCP servers listed in `Requirement/PLUGINS.md` on the build machine. It records the versions in BUILD_SETUP section 9. Keys and tokens are never put in any repository. [BLD-010 r19, O-41]

If the build agent asks you to restart Claude Code, type `/reload-plugins` or restart Claude Code, then say "build" again.

---

## M0 exit

M0 is complete when you have ticked every row in the checklist. [BLD-011]

The exit runs in this order:

1. **Bootstrap release.** The build agent makes a first release. It contains a skeleton app and the smoke-test workflow. The bot opens a pull request into `release`. You review it, approve it and merge it. This release is exempt from the release gate, because the gate needs the smoke test. [BLD-011 (1)]
2. **Smoke test, stage 1.** This checks the secrets that GitHub Actions can see. It is the first task of M1, and it must pass before other M1 work. It sends one test email to you with the subject `[TEST]`. [BLD-011 (2), SEC-101]
3. **Smoke test, stage 2.** This runs after the skeleton is deployed. It checks the Vercel self-check route and the Worker cron self-check. [BLD-011 (3), SEC-101]
4. **M0 exit.** M0 is done when every row in the checklist is ticked. [BLD-011 (4)]

**First approval.** The bootstrap release's `deploy-production` job waits for you. Approve it in GitHub under the workflow run, using **Review deployments**. Until you approve it, the nightly check shows "awaiting first approval". This is the only production deployment before the first real release. [BLD-011, SEC-108 c]

Give the build agent the bot's token only through its own secret configuration. [BLD-011, SEC-102]

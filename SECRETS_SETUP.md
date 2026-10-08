# GitHub Environment Secrets Setup

This guide shows where to add environment secrets for the validation workflow and builds.

## Setup Location

Go to **GitHub repository settings** → **Secrets and variables** → **Actions**

Add secrets at the **Repository** level (not environment-specific yet; can be scoped later per Environments in spec SEC-017).

## Required Secrets

### 1. Cloudflare (staging account)
- **`CLOUDFLARE_API_TOKEN`** — "Edit Cloudflare Workers" scoped token only
- **`CLOUDFLARE_ACCOUNT_ID`** — Your Cloudflare account ID (hex, ~32 chars)

**How to get them:**
1. Cloudflare Dashboard → My Profile → API Tokens → Create Token
2. Use template "Edit Cloudflare Workers" → select staging scope
3. Cloudflare Dashboard → Overview → Copy Account ID

### 2. Turso Database
- **`TURSO_CONNECTION_URL`** — Connection string from Turso CLI or dashboard
  - Format: `libsql://db-name-[random].turso.io?authToken=...`
- **`TURSO_AUTH_TOKEN`** — Auth token for database access

**How to get them:**
1. `turso db list` → find your database
2. `turso db show <db-name>` → see connection strings
3. Turso Dashboard → Tokens → Create new token (org/database scoped)

### 3. Google
- **`GOOGLE_CLIENT_ID`** — OAuth client ID (ends with `.apps.googleusercontent.com`)
- **`GOOGLE_CLIENT_SECRET`** — OAuth client secret
- **`GOOGLE_API_KEY`** — Server-side API key (optional, for staging)

**How to get them:**
1. Google Cloud Console → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID (Web application)
3. Redirect URIs: `https://<staging-domain>/api/auth/callback/google`
4. Download JSON → extract `client_id` and `client_secret`

### 4. Resend (Email)
- **`RESEND_API_KEY`** — API key from Resend dashboard

**How to get it:**
1. Resend.com → Settings → API Keys → New API Key
2. Create with "Sending only" permissions
3. Copy the key (starts with `re_...`)

### 5. LLM Providers (≥1 required)
- **`GROQ_API_KEY`** — Groq API key (free tier; sign up at groq.com)
- **`OPENROUTER_API_KEY`** — OpenRouter API key (free tier available)
- **`GOOGLE_GENERATIVE_AI_API_KEY`** — Google AI Studio key (free tier)

**How to get them:**
- **Groq:** groq.com/console → API Keys
- **OpenRouter:** openrouter.ai → Settings → API Keys
- **Google AI:** ai.google.dev → Get API key

## Validation Workflow

The workflow at `.github/workflows/validate-env-secrets.yml` runs on every push to `main` or `release`.

**What it checks:**
- ✅ All Cloudflare secrets present → test API access
- ✅ All Turso secrets present → parse connection URL
- ✅ All Google secrets present (OAuth required, API key optional)
- ✅ Resend API key working → test endpoint access
- ⚠️ ≥1 LLM provider key configured (warning only, non-blocking)

**View results:** GitHub Actions tab → Latest run → "Validate all environment credentials"

## Secret Rotation (SEC-021)

Per spec ch. 12 (SEC-021):
- **Cloudflare token:** rotate every 30 days
- **Turso token:** rotate every 30 days
- **Google OAuth secret:** rotate every 30 days
- **Resend API key:** rotate every 14 days
- **LLM keys:** check provider limits every 7 days

Update BUILD_SETUP.md §8 (Secrets register) with rotation dates.

## Notes

- **Never commit secrets** to the repo (the validation workflow prevents this via GitHub secret scanning)
- Secrets are **never logged** by the workflow (all API tests redact the actual keys)
- Staging secrets should be separate from production (per BUILD_SETUP §2–6)
- Environment-scoped secrets (prod vs staging) are set up in SEC-017 during M1

# Credential smoke test, stage 1

Proves that each secret visible to GitHub Actions works, without printing it
(BLD-011, SEC-101). Manual only; it never runs on push. Zero npm dependencies.

## What it checks

| Job (environment) | Checks |
| --- | --- |
| `staging` | Turso round-trip on a temp table; one `[TEST]` email to the Owner via Resend; format of `ACTIONS_HMAC_SECRET` and `PII_HASH_KEY`; fixtures repo read |
| `deploy-staging` | Cloudflare API token and account id; Worker dry-run deploy (`--env staging`) |
| `ci-fixtures` | fixtures repo read |
| `production` | Turso round-trip; one `[TEST]` email; Owner and recovery email format; HMAC and PII key format; backup public key format; data repo read; Google AI, Groq and OpenRouter keys (free model-list calls only) |
| `deploy-production` | Cloudflare API token and account id; Vercel token; Worker dry-run deploy |

OAuth client secrets are Vercel-only and are checked in stage 2, together with
the Vercel self-check route and the Worker cron self-check. Keys that are only
format-checked here are proven end-to-end in stage 2.

## How to run it

Actions, then "Credential smoke test (stage 1)", then Run workflow:

- Branch `main` and target `staging`.
- Branch `release` and target `production`. The `deploy-production` job waits
  for the Owner's approval (required reviewer).

The `guard` job fails any other branch and target combination. Jobs use
`deployment: false`, so no deployment record is created.

Each run of an app suite (`staging` or `production`) sends exactly one email
with subject `[TEST] Praxis credential smoke test (<env>)` to the Owner.

## Output and local tests

The log shows only check names, PASS or FAIL, and a short safe detail such as
`HTTP 401` or `missing`. Secret values, hostnames and addresses are never printed.

Run the tests (no network): `node --test "scripts/smoke/*.test.mjs"`

## Stage 2, Vercel self-check (SEC-101, SEC-017)

Secrets that Actions cannot see are proven by a signed route on the deployed app,
`POST /api/internal/self-check`. The `Stage 2 — Vercel self-check` step at the end of the
`staging` and `production` jobs (`scripts/smoke/stage2.mjs`) calls it and prints one
`PASS`, `FAIL` or `PENDING` line per secret. The route never returns a secret value, and
Actions never prints the app URL (it comes from the environment secret
`APP_BASE_URL_STAGING` or `APP_BASE_URL_PROD`; if missing, the step says so and exits 1).

Signing scheme (code: `src/lib/security/hmac.ts` and `scripts/smoke/sign.mjs`):

| Item | Value |
| --- | --- |
| `X-Praxis-Timestamp` | unix seconds, integer string |
| `X-Praxis-Nonce` | 32 lowercase hex characters (16 random bytes), single use |
| `X-Praxis-Signature` | lowercase hex HMAC-SHA256, key = `ACTIONS_HMAC_SECRET` as UTF-8, message = `<timestamp>.<nonce>.<raw body>` |
| Body | `{"purpose":"self-check"}`, at most 4 KB |

The server rejects (401, same generic body for every reason) a bad or missing header, a
timestamp more than 300 s old or ahead, a wrong signature, or a nonce it has seen
(`request_nonce` table in the main Turso DB; if that store fails the route answers 503, fail
closed). A missing or malformed `ACTIONS_HMAC_SECRET` on Vercel gives 503 without evaluating
any signature. Only POST is accepted.

The environment is derived on the server (no new variable): `BACKUP_PUBLIC_KEY` present means
production, otherwise `TEST_IDENTITY_SECRET` present means staging. The caller fails the run if
that differs from its `SMOKE_ENV`. `WORKER_HMAC_SECRET` not set yet is reported `PENDING` and
does not fail the run. No email is sent in stage 2.

## Stage 2: test-identity login probe (SEC-109, TST-113)

After the self-check, `stage2.mjs` sends one unsigned `POST /api/test-identity/login` with body
`{}`. On `production` it passes only on HTTP 404 ("Test identity login disabled"); on `staging`
it passes only on HTTP 401 (route enabled, signature required). Anything else fails the run.
The response body is never read or printed.

`scripts/e2e/test-login.mjs` exports `testLogin(baseUrl, secret, email, fetchImpl)` for the
staging E2E suite: it signs the call with `TEST_IDENTITY_SECRET` (same scheme as `sign.mjs`) and
returns the `name=value` session cookie.

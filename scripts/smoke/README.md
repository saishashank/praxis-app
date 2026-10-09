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

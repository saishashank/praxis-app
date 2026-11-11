# Rotating a secret

M18 OPS-108 (D-976). One section per secret of the production table (`scripts/secrets/rows.json`, the same rows as `docs/owner-guide/M8_go_live.md` section F and `docs/owner-guide/secrets_tool.md`). It holds names, places and commands only: never a value. Staging is retired (D-964), so the three staging-only rows (`b-s`, `c4`, `h-s`) are not rotated any more: revoke them at the issuer once (listed at the end).

## The same five steps for every secret

1. **Issue the new value** at the issuer (the "Issuer" line of the section). Never paste it into chat, e-mail, notes or a ticket.
2. **Set it everywhere in one go**: `npm run secrets -- set <row>` (the "Command" line). The tool prints the plan, asks for `yes`, then writes every place (GitHub environment, Vercel project, Cloudflare Worker) and prints `ok` or `FAILED` per place. A value is never printed.
3. **Redeploy** if a Vercel or Cloudflare place changed: run **Deploy production** on the approved commit (a new environment variable only reaches a new deployment).
4. **Prove it**: run **Credential smoke test (stage 1)** with target `production` on `release`; its stage 2 (`scripts/smoke/stage2.mjs`) also exercises the signed paths. The "Proof" line names the check that must say PASS. After a Worker secret changed, the Worker's own self-check (02:15 UTC, or **Run now** in the Owner page) must also pass.
5. **Revoke the old value** at the issuer only after the proof is green, then record the rotation: date and row letter, no value. The expiry date for the row restarts on the Configuration page.

**Rollback.** If the proof is red, put the previous value back with the same command (keep it in the password manager until the proof is green), redeploy, and run the smoke test again. Where a section says "no rollback", the old value cannot be put back and the section says what to do instead.

## Production secrets

### b - Worker dispatch token (`GITHUB_DISPATCH_TOKEN`)

- **Where**: Cloudflare Worker `praxis-sentinel`.
- **Issuer**: GitHub, your account: a fine-grained token on the code repository only (Actions read and write).
- **Command**: `npm run secrets -- set b`.
- **Proof**: smoke test stage 1 (the Worker dispatch check); the next scheduled dispatch (or **Run now**) starts a workflow.
- **Rollback**: set the previous token back; revoke the new one.

### c1 - Session secret and cron secret (`AUTH_SECRET`, `CRON_SECRET`)

- **Where**: Vercel project `praxis-app` (Production).
- **Issuer**: your password manager's generator (64 hex characters).
- **Command**: `npm run secrets -- set c1`.
- **Proof**: smoke test stage 2 (Vercel self-check) checks the format; you sign in again.
- **No rollback of sessions**: changing `AUTH_SECRET` ends every signed-in session (everybody signs in again). Do it at a quiet time. Putting the old value back makes the old sessions valid again.

### c2 - Worker to Vercel signing secret (`WORKER_HMAC_SECRET`)

- **Where**: Vercel project `praxis-app` **and** Cloudflare Worker `praxis-sentinel` (one value, set by one command).
- **Issuer**: your password manager's generator (64 hex characters).
- **Command**: `npm run secrets -- set c2`.
- **Proof**: smoke test stage 2 signs a call with scheme v2 (method, path and body hash, SEC-115); the Worker self-check passes. Redeploy Vercel and the Worker in the same run: in the minutes between the two, a Worker call is refused (nothing is lost; the Worker retries).
- **Rollback**: set the previous value on both sides with the same command.

### c3 - Actions to Vercel signing secret (`ACTIONS_HMAC_SECRET_PROD`, `ACTIONS_HMAC_SECRET`)

- **Where**: GitHub environment `production` and Vercel project `praxis-app`.
- **Issuer**: your password manager's generator (64 hex characters).
- **Command**: `npm run secrets -- set c3`.
- **Proof**: smoke test stage 2 (the Actions to Vercel signed call); the next maintenance or backup run reaches the app.
- **Rollback**: set the previous value in both places.

### d - Turso main-database tokens (`TURSO_MAIN_TOKEN_PROD`, `TURSO_MAIN_TOKEN`)

- **Where**: GitHub environment `production`, Vercel project `praxis-app`, Cloudflare Worker `praxis-sentinel` (one new token per caller).
- **Issuer**: the Turso dashboard: create the new tokens first, remove the old ones after the proof.
- **Command**: `npm run secrets -- set d`.
- **Proof**: smoke test stage 1 (the Turso round trip: exactly five requests) for each store; the next nightly run writes its run record.
- **Rollback**: the old tokens stay valid until you remove them, so put them back and remove the new ones.

### e - Turso auth-database token (`TURSO_AUTH_TOKEN`)

- **Where**: Vercel project `praxis-app`.
- **Issuer**: the Turso dashboard.
- **Command**: `npm run secrets -- set e`.
- **Proof**: smoke test stage 2 (auth database round trip); you can sign in.
- **Rollback**: set the previous token back; remove the new one.

### f - Data-repo token (`DATA_REPO_TOKEN_PROD`)

- **Where**: GitHub environment `production`.
- **Issuer**: GitHub: a fine-grained token on the private data repository only (contents read and write).
- **Command**: `npm run secrets -- set f`.
- **Proof**: dispatch **Nightly backup**: it writes the file to the data repository.
- **Rollback**: set the previous token; revoke the new one.

### f-r - Read-only fixtures token (`FIXTURES_READ_TOKEN`)

- **Where**: GitHub environment `ci-fixtures` (the `fixtures` and `recorded-day` jobs of `ci.yml` use it only as the checkout token).
- **Issuer**: GitHub: a fine-grained token on the private fixtures repository only (contents read).
- **Command**: `npm run secrets -- set f-r`.
- **Proof**: the `fixtures` and `recorded-day` jobs of the next CI run check the repository out (a missing token fails `recorded-day`, never skips it).
- **Rollback**: set the previous token; revoke the new one.

### g - Cloudflare API token (`CLOUDFLARE_API_TOKEN_PROD`)

- **Where**: GitHub environment `deploy-production`.
- **Issuer**: Cloudflare: a token with Edit Workers on the production account.
- **Command**: `npm run secrets -- set g`.
- **Proof**: smoke test stage 1 (Cloudflare account and user endpoints); the next **Deploy production** run deploys the Worker.
- **Rollback**: set the previous token; delete the new one.

### n - Vercel deploy token (`VERCEL_TOKEN_PROD`)

- **Where**: GitHub environment `deploy-production`.
- **Issuer**: Vercel, Account Settings, Tokens.
- **Command**: `npm run secrets -- set n`.
- **Proof**: smoke test stage 1 (Vercel token check); the next **Deploy production** run builds.
- **Rollback**: set the previous token; delete the new one.

### h - Resend API key (`RESEND_API_KEY_PROD`, `RESEND_API_KEY`)

- **Where**: GitHub environment `production` and Vercel project `praxis-app`.
- **Issuer**: Resend: a new key with Sending access; delete the old key afterwards.
- **Command**: `npm run secrets -- set h`.
- **Proof**: smoke test stage 1 (the Resend pass and payload checks); the smoke test send reaches the Owner inbox.
- **Rollback**: set the previous key back while it still exists.

### i - LLM API keys (`GOOGLE_AI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`)

- **Where**: GitHub environment `production` and Vercel project `praxis-app`.
- **Issuer**: each provider (Google AI Studio, Groq, OpenRouter): rotate one provider at a time.
- **Command**: `npm run secrets -- set i` (or the single name, for example `npm run secrets -- set GROQ_API_KEY`).
- **Proof**: smoke test stage 1 (the LLM key checks). The live LLM roles stay off until the Owner turns them on (`llm_live_roles`), so no key is used for money decisions (PRD-041).
- **Rollback**: set the previous key while it still exists.

### j - Google OAuth client secret (`AUTH_GOOGLE_SECRET`)

- **Where**: Vercel project `praxis-app`.
- **Issuer**: Google Cloud Console, APIs and Services, Credentials: the production client.
- **Command**: `npm run secrets -- set j`.
- **Proof**: smoke test stage 2 (the Google OAuth format check); sign in with Google once.
- **Rollback**: Google keeps the old secret valid until you delete it: set it back.

### m - GitHub read token for release detection (`GITHUB_READ_TOKEN`)

- **Where**: Vercel project `praxis-app`.
- **Issuer**: GitHub: a fine-grained token on the code repository (contents, actions and deployments read).
- **Command**: `npm run secrets -- set m`.
- **Proof**: smoke test stage 2 (GitHub read check); the nightly deployed-commit check (SEC-108 d) still reads the release head.
- **Rollback**: set the previous token; revoke the new one.

### pii - Personal-data hash key (`PII_HASH_KEY_PROD`, `PII_HASH_KEY`)

- **Where**: GitHub environment `production` and Vercel project `praxis-app`.
- **Issuer**: your password manager's generator (64 hex characters).
- **Command**: `npm run secrets -- set pii`.
- **Proof**: smoke test stage 2 (format check).
- **No rollback by design**: hashes written with the old key do not match the new key (NFR-030). Rotate only after a suspected leak, and expect the next retention run to write new hashes.

### k - Backup key pair (keep)

- **Where**: public key in GitHub environment `production` and Vercel project `praxis-app`; the private key offline only.
- **Rotate only on suspicion (OPS-037a)**: follow `M8_go_live.md` section N, block (k): a new offline `age` pair, the new public key in both places, a fresh **Nightly backup**, then a real-key restore drill (`M8_go_live.md` section H) before the old key is destroyed.
- **No rollback**: never destroy the old private key before the drill with the new one passed.

### a, l - Revoke or absent

- **a (build token)**: the bot token is revoked at GitHub, never rotated (`M8_go_live.md` section E). The PR lists this as an Owner step.
- **l (temporary restore secrets)**: `TURSO_PLATFORM_TOKEN_TEMP` and `BACKUP_PRIVATE_KEY` exist in the `production` environment only during a restore drill. After it, delete both and revoke the token; **Restore drill** with mode `verify-removed` must then be green. The watchdog fails while either is present.

## Retired staging secrets (D-964)

Staging is retired, so nothing is rotated for it. Revoke these once at the issuer and delete them from GitHub environment `staging`, the staging Vercel project and the staging Worker: `b-s` (the staging dispatch token), `c4` (the test-identity signing secret `TEST_IDENTITY_SECRET`), `h-s` (the staging Resend key), the staging Turso tokens, the staging Cloudflare token and the staging Google OAuth client. The retired staging workflows (`nightly.yml`, `deploy-staging.yml`, `staging-e2e-day.yml`) stay in the repository for history and need none of them.

## After a leak

Do not wait for a schedule. Revoke at the issuer first, then run the five steps above for that row, then read the provider's logs and the audit log for use you did not make (OPS-037). `M8_go_live.md` section N has the same steps as generated blocks per row.

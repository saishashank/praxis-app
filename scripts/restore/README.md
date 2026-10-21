# Database restore (workflow drill and local script)

No personal data is in this file. Spec: OPS-040, NFR-004, TST-108, AT-04, SEC-017 (l), SEC-108 f, PLT-022b.

## Spec text this folder implements (quoted verbatim from `praxis-app-data/Requirement/v1/spec/`, with line numbers)

Order: OPS-040 (all steps), SEC-017 (l), TST-108, NFR-004 RTO, AT-04, SEC-108 f, PLT-022b. OPS-040a (Owner account recovery) is not relevant to a database restore and is not quoted.

- `11_ops_runbook.md` line 48:

  > - **OPS-040 (s9) Restore database.** Target RTO ≤ 4 h **counted from when the Owner starts** the procedure (NFR-004). Steps (Owner guide has screenshots): (0) revoke any active build-agent PAT; (1) add the **offline private backup key** and a **temporary Turso platform token** (the narrowest scope that can create a database, shortest expiry offered [VERIFY scope/expiry options]) as secrets of the GitHub `production` environment; (2) run the **"Restore database"** workflow (inputs: backup id, target = main DB and/or auth DB) which decrypts the backup, creates a new Turso DB by whole-database import and verifies checksums (TST-108); (3) in the Turso dashboard create the new database's tokens, one per SEC-017 caller, and enter each — **together with the new database URL** — directly into every store listed for it in the SEC-017 table (never through a workflow log); then redeploy the current production Vercel deployment (same commit, so it passes the approval check) and the Worker (OPS-050) so both pick them up (main DB: Vercel env, Actions, Worker; auth DB: Vercel env only); (4) delete the temporary token and the private-key secret (the workflow fails until they are gone); (5) run the smoke test and record the incident. If GitHub itself is unavailable, the restore from the monthly offsite copy needs a technical helper or the build agent, working from a local machine with the same steps.

- `10_nfr_testing.md` line 102:

  > | (l) temporary Turso platform token (restore and drills only) | narrowest create-database scope, shortest expiry | deleted after use | GitHub environment `production` (temporary); the restore/drill workflow fails while it exists and the nightly watchdog checks it is gone; revoke it at Turso and delete the environment secret |

- `10_nfr_testing.md` line 144:

  > - **TST-108 (s9) Restore test:** quarterly after go-live, restore the latest encrypted main-DB and auth-DB backups into **two throwaway Turso databases** (main and auth; created with the temporary token (l), not connected to any app — this exercises the real import path), verify checksums of forever tables, replay one cohort to identical NAV, then delete both databases and revoke (l). The private key is added only for the drill and removed afterwards; the workflow's last step fails (so GitHub emails the Owner) while the private-key secret or (l) is still present, and the nightly watchdog repeats that check. Any active build-agent PAT is revoked before a real-key drill and a new short-lived PAT is issued afterwards if the build continues. **During the build (M1–M7)** — at M1 exit and whenever backup or restore code changes — the drill job **generates a fresh throwaway key pair inside the run**, requests a fresh staging backup and staging auth export encrypted to that public key within the same run, restores them into two throwaway Turso databases (main and auth; created with (l)) and verifies checksums — so the real private key never meets an active PAT and no throwaway key is stored anywhere; cohort replay is added once cohorts exist (M3). The real key is checked without GitHub: at M0 the Owner performs the guide's offline encrypt/decrypt test with the real key pair, and each monthly offsite download includes a local decrypt-only check. The first real-key drill is part of M8 after the PAT is revoked (AT-30).

- `10_nfr_testing.md` line 24:

  > - **NFR-004 Recovery objectives:** RPO ≤ 24 h (nightly backup, PLT-022); RTO ≤ 4 h for the database via the documented restore; ≤ 1 h for app/worker redeploy.

- `14_system_acceptance.md` line 11:

  > | AT-04 | Backup & restore | Nightly main-DB and auth-DB backups present (auth via the encrypted Vercel export); the build-phase drill (in-run throwaway key pair, fresh staging backups) restores them into two throwaway Turso databases (main and auth, both deleted afterwards) within 4 h with matching checksums; the drill fails while the temporary token (l) remains; the real-key drill with cohort replay is part of AT-30 | PLT-022, ROL-101a, TST-108, OPS-040 |

- `10_nfr_testing.md` line 115:

  > (f) The backup **private** key is never stored on GitHub (PLT-022b).

- `02_platform_hosting_auth.md` line 36:

  > - **PLT-022b (s9)** Backups MUST be encrypted (e.g. `age`) to a public key (stored in the GitHub environment `production` and in the production Vercel env for the auth-DB export); the **private key is never stored on GitHub** except as a temporary secret during a restore or drill (then deleted, TST-108). Encrypted backups are stored as release assets of the data repo (not commits), retained 14 daily / 8 weekly / 12 monthly. Each month the Owner downloads the latest encrypted backup and history files to storage outside GitHub (OPS-020). Personal data in backups follows NFR-030 (identity fields of users revoked > 90 days are hashed).

Note on the spec tension (decision 4 of `docs/M8_design.md`, D-152, replaces the stricter reading of D-052): OPS-040 and TST-108 put the private key on GitHub as a **temporary** environment secret, and PLT-022b allows exactly that ("except as a temporary secret during a restore or drill"). So there are two paths: the workflow `.github/workflows/restore-drill.yml` (this folder's `drill-turso.mjs`) and the local script `restore.mjs` (the path when GitHub itself is unavailable, OPS-040 last sentence).

## The workflow path: `restore-drill.yml` (TST-108, OPS-040, AT-04, AT-30)

Dispatch only (no schedule), from the release branch, in the GitHub environment you choose. Inputs: `mode` (`drill`, `restore`, `verify-removed`), `environment` (`production`, or `staging` for the synthetic build-phase drill only), `key` (`real` or `throwaway`), `backup` (a tag `backup-YYYY-MM-DD`, empty = latest), `targets` (`both`, `main`, `auth`), `confirm` (restore mode: must be exactly `RESTORE`).

- **drill, key=real** (quarterly after go-live; the first real-key drill is part of M8 / AT-30): downloads the latest encrypted main and auth backups from the data repo (token (f)), decrypts them **in memory** with the temporary private key, verifies every table checksum, creates **two throwaway Turso databases** with the temporary platform token (l), restores into them (the real import path; counts and SHA-256 are re-read and compared), replays the **check cohort** (`cohortCheck.mjs`: a fixed, seeded cohort is replayed over the bars in the backup and over the bars read back from the restored database; every NAV value must be identical), then deletes both databases. A database that cannot be deleted fails the run and is named so you can delete it by hand.
- **drill, key=throwaway** (build phase M1 to M7, staging): the same pipeline on **synthetic data only**, with a key pair generated inside the run. No private key, no production data, no data-repo token. Only the temporary token (l) is needed.
- **restore** (OPS-040 steps 2 and 3): refused unless `confirm` is exactly `RESTORE`, the key is the real key and the environment is `production`. It restores into **new** databases named `restore-<db>-<date>-<random>`, **keeps** them and prints only their names. Then you create their tokens in the Turso dashboard and enter them with the new URL into the stores of SEC-017 (never through a log). A failed restore deletes the half-made databases. Revoke any active build-agent PAT first (OPS-040 step 0).
- **verify-removed**: skips the drill and only runs the last step, so a run can end green after you removed the temporary secrets.

Secrets are used only in the steps that need them: the guard step (presence check), the drill/restore step and the last step; never in `run:` text. The private key is read from the environment and decrypted in memory. No plaintext file is written; an `always()` step still removes the plaintext temp folder. The **last step fails while** `BACKUP_PRIVATE_KEY` or `TURSO_PLATFORM_TOKEN_TEMP` still exists in the environment, so a drill or restore run ends **red on purpose** until you delete them (GitHub then emails you). The log and job summary hold table names, counts, PASS/FAIL, elapsed time (against the 4 hour RTO) and, only if a delete failed or after a restore, database names: no URL, token, key or row content (every line also passes through a scrubber that blanks any secret value the process holds).

Owner steps for a drill: see "How to run a drill" below.

## The temporary Turso platform token (l)

The SEC-017 row (l) says the restore/drill workflow fails while token (l) exists and the nightly watchdog checks it is gone.

- The **workflow** path uses (l) (`TURSO_PLATFORM_TOKEN_TEMP`) to create and delete the databases (`turso-platform.mjs`; endpoint names and the narrowest create-database scope are [VERIFY] against the Turso Platform API reference before the first real run).
- The **local script** path (`restore.mjs`) does not need (l): you create the empty target database and its token in the Turso dashboard and revoke them after use.
- **Correction (M8 design finding 5):** an earlier version of this file said the watchdog cannot see the temporary secrets and that no check was built. That was wrong. A workflow job that runs in the `production` environment can tell whether its **own** secrets are set (an unset secret reads as empty), so no broader credential is needed. The last step of this workflow does exactly that, and the production job of `watchdog.yml` gets the same check (M8 T9). Reading secret _names_ through the GitHub API would need admin rights; this does not.
- The owner guide (section I) keeps the checklist line: "no `TURSO_PLATFORM_TOKEN_TEMP` and no `BACKUP_PRIVATE_KEY` in the GitHub `production` environment, and no restore token left at Turso".

## How to run a drill (Owner)

Build phase (staging, synthetic):

1. In the GitHub environment `staging`: add the secret `TURSO_PLATFORM_TOKEN_TEMP` (narrowest create-database scope, shortest expiry). Add the repository or environment variable `TURSO_ORG` (your Turso organisation name; optional `TURSO_GROUP`).
2. Actions, "Restore drill", Run workflow on `release`: `mode=drill`, `environment=staging`, `key=throwaway`.
3. Read the summary: `verify`, `restore`, `cohort ... NAV identical`, `delete: 2/2`, `drill: PASS`. The last step is red because the token still exists.
4. Revoke the token at Turso and delete the `TURSO_PLATFORM_TOKEN_TEMP` secret. Run the workflow again with `mode=verify-removed`: it must be green.

Real key (production, after the build-agent PAT is revoked):

1. Add `BACKUP_PRIVATE_KEY` (the offline private key text) and `TURSO_PLATFORM_TOKEN_TEMP` to the GitHub environment `production`. `TURSO_ORG` must be set as a variable.
2. Run the workflow: `mode=drill`, `environment=production`, `key=real`, `targets=both`.
3. Read the summary as above (it must say PASS and show elapsed time; RTO 4h within).
4. Delete both secrets, revoke the token at Turso, run again with `mode=verify-removed` (green). The next nightly watchdog must stay green.

Real restore: the same, with `mode=restore`, `confirm=RESTORE`; then OPS-040 steps 3 to 5.

## Local script: `restore.mjs` (GitHub-down path)

`restore.mjs` is a **local** restore script. It is run on the Owner's own computer (or by the build agent with the Owner present) when GitHub is unavailable, using the monthly offsite copy. The Owner decrypts on their own computer (owner guide, section I), then runs this script on the plaintext `.ndjson.gz`.

## Usage

```
node scripts/restore/restore.mjs --file main-<date>.ndjson.gz --db main --dry-run
node scripts/restore/restore.mjs --file main-<date>.ndjson.gz --db main
```

- `--file` the decrypted, still gzip-compressed dump (`main-<date>.ndjson.gz` or `auth-<date>.ndjson.gz`). A `.age` file is refused with a hint.
- `--db main|auth` must match the database named inside the dump.
- `--dry-run` reads the file and verifies structure, row counts and SHA-256 per table. No database is opened and no environment variable is needed.
- Environment (real run only), set in your terminal only: `RESTORE_TARGET_URL`, `RESTORE_TARGET_TOKEN` of the **new, empty** database made for this restore.

## What it checks

1. The dump verifies (`parseBackup`: structure, counts, per-table SHA-256). A changed, truncated or forged file is refused before anything is written.
2. The target is not the live database: refused when `RESTORE_TARGET_URL` equals `TURSO_MAIN_URL`, `TURSO_AUTH_URL`, `TURSO_MAIN_URL_PROD` or `TURSO_AUTH_URL_PROD` when those variables are set in the same shell (scheme, case and trailing slash are ignored).
3. The target has no user tables (refused otherwise, nothing is changed).
4. The restore is one atomic batch (`restoreDatabase` in `scripts/backup/core.mjs`); if anything fails, nothing is kept.
5. The restored database is read back and every table's row count and SHA-256 is compared with the dump.

Output is a table of table names, row counts and PASS/FAIL, then `restore: PASS ... elapsed XmYYs`. It never prints the URL, the token, a key or any row content, and driver errors are replaced by short fixed messages. Exit code 0 on PASS, 1 otherwise.

## Timing the 4-hour recovery objective (NFR-004)

The 4 hours count from when the Owner starts, not from when the script starts. Note the time you begin step 1 of the owner guide (section I) and the time you finish the final smoke test. The script prints its own elapsed time only for its part; the whole is your two timestamps.

## Limits (known, documented)

- Everything is held in memory (the same limit as the backup, see `scripts/backup/README.md`). Streaming is a later change.
- The restore sends one batch to Turso. A database much larger than the M1 sizes may need chunking; the script then fails closed (nothing written) rather than partially restoring.
- The dump format does not carry AUTOINCREMENT sequences or integers beyond 2^53 (see `core.mjs`).
- The check cohort is the simple deterministic buy-and-hold check (`cohortCheck.mjs`), not the batch 2a/2b trading engine; a stored live cohort can be injected later. It needs the `price_bar` table, so an empty main backup fails the cohort step.
- Restoring does not point the app at the new database. That is OPS-040 step 3 (owner guide, section I).

## Tests

`restore.test.mjs` (local script), `turso-platform.test.mjs` (fake fetch), `cohortCheck.test.mjs`, `drill-turso.test.mjs` (fake Platform API, local libSQL files, synthetic throwaway key) and `restore-drill.workflow.test.mjs` (parses the YAML). node:test, no network, no credentials; all part of `npm run test:smoke`.

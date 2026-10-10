# Database restore (local script)

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

Note on a spec tension: OPS-040 step 1 adds the private key to GitHub as a temporary secret, while SEC-108 f and PLT-022b say the private key is never on GitHub except temporarily for a restore or drill. This script takes the stricter reading: the key is never on GitHub, decryption is local.

## What this folder is

`restore.mjs` is a **local-only** restore script. It is run on the Owner's own computer (or by the build agent with the Owner present). **There is no restore workflow and no GitHub Action in this folder, and none is planned for the production restore**.

Why local: the backup is encrypted to the Owner's offline key, and the private key is never stored on GitHub (SEC-108 f, PLT-022b). A workflow could not decrypt it unless the key were added as a temporary secret, which this design avoids. The Owner decrypts on their own computer (owner guide, section I), then runs this script on the plaintext `.ndjson.gz`.

## The temporary Turso platform token (l)

The SEC-017 row (l) says the restore/drill workflow fails while token (l) exists and the nightly watchdog checks it is gone. This restore path **does not need token (l)**: the Owner creates the empty target database in the Turso dashboard and a database token for it, which are then revoked after use. No workflow here holds (l), and no (l) check is added by this task.

- The app cannot list GitHub environment secret names with the read token (m) (that needs admin rights), so the watchdog cannot check that (l) is absent without a new, broader credential. Not built.
- Instead, the owner guide (section I) has a checklist line: "no `TURSO_PLATFORM_TOKEN_TEMP` in the GitHub `production` environment, and no restore token left at Turso".
- The workflow-based drill (TST-108, which does use (l)) is a later task and will need the SEC-017 (l) behaviour above.

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
- Restoring does not point the app at the new database. That is OPS-040 step 3 (owner guide, section I).

## Tests

`scripts/restore/restore.test.mjs` (node:test, local temp libSQL files, no network, no credentials), part of `npm run test:smoke`.

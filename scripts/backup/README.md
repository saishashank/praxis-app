# Nightly backup and restore drill

No personal data is in this file. Spec: PLT-022, PLT-022a, PLT-022b, DAT-143, TST-108, OPS-020, OPS-040.

## What runs

| Piece                                                           | What it does                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/backup.yml`, job `production`                | Manual dispatch on `release` (the Worker dispatches it from M2). Runs `run.mjs` on the latest approved commit.                                                                                                                                                           |
| `run.mjs`                                                       | Dumps the main database, asks the signed Vercel route for the already-encrypted auth database, uploads both to the release `backup-<date>` of the private **data** repo, prunes old releases (14 daily / 8 weekly / 12 monthly), writes the run record `nightly-backup`. |
| `.github/workflows/backup.yml`, job `drill`, and the CI app job | Runs `drill.mjs`: a throwaway key pair and small synthetic databases, no secrets, no production data. Must print `drill: PASS`.                                                                                                                                          |
| `core.mjs`                                                      | The shared dump / restore / encrypt / retention code (also used by the Vercel route through `src/lib/backup/`).                                                                                                                                                          |

## The files

Each release `backup-YYYY-MM-DD` in the data repo holds two assets:

- `main-YYYY-MM-DD.ndjson.gz.age` : the main database.
- `auth-YYYY-MM-DD.ndjson.gz.age` : the auth database (users, audit log).

Each file is a gzip-compressed text file (one JSON object per line: a header, the table definitions,
the rows, and a last line with row counts and SHA-256 checksums per table), encrypted with
[age](https://age-encryption.org) to the backup **public** key. Short-lived tables that are rebuilt
by themselves (`request_nonce` in main, `rate_limit` in auth) keep their definition but no rows.

## Decrypting a backup with the offline key (OPS-020 monthly check)

Do this on your own computer, never on GitHub. The private key file (`key.txt`) stays offline.

```
age -d -i key.txt main-YYYY-MM-DD.ndjson.gz.age > main-YYYY-MM-DD.ndjson.gz
```

A successful decrypt that produces a non-empty `.gz` file is the "local decrypt-only check". To look
inside, un-gzip it (`gzip -dk main-YYYY-MM-DD.ndjson.gz`); the first line shows the database name,
schema version and table list. Delete the decrypted files when done.

## Restoring into a new database

Restoring into a new Turso database is the "Restore database" procedure (OPS-040) and its
workflow. The step-by-step guide is written later. The restore code already exists
(`restoreDatabase` in `core.mjs`): it refuses a file whose row counts or checksums do not match,
refuses a database that is not empty, and re-reads what it wrote to compare checksums again.

## Notes for the build

- The private key is never stored on GitHub (SEC-108 f). The workflow only sees `BACKUP_PUBLIC_KEY`.
- Secrets used by the production job: `TURSO_MAIN_URL_PROD`, `TURSO_MAIN_TOKEN_PROD`,
  `BACKUP_PUBLIC_KEY`, `APP_BASE_URL_PROD`, `ACTIONS_HMAC_SECRET_PROD`, `DATA_REPO_TOKEN_PROD`.
  The Vercel production project needs `BACKUP_PUBLIC_KEY` too (for the auth export).
- The data repo needs at least one commit (GitHub creates a release's tag on its default branch).
- Everything is held in memory while it runs. Streaming is a later change if the databases grow.

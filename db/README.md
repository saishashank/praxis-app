# Database migrations

Two databases, one folder each: `migrations/main` (Turso main DB) and `migrations/auth` (separate auth DB, ROL-101a).

## How it works

- Files are named `NNNN_snake_name.sql` (4-digit, contiguous from `0001`).
- Each file has a `-- +up` section and a `-- +down` section. Statements end with `;` at the end of a line; a `CREATE TRIGGER` body ends with a line that is exactly `END;`.
- The runner (`src/lib/db/migrate-core.mjs`) applies pending `up` sections in order, one transaction per file, and records each in `schema_migrations(version, name, checksum, applied_at)`. `checksum` is the SHA-256 of the whole file.
- `down(n)` rolls back the last `n` migrations (used by the up/down tests, TST-125).
- Production and staging migrate during the **Vercel build** (`npm run build` runs `node scripts/db/migrate.mjs --if-vercel`). Only Vercel holds the auth-DB token (ROL-101a), so Workers and Actions never migrate. A missing variable or any error fails the deploy. Nothing prints URLs or tokens.
- Local use: `TURSO_MAIN_URL=file:local.db node scripts/db/migrate.mjs --db main` (same for `auth` with `TURSO_AUTH_URL`).

## Rules

1. **Never edit a migration that has been applied anywhere.** The checksum check turns any edit into a hard error. Add a new file instead.
2. **Expand-only while old code may run.** The previous deployment keeps serving until the new one is live, so a migration may add tables, columns and indexes but must not drop or rename anything the previous release still uses. Removals happen in a later migration, after no running code uses them.
3. Timestamps are `TEXT` ISO-8601 UTC with milliseconds and `Z` (D-031). Booleans are `INTEGER` 0/1 with a `CHECK`.
4. No secrets in any table (SEC-103).

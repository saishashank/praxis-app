# Rolling back from V2 to V1

Applies once migrations 0015 to 0023 have reached a database. Rehearse it once on staging before production (V2 go-live step "Try the rollback once").

## What stays true

- V1 code never reads the V2 tables and the V2 changes to old tables are additive, so a V1 deployment runs correctly on a V2 database. The Worker and the workflows on `main` keep working.
- Nothing in V2 trades money on its own: every Cortex family is in shadow, so there is no position to unwind.

## Level 1: instant rollback (no build, minutes)

Use this first. In Vercel, promote the last good V1 deployment (Deployments, the V1 build, "Instant Rollback"). No build runs, so the migration step is not involved. The schema stays at 0023. Re-promote the V2 deployment to go forward again.

## Level 2: a V1 rebuild or hotfix on the V2 database

A V1 build runs `node scripts/db/migrate.mjs --if-vercel`. The V1 copy of that script stops with `applied migration 15 has no file` because the database is ahead of the V1 tree. Pick one:

1. **Tolerate the newer schema (recommended, keeps data).** Put the V2 tolerance on `main`/`release` as one small commit and set `MIGRATE_ALLOW_NEWER=1` for the Production environment in Vercel:
   - in `src/lib/db/migrate-core.mjs` take the `migrateUp(db, migrations, opts)` change from the V2 tree: versions after the tree's last file are skipped when `allowNewer` is true; a changed checksum or a missing file inside the tree still throws;
   - in `scripts/db/migrate.mjs` pass `{ allowNewer: process.env.MIGRATE_ALLOW_NEWER === "1" }` to `migrateUp`.
   - With the variable unset the old strict behaviour stays. Remove the variable when you are back on V2.
2. **Step the schema down to V1.** From a V2 checkout, with the database credentials for that database in the environment:
   - `node scripts/db/migrate.mjs --db main --down-to 14 --confirm-down`
   - It runs the `-- +down` sections of 0023 to 0015, newest first, and then the V1 tree accepts the database with no flag. Going forward again is a normal `migrate.mjs --db main`.
   - **This deletes data.** Take a backup first (the nightly backup, or run `scripts/backup` by hand and keep the file). What goes: every Cortex, intraday, steelman and experts table with its rows; 0020 also deletes every `pick_*` e-mail row and attempt (it restores the narrower `email_message` kind list); 0016 and 0017 take back the "known at" and "first seen" additions.
   - The auth database has no V2 migrations; do not run `--db auth` down.

## After a rollback

- Check System Health on the rolled-back deployment. The Worker slots `quote-poll` and `intraday-scan` call V2 routes: unlist them in System Health first if you rolled the app back (they would only fail).
- Record what you did and why in `docs/06_open_questions.md`.

## Tested

`tests/db/0023_feature_retention.test.ts` covers: an older tree failing by default and tolerating the newer database only on request; the checksum guard; `--down-to 14` from 0023 and back up to a schema identical to a fresh one; the CLI refusing `--down-to` without `--confirm-down`.

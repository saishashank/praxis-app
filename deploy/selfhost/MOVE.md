# Move checklist: the Oracle VM is gone, or must go

Operator checklist (REQ\infra\INFRA_REQUIREMENT.md §15.4). Steps marked ★ are the Owner's: they need the Owner's
accounts, password manager or registrar. Everything else is a command on the repo as it stands. The aim: Praxis
is working somewhere within the hour, and the evening jobs never stop while we decide where.

## 0. Know why you are here

One of: the dead-man email arrived, Oracle sent a notice, or the site is down. Do not wait to see whether it
comes back. Step 1 is safe in every case.

## 1. Put the cloud runtime in charge first (about 30 minutes, free)

The cloud runtime (Vercel, the Worker, Actions, Turso) is kept warm for exactly this.

1. Make sure Turso holds recent data. Restore the newest backup (bucket hourly, bucket nightly or the data
   repo copy, whichever is newest) into Turso with the "Restore database" procedure (OPS-040). The off-box
   copies are listed by `scripts/selfhost/latest-backup.mjs`.
2. Tell the cloud clock it owns the schedule, from any machine that has the repo and the Turso variables:
   `node scripts/db/migrate.mjs --db main` first (brings the schema to the current tree), then set
   `clock_owner=cloud` in the Turso `worker_state` table. On a box that still runs the self-hosted stack,
   `/srv/praxis/bin/switch.sh cloud --turso` does it.
3. Check the next evening slot ran (the Worker's own status page, or the watchdog mail).

If the old box is still alive, stop its clock first: `/srv/praxis/bin/switch.sh cloud --local` (sets
`CLOCK_ENABLED=0` and `EMAIL_LIVE=0` so the standby sends no mail, `clock_owner=cloud` in sqld, restarts). Two clocks must never both own the schedule.

## 2. Choose where to go (in this order)

| Order | Target                                                                    | Time                    | Cost                         | When                                                                          |
| ----- | ------------------------------------------------------------------------- | ----------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| 1     | Cloud runtime (step 1 above)                                              | 30 min                  | free                         | always, first                                                                 |
| 2     | A new Oracle free VM in another availability domain                       | about 1 h               | free                         | the account is fine, only the VM was reclaimed                                |
| 3     | The Owner's home PC (Docker Desktop with WSL2) behind a Cloudflare Tunnel | 1 to 2 h                | power                        | Oracle is gone and a stop-gap is needed; the home IP also helps ASX and Yahoo |
| 4     | A paid VPS in Sydney or Melbourne, 2 to 4 vCPU and 8 GB                   | about 1 h after sign-up | roughly A$10 to 30 per month | long-term home if the free tier is withdrawn                                  |

★ The Owner creates the box (Ubuntu 24.04, arm64 or amd64) and adds the agent's SSH public key. For the home PC,
the Owner also creates the tunnel.

## 3. Bring the box up

1. ★ Copy the three env files onto the new box from the password manager into `/srv/praxis/env/`:
   `web.env`, `jobs.env`, `sqld.env`, mode 600. They are never kept only on a server.
2. On the box, as root, with the release that is live in cloud (the full 40-character SHA):

   ```
   bootstrap.sh --release <sha> --domain <praxis.example.com>
   ```

   (`--skip-os-hardening` on a home PC. `GHCR_USER` and `GHCR_TOKEN` in the environment only if the images are
   private.) It hardens the host, installs Docker, lays out `/srv/praxis`, checks the env names, pulls the
   images for this CPU, starts sqld, restores the newest backup, migrates, starts web and clock with
   `CLOCK_ENABLED=0` and runs the smoke test. Safe to run again after any failure.

3. The backup key is not stored on the box. If the restore step asks for it, run it once by hand with the key
   in the environment for that one command: `BACKUP_PRIVATE_KEY=... /srv/praxis/bin/praxis restore-latest`.
4. `praxis status` shows the clock up with `enabled=false`. The site answers on the box.

## 4. Point traffic at it

1. ★ DNS: change the A record to the new box (TTL 300). For the tunnel case, point the tunnel at the box.
2. ★ Google sign-in: check the authorised redirect URL for the domain is still correct.
3. Open the site, sign in, check Home and Picks show the restored data.

## 5. Compare for one evening, then switch

1. Leave the new box with `CLOCK_ENABLED=0` and `EMAIL_LIVE=0` (shadow) and cloud as owner. Run the compare job
   for one evening (one night is enough here). The deploy check (`praxis deploy <sha>`) does the same smoke test.
2. When the numbers agree, do the cutover on the new box, in this order:
   1. `/srv/praxis/bin/switch.sh selfhost --turso` (clock_owner in Turso, cloud goes to standby)
   2. ★ the final restore into sqld (needs the backup key): `praxis restore-latest --replace` (the plain command refuses a database that already holds tables; --replace drops and recreates main and auth, and refuses unless `CLOCK_ENABLED=0`, the owner is not selfhost and no job is running)
   3. `/srv/praxis/bin/switch.sh selfhost --local --restored` (sqld owner, `EMAIL_LIVE=1`, `CLOCK_ENABLED=1`,
      restart web and clock)
   4. `praxis owner` shows `selfhost`; watch the next tick.
3. Rollback at any point: `switch.sh cloud --local`, restore Turso from the newest backup, then
   `switch.sh cloud --turso`.

## 6. Record it

Write the move into BUILD_SETUP section 9 and the decision log, and add a row to the move-drill table in
`docs/SELFHOST.md` (box, minutes, backup age, anything that failed). A failure here is a P1 fix before the
next trading week.

## Rules that keep this working

- No Oracle-specific services anywhere: a plain VM with a public IP is all the stack needs.
- Images are multi-arch; the hashed Python requirements exist for both CPUs (`deploy/selfhost/ARM64.md`).
- Three copies of the data: the box, the bucket and the data repo (plus the nightly Turso copy while self-hosted).
- The cloud runtime stays configured and its secrets stay valid. Only `clock_owner` moves.

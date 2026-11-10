# Self-hosted runtime: operator notes

Short operator doc for the self-hosted stack under `deploy/selfhost/`. The requirement lives in the
private data repo (`REQ\infra\INFRA_REQUIREMENT.md`); this file only points at it by section number.

## Monitoring (REQ §8.3, §9, §12 R3/R9)

The clock (`clock/monitor.ts`) watches the server from inside its own container. All mail goes to the
Owner address only and carries numbers, never paths, URLs or secrets.

### External dead-man check (the alarm that does not depend on the server)

1. Create one check at healthchecks.io (or an equivalent): **period 2 minutes, grace 10 minutes**,
   email notification to the Owner.
2. Put its ping URL in `DEADMAN_PING_URL` in `/srv/praxis/env/jobs.env`. Empty disables the ping and
   the clock logs one warning at start-up.
3. The clock sends `GET <url>` every 2 minutes, on the owner and on the standby clock alike, but only
   while its own tick is healthy (last tick under 3 minutes old). A killed or stuck clock goes silent.
4. Worst case from kill to email: last ping at most 2 minutes before the kill, plus the 10 minute
   grace, is 12 minutes, inside the 15 minute acceptance of task T6. (A 5 minute ping with a 15 minute
   grace, as first written in §8.3, would be 20 minutes worst case, so the cadence was tightened.)
5. `CLOCK_ENABLED=0` (maintenance) also stops the ping, so expect the mail; pause the check first.

### Host checks (every 5 minutes)

| Condition                   | Mail when                                          | Notes                                                            |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Disk                        | use of `MONITOR_DISK_PATHS` (default `JOBS_ROOT`) above 80 % | `fs.statfs`; same filesystem as the data volume on the VM         |
| Memory                      | available memory below 10 %                        | `/proc/meminfo`; skipped where it does not exist                  |
| Restarts                    | more than 3 clock starts in 1 hour                 | counted in `worker_state` key `clock_starts:selfhost`             |

One mail per condition per 6 hours while it lasts, and one recovery mail. The debounce state is
stored in the same `worker_state` row, so a restart loop cannot become a mail loop.

### Idle trend (Oracle reclamation early warning, REQ §9)

CPU, memory and network are sampled every 5 minutes into hourly means (kept 8 days in `worker_state`
key `host_trend:selfhost`, one write per hour). Every Sunday from 09:00 Sydney the 95th percentile of
the last 7 days is computed; if CPU, memory **and** network (as a share of `IDLE_NET_REF_MBPS`,
default 10 Mbit/s) are all below 25 %, the Owner gets a mail. Nothing generates synthetic load: the
answer to reclamation is to be able to move (REQ §15), not to prevent it. The latest numbers are in
`GET /health` under `host` (no secrets). Inside a container `/proc/net/dev` shows the container's own
traffic; point `HOST_NET_DEV_PATH` at a bind-mounted host file for the host's.

## Replay bridge (REQ §9)

Replay stays on GitHub Actions (12 GB heap) and keeps using Turso; sqld is never exposed.

- 23:25 Sydney: `turso-refresh` makes Turso identical to sqld (done by 00:05 at the latest, before the
  00:15 replay slot).
- 00:15: the clock dispatches `replay.yml` as before (up to 330 minutes).
- 06:00 and 23:10 Sydney: `replay-sync` copies the new rows of replay's seven result tables
  (`lineage`, `lineage_split`, `trial_ledger`, `replay_run`, `validation_result`, `label`,
  `replay_stat`) from Turso into sqld, write-once with `ON CONFLICT DO NOTHING`. It runs only while
  sqld says `clock_owner = selfhost` (exit 3 = standby, no alert). The 23:10 run saves any manual
  replay of the day before the refresh overwrites Turso.
- Source credentials reuse `TURSO_REFRESH_MAIN_URL` and `TURSO_REFRESH_MAIN_TOKEN`; Turso is only read.

## Move drill (REQ §15.5)

The weekly restore drill proves the backups. The move drill proves the whole rebuild: a fresh box to a working
Praxis from the latest backup. The checklist for a real move is `deploy/selfhost/MOVE.md`.

**Quarterly**, on the first Saturday of January, April, July and October (after replay):

1. Get a throwaway amd64 box: the Owner's PC under WSL2 with Docker, or a VPS billed by the hour.
2. Put the three env files in `/srv/praxis/env/` from the password manager. Start a timer.
3. `bootstrap.sh --release <sha of the live release> --domain <test name>`. Leave `CLOCK_ENABLED=0` and
   `EMAIL_LIVE=0`.
4. Pass means: sign-in and Home work on the restored data within 60 minutes of the timer start. Note the
   age of the backup that was restored.
5. Destroy the box. Add a row below. Any failure is a P1 fix before the next trading week.

| Date | Box | Minutes | Backup age | Failures |
|---|---|---|---|---|
| 2026-11-10 (first run) | CI proxy (not a real box): GitHub-hosted runners, images built from source, synthetic data | pending (see the Self-host check run), pending | n/a (synthetic) | pending |

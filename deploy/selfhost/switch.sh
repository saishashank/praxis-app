#!/bin/sh
# switch.sh: the automatable parts of the runtime switch (INFRA T7, REQ\infra\INFRA_REQUIREMENT.md §11.3 cutover,
# §11.4 switch back). Installed as /srv/praxis/bin/switch.sh. It NEVER touches Turso unless --turso is given, and
# it changes nothing unless a step flag is given: without flags it prints the plan.
#   switch.sh status
#   switch.sh selfhost                       print the §11.3 plan
#   switch.sh selfhost --turso               §11.3 step 2: clock_owner=selfhost in TURSO (cloud goes to standby)
#   switch.sh selfhost --local --restored    §11.3 step 4: sqld clock_owner=selfhost, EMAIL_LIVE=1, CLOCK_ENABLED=1,
#                                            restart web and clock (--restored = you did step 3, the final restore)
#   switch.sh cloud                          print the §11.4 plan
#   switch.sh cloud --local                  §11.4 step 1: CLOCK_ENABLED=0, clock_owner=cloud in sqld, restart
#   switch.sh cloud --turso                  §11.4 step 3: clock_owner=cloud in TURSO (after you restored it, step 2)
# Steps marked (YOU) are the Owner's: restores (they need the backup key, which is never stored here), DNS and the
# Vercel banner. Add --force to restart even though a job is running. No secret is printed or put on a command line.
set -eu

COMPOSE_DIR="${PRAXIS_COMPOSE_DIR:-/srv/praxis/compose}"
ENV_DIR="${PRAXIS_ENV_DIR:-/srv/praxis/env}"
PRAXIS="$(dirname "$0")/praxis"

target="${1:-}"
[ "$#" -gt 0 ] && shift
local_step=0
turso_step=0
restored=0
force=0
for a in "$@"; do
  case "$a" in
    --local) local_step=1 ;;
    --turso) turso_step=1 ;;
    --restored) restored=1 ;;
    --force) force=1 ;;
    *) echo "switch: unknown argument $a" >&2; exit 2 ;;
  esac
done

compose() {
  docker compose -p praxis-prod -f "$COMPOSE_DIR/docker-compose.prod.yml" --env-file "$COMPOSE_DIR/.env" "$@"
}

# set_env file key value: replace or append KEY=value in an env file, without printing it.
set_env() {
  f="$ENV_DIR/$1"
  [ -f "$f" ] || { echo "switch: $f not found" >&2; exit 1; }
  if grep -q "^$2=" "$f"; then sed -i "s/^$2=.*/$2=$3/" "$f"; else printf '%s=%s\n' "$2" "$3" >> "$f"; fi
}

assert_idle() {
  [ "$force" = 1 ] && return 0
  h="$(compose exec -T clock node -e "fetch('http://127.0.0.1:9100/health').then(r=>r.text()).then(t=>process.stdout.write(t))" 2>/dev/null || true)"
  case "$h" in
    *'"running":[]'*|"") return 0 ;;
    *) echo "switch: a job is running; wait for it or use --force" >&2; exit 3 ;;
  esac
}

# The env files changed, so the containers are recreated (a plain restart keeps the old environment).
recreate() { compose up -d --force-recreate --no-deps "$@"; }

# The Turso pair (TURSO_REFRESH_MAIN_*) is in the clock container's own environment (jobs.env): the values stay inside.
turso_owner() {
  compose exec -T clock sh -c 'TURSO_MAIN_URL="$TURSO_REFRESH_MAIN_URL" TURSO_MAIN_TOKEN="$TURSO_REFRESH_MAIN_TOKEN" exec node clock/cli.mjs owner '"$1"
}

case "$target" in
  status)
    "$PRAXIS" owner
    ;;
  selfhost)
    if [ "$turso_step" = 0 ] && [ "$local_step" = 0 ]; then
      cat <<'PLAN'
Cutover (§11.3). Needs the Owner's OK. Pick a weekend or a non-trading evening after 01:00 (after replay).
  1 (YOU) choose the time.
  2 switch.sh selfhost --turso              clock_owner=selfhost in Turso: the Worker and Vercel crons stand by from the next tick.
  3 (YOU) final backup of Turso, restored into sqld:   BACKUP_PRIVATE_KEY=... praxis restore-latest --replace   (data of record moves; --replace because main and auth hold shadow-week data)
  4 switch.sh selfhost --local --restored   sqld clock_owner=selfhost, EMAIL_LIVE=1, CLOCK_ENABLED=1, restart web and clock.
    (YOU) remove the shadow banner (its setting is in web.env, see env.example).
  5 (YOU) check: the next tick shows "owner" here and "standby" on the Worker (praxis owner); 08:00 morning slot; heartbeat email.
  6 (YOU) Vercel app shows the "moved" banner with the new link.
PLAN
      exit 0
    fi
    if [ "$turso_step" = 1 ]; then
      echo "switch: setting clock_owner=selfhost in Turso (§11.3 step 2)"
      turso_owner selfhost
      echo "switch: next (YOU): step 3, the final restore into sqld; then: switch.sh selfhost --local --restored"
    fi
    if [ "$local_step" = 1 ]; then
      [ "$restored" = 1 ] || { echo "switch: --local needs --restored (step 3, the final restore into sqld, must be done first)" >&2; exit 2; }
      assert_idle
      echo "switch: self-hosted side of the cutover (§11.3 step 4)"
      "$PRAXIS" owner selfhost
      set_env jobs.env EMAIL_LIVE 1
      set_env web.env EMAIL_LIVE 1
      set_env jobs.env CLOCK_ENABLED 1
      set_env web.env CLOCK_ENABLED 1
      recreate web clock
      echo "switch: done. (YOU) remove the shadow banner, check the next tick (praxis owner), then the Vercel 'moved' banner."
    fi
    ;;
  cloud)
    if [ "$turso_step" = 0 ] && [ "$local_step" = 0 ]; then
      cat <<'PLAN'
Switch back to cloud (§11.4).
  1 switch.sh cloud --local    CLOCK_ENABLED=0 on this host, clock_owner=cloud in sqld, recreate web and clock.
  2 (YOU) restore the latest sqld backup into Turso (or use last night's refresh, §8.2-3).
  3 switch.sh cloud --turso    clock_owner=cloud in Turso: the Worker resumes on its next tick.
  4 (YOU) remove the Vercel banner; users go back to the Vercel URL.
PLAN
      exit 0
    fi
    if [ "$local_step" = 1 ]; then
      assert_idle
      echo "switch: stopping the self-hosted clock (§11.4 step 1)"
      "$PRAXIS" owner cloud
      set_env jobs.env CLOCK_ENABLED 0
      set_env web.env CLOCK_ENABLED 0
      recreate web clock
    fi
    if [ "$turso_step" = 1 ]; then
      echo "switch: setting clock_owner=cloud in Turso (§11.4 step 3)"
      turso_owner cloud
    fi
    ;;
  *)
    echo "usage: switch.sh status | selfhost [--turso | --local --restored] | cloud [--local | --turso] [--force]" >&2
    exit 2
    ;;
esac

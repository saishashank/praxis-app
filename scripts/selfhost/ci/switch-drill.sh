#!/usr/bin/env bash
# Branch CI only (selfhost-check.yml, job "stack"): deploy/selfhost/switch.sh run for real against the stack that
# bootstrap.sh built, with a SECOND local sqld standing in for the cloud database ("fake-turso", on the same Docker
# network, never a turso.io address). The self-hosted side is the stack's own sqld ("local").
#   cloud to selfhost:  switch.sh selfhost --turso, then --local --restored
#   selfhost to cloud:  switch.sh cloud --local, then --turso
# Asserts clock_owner on BOTH databases after every step, that the plan-only default changes nothing (owners,
# env files and container ids), that --local without --restored is refused, and the env and clock state.
# While the self-hosted clock is "owner" for a few seconds it has no tokens and its mail provider is the mock.
set -euo pipefail

SRV=/srv/praxis
SWITCH="$SRV/bin/switch.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
SQLD_IMAGE="${SQLD_IMAGE:?SQLD_IMAGE is not set}"
JOBS_IMAGE="$(docker inspect -f '{{.Config.Image}}' praxis-prod-clock-1)"
LOCAL_URL=http://main.sqld:8080
TURSO_URL=http://fake-turso:8080
fail() { echo "::error::switch-drill: $*"; exit 1; }
ok() { echo "ok   $*"; }

# The local sqld checks tokens (JWT): the throwaway token from jobs.env is used for the read, never printed.
LOCAL_TOKEN="$(sudo sed -n 's/^TURSO_MAIN_TOKEN=//p' "$SRV/env/jobs.env" | head -n1)"
[ -n "$LOCAL_TOKEN" ] && echo "::add-mask::$LOCAL_TOKEN"

owner_of() { # owner_of <url> [token]
  docker run --rm --network praxis-prod -e OWNER_TOKEN="${2:-}" -v "$HERE/owner.mjs:/owner.mjs:ro" \
    --entrypoint node "$JOBS_IMAGE" /owner.mjs "$1"
}
local_owner() { owner_of "$LOCAL_URL" "$LOCAL_TOKEN"; }
turso_owner() { owner_of "$TURSO_URL"; }
expect() { # expect <what> <want> <got>
  [ "$2" = "$3" ] || fail "$1: want '$2', got '$3'"
}
env_value() { sudo sed -n "s/^$2=//p" "$SRV/env/$1" | head -n1; }
ids() { docker inspect -f '{{.Id}}' praxis-prod-web-1 praxis-prod-clock-1 | tr '\n' ' '; }
env_hash() { sudo sha256sum "$SRV/env/web.env" "$SRV/env/jobs.env" "$SRV/env/sqld.env" | awk '{print $1}' | tr '\n' ' '; }
clock_health() { docker exec praxis-prod-clock-1 node -e "fetch('http://127.0.0.1:9100/health').then(r=>r.text()).then(t=>process.stdout.write(t))"; }
wait_clock() { # wait_clock <enabled true|false> [owner]
  local want_enabled="$1" want_owner="${2:-}" h=""
  for _ in $(seq 1 90); do
    h="$(clock_health 2>/dev/null || true)"
    if [ -n "$h" ] && node -e "
      const h=JSON.parse(process.argv[1]);
      const okEnabled = h.enabled === ($want_enabled);
      const okOwner = '$want_owner' === '' || h.owner === '$want_owner';
      process.exit(okEnabled && okOwner ? 0 : 1)" "$h" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "last health: $h"
  fail "the clock did not reach enabled=$want_enabled owner=${want_owner:-any}"
}

# ---- the stand-in for the cloud database: its own sqld (no namespaces), main schema migrated ----------------------
docker rm -f fake-turso >/dev/null 2>&1 || true
docker run -d --name fake-turso --network praxis-prod --network-alias fake-turso -p 127.0.0.1:18080:8080 \
  --entrypoint /bin/sqld --user 666:666 "$SQLD_IMAGE" \
  --http-listen-addr=0.0.0.0:8080 --db-path=/var/lib/sqld/data.sqld >/dev/null
for _ in $(seq 1 40); do
  curl -fsS http://127.0.0.1:18080/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:18080/health >/dev/null || { docker logs fake-turso | tail -n 20; fail "fake-turso did not start"; }
docker run --rm --network praxis-prod -e TURSO_MAIN_URL="$TURSO_URL" --entrypoint node "$JOBS_IMAGE" \
  scripts/db/migrate.mjs --db main --target sqld | tail -n 2
# jobs.env must point the refresh pair at it (predeploy-ci-env.mjs --refresh-url did); never at turso.io.
case "$(env_value jobs.env TURSO_REFRESH_MAIN_URL)" in "$TURSO_URL") ;; *) fail "TURSO_REFRESH_MAIN_URL is not the local stand-in" ;; esac
ok "fake-turso is up, migrated, and is what TURSO_REFRESH_MAIN_URL points at"

# ---- start state: cloud owns the schedule everywhere (no owner key yet) ------------------------------------------------
expect "local owner at start" absent "$(local_owner)"
expect "turso owner at start" absent "$(turso_owner)"
expect "CLOCK_ENABLED (jobs.env) at start" 0 "$(env_value jobs.env CLOCK_ENABLED)"
expect "CLOCK_ENABLED (web.env) at start" 0 "$(env_value web.env CLOCK_ENABLED)"
wait_clock false

# ---- plan-only default changes nothing ---------------------------------------------------------------------------------
before_hash="$(env_hash)"; before_ids="$(ids)"
sudo "$SWITCH" selfhost | tee "${RUNNER_TEMP:-/tmp}/plan-selfhost.txt" > /dev/null
sudo "$SWITCH" cloud | tee "${RUNNER_TEMP:-/tmp}/plan-cloud.txt" > /dev/null
grep -q '^Cutover' "${RUNNER_TEMP:-/tmp}/plan-selfhost.txt" || fail "selfhost without flags did not print the cutover plan"
grep -q '^Switch back' "${RUNNER_TEMP:-/tmp}/plan-cloud.txt" || fail "cloud without flags did not print the switch-back plan"
expect "local owner after plans" absent "$(local_owner)"
expect "turso owner after plans" absent "$(turso_owner)"
expect "env files after plans" "$before_hash" "$(env_hash)"
expect "containers after plans" "$before_ids" "$(ids)"
ok "plan-only default (selfhost and cloud): nothing changed"

# ---- cloud to selfhost -------------------------------------------------------------------------------------------------
sudo "$SWITCH" selfhost --turso
expect "turso owner after selfhost --turso" selfhost "$(turso_owner)"
expect "local owner after selfhost --turso" absent "$(local_owner)"
expect "env files after selfhost --turso" "$before_hash" "$(env_hash)"
ok "selfhost --turso: clock_owner=selfhost in the cloud stand-in, local untouched"

set +e
sudo "$SWITCH" selfhost --local >/dev/null 2>&1
rc=$?
set -e
expect "exit of selfhost --local without --restored" 2 "$rc"
expect "local owner after the refused --local" absent "$(local_owner)"
expect "env files after the refused --local" "$before_hash" "$(env_hash)"
ok "selfhost --local without --restored is refused (exit 2) and changes nothing"

sudo "$SWITCH" selfhost --local --restored
expect "local owner after selfhost --local" selfhost "$(local_owner)"
expect "turso owner after selfhost --local" selfhost "$(turso_owner)"
for f in jobs.env web.env; do
  expect "CLOCK_ENABLED ($f) after selfhost --local" 1 "$(env_value "$f" CLOCK_ENABLED)"
  expect "EMAIL_LIVE ($f) after selfhost --local" 1 "$(env_value "$f" EMAIL_LIVE)"
done
[ "$(ids)" != "$before_ids" ] || fail "web and clock were not recreated"
wait_clock true selfhost
ok "selfhost --local --restored: sqld owner=selfhost, env on, containers recreated, clock ticks as owner"
echo "state: local=$(local_owner) turso=$(turso_owner)"

# ---- selfhost to cloud -------------------------------------------------------------------------------------------------
sudo "$SWITCH" cloud --local
expect "local owner after cloud --local" cloud "$(local_owner)"
expect "turso owner after cloud --local" selfhost "$(turso_owner)"
for f in jobs.env web.env; do
  expect "CLOCK_ENABLED ($f) after cloud --local" 0 "$(env_value "$f" CLOCK_ENABLED)"
done
wait_clock false
ok "cloud --local: sqld owner=cloud, CLOCK_ENABLED=0, clock disabled"

sudo "$SWITCH" cloud --turso
expect "turso owner after cloud --turso" cloud "$(turso_owner)"
expect "local owner after cloud --turso" cloud "$(local_owner)"
ok "cloud --turso: clock_owner=cloud in the cloud stand-in"

sudo "$SWITCH" status | sed 's/^/     status: /'
docker rm -f fake-turso >/dev/null
echo "switch-drill: PASS"

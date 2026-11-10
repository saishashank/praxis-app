#!/usr/bin/env bash
# Branch CI only (selfhost-check.yml, job "stack"): `praxis restore-latest --replace` on the stack bootstrap.sh built.
# There is no backup bucket in CI, so the RESTORE itself is not run here; what is proved is the part that is new and
# dangerous: the guard (CLOCK_ENABLED, owner, running jobs) and that the main and auth namespaces really are dropped
# and recreated through the admin API (which needs its key), so a following restore meets empty databases.
set -euo pipefail

SRV=/srv/praxis
PRAXIS="$SRV/bin/praxis"
HERE="$(cd "$(dirname "$0")" && pwd)"
JOBS_IMAGE="$(docker inspect -f '{{.Config.Image}}' praxis-prod-clock-1)"
fail() { echo "::error::replace-drill: $*"; exit 1; }
ok() { echo "ok   $*"; }
pc() { sudo docker compose --project-directory "$SRV/compose" -f "$SRV/compose/docker-compose.prod.yml" "$@"; }
LOCAL_TOKEN="$(sudo sed -n 's/^TURSO_MAIN_TOKEN=//p' "$SRV/env/jobs.env" | head -n1)"
[ -n "$LOCAL_TOKEN" ] && echo "::add-mask::$LOCAL_TOKEN"
owner_of() {
  docker run --rm --network praxis-prod -e OWNER_TOKEN="$LOCAL_TOKEN" -v "$HERE/owner.mjs:/owner.mjs:ro" \
    --entrypoint node "$JOBS_IMAGE" /owner.mjs http://main.sqld:8080
}
migrate() { pc run --rm --no-deps -T clock node scripts/db/migrate.mjs --db "$1" --target sqld; }

# the admin API is behind its key
code="$(docker run --rm --network praxis-prod --entrypoint node "$JOBS_IMAGE" -e "fetch('http://sqld:8081/v1/namespaces/probe/create',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))")"
case "$code" in 401|403) ok "sqld admin API without its key: HTTP $code" ;; *) fail "admin API answered $code without a key" ;; esac

# state to be erased: an owner row in main
sudo "$PRAXIS" owner cloud > /dev/null
[ "$(owner_of)" = cloud ] || fail "could not seed the marker row"

# guard 1: CLOCK_ENABLED must be 0 in the container that runs it
set +e
out="$(pc run --rm --no-deps -T -e CLOCK_ENABLED=1 clock node clock/cli.mjs restore-latest --replace 2>&1)"
rc=$?
set -e
echo "$out" | sed 's/^/     /'
[ "$rc" = 1 ] && echo "$out" | grep -q 'refused: CLOCK_ENABLED must be 0' || fail "--replace was not refused with CLOCK_ENABLED=1 (exit $rc)"
[ "$(owner_of)" = cloud ] || fail "the refused --replace changed data"
ok "refused while CLOCK_ENABLED is not 0; data untouched"

# guard 2: the owner must not be selfhost
sudo "$PRAXIS" owner selfhost > /dev/null
set +e
out="$(sudo "$PRAXIS" restore-latest --replace 2>&1)"
rc=$?
set -e
echo "$out" | sed 's/^/     /'
[ "$rc" = 1 ] && echo "$out" | grep -q 'refused: the clock owner is selfhost' || fail "--replace was not refused while the owner is selfhost (exit $rc)"
[ "$(owner_of)" = selfhost ] || fail "the refused --replace changed data"
ok "refused while the clock owner is selfhost; data untouched"

# guard 3: a running job
sudo "$PRAXIS" owner cloud > /dev/null
docker run --rm --network praxis-prod -e T="$LOCAL_TOKEN" --entrypoint node "$JOBS_IMAGE" -e "
  const h={'content-type':'application/json',authorization:'Bearer '+process.env.T};
  const now=new Date().toISOString();
  fetch('http://main.sqld:8080/v2/pipeline',{method:'POST',headers:h,body:JSON.stringify({requests:[{type:'execute',stmt:{sql:\"INSERT INTO job_run (job, status, local_date, started_at, heartbeat_at) VALUES ('ci-probe','running','2026-01-01','\"+now+\"','\"+now+\"')\"}},{type:'close'}]})}).then(r=>r.json()).then(j=>{if(j.results[0].type!=='ok'){console.log(JSON.stringify(j.results[0]).slice(0,300));process.exit(1)}})"
set +e
out="$(sudo "$PRAXIS" restore-latest --replace 2>&1)"
rc=$?
set -e
echo "$out" | sed 's/^/     /'
[ "$rc" = 1 ] && echo "$out" | grep -q 'refused: a job is running' || fail "--replace was not refused while a job runs (exit $rc)"
ok "refused while a job is running"

# the real thing: end the probe run first, then replace
docker run --rm --network praxis-prod -e T="$LOCAL_TOKEN" --entrypoint node "$JOBS_IMAGE" -e "
  const h={'content-type':'application/json',authorization:'Bearer '+process.env.T};
  fetch('http://main.sqld:8080/v2/pipeline',{method:'POST',headers:h,body:JSON.stringify({requests:[{type:'execute',stmt:{sql:\"UPDATE job_run SET status='failed' WHERE job='ci-probe'\"}},{type:'close'}]})}).then(r=>r.json()).then(j=>{if(j.results[0].type!=='ok'){console.log(JSON.stringify(j.results[0]).slice(0,300));process.exit(1)}})"
set +e
out="$(sudo "$PRAXIS" restore-latest --replace 2>&1)"
rc=$?
set -e
echo "$out" | sed 's/^/     /'
echo "$out" | grep -q 'main and auth namespaces dropped and recreated' || fail "--replace did not drop and recreate the namespaces"
[ "$rc" != 0 ] || fail "the restore cannot succeed without a backup source in CI, yet --replace exited 0"
[ "$(owner_of)" = absent ] || fail "main still holds the owner row after --replace (not emptied)"
ok "--replace dropped and recreated main and auth (the restore after it stops: no backup source in CI)"

# the empty namespaces take a fresh migration, as the restore's own second half does
migrate main | grep -E "applied [1-9][0-9]*" > /dev/null || fail "main was not empty after --replace"
migrate auth | grep -E "applied [1-9][0-9]*" > /dev/null || fail "auth was not empty after --replace"
ok "both databases migrate from scratch after --replace"
echo "replace-drill: PASS"

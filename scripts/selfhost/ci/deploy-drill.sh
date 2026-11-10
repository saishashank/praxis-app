#!/usr/bin/env bash
# Branch CI only (selfhost-check.yml, job "stack"): `praxis deploy` run for real on the stack bootstrap.sh built,
# with the images in a local registry:2 (localhost:5000) instead of GHCR. Everything is by digest:
#   1 deploy build A (the bootstrap release), 2 deploy build B, 3 `praxis deploy --rollback` (A is back),
#   4 a build that fails the pre-deploy check (prod untouched), 5 a build that PASSES the check but is unhealthy in
#   production (prod is reverted to A automatically).
# Usage: deploy-drill.sh <40-hex sha of build A>; env WEB_IMAGE and JOBS_IMAGE name the locally built images.
set -euo pipefail

SHA_A="${1:?usage: deploy-drill.sh <40-hex sha>}"
REG=localhost:5000
SRV=/srv/praxis
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB_IMAGE="${WEB_IMAGE:?}"
JOBS_IMAGE="${JOBS_IMAGE:?}"
SHA_B="$(printf 'praxis-ci-build-b' | sha1sum | cut -d' ' -f1)"
SHA_C="$(printf 'praxis-ci-build-fails-check' | sha1sum | cut -d' ' -f1)"
SHA_D="$(printf 'praxis-ci-build-unhealthy-in-prod' | sha1sum | cut -d' ' -f1)"
fail() { echo "::error::deploy-drill: $*"; exit 1; }
ok() { echo "ok   $*"; }

digest_of() { # digest_of <web|jobs> <tag>: the digest the REGISTRY reports for the tag (what a pull will record)
  curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' \
    "http://localhost:5000/v2/praxis-$1/manifests/$2" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'
}
running() { docker inspect -f '{{.Config.Image}}' "praxis-prod-$1-1"; } # image reference the container was created from
state_sha() { sudo node -e "console.log(JSON.parse(require('fs').readFileSync('$SRV/state/$1','utf8')).sha)"; }
state_digest() { sudo node -e "console.log(JSON.parse(require('fs').readFileSync('$SRV/state/$1','utf8')).$2.digest)"; }
expect() { [ "$2" = "$3" ] || fail "$1: want '$2', got '$3'"; }
wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "praxis-prod-$1-1" 2>/dev/null)" = healthy ] && return 0
    sleep 3
  done
  fail "praxis-prod-$1-1 is not healthy"
}

push() { # push <web|jobs> <local image> <tag>
  docker tag "$2" "$REG/praxis-$1:$3"
  docker push -q "$REG/praxis-$1:$3" >/dev/null
}
variant() { # variant <name> <web Dockerfile body>: a new web image on top of the built one
  local d
  d="$(mktemp -d)"
  cp "$HERE/flaky-web.cjs" "$d/"
  printf '%s\n' "$2" > "$d/Dockerfile"
  docker build -q -t "praxis-ci-web-$1" "$d" >/dev/null
  rm -rf "$d"
}

deploy() { # deploy <args...>: as root, from the local registry, no ZAP (the branch check job runs ZAP), no backup key
  sudo env PRAXIS_REGISTRY="$REG" "$SRV/bin/praxis" deploy "$@" --skip-zap --data none --no-notify
}

# ---- the builds ------------------------------------------------------------------------------------------------------
variant b "FROM $WEB_IMAGE
LABEL praxis.ci.build=b"
d="$(mktemp -d)"; printf 'FROM %s\nLABEL praxis.ci.build=b\n' "$JOBS_IMAGE" > "$d/Dockerfile"
docker build -q -t praxis-ci-jobs-b "$d" >/dev/null; rm -rf "$d"
variant c "FROM $WEB_IMAGE
CMD [\"node\",\"-e\",\"require('http').createServer((q,s)=>{s.statusCode=500;s.end('x')}).listen(3000,'0.0.0.0')\"]"
variant d "FROM $WEB_IMAGE
COPY flaky-web.cjs /ci/flaky-web.cjs
CMD [\"node\",\"/ci/flaky-web.cjs\"]"
push web "$WEB_IMAGE" "$SHA_A"; push jobs "$JOBS_IMAGE" "$SHA_A"
push web praxis-ci-web-b "$SHA_B"; push jobs praxis-ci-jobs-b "$SHA_B"
push web praxis-ci-web-c "$SHA_C"; push jobs "$JOBS_IMAGE" "$SHA_C"
push web praxis-ci-web-d "$SHA_D"; push jobs "$JOBS_IMAGE" "$SHA_D"

WA="$(digest_of web "$SHA_A")"; JA="$(digest_of jobs "$SHA_A")"
WB="$(digest_of web "$SHA_B")"; JB="$(digest_of jobs "$SHA_B")"
for v in "$WA" "$JA" "$WB" "$JB"; do case "$v" in sha256:????????????????????????????????????????????????????????????????) ;; *) fail "bad digest from the registry: '$v'" ;; esac; done
[ "$WA" != "$WB" ] && [ "$JA" != "$JB" ] || fail "builds A and B have the same digests"
echo "A web=$WA jobs=$JA"
echo "B web=$WB jobs=$JB"

assert_running() { # assert_running <label> <web digest> <jobs digest>
  expect "$1: web image" "$REG/praxis-web@$2" "$(running web)"
  expect "$1: clock image" "$REG/praxis-jobs@$3" "$(running clock)"
  wait_healthy web
  wait_healthy clock
  ok "$1: web and clock run $REG/…@${2:0:19}… / @${3:0:19}… and are healthy"
}

# ---- 1. deploy A by digest ----------------------------------------------------------------------------------------------
deploy "$SHA_A"
expect "deployed.json sha after A" "$SHA_A" "$(state_sha deployed.json)"
expect "deployed.json web digest after A" "$WA" "$(state_digest deployed.json web)"
assert_running "deploy A" "$WA" "$JA"

# ---- 2. deploy B --------------------------------------------------------------------------------------------------------
deploy "$SHA_B"
expect "deployed.json sha after B" "$SHA_B" "$(state_sha deployed.json)"
expect "deployed.prev.json sha after B" "$SHA_A" "$(state_sha deployed.prev.json)"
assert_running "deploy B" "$WB" "$JB"
sudo grep -q "^PRAXIS_WEB_IMAGE=$REG/praxis-web@$WB$" "$SRV/compose/.env" || fail "compose .env does not pin web B by digest"

# ---- 3. rollback --------------------------------------------------------------------------------------------------------
deploy --rollback
expect "deployed.json sha after rollback" "$SHA_A" "$(state_sha deployed.json)"
expect "deployed.prev.json sha after rollback" "$SHA_B" "$(state_sha deployed.prev.json)"
assert_running "rollback to A" "$WA" "$JA"

# ---- 4. a build that fails the pre-deploy check: exit 1, prod untouched -------------------------------------------------
before_id="$(docker inspect -f '{{.Id}}' praxis-prod-web-1)"
set +e
deploy "$SHA_C"
rc=$?
set -e
expect "exit code of the deploy that fails the check" 1 "$rc"
sudo grep -E 'FAIL' "$SRV/state/last-deploy.log" | sed 's/^/     /' || true
sudo grep -q 'FAIL check: web' "$SRV/state/last-deploy.log" || fail "the failure was not at the check's web step"
expect "web container id after the failed check" "$before_id" "$(docker inspect -f '{{.Id}}' praxis-prod-web-1)"
expect "deployed.json sha after the failed check" "$SHA_A" "$(state_sha deployed.json)"
assert_running "failed check leaves prod on A" "$WA" "$JA"
left="$(docker ps -a --format '{{.Names}}' | grep praxis-check || true)"
[ -z "$left" ] || fail "check containers left behind: $left"

# ---- 5. passes the check, unhealthy in prod: automatic revert ----------------------------------------------------------
set +e
deploy "$SHA_D"
rc=$?
set -e
expect "exit code of the deploy whose new web is unhealthy in prod" 1 "$rc"
sudo sed 's/^/     last-deploy: /' "$SRV/state/last-deploy.log"
sudo grep -q 'ok   check: smoke test' "$SRV/state/last-deploy.log" || fail "the flaky build did not pass the check (it must, to reach prod)"
sudo grep -q 'FAIL prod: web' "$SRV/state/last-deploy.log" || fail "the failure was not at the prod web step"
sudo grep -q 'containers put back on' "$SRV/state/last-deploy.log" || fail "no automatic revert recorded"
expect "deployed.json sha after the revert" "$SHA_A" "$(state_sha deployed.json)"
sudo grep -q "^PRAXIS_WEB_IMAGE=$REG/praxis-web@$WA$" "$SRV/compose/.env" || fail "compose .env is not back on A's digest"
assert_running "automatic revert" "$WA" "$JA"
echo "deploy-drill: PASS"

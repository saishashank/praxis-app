#!/usr/bin/env bash
# Branch CI only (selfhost-check.yml, job "stack"): the production Caddy of /srv/praxis/compose, brought up by
# bootstrap.sh with PRAXIS_DOMAIN=localhost. For a name like localhost Caddy issues its certificate from its OWN
# internal CA (no ACME, no outside network), so the repo Caddyfile and compose file run exactly as in production.
# Checks: https with that CA (root fetched from the container), the headers the Caddyfile sets, the 404 of the
# internal routes, http to https, and that web, clock and sqld are reachable only through Caddy's rules (no host
# ports, no route to sqld or the clock).
set -euo pipefail

TMP="${RUNNER_TEMP:-/tmp}"
CA="$TMP/caddy-root.crt"
CADDY=praxis-prod-caddy-1
fail() { echo "::error::caddy-check: $*"; exit 1; }
ok() { echo "ok   $*"; }

for _ in $(seq 1 30); do
  docker cp "$CADDY:/data/caddy/pki/authorities/local/root.crt" "$CA" 2>/dev/null && [ -s "$CA" ] && break
  sleep 2
done
[ -s "$CA" ] || fail "no root certificate in the caddy container (internal CA not created)"
openssl x509 -in "$CA" -noout -subject -issuer | sed 's/^/     /'

# https://localhost/ with the internal CA as the ONLY trust anchor, name resolved to the box.
tls() { curl --silent --show-error --max-time 20 --cacert "$CA" --resolve localhost:443:127.0.0.1 "$@"; }

code="$(tls -o /dev/null -w '%{http_code} %{ssl_verify_result}' https://localhost/api/health)"
[ "$code" = "200 0" ] || fail "https://localhost/api/health gave '$code' (want '200 0': 200 and a verified certificate)"
ok "https answers 200 and the certificate verifies against Caddy's internal CA"

# Without that CA the same call must NOT verify: proves the check above is not trusting everything.
if curl --silent --max-time 20 --resolve localhost:443:127.0.0.1 -o /dev/null https://localhost/api/health 2>/dev/null; then
  fail "https verified without the internal CA: the verification test proves nothing"
fi
ok "without the internal CA the connection is refused (certificate not trusted)"

hdr="$(tls -D - -o /dev/null https://localhost/signin | tr -d '\r')"
echo "$hdr" | sed 's/^/     /'
echo "$hdr" | grep -qi '^strict-transport-security: max-age=63072000; includeSubDomains$' || fail "HSTS header missing or different"
ok "Strict-Transport-Security: max-age=63072000; includeSubDomains"
if echo "$hdr" | grep -qi '^server:'; then fail "the Server header is present (Caddyfile removes it)"; fi
ok "no Server header"

# Compression is switched on in the Caddyfile (encode zstd gzip): a page body is large enough to be encoded.
enc="$(tls -D - -o /dev/null -H 'Accept-Encoding: gzip' https://localhost/signin | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ee]ncoding: //p')"
case "$enc" in gzip|zstd) ok "response compressed ($enc)" ;; *) fail "no content-encoding on /signin (got '$enc')" ;; esac

# Internal routes do not exist from outside: Caddy's own empty 404, not the app's page.
for p in /api/internal /api/internal/x /api/internal/anything/deeper; do
  out="$(tls -o "$TMP/internal.body" -w '%{http_code}' "https://localhost$p")"
  [ "$out" = 404 ] || fail "$p answered $out (want 404)"
  [ ! -s "$TMP/internal.body" ] || fail "$p answered with a body (Caddy's respond 404 is empty; this came from the app)"
done
ok "/api/internal and below: 404 with an empty body"

# http to https.
red="$(curl --silent --max-time 15 --resolve localhost:80:127.0.0.1 -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost/)"
case "$red" in "308 https://localhost/"*) ok "http redirects to https ($red)" ;; *) fail "http answered '$red'" ;; esac

# The edge does not lead to sqld or the clock: their paths reach the app (which has no such routes), never them.
for p in /v2/pipeline /v1/namespaces /health /metrics; do
  body="$(tls "https://localhost$p" || true)"
  if echo "$body" | grep -Eq '"results"|"namespaces"|"lastTick"|"runtime":"selfhost"'; then fail "$p returned sqld or clock output through Caddy"; fi
done
ok "sqld and clock paths through Caddy return nothing of theirs"
# Another Host name (the sqld namespace alias) gets no certificate and no route.
sni="$(curl --silent --insecure --max-time 10 --resolve main.sqld:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://main.sqld/health 2>/dev/null || true)"
[ "$sni" != 200 ] || fail "Host main.sqld was served through Caddy"
ok "Host main.sqld is not served (HTTP '${sni:-none}')"

# Published ports: Caddy only.
for c in web clock sqld; do
  [ -z "$(docker port "praxis-prod-$c-1")" ] || fail "praxis-prod-$c-1 publishes a host port"
done
docker port "$CADDY" | sed 's/^/     caddy: /'
ok "web, clock and sqld publish no host port; caddy publishes 80 and 443"
for port in 3000 8080 8081 9100; do
  if curl --silent --max-time 3 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then fail "port $port answers on the host"; fi
done
ok "ports 3000, 8080, 8081 and 9100 are closed on the host"
echo "caddy-check: PASS"

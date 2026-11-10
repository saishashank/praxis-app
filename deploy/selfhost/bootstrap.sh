#!/usr/bin/env bash
# bootstrap.sh: a fresh Ubuntu 24.04 box (arm64 or amd64) to a working Praxis, clock still OFF (INFRA §15.2).
#
# Usage (as root or with sudo):
#   bootstrap.sh --release <git-sha> --domain <praxis.example.com> [--repo owner/name] [--skip-os-hardening]
#                [--skip-restore]
#   --skip-restore   do not restore a backup (it needs the Owner's backup key, which is never on the box): sqld gets
#                    the migrated EMPTY schema only. For rehearsals and CI; a real move never uses it.
#   PRAXIS_IMAGE_PREFIX=<registry/path> (environment) pulls praxis-web and praxis-jobs from there instead of GHCR and
#                    pins the compose stack to the pulled digests (branch CI uses a local registry). Unset = production.
#
# Before running: put the three env files in /srv/praxis/env/ (web.env, jobs.env, sqld.env, chmod 600),
# filled from the Owner's own copy. This script only checks that the NAMES exist; it never prints a value.
# If the GHCR images are private, export GHCR_USER and GHCR_TOKEN first (read from the environment, never an argument).
#
# Every step is idempotent: running it again on a half-built box continues where it stopped.
# Restore and migrations run as one-off containers of the clock service (the clock is not up yet); the smoke test runs
# scripts/selfhost/smoke.mjs in the web image on the compose network.
set -euo pipefail

REPO="saishashank/praxis-app"
RELEASE=""
DOMAIN=""
SKIP_HARDENING=0
SKIP_RESTORE=0
BASE=/srv/praxis
ENV_DIR="$BASE/env"
COMPOSE_DIR="$BASE/compose"
BIN_DIR="$BASE/bin"
# Optional pin for the Docker packages (INFRA §15.2 step 2). TODO pin: set a tested version string,
# e.g. DOCKER_APT_VERSION="5:<version>-1~ubuntu.24.04~noble", at the first real install.
DOCKER_APT_VERSION="${DOCKER_APT_VERSION:-}"

log() { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] WARNING: %s\n' "$*" >&2; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --skip-os-hardening) SKIP_HARDENING=1; shift ;;
    --skip-restore) SKIP_RESTORE=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage 2 ;;
  esac
done

[[ "$RELEASE" =~ ^[0-9a-f]{40}$ ]] || die "--release must be a full 40-character git SHA"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "--domain must be a host name"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be owner/name"
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
log "release ${RELEASE:0:12}, domain $DOMAIN, architecture $ARCH"

IMAGE_PREFIX="ghcr.io/${REPO%%/*}"
# Registry owners are lower-case.
IMAGE_PREFIX="$(printf '%s' "$IMAGE_PREFIX" | tr '[:upper:]' '[:lower:]')"
# Rehearsal only: another registry (branch CI). Default = GHCR, unchanged.
LOCAL_REGISTRY=0
if [ -n "${PRAXIS_IMAGE_PREFIX:-}" ]; then
  [[ "$PRAXIS_IMAGE_PREFIX" =~ ^[a-z0-9][a-z0-9.:/_-]*$ ]] || die "PRAXIS_IMAGE_PREFIX is not a registry path"
  IMAGE_PREFIX="$PRAXIS_IMAGE_PREFIX"
  LOCAL_REGISTRY=1
  warn "PRAXIS_IMAGE_PREFIX is set: images come from $IMAGE_PREFIX, not GHCR (rehearsal)"
fi

# ---------------------------------------------------------------- 1. OS hardening
step_os() {
  log "1/8 OS hardening"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends ca-certificates curl gnupg ufw fail2ban unattended-upgrades jq nodejs

  timedatectl set-timezone UTC || warn "could not set timezone (not systemd?)"

  if [ "$SKIP_HARDENING" -eq 1 ]; then
    warn "--skip-os-hardening: SSH and firewall settings left as they are"
    return
  fi

  # Key-only SSH, but only when a key is installed for root or the sudo user, so we never lock ourselves out.
  local have_key=0 f
  for f in /root/.ssh/authorized_keys "/home/${SUDO_USER:-nobody}/.ssh/authorized_keys"; do
    if [ -s "$f" ]; then have_key=1; fi
  done
  if [ "$have_key" -eq 1 ]; then
    mkdir -p /etc/ssh/sshd_config.d
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' \
      >/etc/ssh/sshd_config.d/99-praxis.conf
    sshd -t && systemctl reload ssh || warn "sshd reload failed; check /etc/ssh/sshd_config.d/99-praxis.conf"
  else
    warn "no SSH authorized_keys found; password login NOT disabled"
  fi

  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  # Docker publishes ports around ufw; only caddy publishes anything (80/443), see docker-compose.prod.yml.

  systemctl enable --now fail2ban
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
    >/etc/apt/apt.conf.d/20auto-upgrades

  if ! swapon --show --noheadings | grep -q .; then
    if [ ! -f /swapfile ]; then
      fallocate -l 4G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
  fi
}

# ---------------------------------------------------------------- 2. Docker
step_docker() {
  log "2/8 Docker Engine + compose plugin"
  if docker compose version >/dev/null 2>&1; then
    log "docker already installed: $(docker --version)"
    return
  fi
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  if [ -n "$DOCKER_APT_VERSION" ]; then
    apt-get install -y "docker-ce=$DOCKER_APT_VERSION" "docker-ce-cli=$DOCKER_APT_VERSION" containerd.io docker-compose-plugin
  else
    warn "DOCKER_APT_VERSION not set: installing the current Docker release (TODO pin a version)"
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi
  systemctl enable --now docker
}

# ---------------------------------------------------------------- 3. layout + files from the repo
fetch_file() { # fetch_file <repo path> <dest> <required|optional> <mode>
  local src="$1" dest="$2" need="$3" mode="$4" url tmp
  url="https://raw.githubusercontent.com/${REPO}/${RELEASE}/${src}"
  tmp="$(mktemp)"
  if curl -fsSL --retry 3 -o "$tmp" "$url"; then
    install -m "$mode" "$tmp" "$dest"
  elif [ "$need" = required ]; then
    rm -f "$tmp"; die "could not fetch $src at ${RELEASE:0:12}"
  else
    warn "optional file not in this release yet: $src"
  fi
  rm -f "$tmp"
}

step_layout() {
  log "3/8 host layout and compose files"
  mkdir -p "$COMPOSE_DIR" "$ENV_DIR" "$BIN_DIR" "$BASE/sqld" "$BASE/check" "$BASE/jobs"
  chmod 700 "$ENV_DIR"
  # The jobs and web containers run as uid 10001; sqld runs as uid 666.
  chown 10001:10001 "$BASE/jobs"
  # sqld runs as uid 666 (the image's own user) directly, without the image wrapper that chowns (compose file).
  chown 666:666 "$BASE/sqld"
  fetch_file deploy/selfhost/docker-compose.prod.yml "$COMPOSE_DIR/docker-compose.prod.yml" required 0644
  fetch_file deploy/selfhost/docker-compose.check.yml "$COMPOSE_DIR/docker-compose.check.yml" required 0644
  fetch_file deploy/selfhost/Caddyfile "$COMPOSE_DIR/Caddyfile" required 0644
  fetch_file deploy/selfhost/env.example "$COMPOSE_DIR/env.example" required 0644
  fetch_file deploy/selfhost/bin/praxis "$BIN_DIR/praxis" optional 0755
  fetch_file deploy/selfhost/deploy.sh "$BIN_DIR/deploy.sh" optional 0755
  fetch_file deploy/selfhost/switch.sh "$BIN_DIR/switch.sh" optional 0755
  # praxis deploy runs these with the host node (deploy.sh falls back to the jobs image when one is missing).
  fetch_file scripts/selfhost/predeploy.mjs "$BIN_DIR/predeploy.mjs" optional 0644
  fetch_file scripts/selfhost/smoke.mjs "$BIN_DIR/smoke.mjs" optional 0644
  fetch_file scripts/selfhost/predeploy-copy.mjs "$BIN_DIR/predeploy-copy.mjs" optional 0644
  fetch_file deploy/selfhost/backup-now.sh "$BIN_DIR/backup-now.sh" optional 0755
  # Non-secret compose variables. PRAXIS_SHA is rewritten with the digest in step 5.
  {
    printf 'PRAXIS_SHA=%s\n' "$RELEASE"
    printf 'PRAXIS_DOMAIN=%s\n' "$DOMAIN"
  } >"$COMPOSE_DIR/.env"
  chmod 644 "$COMPOSE_DIR/.env"
}

# ---------------------------------------------------------------- 4. env file names
# Reads a section of env.example (between BEGIN/END markers) and prints its names.
section_names() {
  awk -v s="$1" '
    $0 == "# ===== BEGIN " s " =====" {on=1; next}
    $0 == "# ===== END " s " =====" {on=0}
    on && /^[A-Z][A-Z0-9_]*=/ {sub(/=.*/, ""); print}
  ' "$COMPOSE_DIR/env.example"
}

step_env() {
  log "4/8 env files (names only)"
  local f name missing=0 empty=()
  for f in web jobs sqld; do
    local path="$ENV_DIR/$f.env"
    [ -f "$path" ] || { printf '  missing file: %s\n' "$path" >&2; missing=1; continue; }
    chmod 600 "$path"
    while read -r name; do
      if ! grep -q "^${name}=" "$path"; then
        printf '  %s.env: missing name %s\n' "$f" "$name" >&2; missing=1
      elif [ -z "$(sed -n "s/^${name}=//p" "$path" | head -n1 | tr -d ' "'"'")" ]; then
        empty+=("$f.env:$name")
      fi
    done < <(section_names "$f.env")
  done
  [ "$missing" -eq 0 ] || die "env files are incomplete; fill them from $COMPOSE_DIR/env.example (names listed above)"
  if [ "${#empty[@]}" -gt 0 ]; then
    warn "names present but empty (fine if intentionally blank): ${empty[*]}"
  fi
  # The clock stays off until the Owner switches (INFRA §6). Compare only; the value is never printed.
  local v
  for f in web jobs; do
    v="$(sed -n 's/^CLOCK_ENABLED=//p' "$ENV_DIR/$f.env" | head -n1 | tr -d ' "'"'")"
    [ "$v" = "0" ] || die "CLOCK_ENABLED in $f.env must be 0 for bootstrap; switch on later with: praxis owner selfhost"
  done
}

# ---------------------------------------------------------------- 5. images by digest
step_images() {
  log "5/8 pull images for $ARCH and pin their digests"
  if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
  fi
  local img digest web_ref="" jobs_ref=""
  for img in praxis-web praxis-jobs; do
    docker pull --platform "linux/$ARCH" "$IMAGE_PREFIX/$img:$RELEASE" >/dev/null \
      || die "cannot pull $IMAGE_PREFIX/$img:$RELEASE for linux/$ARCH (not built yet, wrong arch, or private: set GHCR_USER and GHCR_TOKEN)"
    [ "$(docker image inspect --format '{{.Architecture}}' "$IMAGE_PREFIX/$img:$RELEASE")" = "$ARCH" ] \
      || die "$img came back with the wrong architecture"
    digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE_PREFIX/$img:$RELEASE" | sed 's/.*@//')"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not read the digest of $img"
    log "$img @ $digest"
    if [ "$img" = praxis-web ]; then web_ref="$IMAGE_PREFIX/$img@$digest"; else jobs_ref="$IMAGE_PREFIX/$img@$digest"; fi
  done
  if [ "$LOCAL_REGISTRY" -eq 1 ]; then
    # The compose file names ghcr.io images: point it at the pulled digests (same variables deploy.sh uses).
    {
      printf 'PRAXIS_WEB_IMAGE=%s\n' "$web_ref"
      printf 'PRAXIS_JOBS_IMAGE=%s\n' "$jobs_ref"
    } >>"$COMPOSE_DIR/.env"
  fi
  # Compose uses the SHA tag; the digests are logged above for the record. deploy.sh (T5) verifies them on later deploys.
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.prod.yml" pull sqld caddy
}

compose() { docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.prod.yml" "$@"; }

need_cli() {
  [ -x "$BIN_DIR/praxis" ] || die "$BIN_DIR/praxis is not in release ${RELEASE:0:12} (built in a later task); cannot continue"
}

# ---------------------------------------------------------------- 6. database
# One-off containers of the clock service (jobs image, jobs.env): the clock itself is not running yet, and neither
# restore-latest nor the migrations need it.
run_jobs() { compose run --rm --no-deps -T "$@"; }

step_database() {
  log "6/8 sqld, restore latest backup, migrations, checks"
  need_cli
  compose up -d --wait --wait-timeout 180 sqld
  if [ "$SKIP_RESTORE" -eq 1 ]; then
    warn "--skip-restore: no backup restored; sqld holds only the migrated empty schema"
    run_jobs clock node scripts/db/migrate.mjs --db main --target sqld
    run_jobs clock node scripts/db/migrate.mjs --db auth --target sqld
  else
    # newest of: bucket hourly, bucket nightly, data repo nightly; verifies row counts and FK check, then migrates.
    # BACKUP_PRIVATE_KEY comes from the caller's environment for this one command and is never stored.
    run_jobs -e BACKUP_PRIVATE_KEY clock node clock/cli.mjs restore-latest
  fi
}

# ---------------------------------------------------------------- 7. web + clock (standby) + smoke
smoke() {
  [ -f "$BIN_DIR/smoke.mjs" ] || die "$BIN_DIR/smoke.mjs is not in release ${RELEASE:0:12}; cannot run the smoke test"
  local web_ref
  web_ref="$(compose config --images | grep 'praxis-web' | head -n1)"
  [ -n "$web_ref" ] || die "could not read the web image from the compose file"
  local pass=()
  [ -n "${SMOKE_SESSION_COOKIE:-}" ] && pass=(-e SMOKE_SESSION_COOKIE)
  docker run --rm --network praxis-prod --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint node "${pass[@]}" -v "$BIN_DIR/smoke.mjs:/smoke.mjs:ro" "$web_ref" /smoke.mjs http://web:3000
}

step_start() {
  log "7/8 start web, clock (standby) and caddy, then smoke test"
  need_cli
  compose up -d --wait --wait-timeout 300 web clock caddy
  smoke
}

# ---------------------------------------------------------------- 8. next steps
step_next() {
  log "8/8 done. The clock is still OFF. Next, by hand:"
  cat <<EOF
  1. DNS: point an A record for $DOMAIN at this box's public IP (TTL 300 s).
  2. Google OAuth client: add https://$DOMAIN/api/auth/callback/google as a redirect URL.
  3. When satisfied (side-by-side week, INFRA §11.2): $BIN_DIR/praxis owner selfhost
EOF
}

step_os
step_docker
step_layout
step_env
step_images
step_database
step_start
step_next
log "finished in $((SECONDS / 60)) min $((SECONDS % 60)) s (from the start of this script)"

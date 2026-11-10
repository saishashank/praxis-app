#!/bin/sh
# deploy.sh: `praxis deploy <sha>` on the host (INFRA T7, REQ\infra\INFRA_REQUIREMENT.md §10). A thin wrapper:
# the whole flow (pull by digest, pre-deploy check on a throwaway copy, snapshot, migrate, restart, record, prune)
# is scripts/selfhost/predeploy.mjs, which is tested with a fake docker. Installed next to it in /srv/praxis/bin/:
# predeploy.mjs, smoke.mjs and predeploy-copy.mjs (bootstrap.sh copies them; if one is missing this script takes
# all missing ones from the praxis-jobs image of the SHA being deployed).
#   praxis deploy <40-hex sha> [--wait] [--no-pull] [--skip-zap] [--data auto|backup|snapshot|none]
#   praxis deploy --rollback [--skip-check] [--wait]
# Last night's backup is used for the check when BACKUP_PRIVATE_KEY is in the caller's environment (never stored on
# the server); otherwise the check uses a live snapshot of prod and says so. SMOKE_SESSION_COOKIE (optional) makes
# the smoke test sign in. Exit: 0 deployed, 1 check or deploy failed (prod untouched when the check failed),
# 2 usage, 3 refused because a job is running (--wait polls up to 30 minutes).
set -eu

BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${PRAXIS_REGISTRY:-ghcr.io/saishashank}"

command -v docker >/dev/null 2>&1 || { echo "deploy: docker is not installed" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "deploy: node (18 or newer) is needed on the host to run the deploy flow" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "deploy: node 18 or newer is needed" >&2; exit 1; }

FILES="predeploy.mjs smoke.mjs predeploy-copy.mjs"
missing=""
for f in $FILES; do [ -f "$BIN_DIR/$f" ] || missing="$missing $f"; done

if [ -n "$missing" ]; then
  sha=""
  for a in "$@"; do
    case "$a" in -*) ;; *) sha="$a"; break ;; esac
  done
  case "$sha" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) echo "deploy: missing in $BIN_DIR:$missing (copy them from scripts/selfhost/ of the repo)" >&2; exit 2 ;;
  esac
  echo "deploy: taking$missing from the praxis-jobs image of $sha (not in $BIN_DIR)"
  docker pull "$REGISTRY/praxis-jobs:$sha" >/dev/null
  cid="$(docker create "$REGISTRY/praxis-jobs:$sha")"
  trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
  for f in $missing; do
    docker cp "$cid:/app/scripts/selfhost/$f" "$BIN_DIR/$f"
  done
fi

# Not `exec`: the EXIT trap above (removes the scratch container) must still run.
node "$BIN_DIR/predeploy.mjs" "$@"

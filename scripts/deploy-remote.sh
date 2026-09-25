#!/bin/bash
# Build a release on this machine (the laptop), copy it to the farm host over
# SSH and deploy it there. Replaces rsyncing the working tree.
#
#   scripts/deploy-remote.sh [options] <user@host>
#   scripts/deploy-remote.sh fidelity@100.119.132.42
#   scripts/deploy-remote.sh --migrate fidelity@100.119.132.42   # one-time: flat ~/phone-farm -> releases
#
# The host runs the deploy.sh (and migrate-to-releases.sh) shipped INSIDE the
# tarball being deployed, so the deploy logic always matches the release.
#
# Options:
#   --tarball FILE        deploy an existing tarball (e.g. a GitHub release asset) instead of building
#   --version NAME        passed to release.sh
#   --migrate             run scripts/migrate-to-releases.sh --yes on the host first, then deploy
#                         with --install-agents
#   --remote-root DIR     farm root on the host, relative to its home (default phone-farm)
#   --remote-path PATH    PATH prefix for the non-interactive SSH shell
#                         (default /opt/homebrew/bin:/usr/local/bin — where node lives)
#   any other --flag      passed through to deploy.sh (--install-agents, --restart-wda MODE,
#                         --force, --no-restart)
#
# SSH options come from ~/.ssh/config; PHONE_FARM_SSH_OPTS adds more.
set -euo pipefail

TARBALL="" VERSION="" MIGRATE=0 HOST="" REMOTE_ROOT=phone-farm
REMOTE_PATH=${PHONE_FARM_REMOTE_PATH:-/opt/homebrew/bin:/usr/local/bin}
DEPLOY_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --tarball) TARBALL=${2:?}; shift ;;
        --version) VERSION=${2:?}; shift ;;
        --migrate) MIGRATE=1 ;;
        --remote-root) REMOTE_ROOT=${2:?}; shift ;;
        --remote-path) REMOTE_PATH=${2:?}; shift ;;
        --restart-wda) DEPLOY_ARGS+=("$1" "${2:?}"); shift ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        --*) DEPLOY_ARGS+=("$1") ;;
        *) HOST=$1 ;;
    esac
    shift
done
[ -n "$HOST" ] || { echo "usage: deploy-remote.sh [options] <user@host>" >&2; exit 64; }
[[ "$REMOTE_ROOT" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "unsafe --remote-root" >&2; exit 64; }
[ "$MIGRATE" = 1 ] && DEPLOY_ARGS+=(--install-agents)

# shellcheck disable=SC2206
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=30 ${PHONE_FARM_SSH_OPTS:-})

if [ -z "$TARBALL" ]; then
    RELEASE_ARGS=()
    [ -n "$VERSION" ] && RELEASE_ARGS+=(--version "$VERSION")
    TARBALL=$("$(dirname "${BASH_SOURCE[0]}")/release.sh" "${RELEASE_ARGS[@]+"${RELEASE_ARGS[@]}"}" | tail -n 1)
fi
[ -f "$TARBALL" ] || { echo "no tarball at $TARBALL" >&2; exit 1; }
NAME=$(basename "$TARBALL" .tgz)
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "unsafe tarball name $NAME" >&2; exit 1; }
[ -f "$TARBALL.sha256" ] || (cd "$(dirname "$TARBALL")" && shasum -a 256 "$NAME.tgz" > "$NAME.tgz.sha256")

echo "deploy-remote: copying $NAME.tgz to $HOST:$REMOTE_ROOT/incoming/" >&2
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $REMOTE_ROOT/incoming"
scp "${SSH_OPTS[@]}" -q "$TARBALL" "$TARBALL.sha256" "$HOST:$REMOTE_ROOT/incoming/"

# The remote script: verify, pull scripts/ out of the tarball, run them.
# Arguments are shell-quoted for the remote login shell, which splits them again.
ssh "${SSH_OPTS[@]}" "$HOST" "bash -s -- $(printf '%q ' "$REMOTE_ROOT" "$NAME" "$MIGRATE" "$REMOTE_PATH" "${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}")" <<'REMOTE'
set -euo pipefail
case "$1" in /*) root=$1 ;; *) root=$HOME/$1 ;; esac
name=$2 migrate=$3 path_prefix=$4; shift 4
export PATH="$path_prefix:$PATH" PHONE_FARM_ROOT="$root"
command -v node >/dev/null || { echo "node not found on PATH ($PATH); pass --remote-path" >&2; exit 1; }
tarball=$root/incoming/$name.tgz
(cd "$root/incoming" && shasum -a 256 -c "$name.tgz.sha256" >/dev/null) || { echo "checksum mismatch after copy" >&2; exit 1; }
tools=$(mktemp -d "${TMPDIR:-/tmp}/phone-farm-deploy.XXXXXX")
trap 'rm -rf "$tools"' EXIT
top=$(tar -tzf "$tarball" | awk -F/ 'NR == 1 { print $1 }')  # awk reads it all: no SIGPIPE under pipefail
tar -xzf "$tarball" -C "$tools" "$top/scripts"
if [ "$migrate" = 1 ]; then
    "$tools/$top/scripts/migrate-to-releases.sh" --yes
fi
"$tools/$top/scripts/deploy.sh" "$@" "$tarball"
REMOTE

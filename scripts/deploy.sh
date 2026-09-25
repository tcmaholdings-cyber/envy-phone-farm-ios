#!/bin/bash
# Deploy a release on the farm host. Runs ON the host, as the farm user.
#
#   scripts/deploy.sh [options] <phone-farm-<version>.tgz | release-id>
#
# Steps (each safe to re-run; a second run of the same release is a no-op):
#   1. unpack the tarball to ~/phone-farm/releases/<id>/ (verifying <tgz>.sha256 if present)
#   2. link host state from ~/phone-farm/shared/ (.env, .env.devices, devices.json,
#      .wda, .appium2, .scheduler-data, logs, backups)
#   3. install dependencies: reuse the live release's node_modules when the lockfile
#      and Node ABI match, otherwise `npm ci` (dev dependencies included — see below)
#   4. reinstall the Appium driver when its pinned version changed
#   5. smoke check: `npm run deploy:smoke` imports the app with the host's .env and
#      devices.json without starting anything
#   6. `npm run db:migrate` (migrations must stay compatible with the previous release)
#   7. write RELEASED, flip current -> releases/<id> atomically
#   8. restart: web -> health -> worker drains -> wda-service/appium if their code
#      changed -> /health/ready; any failure flips back to the previous release
#   9. keep the newest 5 releases (plus current and any still in use)
#
# Dev dependencies are installed on purpose: tsx (the runtime loader every
# process starts with), typescript (`npm run web` recompiles the browser assets)
# and appium (the appium agent) are devDependencies, so `npm ci --omit=dev`
# would leave a host that cannot start.
#
# Options:
#   --install-agents      after the flip, (re)install the launchd agents from this
#                         release instead of restarting them (first deploy after
#                         scripts/migrate-to-releases.sh, or after an installer change)
#   --restart-wda MODE    auto (default: only when src/devices, src/types.ts, Patches or
#                         the lockfile changed) | always | never
#   --no-restart          flip only; restart the agents yourself
#   --skip-ready          do not gate on GET /health/ready (Appium or a phone-side check is down
#                         for reasons this deploy cannot fix); /health must still report the release
#   --force               re-activate even if this release is already current
#
# Environment: PHONE_FARM_ROOT (~/phone-farm), PHONE_FARM_LAUNCHD_PREFIX (com.phone-farm),
# PHONE_FARM_KEEP_RELEASES (5), PHONE_FARM_HEALTH_TIMEOUT (120 s),
# PHONE_FARM_WORKER_STOP_TIMEOUT (the worker's WORKER_DRAIN_SECONDS + WORKER_KILL_GRACE_SECONDS
# + 30 s), PHONE_FARM_HEALTH_URL (from WEB_HOST/WEB_PORT).
#
# Exit: 0 live and healthy · 1 failed before the flip (nothing changed) ·
#       2 unhealthy, rolled back to the previous release · 3 rollback unhealthy too.
set -euo pipefail
SCRIPT_NAME=deploy
# shellcheck source=lib/release-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/release-common.sh"

INSTALL_AGENTS=0 NO_RESTART=0 SKIP_READY=0 FORCE=0 RESTART_WDA=auto RESTART_APPIUM=0 INPUT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --install-agents) INSTALL_AGENTS=1 ;;
        --no-restart) NO_RESTART=1 ;;
        --skip-ready) SKIP_READY=1 ;;
        --force) FORCE=1 ;;
        --restart-wda) RESTART_WDA=${2:?--restart-wda needs auto|always|never}; shift ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        -*) die "unknown option $1" ;;
        *) INPUT=$1 ;;
    esac
    shift
done
case "$RESTART_WDA" in auto|always|never) ;; *) die "--restart-wda must be auto, always or never" ;; esac
[ -n "$INPUT" ] || die "usage: deploy.sh [options] <tarball.tgz | release-id>"
export RESTART_WDA NO_RESTART SKIP_READY

[ -d "$SHARED" ] && [ -L "$CURRENT" ] || die "$ROOT is not in the release layout; run scripts/migrate-to-releases.sh first"
[ -f "$SHARED/.env" ] || die "$SHARED/.env is missing"
mkdir -p "$RELEASES" "$SHARED/logs"
acquire_lock

valid_id () { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; }

# ---- 1. unpack -------------------------------------------------------------
unpack () {
    local tarball=$1 incoming top id
    if [ -f "$tarball.sha256" ]; then
        (cd "$(dirname "$tarball")" && shasum -a 256 -c "$(basename "$tarball").sha256" >/dev/null) \
            || die "checksum mismatch for $tarball"
        log "checksum ok for $(basename "$tarball")"
    fi
    # grep without -q: an early exit would SIGPIPE tar and pipefail would hide the match.
    if tar -tzf "$tarball" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then die "$tarball contains unsafe paths"; fi
    incoming="$RELEASES/.incoming.$$"
    rm -rf "$incoming"; mkdir -p "$incoming"
    tar -xzf "$tarball" -C "$incoming"
    top=$(ls -1A "$incoming")
    [ "$(echo "$top" | wc -l | tr -d ' ')" = 1 ] && [ -f "$incoming/$top/RELEASE.json" ] \
        || { rm -rf "$incoming"; die "$tarball is not a phone-farm release (no <dir>/RELEASE.json)"; }
    id=$(json_field "$incoming/$top/RELEASE.json" id)
    valid_id "$id" || { rm -rf "$incoming"; die "RELEASE.json has an invalid id '$id'"; }
    if [ -f "$RELEASES/$id/.ready" ]; then
        log "release $id is already unpacked and installed"
        rm -rf "$incoming"
    else
        [ "$id" = "$(current_id)" ] && die "release $id is current but incomplete; refusing to replace it"
        rm -rf "${RELEASES:?}/$id"
        mv "$incoming/$top" "$RELEASES/$id"
        rm -rf "$incoming"
        log "unpacked $(basename "$tarball") -> releases/$id"
    fi
    RELEASE_ID=$id
}

# ---- 3. dependencies -------------------------------------------------------
node_abi () { node -p 'process.versions.modules + "-" + process.arch'; }

install_deps () {
    local dir=$1 live=$2 abi built
    abi=$(node_abi)
    if [ -d "$dir/node_modules" ]; then
        # .node-abi from an earlier attempt, else what release.sh --with-node-modules recorded
        built=$(cat "$dir/.node-abi" 2>/dev/null || json_field "$dir/RELEASE.json" nodeAbi)
        if [ "$built" = "$abi" ]; then
            log "node_modules already present for $abi"
            echo "$abi" > "$dir/.node-abi"; return
        fi
        log "node_modules were built for '${built:-unknown}', this host is $abi; reinstalling"
    fi
    rm -rf "$dir/node_modules"
    if [ -n "$live" ] && [ -d "$RELEASES/$live/node_modules" ] \
        && cmp -s "$RELEASES/$live/package-lock.json" "$dir/package-lock.json" \
        && [ "$(cat "$RELEASES/$live/.node-abi" 2>/dev/null)" = "$abi" ]; then
        log "lockfile unchanged; cloning node_modules from $live"
        cp -Rc "$RELEASES/$live/node_modules" "$dir/node_modules" 2>/dev/null \
            || cp -R "$RELEASES/$live/node_modules" "$dir/node_modules"
    else
        log "npm ci in releases/$(basename "$dir") (dev dependencies included: tsx, typescript, appium run on the host)"
        (cd "$dir" && npm ci --no-audit --no-fund)
    fi
    echo "$abi" > "$dir/.node-abi"
}

# ---- 4. appium driver ------------------------------------------------------
script_of () { node -e 'try { process.stdout.write(require(process.argv[1]).scripts?.[process.argv[2]] ?? "") } catch {}' "$1/package.json" "$2"; }
appium_version () { json_field "$1/node_modules/appium/package.json" version; }

sync_appium () {
    local dir=$1 live=$2
    [ -n "$live" ] && [ -d "$RELEASES/$live" ] || return 0
    if [ "$(script_of "$dir" appium:install-driver)" != "$(script_of "$RELEASES/$live" appium:install-driver)" ]; then
        log "pinned Appium driver changed; npm run appium:install-driver"
        (cd "$dir" && npm run appium:install-driver)
        RESTART_APPIUM=1
    fi
    if [ "$(appium_version "$dir")" != "$(appium_version "$RELEASES/$live")" ]; then RESTART_APPIUM=1; fi
    if [ "$RESTART_APPIUM" = 1 ]; then log "appium will be restarted"; fi
}

# ---- main ------------------------------------------------------------------
LIVE=$(current_id)
if [ -f "$INPUT" ]; then
    unpack "$INPUT"
elif valid_id "$INPUT" && [ -d "$RELEASES/$INPUT" ]; then
    RELEASE_ID=$INPUT
else
    die "$INPUT is neither a tarball nor a release in $RELEASES"
fi
DIR="$RELEASES/$RELEASE_ID"

if [ "$RELEASE_ID" = "$LIVE" ] && [ "$FORCE" = 0 ]; then
    log "release $RELEASE_ID is already current; checking health only (use --force to re-activate)"
    wait_healthy "$RELEASE_ID" && wait_ready && exit 0
    exit 2
fi

if [ ! -f "$DIR/.ready" ]; then
    link_shared "$DIR"
    install_deps "$DIR" "$LIVE"
    sync_appium "$DIR" "$LIVE"
    log "smoke check"
    (cd "$DIR" && npm run --silent deploy:smoke) || die "smoke check failed for $RELEASE_ID; current is still ${LIVE:-unset}"
    touch "$DIR/.ready"
else
    link_shared "$DIR"   # idempotent; repairs links if shared items were added
    sync_appium "$DIR" "$LIVE"
fi
export RESTART_APPIUM

log "database migrations"
(cd "$DIR" && npm run --silent db:migrate) || die "migrations failed; current is still ${LIVE:-unset}"

if [ "$INSTALL_AGENTS" = 1 ]; then
    write_released "$RELEASE_ID"
    flip_current "$RELEASE_ID"
    log "installing launchd agents from releases/$RELEASE_ID"
    PHONE_FARM_ROOT="$ROOT" PHONE_FARM_LAUNCHD_PREFIX="$PREFIX" "$DIR/deploy/launchd/install-agents.sh"
    if wait_healthy "$RELEASE_ID" && wait_ready; then OK=1; else OK=0; fi
else
    if activate "$RELEASE_ID" "$LIVE"; then OK=1; else OK=0; fi
fi

if [ "$OK" = 1 ]; then
    log "release $RELEASE_ID is live"
    install_tools "$DIR/scripts"
    prune_releases
    if [ -d "$ROOT/incoming" ]; then
        # shellcheck disable=SC2012
        ls -1t "$ROOT/incoming"/*.tgz 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
    fi
    exit 0
fi

if [ -z "$LIVE" ] || [ ! -d "$RELEASES/$LIVE" ]; then
    log "release $RELEASE_ID is unhealthy and there is no previous release to return to"
    exit 3
fi
log "release $RELEASE_ID is unhealthy; rolling back to $LIVE"
RESTART_WDA=auto
if activate "$LIVE" "$RELEASE_ID" "$RELEASE_ID"; then
    log "rolled back to $LIVE; $RELEASE_ID stays in releases/ for inspection"
    exit 2
fi
log "rollback to $LIVE is unhealthy too — check $SHARED/logs/*.log"
exit 3

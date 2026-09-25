#!/bin/bash
# Return the farm host to an earlier release. Runs ON the host, as the farm user.
#
#   scripts/rollback.sh              # the release that was live before the current one
#   scripts/rollback.sh <release-id> # a specific release still in ~/phone-farm/releases
#   scripts/rollback.sh --list       # releases on disk, newest first, current marked
#
# Re-points current, rewrites RELEASED (with rolledBackFrom), restarts web ->
# worker (drained) -> wda-service if its code differs, and checks /health.
# Database migrations are NOT reversed: releases must keep the schema backward
# compatible for exactly this reason (docs/deploy.md).
#
# Options: --restart-wda auto|always|never (default auto), --no-restart, --skip-ready.
# Exit: 0 healthy on the target release · 1 bad arguments / no target · 2 unhealthy.
set -euo pipefail
SCRIPT_NAME=rollback
# shellcheck source=lib/release-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/release-common.sh"

TARGET="" RESTART_WDA=auto NO_RESTART=0 SKIP_READY=0 LIST=0
while [ $# -gt 0 ]; do
    case "$1" in
        --list) LIST=1 ;;
        --no-restart) NO_RESTART=1 ;;
        --skip-ready) SKIP_READY=1 ;;
        --restart-wda) RESTART_WDA=${2:?--restart-wda needs auto|always|never}; shift ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        -*) die "unknown option $1" ;;
        *) TARGET=$1 ;;
    esac
    shift
done
export RESTART_WDA NO_RESTART SKIP_READY RESTART_APPIUM=0

[ -L "$CURRENT" ] || die "$CURRENT is not a symlink; is this host in the release layout?"
LIVE=$(current_id)

if [ "$LIST" = 1 ]; then
    # shellcheck disable=SC2045
    for id in $(ls -1t "$RELEASES"); do
        case "$id" in .*) continue ;; esac
        mark=" "; [ "$id" = "$LIVE" ] && mark="*"
        ready="ready"; [ -f "$RELEASES/$id/.ready" ] || ready="incomplete"
        printf '%s %-24s %-10s %s\n' "$mark" "$id" "$ready" "$(json_field "$RELEASES/$id/RELEASE.json" subject)"
    done
    exit 0
fi

acquire_lock

if [ -z "$TARGET" ]; then
    # The newest entry in the activation history that is not current and is
    # still installed on disk.
    if [ -f "$HISTORY" ]; then
        while read -r id; do
            if [ -n "$id" ] && [ "$id" != "$LIVE" ] && [ -f "$RELEASES/$id/.ready" ]; then TARGET=$id; fi
        done < "$HISTORY"
    fi
    [ -n "$TARGET" ] || die "no earlier release to roll back to (see --list)"
fi
[ "$TARGET" != "$LIVE" ] || die "release $TARGET is already current"
[ -d "$RELEASES/$TARGET" ] || die "release $TARGET is not in $RELEASES (see --list)"
[ -f "$RELEASES/$TARGET/.ready" ] || die "release $TARGET never finished installing; deploy it instead"

link_shared "$RELEASES/$TARGET"
log "rolling back $LIVE -> $TARGET"
if activate "$TARGET" "$LIVE" "$LIVE"; then
    log "release $TARGET is live"
    exit 0
fi
log "release $TARGET is unhealthy after rollback — check $SHARED/logs/*.log; 'scripts/rollback.sh $LIVE' returns to where you were"
exit 2

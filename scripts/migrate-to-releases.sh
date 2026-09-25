#!/bin/bash
# One-time conversion of a flat ~/phone-farm checkout into the release layout.
# Runs ON the host, as the farm user, from anywhere (it does not need to live
# inside ~/phone-farm).
#
#   scripts/migrate-to-releases.sh [--dry-run] [--yes] [--no-agents] [--skip-db-backup]
#
#   before                         after
#   ~/phone-farm/                  ~/phone-farm/
#     src/ node_modules/ ...         current -> releases/<id>
#     .env .env.devices              releases/<id>/   the same code + node_modules, moved
#     devices.json .wda/ .appium2/   shared/          .env .env.devices devices.json .wda/
#     .scheduler-data/ logs/                          .appium2/ .scheduler-data/ logs/ backups/
#                                    .env, devices.json, .wda, logs, ... -> shared/...
#                                                     (compatibility links, so absolute paths such as
#                                                      WDA_XCTESTRUN=~/phone-farm/.wda/... keep working)
#
# Nothing is copied except into the backup: state is moved (same volume, so
# instant) and linked. <id> is the checkout's 12-character git sha, or
# initial-<timestamp> for an rsynced tree without .git.
#
# Steps:
#   1. back up the host state to ~/phone-farm-backups/migrate-<timestamp>/ (0700):
#      state.tgz (.env*, devices.json, .wda, .scheduler-data, backups; .appium2 and logs are
#      moved but not archived — the driver reinstalls with npm run appium:install-driver),
#      pg.sql.gz (pg_dump through docker compose, if it is running), the launchd plists
#      and a listing of the tree
#   2. stop the web, worker, wda-service and appium agents (db and anything else are left alone)
#   3. move host state into shared/, everything else into releases/<id>/, link them
#   4. write RELEASE.json/RELEASED, point current at the release
#   5. reinstall the launchd agents from current and wait for /health
#
# Safe to re-run: a finished migration is detected and left alone; an interrupted
# one resumes from where it stopped (.migrating records the release id and backup).
#
#   --dry-run          print what would happen; change nothing
#   --yes              do not ask for confirmation
#   --no-agents        do not stop or reinstall launchd agents (do it yourself)
#   --skip-db-backup   do not attempt pg_dump
set -euo pipefail
SCRIPT_NAME=migrate
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=lib/release-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/release-common.sh"

DRY=0 YES=0 AGENTS=1 DB_BACKUP=1
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1 ;;
        --yes) YES=1 ;;
        --no-agents) AGENTS=0 ;;
        --skip-db-backup) DB_BACKUP=0 ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option $1" ;;
    esac
    shift
done

JOURNAL="$ROOT/.migrating"
BACKUP_ROOT=${PHONE_FARM_BACKUP_DIR:-$HOME/phone-farm-backups}
# Entries of the root that are layout, not checkout content.
LAYOUT=(shared releases current incoming bin .migrating .history .deploy.lock .current.tmp)

run () { if [ "$DRY" = 1 ]; then echo "  would: $*" >&2; else "$@"; fi; }
is_layout () { local e; for e in "${LAYOUT[@]}"; do [ "$1" = "$e" ] && return 0; done; return 1; }
is_shared () { local e; for e in "${SHARED_ITEMS[@]}"; do [ "$1" = "$e" ] && return 0; done; return 1; }

[ "$(id -u)" != 0 ] || die "run as the farm user, not root (launchd agents live in that user's GUI session)"
[ -d "$ROOT" ] || die "$ROOT does not exist"

if [ -L "$CURRENT" ] && [ ! -f "$JOURNAL" ]; then
    log "$ROOT is already in the release layout (current -> $(readlink "$CURRENT")); nothing to do"
    exit 0
fi

if [ -f "$JOURNAL" ]; then
    ID=$(sed -n 's/^id=//p' "$JOURNAL"); BACKUP=$(sed -n 's/^backup=//p' "$JOURNAL")
    log "resuming an interrupted migration to releases/$ID"
else
    [ -f "$ROOT/package.json" ] || die "$ROOT/package.json not found: this is not a phone-farm checkout"
    if git -C "$ROOT" rev-parse --verify -q HEAD >/dev/null 2>&1 && [ "$(git -C "$ROOT" rev-parse --show-toplevel)" = "$(cd "$ROOT" && pwd -P)" ]; then
        SHA=$(git -C "$ROOT" rev-parse HEAD); ID=${SHA:0:12}
        SUBJECT=$(git -C "$ROOT" log -1 --format=%s)
    else
        SHA="" ID="initial-$(date +%Y%m%d%H%M)" SUBJECT="flat checkout migrated $(date +%F)"
    fi
    BACKUP="$BACKUP_ROOT/migrate-$(date +%Y%m%d-%H%M%S)"
fi
RELEASE="$RELEASES/$ID"

cat >&2 <<EOF
Migrating $ROOT to the release layout
  release:  releases/$ID
  backup:   $BACKUP
  agents:   $([ "$AGENTS" = 1 ] && echo "stop web/worker/wda-service/appium ($PREFIX.*), reinstall from current" || echo "left alone (--no-agents)")
  The worker gets its drain window (WORKER_DRAIN_SECONDS) to finish running tasks,
  then longer ones are stopped: pick a quiet moment.
EOF
if [ "$DRY" = 0 ] && [ "$YES" = 0 ]; then
    read -r -p "Continue? [y/N] " answer
    [ "$answer" = y ] || [ "$answer" = Y ] || die "aborted"
fi

if [ "$DRY" = 0 ] && [ ! -f "$JOURNAL" ]; then
    printf 'id=%s\nbackup=%s\nsha=%s\nsubject=%s\n' "$ID" "$BACKUP" "${SHA:-}" "${SUBJECT:-}" > "$JOURNAL"
fi

# ---- 1. backup ------------------------------------------------------------
if [ -f "$BACKUP/.complete" ]; then
    log "backup already taken at $BACKUP"
else
    log "backing up host state to $BACKUP"
    run mkdir -p "$BACKUP"
    run chmod 700 "$BACKUP_ROOT" "$BACKUP"
    items=()
    for item in .env .env.devices devices.json .wda .scheduler-data backups; do
        # The real item may still be at the root or, on a resumed run, already in shared/.
        if [ -e "$ROOT/$item" ] && [ ! -L "$ROOT/$item" ]; then items+=("$ROOT/$item")
        elif [ -e "$SHARED/$item" ]; then items+=("$SHARED/$item"); fi
    done
    if [ "${#items[@]}" -gt 0 ]; then
        # shellcheck disable=SC2016
        run bash -c 'umask 077; tar -czf "$0" "$@"' "$BACKUP/state.tgz" "${items[@]}"
    fi
    if [ "$DRY" = 0 ]; then
        ls -laR "$ROOT" 2>/dev/null | head -n 20000 > "$BACKUP/tree.txt" || true
        mkdir -p "$BACKUP/LaunchAgents"
        cp -p "$HOME/Library/LaunchAgents/$PREFIX".*.plist "$BACKUP/LaunchAgents/" 2>/dev/null || true
    fi
    if [ "$DB_BACKUP" = 1 ] && command -v docker >/dev/null 2>&1 && [ -f "$ROOT/docker-compose.yml" ]; then
        envfile="$ROOT/.env"; [ -f "$envfile" ] && [ ! -L "$envfile" ] || envfile="$SHARED/.env"
        user=$(sed -n 's/^POSTGRES_USER=//p' "$envfile" 2>/dev/null | tail -n 1)
        db=$(sed -n 's/^POSTGRES_DB=//p' "$envfile" 2>/dev/null | tail -n 1)
        if [ "$DRY" = 1 ]; then
            echo "  would: pg_dump ${db:-phone_farm} > $BACKUP/pg.sql.gz" >&2
        elif (cd "$ROOT" && docker compose exec -T postgres pg_dump -U "${user:-phone_farm}" "${db:-phone_farm}") 2>/dev/null | gzip > "$BACKUP/pg.sql.gz" \
            && [ "$(gzip -dc "$BACKUP/pg.sql.gz" | wc -c | tr -d ' ')" -gt 0 ]; then
            chmod 600 "$BACKUP/pg.sql.gz"; log "database dumped to $BACKUP/pg.sql.gz"
        else
            rm -f "$BACKUP/pg.sql.gz"
            log "WARNING: no database dump (docker compose Postgres not reachable); back it up yourself if it matters"
        fi
    fi
    run touch "$BACKUP/.complete"
fi

# ---- 2. stop agents -------------------------------------------------------
if [ "$AGENTS" = 1 ]; then
    for name in web worker wda-service appium; do
        if agent_loaded "$name"; then
            log "stopping $PREFIX.$name"
            run launchctl bootout "$GUI_DOMAIN/$PREFIX.$name" || true
        fi
    done
fi

# ---- 3. move --------------------------------------------------------------
run mkdir -p "$SHARED" "$RELEASE"
run chmod 700 "$SHARED"
for item in "${SHARED_ITEMS[@]}"; do
    src="$ROOT/$item"
    [ -e "$src" ] || [ -L "$src" ] || continue
    [ -L "$src" ] && continue                       # already a compatibility link
    [ ! -e "$SHARED/$item" ] || die "both $src and $SHARED/$item exist; resolve by hand (backup: $BACKUP)"
    log "moving $item -> shared/"
    run mv "$src" "$SHARED/$item"
done
shopt -s nullglob dotglob
for src in "$ROOT"/*; do
    entry=$(basename "$src")
    is_layout "$entry" && continue
    if is_shared "$entry"; then continue; fi       # moved above, or a compatibility link
    [ ! -e "$RELEASE/$entry" ] || die "both $src and $RELEASE/$entry exist; resolve by hand"
    run mv "$src" "$RELEASE/$entry"
done
shopt -u nullglob dotglob
log "checkout moved to releases/$ID"

if [ "$DRY" = 1 ]; then
    echo "  would: link shared state into releases/$ID, write RELEASE.json, point current at it, add compatibility links" >&2
    [ "$AGENTS" = 1 ] && echo "  would: reinstall agents with $CURRENT/deploy/launchd/install-agents.sh and wait for /health" >&2
    exit 0
fi

# ---- 4. link + activate ---------------------------------------------------
link_shared "$RELEASE"
chmod 600 "$SHARED/.env" "$SHARED/.env.devices" "$SHARED/devices.json" 2>/dev/null || true
if [ ! -f "$RELEASE/RELEASE.json" ]; then
    node -e '
        const [file, id, sha, subject] = process.argv.slice(1);
        require("fs").writeFileSync(file, JSON.stringify({ id, sha: sha || null, version: null, subject,
            builtAt: new Date().toISOString(), migratedFrom: "flat checkout" }, null, 2) + "\n");
    ' "$RELEASE/RELEASE.json" "$ID" "$(sed -n 's/^sha=//p' "$JOURNAL")" "$(sed -n 's/^subject=//p' "$JOURNAL")"
fi
# It was the running code, installed for this Node: record that so the first
# deploy can reuse node_modules when the lockfile has not changed.
[ -d "$RELEASE/node_modules" ] && node -p 'process.versions.modules + "-" + process.arch' > "$RELEASE/.node-abi"
touch "$RELEASE/.ready"
write_released "$ID"
[ "$(current_id)" = "$ID" ] || flip_current "$ID"

for item in "${SHARED_ITEMS[@]}"; do
    [ -e "$ROOT/$item" ] || [ -L "$ROOT/$item" ] || ln -s "shared/$item" "$ROOT/$item"
done
# Run from inside the old checkout, this script moved with it into the release.
[ -d "$SCRIPT_DIR" ] || SCRIPT_DIR="$RELEASE/scripts"
install_tools "$SCRIPT_DIR"
rm -f "$JOURNAL"
log "layout ready: current -> releases/$ID"

# ---- 5. agents ------------------------------------------------------------
if [ "$AGENTS" = 1 ]; then
    installer="$CURRENT/deploy/launchd/install-agents.sh"
    if [ -x "$installer" ] || [ -f "$installer" ]; then
        log "reinstalling launchd agents from current"
        PHONE_FARM_ROOT="$ROOT" PHONE_FARM_LAUNCHD_PREFIX="$PREFIX" bash "$installer"
        # The pre-release code may not report a release id; any 200 is enough here.
        base=$(health_base); deadline=$(( $(date +%s) + HEALTH_TIMEOUT )); up=0
        while [ "$(date +%s)" -lt "$deadline" ]; do
            if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/health" 2>/dev/null || true)" = 200 ]; then up=1; break; fi
            sleep 2
        done
        if [ "$up" = 1 ]; then log "$base/health is up"
        else log "WARNING: $base/health did not answer within ${HEALTH_TIMEOUT}s; check $SHARED/logs/web.log"; fi
    else
        log "WARNING: $installer not found; install the agents yourself"
    fi
fi

# ---- notes ----------------------------------------------------------------
if grep -q "$ROOT/" "$SHARED/.env" 2>/dev/null; then
    log "note: .env has absolute paths under $ROOT/ (e.g. WDA_XCTESTRUN); they resolve through the compatibility links"
fi
# Other agents (a tunnel, custom tooling) that still run from the flat root.
for plist in "$HOME/Library/LaunchAgents"/*.plist; do
    [ -f "$plist" ] || continue
    case "$(basename "$plist")" in "$PREFIX".web.plist|"$PREFIX".worker.plist|"$PREFIX".wda-service.plist|"$PREFIX".appium.plist|"$PREFIX".db.plist) continue ;; esac
    if grep -F "$ROOT" "$plist" | grep -vF "$ROOT/current" | grep -vF "$ROOT/shared" >/dev/null; then
        log "note: $(basename "$plist") refers to $ROOT directly; point it at $CURRENT if it runs code from the checkout"
    fi
done
if command -v docker >/dev/null 2>&1; then
    volumes=$(docker volume ls -q 2>/dev/null | grep postgres || true)
    if [ -n "$volumes" ] && ! echo "$volumes" | grep -x 'phone-farm_phone-farm-postgres' >/dev/null; then
        log "WARNING: no docker volume phone-farm_phone-farm-postgres; set COMPOSE_PROJECT_NAME in $SHARED/.env to the old project (volumes: $(echo "$volumes" | tr '\n' ' '))"
    fi
fi
log "done. Next: deploy a release with scripts/deploy.sh --install-agents <tarball> (or scripts/deploy-remote.sh --migrate from the laptop)"

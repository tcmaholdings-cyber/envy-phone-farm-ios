# shellcheck shell=bash
# Shared by deploy.sh, rollback.sh and migrate-to-releases.sh. Source it; do not run it.
#
# Host layout (PHONE_FARM_ROOT, default ~/phone-farm):
#   current -> releases/<id>     the live release; launchd agents run from here
#   releases/<id>/               one unpacked release (code + node_modules)
#   shared/                      host state that survives every deploy
#   .history                     release ids in activation order (newest last)
#   .deploy.lock/                held while a deploy or rollback runs
#
# Every name in SHARED_ITEMS is a symlink in each release pointing into shared/.

ROOT=${PHONE_FARM_ROOT:-$HOME/phone-farm}
SHARED="$ROOT/shared"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
HISTORY="$ROOT/.history"
LOCK_DIR="$ROOT/.deploy.lock"
PREFIX=${PHONE_FARM_LAUNCHD_PREFIX:-com.phone-farm}
KEEP_RELEASES=${PHONE_FARM_KEEP_RELEASES:-5}
HEALTH_TIMEOUT=${PHONE_FARM_HEALTH_TIMEOUT:-120}
GUI_DOMAIN="gui/$(id -u)"

# Files and directories that belong to the host, not to a release.
SHARED_FILES=(.env .env.devices devices.json)
SHARED_DIRS=(.wda .appium2 .scheduler-data logs backups)
SHARED_ITEMS=("${SHARED_FILES[@]}" "${SHARED_DIRS[@]}")

# Source paths whose change means the WebDriverAgent supervisor must restart
# (its import closure: src/devices/** and src/types.ts, plus the WDA patches).
WDA_SERVICE_PATHS=(src/devices src/types.ts Patches package-lock.json)

log () {
    local line
    line="$(date -u +%Y-%m-%dT%H:%M:%SZ) ${SCRIPT_NAME:-release}: $*"
    echo "$line" >&2
    if [ -d "$SHARED/logs" ]; then echo "$line" >> "$SHARED/logs/deploy.log" 2>/dev/null || true; fi
}

die () { log "ERROR: $*"; exit 1; }

acquire_lock () {
    mkdir -p "$ROOT"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ > "$LOCK_DIR/pid"
    else
        local holder
        holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
        if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
            die "another deploy or rollback is running (pid $holder)"
        fi
        log "removing a stale lock left by pid ${holder:-unknown}"
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR" && echo $$ > "$LOCK_DIR/pid"
    fi
    trap release_lock EXIT
}

release_lock () { rm -rf "$LOCK_DIR"; }

# Release id the current symlink points at, or empty.
current_id () {
    [ -L "$CURRENT" ] || return 0
    basename "$(readlink "$CURRENT")"
}

# JSON field from a file: json_field <file> <key>
json_field () {
    node -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v !== undefined && v !== null) process.stdout.write(String(v)); } catch {}' "$1" "$2"
}

# Last value of KEY in shared/.env (quotes stripped), or empty.
env_value () {
    [ -f "$SHARED/.env" ] || return 0
    sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SHARED/.env" | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//' -e 's/[[:space:]]*$//'
}

# Link every shared item into a release. Refuses a release that ships host state.
link_shared () {
    local release=$1 item
    mkdir -p "$SHARED"
    for item in "${SHARED_DIRS[@]}"; do mkdir -p "$SHARED/$item"; done
    chmod 700 "$SHARED" "$SHARED/.wda" 2>/dev/null || true
    for item in "${SHARED_ITEMS[@]}"; do
        if [ -e "$release/$item" ] && [ ! -L "$release/$item" ]; then
            die "$release/$item is a real file in the release; host state must live in $SHARED"
        fi
        ln -sfn "../../shared/$item" "$release/$item"
    done
}

# Atomically point current at releases/<id> (rename(2) over the old link).
flip_current () {
    local id=$1
    [ -d "$RELEASES/$id" ] || die "release $id does not exist"
    ln -sfn "releases/$id" "$ROOT/.current.tmp"
    node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$ROOT/.current.tmp" "$CURRENT"
    touch "$RELEASES/$id"
    echo "$id" >> "$HISTORY"
    log "current -> releases/$id"
}

# RELEASED is what GET /health reports as "release" (read from the process's
# working directory, i.e. the release). write_released <id> [rolled-back-from]
write_released () {
    local id=$1 from=${2:-}
    node -e '
        const fs = require("fs");
        const [dir, id, from] = process.argv.slice(1);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(dir + "/RELEASE.json", "utf8")); } catch {}
        const out = { id, sha: meta.sha ?? null, version: meta.version ?? null, subject: meta.subject ?? null,
            builtAt: meta.builtAt ?? null, deployedAt: new Date().toISOString() };
        if (from) out.rolledBackFrom = from;
        fs.writeFileSync(dir + "/RELEASED.tmp", JSON.stringify(out, null, 2) + "\n");
        fs.renameSync(dir + "/RELEASED.tmp", dir + "/RELEASED");
    ' "$RELEASES/$id" "$id" "$from"
}

agent_loaded () { launchctl print "$GUI_DOMAIN/$PREFIX.$1" >/dev/null 2>&1; }

agent_pid () {
    launchctl list "$PREFIX.$1" 2>/dev/null | sed -n 's/^[[:space:]]*"PID" = \([0-9][0-9]*\);.*/\1/p'
}

kickstart () {
    local name=$1
    if ! agent_loaded "$name"; then log "agent $PREFIX.$name is not loaded; skipping restart"; return 0; fi
    launchctl kickstart -k "$GUI_DOMAIN/$PREFIX.$name" && log "restarted $PREFIX.$name"
}

# How long to wait for a SIGTERMed worker to exit by itself before forcing it:
# PHONE_FARM_WORKER_STOP_TIMEOUT, else the worker's own drain window
# (WORKER_DRAIN_SECONDS, default 120) + its task kill grace
# (WORKER_KILL_GRACE_SECONDS, default 15) + 30 s, read from shared/.env.
worker_stop_timeout () {
    if [ -n "${PHONE_FARM_WORKER_STOP_TIMEOUT:-}" ]; then echo "$PHONE_FARM_WORKER_STOP_TIMEOUT"; return; fi
    local drain grace
    drain=$(env_value WORKER_DRAIN_SECONDS); grace=$(env_value WORKER_KILL_GRACE_SECONDS)
    [[ "$drain" =~ ^[0-9]+$ ]] || drain=120
    [[ "$grace" =~ ^[0-9]+$ ]] || grace=15
    echo $((drain + grace + 30))
}

# Stop the worker with SIGTERM: it stops taking jobs, lets running tasks finish
# for its drain window, then exits; launchd (KeepAlive) starts it again from the
# new current. Falls back to kickstart -k after worker_stop_timeout.
restart_worker () {
    local pid waited=0 limit
    limit=$(worker_stop_timeout)
    if ! agent_loaded worker; then log "agent $PREFIX.worker is not loaded; skipping restart"; return 0; fi
    pid=$(agent_pid worker)
    if [ -z "$pid" ]; then kickstart worker; return; fi
    log "draining worker (pid $pid, up to ${limit}s)"
    launchctl kill SIGTERM "$GUI_DOMAIN/$PREFIX.worker" || true
    while kill -0 "$pid" 2>/dev/null; do
        if [ "$waited" -ge "$limit" ]; then
            log "worker still running after ${limit}s; forcing restart"
            launchctl kickstart -k "$GUI_DOMAIN/$PREFIX.worker"
            return 0
        fi
        sleep 2; waited=$((waited + 2))
    done
    log "worker drained after ${waited}s; launchd restarts it from current"
    # KeepAlive respawns within ThrottleInterval; make sure it is up.
    sleep 1
    [ -n "$(agent_pid worker)" ] || launchctl kickstart "$GUI_DOMAIN/$PREFIX.worker" 2>/dev/null || true
}

# Does the WebDriverAgent supervisor's code differ between two releases?
wda_service_changed () {
    local from=$1 to=$2 path
    [ -n "$from" ] && [ -d "$RELEASES/$from" ] || return 0
    for path in "${WDA_SERVICE_PATHS[@]}"; do
        if [ -e "$RELEASES/$from/$path" ] || [ -e "$RELEASES/$to/$path" ]; then
            diff -rq "$RELEASES/$from/$path" "$RELEASES/$to/$path" >/dev/null 2>&1 || return 0
        fi
    done
    return 1
}

health_base () {
    if [ -n "${PHONE_FARM_HEALTH_URL:-}" ]; then echo "${PHONE_FARM_HEALTH_URL%/}"; return; fi
    local host port
    host=$(env_value WEB_HOST); port=$(env_value WEB_PORT)
    case "$host" in ''|0.0.0.0|::|'[::]') host=127.0.0.1 ;; esac
    case "$host" in *:*) host="[$host]" ;; esac
    echo "http://$host:${port:-3000}"
}

# GET url -> prints "<status> <body-file>"
http_get () {
    local body
    body=$(mktemp "${TMPDIR:-/tmp}/pf-health.XXXXXX")
    local code
    code=$(curl -sS -o "$body" -w '%{http_code}' --max-time 5 "$1" 2>/dev/null) || code=000
    echo "$code $body"
}

# Wait until /health answers 200 from the new code. GET /health reports
# {"release": "<sha>"}, the sha field of the RELEASED file in the process's
# working directory, so a match proves the restarted web runs release <id>.
# A release without a sha (the flat checkout migrate-to-releases.sh wrapped)
# only needs the 200.
wait_healthy () {
    local id=$1 base deadline code body reported expected
    base=$(health_base)
    expected=$(json_field "$RELEASES/$id/RELEASED" sha | tr '[:upper:]' '[:lower:]')
    deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while :; do
        read -r code body < <(http_get "$base/health")
        reported=""
        [ "$code" = 200 ] && reported=$(node -e 'try { const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (typeof b.release === "string") process.stdout.write(b.release.toLowerCase()); } catch {}' "$body")
        rm -f "$body"
        if [ "$code" = 200 ] && { [ -z "$expected" ] || [ "$reported" = "$expected" ]; }; then
            log "$base/health is up on $id${expected:+ ($expected)}"; return 0
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            log "$base/health not healthy on $id after ${HEALTH_TIMEOUT}s (last: HTTP $code, release '${reported}', expected '${expected}')"
            return 1
        fi
        sleep 2
    done
}

# GET /health/ready must answer 200: Postgres, Appium, the wda-service socket
# and a worker heartbeat no older than 60 s. It answers 503 while the restarted
# worker has not written its first heartbeat (~15 s), so poll for the whole
# HEALTH_TIMEOUT. A 404 means a build from before the readiness route (e.g. a
# rollback target) and is accepted. SKIP_READY=1 (--skip-ready) skips the gate,
# for when Appium or a phone-side dependency is down for reasons a deploy cannot fix.
wait_ready () {
    local base deadline code body
    if [ "${SKIP_READY:-0}" = 1 ]; then log "readiness gate skipped (--skip-ready)"; return 0; fi
    base=$(health_base)
    deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while :; do
        read -r code body < <(http_get "$base/health/ready")
        case "$code" in
            200) rm -f "$body"; log "$base/health/ready ok"; return 0 ;;
            404) rm -f "$body"; log "$base/health/ready not present in this build; skipped"; return 0 ;;
            401|403) rm -f "$body"; log "$base/health/ready needs auth (HTTP $code); skipped"; return 0 ;;
        esac
        if [ "$(date +%s)" -ge "$deadline" ]; then
            # The body names each failing check with a fixed reason (no secrets).
            log "$base/health/ready not ready after ${HEALTH_TIMEOUT}s (last: HTTP $code $(head -c 600 "$body" | tr '\n' ' '))"
            rm -f "$body"
            return 1
        fi
        rm -f "$body"
        sleep 3
    done
}

# Switch to a release and restart what runs it, in this order:
#   web (proves the release boots) -> worker drains and stops -> wda-service /
#   appium (only when their code changed) -> worker comes back last.
# activate <id> <previous-id> [rolled-back-from]; returns 1 if unhealthy.
activate () {
    local id=$1 previous=$2 from=${3:-}
    write_released "$id" "$from"
    flip_current "$id"
    [ "${NO_RESTART:-0}" = 1 ] && { log "--no-restart: agents not restarted"; return 0; }
    kickstart web
    wait_healthy "$id" || return 1
    restart_worker
    case "${RESTART_WDA:-auto}" in
        always) kickstart wda-service ;;
        never) log "wda-service left running (--restart-wda never)" ;;
        *) if wda_service_changed "$previous" "$id"; then kickstart wda-service; else log "wda-service code unchanged; left running"; fi ;;
    esac
    [ "${RESTART_APPIUM:-0}" = 1 ] && kickstart appium
    wait_ready || return 1
}

# Copy deploy.sh, rollback.sh and this library to <root>/bin so they stay
# usable whatever current points at (a rollback target may predate them).
# install_tools <scripts-dir>
install_tools () {
    local src=$1 file
    [ -f "$src/rollback.sh" ] && [ -f "$src/lib/release-common.sh" ] || return 0
    mkdir -p "$ROOT/bin/lib"
    for file in deploy.sh rollback.sh lib/release-common.sh; do
        cp "$src/$file" "$ROOT/bin/$file.tmp" && mv -f "$ROOT/bin/$file.tmp" "$ROOT/bin/$file"
    done
    chmod +x "$ROOT/bin/deploy.sh" "$ROOT/bin/rollback.sh"
}

# Release ids some running node process still uses as its working directory.
releases_in_use () {
    command -v lsof >/dev/null 2>&1 || return 0
    lsof -a -d cwd -c node -Fn 2>/dev/null | sed -n "s|^n$RELEASES/\([^/]*\).*|\1|p" | sort -u
}

# Keep the newest KEEP_RELEASES (by activation time), current, and any in use.
prune_releases () {
    local keep_list current in_use id count=0
    current=$(current_id)
    in_use=$(releases_in_use | tr '\n' ' ')
    keep_list=" $current $in_use "
    # shellcheck disable=SC2045
    for id in $(ls -1t "$RELEASES" 2>/dev/null); do
        [ -d "$RELEASES/$id" ] || continue
        case "$id" in .*) continue ;; esac
        count=$((count + 1))
        if [ "$count" -le "$KEEP_RELEASES" ] || [[ "$keep_list" == *" $id "* ]]; then continue; fi
        log "pruning release $id"
        rm -rf "${RELEASES:?}/$id"
    done
}

#!/bin/bash
# Install (or refresh) launchd *agents* for the always-on farm host.
#
#   deploy/launchd/install-agents.sh            # install + start all five
#   deploy/launchd/install-agents.sh --dry-run  # print the plists, change nothing
#
# Run it as the farm user from a graphical login session (Terminal.app or a
# remote desktop) — the agents inherit that user's session, which is what
# xcodebuild needs to talk to the paired iPhones and the login keychain.
# Do NOT convert these to LaunchDaemons (root, no GUI session): WebDriverAgent
# launches will fail.
#
# Agents (label prefix from PHONE_FARM_LAUNCHD_PREFIX, default com.phone-farm):
#   <prefix>.db           one-shot at login: waits for Docker, `npm run db:up`
#   <prefix>.appium       Appium 3 + XCUITest on 127.0.0.1:4725
#   <prefix>.wda-service  WebDriverAgent supervisor (one WDA per phone)
#   <prefix>.worker       scheduler worker
#   <prefix>.web          dashboard + API on WEB_HOST:WEB_PORT
#   <prefix>.heartbeat    every 60 s: GET /health/ready, and only on 200 ping
#                         PHONE_FARM_HEARTBEAT_URL (off-host dead-man's switch).
#                         Installed only when that variable is set (env or .env);
#                         removed again when it is not.
# Logs: <repo>/logs/<agent>.log (git-ignored). Restart one: `launchctl kickstart -k gui/$(id -u)/<label>`.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PREFIX=${PHONE_FARM_LAUNCHD_PREFIX:-com.phone-farm}
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$REPO/logs"
DRY=${1:-}
NODE_BIN=$(dirname "$(command -v node)")
NPM="$NODE_BIN/npm"
[ -x "$NPM" ] || { echo "npm not found next to node ($NODE_BIN)"; exit 1; }
[ -f "$REPO/.env" ] || { echo "$REPO/.env is missing — copy .env.example first"; exit 1; }
mkdir -p "$AGENTS" "$LOGS"
# launchd SIGKILLs a job this many seconds after SIGTERM (its default is 20).
# The worker drains running tasks for WORKER_DRAIN_SECONDS (default 120), then
# gives task subprocesses WORKER_KILL_GRACE_SECONDS (default 15) between SIGTERM
# and SIGKILL, so its ExitTimeOut must stay above drain + grace + ~20 s.
WORKER_EXIT_TIMEOUT=${PHONE_FARM_WORKER_EXIT_TIMEOUT:-180}

plist () {  # name, keepalive(true|false), program args (xml <string> lines), [extra xml]
  local name=$1 keep=$2 args=$3 extra=${4:-}
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PREFIX.$name</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array>
$args
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><$keep/>
  <key>ThrottleInterval</key><integer>10</integer>$extra
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOGS/$name.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
</dict>
</plist>
EOF
}

npm_args () {  # npm script name -> ProgramArguments xml
  printf '    <string>%s</string>\n    <string>run</string>\n    <string>%s</string>' "$NPM" "$1"
}

# The heartbeat agent exists only when a push URL is configured. The URL itself
# stays in .env (0600); heartbeat.sh reads it at run time, never the plist.
heartbeat_url=${PHONE_FARM_HEARTBEAT_URL:-$(grep -E '^[[:space:]]*(export[[:space:]]+)?PHONE_FARM_HEARTBEAT_URL=.' "$REPO/.env" 2>/dev/null | tail -n 1 || true)}

declare -a NAMES=(db appium wda-service worker web)
if [ -n "$heartbeat_url" ]; then
  NAMES+=(heartbeat)
elif [ "$DRY" != "--dry-run" ]; then
  # Idempotent in both directions: unsetting the URL and re-running removes the agent.
  if launchctl bootout "gui/$(id -u)/$PREFIX.heartbeat" 2>/dev/null || [ -f "$AGENTS/$PREFIX.heartbeat.plist" ]; then
    rm -f "$AGENTS/$PREFIX.heartbeat.plist"
    echo "removed $PREFIX.heartbeat (PHONE_FARM_HEARTBEAT_URL is not set)"
  fi
else
  echo "(PHONE_FARM_HEARTBEAT_URL is not set: no heartbeat agent)"
fi
for name in "${NAMES[@]}"; do
  extra=
  case $name in
    db)      args=$(printf '    <string>/bin/bash</string>\n    <string>%s/deploy/launchd/db-up.sh</string>' "$REPO"); keep=false ;;
    # launchd labels cannot hold ':', so the label is wda-service but the npm script is wda:service.
    wda-service) args=$(npm_args "wda:service"); keep=true ;;
    # Long ExitTimeOut so a restart drains running tasks instead of killing them mid-post.
    worker)  args=$(npm_args worker); keep=true
             extra=$'\n  <key>ExitTimeOut</key><integer>'"$WORKER_EXIT_TIMEOUT"'</integer>' ;;
    # One-shot every 60 s (StartInterval), not a daemon; curl --max-time bounds each run.
    heartbeat) args=$(printf '    <string>/bin/bash</string>\n    <string>%s/deploy/launchd/heartbeat.sh</string>' "$REPO"); keep=false
               extra=$'\n  <key>StartInterval</key><integer>60</integer>' ;;
    *)       args=$(npm_args "$name"); keep=true ;;
  esac
  content=$(plist "$name" "$keep" "$args" "$extra")
  target="$AGENTS/$PREFIX.$name.plist"
  if [ "$DRY" = "--dry-run" ]; then
    echo "----- $target"; echo "$content"; continue
  fi
  # bootout first so a changed plist is re-read; ignore "not loaded"
  launchctl bootout "gui/$(id -u)/$PREFIX.$name" 2>/dev/null || true
  echo "$content" > "$target"
  # bootout returns before the old job is gone; bootstrap then fails with EIO, so retry briefly.
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    launchctl bootstrap "gui/$(id -u)" "$target" 2>/dev/null && break
    [ "$attempt" = 10 ] && { echo "could not load $PREFIX.$name"; exit 1; }
    sleep 1
  done
  echo "installed $PREFIX.$name"
done
[ "$DRY" = "--dry-run" ] && exit 0
echo
echo "Agents loaded. Status:"
launchctl list | grep "$PREFIX" || true
echo "Logs: $LOGS/*.log   ·   Restart one: launchctl kickstart -k gui/$(id -u)/$PREFIX.web"

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

plist () {  # name, keepalive(true|false), program args (xml <string> lines)
  local name=$1 keep=$2 args=$3
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
  <key>ThrottleInterval</key><integer>10</integer>
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

declare -a NAMES=(db appium wda-service worker web)
for name in "${NAMES[@]}"; do
  case $name in
    db)      args=$(printf '    <string>/bin/bash</string>\n    <string>%s/deploy/launchd/db-up.sh</string>' "$REPO"); keep=false ;;
    *)       args=$(npm_args "$name"); keep=true ;;
  esac
  content=$(plist "$name" "$keep" "$args")
  target="$AGENTS/$PREFIX.$name.plist"
  if [ "$DRY" = "--dry-run" ]; then
    echo "----- $target"; echo "$content"; continue
  fi
  # bootout first so a changed plist is re-read; ignore "not loaded"
  launchctl bootout "gui/$(id -u)/$PREFIX.$name" 2>/dev/null || true
  echo "$content" > "$target"
  launchctl bootstrap "gui/$(id -u)" "$target"
  echo "installed $PREFIX.$name"
done
[ "$DRY" = "--dry-run" ] && exit 0
echo
echo "Agents loaded. Status:"
launchctl list | grep "$PREFIX" || true
echo "Logs: $LOGS/*.log   ·   Restart one: launchctl kickstart -k gui/$(id -u)/$PREFIX.web"

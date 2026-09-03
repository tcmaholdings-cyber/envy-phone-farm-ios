#!/bin/bash
# Stop and remove the launchd agents installed by install-agents.sh.
set -uo pipefail
PREFIX=${PHONE_FARM_LAUNCHD_PREFIX:-com.phone-farm}
for name in web worker wda-service appium db; do
  launchctl bootout "gui/$(id -u)/$PREFIX.$name" 2>/dev/null && echo "stopped $PREFIX.$name"
  rm -f "$HOME/Library/LaunchAgents/$PREFIX.$name.plist"
done
echo "removed. Postgres (docker) is left running; stop it with: docker compose down"

#!/bin/bash
# Off-host dead-man's switch, run every 60 s by the <prefix>.heartbeat launchd
# agent (install-agents.sh installs it only when PHONE_FARM_HEARTBEAT_URL is set).
#
# It asks the local dashboard whether the farm is ready (GET /health/ready:
# Postgres, Appium, wda-service socket, fresh worker heartbeat) and, ONLY when
# that answers 200, pings PHONE_FARM_HEARTBEAT_URL — a Healthchecks.io check URL
# or an Uptime Kuma push URL. It never reports failure itself: a host that
# crashes, sleeps, loses power or loses its network simply stops pinging, and
# the external monitor alerts on the missing ping. Set that monitor's period to
# 1 min and its grace to 2 min (alert after ~3 min of silence).
#
# Configuration is read from the environment first, then from <repo>/.env, so
# the push URL (which is a credential) never has to appear in the plist.
#   PHONE_FARM_HEARTBEAT_URL   push URL (required; the script exits 0 when unset)
#   PHONE_FARM_READY_URL       readiness URL (default http://127.0.0.1:$WEB_PORT/health/ready)
#   WEB_PORT                   dashboard port (default 3000)
#
#   deploy/launchd/heartbeat.sh           # one check + ping
#   deploy/launchd/heartbeat.sh --check   # check only, print the readiness body, never ping
set -uo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE=${PHONE_FARM_ENV_FILE:-$REPO/.env}
STATE_FILE=${PHONE_FARM_HEARTBEAT_STATE:-$REPO/logs/.heartbeat-state}
CURL=${CURL:-curl}

# Read NAME from the environment, else the last NAME=value line of .env.
# The file is parsed, never sourced, so nothing in it is executed.
env_value () {
  local name=$1 value
  value=$(printenv "$name" 2>/dev/null || true)
  if [ -z "$value" ] && [ -r "$ENV_FILE" ]; then
    value=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$name=" "$ENV_FILE" | tail -n 1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?$name=//")
    value=${value%$'\r'}
    case $value in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
  fi
  printf '%s' "$value"
}

# Log only when the outcome changes, so a healthy host writes nothing each minute.
note () {  # state, message
  local previous=
  [ -r "$STATE_FILE" ] && previous=$(cat "$STATE_FILE" 2>/dev/null)
  if [ "$previous" != "$1" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) heartbeat $1: $2"
    mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null && printf '%s' "$1" > "$STATE_FILE"
  fi
}

PUSH_URL=$(env_value PHONE_FARM_HEARTBEAT_URL)
PORT=$(env_value WEB_PORT)
READY_URL=$(env_value PHONE_FARM_READY_URL)
READY_URL=${READY_URL:-http://127.0.0.1:${PORT:-3000}/health/ready}

BODY=$("$CURL" -sS --max-time 10 -w '\n%{http_code}' "$READY_URL" 2>&1)
STATUS=${BODY##*$'\n'}
BODY=${BODY%$'\n'*}

if [ "${1:-}" = "--check" ]; then
  echo "$STATUS $BODY"
  [ "$STATUS" = "200" ]
  exit
fi

if [ -z "$PUSH_URL" ]; then
  exit 0
fi

if [ "$STATUS" != "200" ]; then
  # Do not ping: silence is the alert. Record why, once.
  note "not-ready" "$READY_URL answered ${STATUS:-nothing}: $BODY"
  exit 0
fi

# Never echo the push URL: it is the credential for the check.
if "$CURL" -fsS --max-time 10 --retry 2 --retry-delay 2 -o /dev/null "$PUSH_URL" 2>/dev/null; then
  note "ok" "ready; pinged the heartbeat monitor"
else
  note "push-failed" "ready, but the heartbeat monitor could not be reached"
fi
exit 0

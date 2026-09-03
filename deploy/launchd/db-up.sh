#!/bin/bash
# One-shot helper run by the <prefix>.db launchd agent at login: wait for the
# Docker engine, then start the bundled Postgres (`npm run db:up`). If you run
# PostgreSQL natively (Homebrew) instead of Docker, leave this agent installed —
# it exits harmlessly when Docker never appears — or remove it with uninstall-agents.sh.
set -uo pipefail
cd "$(dirname "$0")/../.."
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    exec npm run db:up
  fi
  sleep 5
done
echo "docker engine not available after 5 minutes; skipping db:up (is Docker Desktop set to start at login?)"
exit 0

# Production hardening plan: 2026-09-25

Branch `feat/production-hardening`, cut from `feat/usb-hub-scale-20-phones` at 3e0d7c0. See scale-review-2026-09-25.md for the findings behind it.

## Wave 1: in parallel now (each in its own worktree, merged here)
- **A. Scheduler correctness (#1, #2, #3).**
  - Worker drain: offWork, wait, SIGTERM then SIGKILL, Appium cleanup, launchd ExitTimeOut.
  - `materializeDue` isolated per schedule; an unknown task marks the execution skipped.
  - Job expiry = window + duration + margin.
  - Wait-for-device uses the cached sweep, not lockdown per phone.
  - A per-device try/catch in `registerDeviceWorkers`; unsubscribe removed or disabled phones.
  - A post that already committed is never auto-retried (`effect_committed_at` checkpoint).
- **B. Observability (#5).**
  - A rotated xcodebuild log per UDID.
  - `/health` stays public and minimal. Add `/health/ready`, which checks DB, Appium, the wda socket and the worker heartbeat.
  - `/metrics` in Prometheus format, with a worker heartbeat row.
  - A push-heartbeat launchd agent (URL from env) plus an alert runbook.
- **C. CI + releases (#8).**
  - A GitHub Actions `npm run check` workflow.
  - `scripts/release.sh` builds a tarball per SHA.
  - `scripts/deploy.sh` unpacks to `releases/<sha>`, migrates, runs a smoke check, flips the `current` symlink, restarts the agents and writes `RELEASED`.
  - `scripts/rollback.sh`.
  - The launchd installer points at `current`.

## Wave 2: multi-host (#4) + multi-team signing (#6, code side)
- A `devices` + `hosts` table in Postgres, with `host_id` and a host lease. A one-time import from `devices.json`. Passcodes stay in a local 0600 file on each host.
- The worker works only its own host's phones; the dashboard reads devices from the DB.
- Per-device `signingTeam` → xctestrun mapping (`WDA_XCTESTRUN_<TEAM>`), with the supervisor choosing it per phone.
- Web → remote host reach through an authenticated host-agent endpoint for screenshots, MJPEG and actions.

## Wave 3: tenants (#7)
- A `tenants` table. `tenant_id` on users, groups, devices, schedules, executions and assets. Every query is scoped.
- A platform-operator role distinct from tenant-admin.
- An append-only `audit_log` for every non-GET request. Upload quotas and a 200 MB cap.

## Not code (owner)
- Apple teams: one Organization team per ~100 phones, each needing a legal entity and a D-U-N-S number.
- Hardware: switchable powered hubs, a UPS, and RAM per host.

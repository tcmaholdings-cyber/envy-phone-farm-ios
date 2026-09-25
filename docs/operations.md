# Operations runbook

Day-two operations for a farm host: starting, stopping, watching, fixing,
backing up, upgrading. Commands assume the launchd agents from
`deploy/launchd/`, the label prefix set at install time (`$P` below, e.g.
`com.envy.phone-farm`), and that you run them from the live code:
`cd ~/phone-farm/current` on a host in the release layout
([deploy.md](deploy.md)), or `cd ~/phone-farm` on a plain checkout. Relative
paths such as `logs/` and `.wda/` resolve to `~/phone-farm/shared/` either way.
Deploys, rollbacks and the one-time migration to releases are in
[deploy.md](deploy.md). Running several Macs against one Postgres (shared
device registry, host agents over Tailscale, one Apple Team per ~100 phones)
is in [multi-host.md](multi-host.md).

## Start / stop / restart

```sh
P=com.envy.phone-farm; U=gui/$(id -u)
launchctl list | grep $P                      # what is loaded (PID, last exit code)
launchctl kickstart -k $U/$P.web              # restart one agent (also: worker, wda-service, appium)
launchctl bootout $U/$P.worker                # stop one until next login / bootstrap
launchctl bootstrap $U ~/Library/LaunchAgents/$P.worker.plist   # start it again
deploy/launchd/uninstall-agents.sh            # stop + remove all agents
deploy/launchd/install-agents.sh              # (re)install all agents — idempotent
                                              # (+ <prefix>.heartbeat when PHONE_FARM_HEARTBEAT_URL is set)
```

Order matters only at first boot: `db` → `appium` + `wda-service` → `worker`
+ `web`. KeepAlive restarts a crashed process after 10 s, so a temporarily
missing dependency just produces a few retries in the log.

Restarting the worker is safe but not instant, and it is never needed to pick
up a new phone (it re-reads `devices.json` every 30 s). On SIGTERM it stops
taking jobs, then drains for up to `WORKER_DRAIN_SECONDS` (120 s): a task still
waiting for its phone is queued again for the next worker, a doomscroll is
stopped, and a post is given the time to finish. Whatever is still running at
the deadline is stopped (SIGTERM, SIGKILL 15 s later), and any Appium session
it left open is deleted. launchd's `ExitTimeOut` for the worker is 180 s, so
`kickstart -k` can take up to three minutes.

A run that failed *after* its post was submitted is marked failed with "Not
re-run: the task already committed its side effect". It is never retried, by
the scheduler or by the Retry button, because that would post twice. Check the
account and schedule a new post if it really did not go out. A schedule whose
task version is no longer installed records a **skipped** run with the reason
and moves on to its next occurrence.

Postgres: `docker compose ps`, `npm run db:up`, `docker compose stop postgres`.

## Watching

| What | How |
| --- | --- |
| Process logs | `tail -f logs/web.log logs/worker.log logs/wda-service.log logs/appium.log` |
| One phone's WDA / xcodebuild output | `tail -f .wda/logs/<udid>.log` (rotated `.1`–`.3`), or the last lines: `curl -s --unix-socket .wda/wda-service.sock 'http://x/devices/<udid>/logs?lines=100'` |
| Is the process up | `curl -s http://127.0.0.1:3000/health` — `{"ok":true,"release":"<sha>"}` |
| Is the farm ready | `curl -s http://127.0.0.1:3000/health/ready` — 200/503 with one entry per dependency |
| Metrics | `curl -s -H "Authorization: Bearer $PHONE_FARM_METRICS_TOKEN" http://127.0.0.1:3000/metrics` |
| Per-phone state | `curl -s --unix-socket .wda/wda-service.sock http://x/health` — `physical`, `wda`, `appium`, `message`, `restarts`, `notReadySince`, `disconnectedSince` per UDID |
| Worker alive | `psql "$DATABASE_URL" -c "select host, pid, queues, now() - beat_at as age from scheduler.worker_heartbeats"` |
| Phones the OS sees | `xcrun xctrace list devices` |
| Executions | dashboard → device → *Execution history*, or `GET /api/executions?udid=…`; full log `GET /api/executions/:id` |
| Queue depth | `psql "$DATABASE_URL" -c "select name, count(*) from pgboss.job where state in ('created','active') group by 1"` |

For alerting, see *Monitoring and alerts* below.

## Monitoring and alerts

Three layers, from the outside in. Set up all three on every farm host.

### Endpoints

| Endpoint | Who can call it | Answers |
| --- | --- | --- |
| `GET /health` | anyone | Liveness: `{"ok":true,"release":"<sha>"}`. It only says the web process answers. |
| `GET /health/ready` | anyone (no session) | `200` when all four checks pass, else `503`. Body: `{"ok":…,"checks":{"database","appium","wdaService","worker"}}`, each `{"ok":true}` or `{"ok":false,"reason":…}` with reason `unreachable`, `timeout`, `no heartbeat` or `stale`; `worker` also carries `ageSeconds`. The reasons are fixed words; the real error goes to `logs/web.log` as `readiness check failed`. Each check is bounded at 3 s. |
| `GET /metrics` | `Authorization: Bearer $PHONE_FARM_METRICS_TOKEN` | Prometheus text. `404` while the token is unset, `401` for a wrong one. |
| `GET /api/devices/:udid/wda-log?lines=N` | platform staff | The phone's last N (up to 1000) supervisor lines, from the wda-service. |

The four readiness checks: `database` runs `select 1`; `appium` asks Appium's
`/status` on `APPIUM_HOST:APPIUM_PORT`; `wdaService` needs the socket's
`/health` to answer 200 (it answers 503 while starting); `worker` needs the
freshest row in `scheduler.worker_heartbeats` to be at most
`PHONE_FARM_WORKER_STALE_SECONDS` (60) old. The worker writes that row every
15 s, stamped with the database clock.

### Metrics

| Series | Meaning |
| --- | --- |
| `phone_farm_phones_registered{state}` | Registered phones, `active` / `disabled`. |
| `phone_farm_phones_usb_connected`, `phone_farm_phone_usb_connected{udid,name}` | Active phones usbmux sees (total; per phone 1 or 0). |
| `phone_farm_wda_phones{state}` | Supervised phones per WDA state (`ready`, `connecting`, `unlock-required`, `error`, `disconnected`). |
| `phone_farm_wda_restarts_total{udid,name}` | Times WDA on the phone failed and was relaunched since wda-service started (counter). |
| `phone_farm_phone_wda_not_ready_seconds{udid,name}` | How long WDA has not been ready (0 while ready). |
| `phone_farm_phone_usb_disconnected_seconds{udid,name}` | How long the phone has been off USB (0 while attached). |
| `phone_farm_queue_depth{queue,udid,name}`, `…_deferred`, `…_active` | pg-boss jobs waiting to run now / scheduled for later / running, per device queue. |
| `phone_farm_queue_oldest_job_age_seconds{queue,udid,name}`, `…_max` | How long the oldest runnable job has waited (per queue; worst queue). |
| `phone_farm_queue_depth_total` | Runnable jobs across all queues. |
| `phone_farm_executions_last_hour{status}` | Executions updated in the last hour, per status. |
| `phone_farm_worker_heartbeat_age_seconds`, `phone_farm_worker_host_heartbeat_age_seconds{host}`, `phone_farm_worker_queues{host}` | Worker liveness and how many device queues it serves. |
| `phone_farm_process_uptime_seconds` | Web process uptime. |
| `phone_farm_metrics_source_up{source}` | `usb`, `wda_service`, `database`: 0 means that source failed during this scrape and its series are missing, not zero. |

Scrape through the tunnel or VPN; never open the port:

```yaml
scrape_configs:
  - job_name: phone-farm
    scrape_interval: 30s
    authorization: { credentials_file: /etc/prometheus/phone-farm.token }
    static_configs: [{ targets: ['farm-mini-1:3000'] }]
```

### Off-host heartbeat (dead-man's switch)

A host that crashes, sleeps or loses its network cannot send an alert, so
something outside has to notice the silence:

1. Create a check in Healthchecks.io (or a *Push* monitor in Uptime Kuma) with
   period **1 min** and grace **2 min**. Copy its ping URL.
2. On the host, put `PHONE_FARM_HEARTBEAT_URL=<ping url>` in `.env` and run
   `deploy/launchd/install-agents.sh`. That adds `<prefix>.heartbeat`, which
   runs `deploy/launchd/heartbeat.sh` every 60 s: it calls `GET /health/ready`
   and pings only on a 200. It never reports failure itself; silence is the alert.
3. Check it with `deploy/launchd/heartbeat.sh --check`, which prints the
   readiness answer without pinging. Each state change (ok, not ready, monitor
   unreachable) is logged once to `logs/heartbeat.log`.

Removing the variable and re-running the installer removes the agent. The URL
is a credential: it stays in `.env` and is never written into the plist or a log.

### Alert thresholds

| Alert | Condition | Where |
| --- | --- | --- |
| **Host down** | no heartbeat ping for **more than 3 min** | the external monitor (period 1 min + grace 2 min) |
| **Phone off USB** | `phone_farm_phone_usb_disconnected_seconds > 600` (10 min) | Prometheus |
| **WDA not ready** | `phone_farm_phone_wda_not_ready_seconds > 900` (15 min) while the phone is on USB | Prometheus |
| **Queue backlog** | `phone_farm_queue_oldest_job_age_seconds > 1800`: older than the 30-min run window, so the job will expire unrun | Prometheus |
| **Worker stalled** | `phone_farm_worker_heartbeat_age_seconds > 120` | Prometheus (the host heartbeat stops too, because readiness fails) |
| **WDA flapping** | `increase(phone_farm_wda_restarts_total[1h]) > 10` | Prometheus |
| **Metrics source failing** | `phone_farm_metrics_source_up == 0` for 10 min | Prometheus |
| **Backup stale** | the nightly backup has not succeeded for **more than 26 h** | a second push check pinged by the backup job (see *Backups*), period 1 day, grace 2 h |

```yaml
groups:
  - name: phone-farm
    rules:
      - alert: PhoneOffUsb
        expr: phone_farm_phone_usb_disconnected_seconds > 600
        labels: { severity: warning }
        annotations: { summary: '{{ $labels.name }} ({{ $labels.udid }}) off USB for 10+ min' }
      - alert: WdaNotReady
        expr: phone_farm_phone_wda_not_ready_seconds > 900 and on(udid) phone_farm_phone_usb_disconnected_seconds == 0
        labels: { severity: warning }
        annotations: { summary: '{{ $labels.name }} WDA not ready for 15+ min' }
      - alert: QueueBacklog
        expr: phone_farm_queue_oldest_job_age_seconds > 1800
        labels: { severity: critical }
      - alert: WorkerStalled
        expr: phone_farm_worker_heartbeat_age_seconds > 120
        labels: { severity: critical }
      - alert: WdaFlapping
        expr: increase(phone_farm_wda_restarts_total[1h]) > 10
        labels: { severity: warning }
      - alert: MetricsSourceDown
        expr: phone_farm_metrics_source_up == 0
        for: 10m
        labels: { severity: warning }
```

### Runbook

| Alert | First steps |
| --- | --- |
| Host down | Is the Mac reachable (Tailscale, ping)? If not: power, network, or it slept (`pmset -g`; automatic sleep must be off). If it is: `deploy/launchd/heartbeat.sh --check` shows which readiness check fails; follow that row. If readiness is 200 but no pings arrive, the host cannot reach the monitor (`logs/heartbeat.log` says `push-failed`). |
| `database` not ready | `docker compose ps`; `npm run db:up`; `logs/db.log`. Docker Desktop needs the GUI session logged in. |
| `appium` not ready | `launchctl kickstart -k $U/$P.appium`; `logs/appium.log`. |
| `wdaService` not ready | `launchctl kickstart -k $U/$P.wda-service`; `logs/wda-service.log`. A stale `.wda/wda-service.sock.lock` clears itself within 15 s. |
| `worker` stale or no heartbeat | `launchctl list \| grep $P.worker` (PID, last exit code); `tail logs/worker.log`. If migration 0003 was never applied the table is missing: `npm run db:migrate`. Restarting the worker kills running tasks, so check the dashboard for running executions first. |
| Phone off USB | The card shows its `rackSlot`: reseat that cable or hub port and check the hub's power. Several phones on one hub dropping together points at the hub. |
| WDA not ready or flapping | `tail -200 .wda/logs/<udid>.log` (or the admin route) shows xcodebuild's own error; then find the matching row in *Common failures*. Usual causes: locked phone, untrusted developer profile, profile missing the UDID, stale build. |
| Queue backlog | Is that phone's WDA ready and the worker alive? A job waits for its phone and expires at the end of its window if the phone stays down. `select name, state, count(*) from pgboss.job group by 1, 2` shows the rest. |
| Backup stale | Run the backup by hand, read its output, check free disk (`df -h`). |

### Grid timings

Run these on the Mac mini (or through the SSH tunnel) before and after a change
to see what the grid costs. Replace `<udid>` with a phone whose WDA is ready.

```sh
# The card fragment: should be small and fast (no screenshots are taken for it).
curl -s -o /dev/null -w 'fragment  %{http_code} %{size_download}B %{time_total}s\n' \
  http://127.0.0.1:3000/api/fragments/devices

# Full-size PNG (device page) versus the grid thumbnail.
curl -s -o /dev/null -w 'screenshot %{http_code} %{size_download}B %{time_total}s\n' \
  'http://127.0.0.1:3000/api/devices/<udid>/remote/screenshot?fresh=1'
curl -s -o /dev/null -D - -w 'thumbnail %{http_code} %{size_download}B %{time_total}s\n' \
  http://127.0.0.1:3000/api/devices/<udid>/remote/thumbnail | grep -iE 'etag|thumbnail'

# An unchanged screen should answer 304 with no body (paste the ETag from above).
curl -s -o /dev/null -H 'if-none-match: "t-…"' -w 'revalidate %{http_code} %{size_download}B\n' \
  http://127.0.0.1:3000/api/devices/<udid>/remote/thumbnail

# A phone without WDA should fail fast (503 with x-device-state), not hang.
curl -s -o /dev/null -D - -w '%{time_total}s\n' \
  http://127.0.0.1:3000/api/devices/<other-udid>/remote/thumbnail | grep -iE 'HTTP|x-device-state|s$'
```

Expect the thumbnail at roughly 10–40 KB against hundreds of KB for the PNG,
and a dead phone's 503 within `PHONE_FARM_GRID_SCREENSHOT_TIMEOUT_MS` the first
time and instantly during the failure cooldown.

## Common failures

| Symptom | Cause → fix |
| --- | --- |
| Phone shows **Offline**, `xctrace` lists it under *Devices Offline* | USB. The card prints its `rackSlot` — reseat that cable/hub port; charge-only cable; phone rebooted and is locked → unlock once. |
| The grid feels slow, or phones flap between Online and Offline on a big rack | Too much polling for one USB tree. Raise `PHONE_FARM_GRID_POLL_SECONDS` / `PHONE_FARM_SCREENSHOT_TTL_MS` / `PHONE_FARM_DISCOVERY_TTL_MS` ([configuration.md](configuration.md#fleet-scale-polling)), and close spare dashboard tabs. Measure first with the commands under *Grid timings* below. |
| A card says **WDA not ready** instead of showing the screen | The phone is on USB but the WDA supervisor has not got WebDriverAgent running on it. Hover the pill for the supervisor's message; check `curl -s --unix-socket .wda/wda-service.sock http://x/health`. The grid no longer asks such a phone for a screenshot, so it cannot slow the other cards. |
| A card's still is dimmed and its "updated … ago" stops moving | Its thumbnail requests are failing (WDA wedged or slower than `PHONE_FARM_GRID_SCREENSHOT_TIMEOUT_MS`). The browser keeps the last frame and backs off to at most one try a minute; it recovers by itself when the phone answers. |
| `wda: unlock-required` | Unlock the phone once (Auto-Lock should be *Never*). Check the passcode in `devices.json`. |
| `wda: error … stale or corrupted` / empty `.app` | `rm -rf ~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*` then `npm run wda:prepare -- --udid <udid>` from the GUI session. |
| WDA fails right after adding a phone | The provisioning profile does not list its UDID: re-run `wda:prepare` with the phone connected. |
| `errSecInternalComponent` during `wda:prepare` | Ran over SSH. Use the graphical session (Screen Sharing). |
| Signing fails after an iOS/Xcode update | Match `IOS_PLATFORM_VERSION`; open Xcode once so it downloads the new Developer Disk Image; then `wda:prepare`. |
| `Appium is unavailable on port 4725` | `launchctl kickstart -k $U/$P.appium`; check `logs/appium.log`. Driver missing → `npm run appium:install-driver`. |
| Dashboard 401 everywhere | An auth provider is configured; sign in, or unset `PHONE_FARM_AUTH_PLUGIN` on loopback. |
| `Cross-origin write blocked` (403) | Browser origin ≠ bind host. Add it to `PHONE_FARM_TRUSTED_ORIGINS`, or use the same host you bound. |
| Taps land in the wrong place | Wrong `coordinateProfile`, or the phone's Display Zoom / text size changed. Recalibrate from the device page → *Touch points*. |
| Task "window expired" | The phone was not ready within `run_window_minutes` (30) of the schedule time. Look at `wda-service` health for that period. |
| TikTok flow fails at a step | TikTok updated its layout. Compare a screenshot with the target in `Touch points`; recalibrate, or update the profile in `src/tiktok/coordinates.ts`. |

## Adding a phone

1. Prepare it (install guide §5), connect it, `xcrun xctrace list devices` shows it.
2. `npm run wda:prepare -- --udid <udid>` from the GUI session.
3. Dashboard → **Register a phone** (platform staff) → checks → **Finish registration**. Pick free `wdaLocalPort` / `mjpegLocalPort` (the wizard proposes the next ones), set the **rack** (access can be granted per rack) and the **rack slot** so the phone can be found later. The model is detected and saved automatically.
4. Device page → *Touch points* → calibrate; run a `doomscroll` once.

### Signing on another Mac

A farm host does not have to hold the Apple ID. Sign on a Mac that does, copy the build:

1. Register the new phone's UDID with the Team: developer.apple.com → *Devices* →
   *+* (or *Register Multiple Devices* with a tab-separated `Device ID / Device Name / Device Platform` file).
2. On the signing Mac: `npm run wda:prepare -- --generic` → `.wda/prebuilt/Build/Products`.
   Automatic signing puts every registered device into the profile, so re-run it after each registration.
3. Copy that folder to the host, e.g. `rsync -a .wda/prebuilt/Build/Products/ host:phone-farm/shared/.wda/prebuilt/`
   (`host:phone-farm/.wda/prebuilt/` on a host not yet migrated to releases),
   and set `WDA_XCTESTRUN=/Users/<user>/phone-farm/.wda/prebuilt/WebDriverAgentRunner_iphoneos<sdk>-arm64.xctestrun`
   in the host's `.env` (once).
4. Restart `wda-service` on the host. Skip `wda:prepare` there; the wizard's *Prepare* step signs locally and does not apply.

More than ~100 phones need more than one Apple Team: build one artifact per Team with `npm run wda:prepare -- --generic --team <TEAMID>`, set `WDA_XCTESTRUN_<TEAMID>` on the hosts and give each phone its `signingTeam` — see *Signing teams* in [multi-host.md](multi-host.md#signing-teams).

## Team access and VAs

With `PHONE_FARM_AUTH_PLUGIN=builtin` ([configuration](configuration.md#built-in-accounts))
everyone signs in with their own account.

**First accounts** (on the host, once, after `npm run db:migrate`). The farm
operator's own staff are **platform** accounts; a customer organisation's
admin is an **admin** of that tenant ([tenants.md](tenants.md)):

```sh
npm run users -- create kash --role platform --name "Kash"
npm run users -- create rex --role platform --name "Rex"
npm run users -- create acme-boss --role admin --tenant acme --name "Acme boss"   # after creating tenant "acme"
npm run users -- list
```

Upgrading from a release without tenants turns every existing `admin` into
`platform` and puts every operator in the default tenant, `beloura`.

Each `create` prints a temporary password on stdout, once — nothing else
stores it. Hand it over privately; the person must choose their own password
(12+ characters) at first sign-in. Re-running `create` for an existing user
changes nothing. A forgotten password: `npm run users -- reset-password <username>`
(or **Reset password** on the Team page) — it also signs that person out
everywhere.

**Roles**

| Role | Can |
| --- | --- |
| Platform | Everything, in every organisation: all phones, registering phones, device settings (name, passcode, rack, slot, disconnect, remove), the Organisations page, every Team page and the whole audit log. |
| Admin | Everything inside their own organisation: all its phones, its Team page (people, groups, grants), its media and its audit log. Never device settings, registration, or anything of another organisation. |
| Operator | Only the phones granted to them in their organisation, at the granted level. Never device settings, registration or the Team page. |

**Access levels** (per phone)

| Level | An operator can |
| --- | --- |
| View | See the phone in the grid, its screen and live stream, its device page read-only, and its schedules and run history. |
| Operate | Everything in View, plus drive the phone (tap, swipe, unlock, wake, home, volume), run and schedule doomscrolls and posts, pause/resume/cancel schedules, stop and retry runs, edit TikTok accounts and calibrate touch points. |

A **grant** gives a person or a group a level on a scope: **all phones**, a
**rack** (every phone whose `rack` matches), a **model** (every phone whose
`model` matches, e.g. `iPhone 12 mini`) or **one phone**. A person's level on a
phone is the highest of their own grants and their groups' grants; with no
matching grant the phone does not exist for them (its pages and API answer
404). Grants follow the phones: move a phone to rack 2 and rack-1 access to it
ends at once.

**Adding a VA** (an organisation's admin, or platform staff with the Team page's switcher on that organisation):

1. **Add person** → username, display name, role *Operator*, optional groups →
   **Save**. Copy the temporary password from the dialog — it is shown once.
2. Under **Phone access**, choose the person (or their group), a scope and a
   level → **Grant access**. Granting the same scope again changes its level.
3. Check **What each operator can reach** at the bottom of the page.

Groups ("Night shift", "Rack 1 team") save repeating grants: grant the group
once, then add or remove members. **Disable** blocks sign-in and ends the
person's sessions at once without losing their setup; **Delete** removes the
account, its grants and memberships. The last active admin cannot be demoted,
disabled or deleted (per organisation; likewise the last platform account),
and nobody can disable or delete their own account.

**Rack and model on existing phones.** Models fill themselves in the first
time the dashboard sees each phone connected (open the grid once with the
phones plugged in). Racks are set by platform staff: per phone on the device page
(*Rack & slot*), or in bulk on the host:

```sh
npm run devices -- list                          # name, UDID, rack, slot, model
npm run devices -- set-rack 1 --all              # every registered phone
npm run devices -- set-rack 2 <udid> <udid> …    # just these
```

Every change — each state-changing request, sign-in, and user, group, grant
or organisation change — is recorded in the append-only audit log: the
**Audit** page (CSV export there too), `GET /api/audit`, and an `audit` line
in `logs/web.log` (`grep '"audit"' logs/web.log | tail`). See
[tenants.md](tenants.md#audit-log).

## Retiring a phone

Dashboard → device → **Remove device** (right end of the settings row; cancels its schedules,
forgets its entry; WebDriverAgent stays installed on the phone). To pause
without forgetting: **Disconnect** on the grid (`"disabled": true`).

## Backups

Nightly, from a cron/launchd job on the host, run in `~/phone-farm/shared`
(where the real files are; `tar` would archive the links in a release
directory, not their contents). On a plain checkout run it in `~/phone-farm`
without `-f ../current/docker-compose.yml`:

```sh
cd ~/phone-farm/shared && set -o pipefail
docker compose -f ../current/docker-compose.yml exec -T postgres pg_dump -U phone_farm phone_farm | gzip > backups/pg-$(date +%F).sql.gz \
  && tar czf backups/state-$(date +%F).tgz .env devices.json $(test -f device-secrets.json && echo device-secrets.json) .scheduler-data \
  && curl -fsS -m 10 -o /dev/null "$BACKUP_PING_URL"   # a second push check: period 1 day, grace 2 h
```

`BACKUP_PING_URL` belongs to this job only (it is not read by the farm). The
ping runs only when both steps succeeded, so a missing ping means the backup
is stale — see *Alert thresholds*.

`.scheduler-data` is archived whole: it holds every uploaded file the
`scheduler.assets` rows point at — `uploads/` (the dashboard's media uploads,
`POST /api/assets`) and `assets/` (media sent with a TikTok post) — and nothing
else. The dump runs first, so a file uploaded between the two steps is in the
archive without its row (harmless). The reverse can happen too: media is
deleted when a post succeeds or is cancelled, a schedule is cancelled, history
expires or an unattached upload is swept, and if that happens in the window the
restored database holds an asset row whose file is missing. Such rows belong to
finished, cancelled or orphaned work that will not run again. If
`SCHEDULER_DATA_DIR` points somewhere else, archive that directory instead.

Restore, with the agents stopped, in `~/phone-farm/shared` (the database
restore needs the release's compose file, and the migrations run from
`current/`, because `shared/` has no `docker-compose.yml` or `package.json`):

```sh
cd ~/phone-farm/shared
gunzip -c backups/pg-….sql.gz | docker compose -f ../current/docker-compose.yml exec -T postgres psql -U phone_farm phone_farm
tar xzf backups/state-….tgz
cd ../current && npm run db:migrate
```

On a plain checkout run the same steps in `~/phone-farm`, without
`-f ../current/docker-compose.yml` and without `cd ../current`. The `tar` step
puts the files back: `.env`, `devices.json`, `device-secrets.json` on a
multi-host farm, and `.scheduler-data/`, without which scheduled posts fail
because their media is missing. Then restart the agents.

## Upgrading the software

From the laptop, in a clean checkout of the tag or branch to run:

```sh
scripts/deploy-remote.sh <user>@<host>       # build, copy, migrate the DB, flip, restart, health-check
~/phone-farm/bin/rollback.sh     # on the host: back to the previous release
```

[deploy.md](deploy.md) covers what each step does, the automatic rollback, and
the one-time conversion of a plain checkout (`scripts/migrate-to-releases.sh`).
Tags (`vX.Y.Z`) are the supported upgrade points; CI attaches a release
tarball to each one.

Read the release notes for `taskVersion` changes: a schedule persists the
version it was created with and fails loudly, rather than silently running new
logic, if that version is removed (`PLUGIN_DEVELOPMENT.md`).

## Upgrading iOS / Xcode

Keep the fleet on one iOS version. Update Xcode first (App Store), open it,
let it fetch the Developer Disk Image, then update phones one at a time:
update → re-trust → Developer Mode still on → `wda:prepare --udid` → check
health. Update `IOS_PLATFORM_VERSION` when the whole fleet has moved.

## Security hygiene

- `.env` and `devices.json` are `0600`; never commit them, never paste them in tickets.
- Rotate `POSTGRES_PASSWORD` (edit `.env`, `ALTER ROLE … PASSWORD`, restart web + worker) when staff change.
- The dashboard stays on loopback, or behind a VPN or tunnel **with sign-in on** (`configuration.md` → Exposure).
- Review **Team** when staff change: disable or delete leavers, remove grants nobody needs. Temporary passwords are shown once; if one leaks before first use, reset it.
- Plugins are trusted code: install only reviewed, pinned packages (`PLUGIN_DEVELOPMENT.md`).

# Phone Farm backend: production readiness for hundreds of phones

2026-09-25. This is a read-only review of branch `feat/usb-hub-scale-20-phones` (3e0d7c0). The live figures come from the fidelity Mac mini, which had 36 phones registered and 35 on USB at the time.

## Where it stands

It runs correctly on one Mac for a few dozen phones. It will not work across several Macs, and it won't run 100+ phones on one Mac. Every component assumes a single host:
- `devices.json` is a file on that host.
- WDA and Appium are reached at `127.0.0.1:<port>`.
- One WDA build is signed for one Apple Team.
- Monitoring consists of a `/health` endpoint that always returns `ok: true`.

### Measured on the host (16 GB, 10 cores, load average about 8)

| Process | Count | RSS |
|---|---|---|
| `node` + `tsx` supervisor per phone (`src/devices/wda/start.ts`) | 36 (one per registered phone, connected or not) | about 130 MB each, **about 4.7 GB total** |
| `xcodebuild test-without-building` | 13 | about 1.3 GB total |
| web (`src/api/server.ts`) | 1 | 277 MB |
| worker, wda-service, appium | 1 each | 60–180 MB |

Scaled linearly to 100 phones on one host, the supervisors take about 13 GB and xcodebuild about 10 GB. **A 16 GB Mac tops out at roughly 40–50 phones as the code stands.**

## Critical

| # | Finding | Where | Fix |
|---|---|---|---|
| C1 | **Restarting the worker kills every running task.** A post with `retryLimit: 0` is marked failed even if it was published; retrying it posts twice. The auto-register script restarted the worker on every registration, although the worker already picks up new devices within 30 s. **That restart was removed on 2026-09-25.** | `worker.ts:63,87-92`, `executor.ts:96` | Drain on shutdown: `offWork` → wait for running jobs → SIGTERM escalating to SIGKILL, plus Appium session cleanup and a long launchd `ExitTimeOut`. Never restart the worker to add a device. |
| C2 | **One bad schedule stops all schedules from being queued.** `materializeDue` handles up to 100 rows in one transaction. `plugins.task()` throws for a task version that isn't installed, which rolls back the whole batch every 5 s. | `repository.ts:210-248` | One transaction or savepoint per row. On an unknown task, mark the execution `skipped` and move the schedule on. |
| C3 | **Waiting jobs query every phone repeatedly (O(n²)).** Each waiting job calls the uncached `discoverConnectedDevices()` every 5 s, and each call sends 3 lockdown requests to every phone. After a hub brownout at 100 phones, that is about 30k USB calls per 5 s, on the USB tree that just failed. | `executor.ts:30`, `discovery.ts:25` | Use the shared, cached sweep plus the supervisor's state instead of lockdown. |
| C4 | **The code assumes one host.** The registry is a JSON file whose lock only works inside one process (web, CLI and registration can each overwrite another's changes). Every consumer dials `127.0.0.1`. The worker subscribes to every phone's queue, so a second host on the same DB would compete for jobs. | `registry.ts:153`, `registry-remote.ts:23`, `executor.ts:32`, `worker.ts:23` | Move `devices` and `hosts` into Postgres with `host_id` and a lease. Each host's worker handles only its own phones. Web routes to a per-host agent. |
| C5 | **Nothing is watched or alerted on.** `/health` always returns `ok: true`, the worker has no health endpoint, and xcodebuild output is discarded (only `[wda-state]` lines are kept). This is why nobody was alerted during the Mac mini's 1 h+ outage, and why WDA failures need xcresult spelunking. | `app.ts:574`, `connection-manager.ts:255-266` | Add `/health/ready` (checks DB, Appium, wda socket) and Prometheus `/metrics`. Add a push heartbeat from each host to an external dead-man's switch. Write a rotated log per UDID. |
| C6 | **The Apple 100-device limit applies per Team per membership year.** The code supports one `WDA_XCTESTRUN` per host. | `runner-args.ts:25` | One Team per ~100 phones, each an organisation with its own D-U-N-S number. Store Team and xctestrun per device. Build a versioned signing artifact per Team and alert on profile expiry. Enterprise is not a realistic route. |
| C7 | **There is no tenant model (a blocker for the PaaS).** There's only global admin plus grants. Assets have no owner, and uploads can be up to 20 × 2 GB to local disk. | `policy.ts`, `app.ts:249,942` | Add `tenant_id` everywhere, separate tenant-admin from platform-operator, and add quotas plus an upload cap. |
| C8 | **There is no CI and no versioned deploy.** `.github/` is missing, and the Mac mini is rsynced from a laptop. The `RELEASED` file is read but never written. | `app.ts:579` | GitHub Actions `npm run check`, a release tarball per SHA, a `releases/<sha>` + `current` symlink, migrate → smoke test → flip. Rollback means re-pointing the symlink. |

## High

- **Processes per phone.** Replace N supervisor processes with one process driven by a single shared sweep. Spawn `xcodebuild` only for phones that are attached. Limit concurrent launches per host to about 4–8, with jittered backoff: today every phone relaunches at once after a power dip (`start.ts:203`, `connection-manager.ts:241`).
- **Job expiry shorter than the job.** `expireInSeconds` is the task's duration plus 600 s, but a job can wait up to its 30-minute window first. A job that expires mid-run can be claimed a second time while the old process is still running (`repository.ts:242,330`). Set expiry to window + duration + margin.
- **DB connections.** A drizzle pool (10), a pg-boss pool (10) and a LISTEN connection per process: about 40 per host, which exhausts `max_connections=100` at about 3 hosts. Size the pools explicitly and add PgBouncer.
- **DB load that grows with running jobs.** A `stopRequested` poll every 1 s per job, log inserts every 3 s per job, and reconcile on every host every 60 s. Use NOTIFY for stops, batch the log inserts, and elect one host (advisory lock) for reconcile and cleanup.
- **One Appium server per host** (`:4725`). Pool one Appium per 10–20 phones, or drive WDA directly the way remote control already does.
- **Per-request cost in web.** Every request runs session + user (+ groups + grants) queries against a pool of 10, and re-parses `devices.json` for every device check (`accounts.ts:151`, `registry.ts:105`). Cache the session and access for 10–30 s, hold the registry in memory, and invalidate on writes.
- **Thumbnails compete with automation for WDA.** A full PNG screenshot every 4 s per viewed phone, decoded on the main thread (`app.ts:779`). Freeze or slow thumbnails while a task runs, take frames from MJPEG, and bound sharp concurrency.
- **Grid fragment.** The whole grid is re-rendered and swapped per client per poll, about 300 KB every 10 s at 300 phones (`app.ts:1008`). Render once per interval and share it, add an ETag, filter by rack, and swap only the cards that changed.
- **Audit log.** Only login and Team changes are recorded, and only to the console. Add an append-only `audit_log` covering every non-GET.
- **Postgres.** It runs in Docker Desktop, needs a GUI login, has `KeepAlive=false` and has no backups (`db-up.sh`, `install-agents.sh:69`). Use native Postgres or managed Postgres with PITR, plus an encrypted off-host `pg_dump` and a restore test.

## Medium

- Failures (`execution.deadlineAt`) have no dead-letter queue or alert.
- Side-effecting tasks have no `effect_committed_at` checkpoint.
- Every schedule fires on the minute; add jitter.
- The schedule-gap check can race; take an advisory lock.
- Queues for disabled phones are never unsubscribed.
- The worker's device loop has no per-device try/catch.
- MJPEG opens one upstream per viewer, with no stall watchdog.
- There are no Fastify timeouts and no rate limits beyond login.
- The login throttle is in memory only.
- `/health` exposes versions to anonymous callers.
- Logs never rotate.
- Secrets live in plain `.env`.
- Port fallbacks to 8100/9100 can collide.

## Already done well

- The grid fetches only visible tiles, pauses when hidden and caps requests in flight.
- Screenshot requests for a phone share one fetch, with a cooldown when the phone fails.
- Recurrence collapses missed runs into one instead of bursting.
- The pg-boss singleton policy gives correct per-device exclusivity.
- `materializeDue` uses `skip locked`.
- An ungranted phone returns 404.

## Target architecture

```
                 Cloudflare ── control plane (Linux VM or phone-less Mac)
                               web ×2 (stateless) · scheduler (leader) · Postgres (managed, PITR)
                               Prometheus/Loki/Grafana · alerting
                                        │ Tailscale
          ┌─────────────────────────────┼─────────────────────────────┐
     Mac host A (≤ ~35 phones)     Mac host B                    Mac host C …
     host-agent: supervisor (1 proc), Appium pool, worker for own phones,
     screenshot/MJPEG/actions API (authed), metrics, heartbeat
     powered switchable hubs (Cambrionix/Acroname) · UPS
```

## Roadmap

**Phase 1: harden the single host (2–3 weeks)**
1. Drain the worker gracefully; stop restarting it (done in the auto-register script).
2. Isolate each schedule in `materializeDue`, and fix the job expiry.
3. Replace the O(n²) discovery with the shared sweep.
4. Per-UDID xcodebuild logs, `/health/ready`, `/metrics`, an off-host heartbeat and alerts: host missing for more than 3 min, phone off USB for more than 10 min, WDA not ready for more than 15 min, queue backlog, backup age.
5. Native Postgres with encrypted off-host backups.
6. CI, release tarballs and symlinked deploys with rollback.
7. Cache the session, access and registry in the web tier; protect thumbnails.
8. One supervisor process with a launch limit (lifts the per-host ceiling from about 45 phones to about the USB/Xcode limit).

**Phase 2: multi-host (4–6 weeks)**
- Move devices into Postgres with `host_id`, and run a host agent on each Mac.
- Move web and the scheduler off the Macs. Size the pools and add PgBouncer.
- Pool Appium servers.
- Build a signing pipeline per Team (App Store Connect API for UDID registration), and pin Xcode per host pool (an iOS 16 pool on Xcode 16).
- Automate onboarding: Apple Configurator supervision, auto-registration (a prototype is `~/phone-farm-tools/auto-register.sh` on the Mac mini) and auto-signing.

**Phase 3: PaaS**
- Tenants, quotas and an audit log.
- Team and slot inventory.
- SLOs (phone-ready %, run success %).
- Host provisioning in under 1 h (Ansible/MDM) and spare-host failover.
- On-call.

## Open questions for the owner
- Target number of phones per Mac? That sets RAM (16 GB is enough for about 35 today, or 64 GB+) and the hub design.
- How many Apple Teams, and under which legal entities?
- Is the control plane on cloud or on site?

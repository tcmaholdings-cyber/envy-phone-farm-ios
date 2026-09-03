# Operations runbook

Day-two operations for a farm host: starting, stopping, watching, fixing,
backing up, upgrading. Commands assume the repo at `~/phone-farm`, the launchd
agents from `deploy/launchd/` and the label prefix set at install time
(`$P` below, e.g. `com.envy.phone-farm`).

## Start / stop / restart

```sh
P=com.envy.phone-farm; U=gui/$(id -u)
launchctl list | grep $P                      # what is loaded (PID, last exit code)
launchctl kickstart -k $U/$P.web              # restart one agent (also: worker, wda-service, appium)
launchctl bootout $U/$P.worker                # stop one until next login / bootstrap
launchctl bootstrap $U ~/Library/LaunchAgents/$P.worker.plist   # start it again
deploy/launchd/uninstall-agents.sh            # stop + remove all five
deploy/launchd/install-agents.sh              # (re)install all five — idempotent
```

Order matters only at first boot: `db` → `appium` + `wda-service` → `worker`
+ `web`. KeepAlive restarts a crashed process after 10 s, so a temporarily
missing dependency just produces a few retries in the log.

Postgres: `docker compose ps`, `npm run db:up`, `docker compose stop postgres`.

## Watching

| What | How |
| --- | --- |
| Process logs | `tail -f logs/web.log logs/worker.log logs/wda-service.log logs/appium.log` |
| Dashboard health | `curl -s http://127.0.0.1:3000/health` — loaded plugins + versions |
| Per-phone state | `curl -s --unix-socket .wda/wda-service.sock http://x/health` — `physical`, `wda`, `appium`, `message` per UDID |
| Phones the OS sees | `xcrun xctrace list devices` |
| Executions | dashboard → device → *Execution history*, or `GET /api/executions?udid=…`; full log `GET /api/executions/:id` |
| Queue depth | `psql "$DATABASE_URL" -c "select name, count(*) from pgboss.job where state in ('created','active') group by 1"` |

Set up an external uptime check against `/health` (through the SSH tunnel or
VPN) and alert if any phone is not `ready` for more than 15 minutes.

## Common failures

| Symptom | Cause → fix |
| --- | --- |
| Phone shows **Offline**, `xctrace` lists it under *Devices Offline* | USB. Reseat the cable/hub port; charge-only cable; phone rebooted and is locked → unlock once. |
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
3. Dashboard → **Register device** → checks → Finalize. Pick free `wdaLocalPort` / `mjpegLocalPort` (the wizard proposes the next ones).
4. Device page → *Touch points* → calibrate; run a `doomscroll` once.

## Retiring a phone

Dashboard → device → *Danger zone* → **Remove device** (cancels its schedules,
forgets its entry; WebDriverAgent stays installed on the phone). To pause
without forgetting: **Disconnect** on the grid (`"disabled": true`).

## Backups

Nightly, from a cron/launchd job on the host:

```sh
docker compose exec -T postgres pg_dump -U phone_farm phone_farm | gzip > backups/pg-$(date +%F).sql.gz
tar czf backups/state-$(date +%F).tgz .env devices.json .scheduler-data/assets
```

Restore: `gunzip -c backups/pg-….sql.gz | docker compose exec -T postgres psql -U phone_farm phone_farm`,
put the two files back, run `npm run db:migrate`, restart the agents.

## Upgrading the software

```sh
git fetch && git checkout <tag>          # tags are the supported upgrade points
npm install
npm run appium:install-driver            # if the pinned XCUITest version changed
npm run db:migrate                       # idempotent
npm run check                            # typecheck + tests must pass before restarting
deploy/launchd/install-agents.sh         # re-reads plists and restarts all agents
```

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
- The dashboard stays on loopback or behind a VPN + auth provider (`configuration.md` → Exposure).
- Plugins are trusted code: install only reviewed, pinned packages (`PLUGIN_DEVELOPMENT.md`).

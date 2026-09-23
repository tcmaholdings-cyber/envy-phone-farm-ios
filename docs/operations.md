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
3. Dashboard → **Register a phone** → checks → **Finish registration**. Pick free `wdaLocalPort` / `mjpegLocalPort` (the wizard proposes the next ones), and record the **rack slot** so the phone can be found later.
4. Device page → *Touch points* → calibrate; run a `doomscroll` once.

### Signing on another Mac

A farm host does not have to hold the Apple ID. Sign on a Mac that does, copy the build:

1. Register the new phone's UDID with the Team: developer.apple.com → *Devices* →
   *+* (or *Register Multiple Devices* with a tab-separated `Device ID / Device Name / Device Platform` file).
2. On the signing Mac: `npm run wda:prepare -- --generic` → `.wda/prebuilt/Build/Products`.
   Automatic signing puts every registered device into the profile, so re-run it after each registration.
3. Copy that folder to the host, e.g. `rsync -a .wda/prebuilt/Build/Products/ host:phone-farm/.wda/prebuilt/`,
   and set `WDA_XCTESTRUN=/Users/<user>/phone-farm/.wda/prebuilt/WebDriverAgentRunner_iphoneos<sdk>-arm64.xctestrun`
   in the host's `.env` (once).
4. Restart `wda-service` on the host. Skip `wda:prepare` there; the wizard's *Prepare* step signs locally and does not apply.

## Retiring a phone

Dashboard → device → **Remove device** (right end of the settings row; cancels its schedules,
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

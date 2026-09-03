# Configuration reference

Everything the farm reads at startup, where it lives, and what changes it.
Three files carry all state: `.env` (settings + secrets), `devices.json`
(the fleet), and PostgreSQL (schedules, executions, assets). All three are
git-ignored except `.env.example`.

## `.env`

Loaded by every `npm run …` script (`--env-file-if-exists=.env`, then
`.env.devices` if present). Restart a process to pick up a change.

### Network & processes

| Key | Default | Meaning |
| --- | --- | --- |
| `WEB_HOST` | `127.0.0.1` | Bind address of the dashboard/API. Anything but loopback **requires** `PHONE_FARM_AUTH_PLUGIN` (startup fails otherwise). |
| `WEB_PORT` | `3000` | Dashboard/API port. |
| `APPIUM_HOST` / `APPIUM_PORT` | `127.0.0.1` / `4725` | Where task subprocesses find Appium. The `npm run appium` script binds the same address. |
| `WDA_LOCAL_PORT` / `MJPEG_LOCAL_PORT` | `8100` / `9100` | Base ports for the per-phone USB forwards; each registered device carries its own `wdaLocalPort` / `mjpegLocalPort` (8100, 8101, … / 9100, 9101, …). |
| `PHONE_FARM_TRUSTED_ORIGINS` | — | Comma-separated origins allowed to make state-changing browser requests besides the page's own origin (CSRF guard). API clients use `Authorization: Bearer` instead. |

### Database

| Key | Meaning |
| --- | --- |
| `DATABASE_URL` | `postgresql://user:password@127.0.0.1:5432/phone_farm`. Used by `web`, `worker`, `db:migrate`, `db:setup`. |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_PORT` | Only for the bundled `docker compose` Postgres. Keep them consistent with `DATABASE_URL`. |

### Devices, Xcode & WebDriverAgent

| Key | Meaning |
| --- | --- |
| `DEVICES_CONFIG_PATH` | Path of the fleet file (default `devices.json`). |
| `SCHEDULER_DATA_DIR` | Uploaded media for post-style tasks (default `.scheduler-data`). |
| `XCODE_ORG_ID` | Apple Developer **Team ID** used to sign WebDriverAgent. |
| `XCODE_SIGNING_ID` | Signing identity, normally `Apple Development`. |
| `WDA_BUNDLE_ID` | Bundle id of the signed WebDriverAgent runner, unique per Team. |
| `IOS_PLATFORM_VERSION` | iOS version of the fleet (Appium capability). |
| `XCODE_DEVELOPER_DIR` | Optional. Pin a specific Xcode (`/Applications/Xcode-26.app/Contents/Developer`) instead of `xcode-select`'s. |
| `IOS_UDID` | Optional. Pins which phone the CLI scripts (`wda:prepare`, `wda:start`) target when more than one is connected; `--udid` wins over it. |
| `IOS_PASSCODE` / `IOS_PASSCODE_<UDID>` | **Deprecated** fallback for device passcodes; use `devices.json`. |

### Plugins & authentication

| Key | Meaning |
| --- | --- |
| `PHONE_FARM_PLUGINS` | Comma-separated ESM package names of extra task plugins. Empty = only the built-in TikTok plugin. `web` and `worker` must have identical values. |
| `PHONE_FARM_AUTH_PLUGIN` | ESM module exporting an `AuthProvider` (`src/plugin.ts`). Mandatory before `WEB_HOST` leaves loopback. |
| `TIKTOK_BUNDLE_ID` | `com.zhiliaoapp.musically` — the TikTok app the built-in plugin drives. |

### Branding

`PHONE_FARM_BRAND_NAME`, `PHONE_FARM_BRAND_TITLE`, `PHONE_FARM_BRAND_BY`,
`PHONE_FARM_BRAND_BY_URL`, `PHONE_FARM_BRAND_LOGO`, `PHONE_FARM_FOOTER_TEXT`,
`PHONE_FARM_BRAND_URL` — see [branding.md](branding.md).

### launchd

`PHONE_FARM_LAUNCHD_PREFIX` (default `com.phone-farm`) — label prefix used by
`deploy/launchd/install-agents.sh`; not read by the application itself.

### Advanced / tuning (rarely needed)

| Key | Default | Meaning |
| --- | --- | --- |
| `DATABASE_POOL_SIZE` | `10` | Max Postgres connections per process (`web` and `worker` each open a pool). |
| `SCHEDULER_RUN_WINDOW_MINUTES` | `30` | Grace period after a schedule's time before the execution is abandoned as "window expired". A schedule's own `runWindowMinutes` overrides it. |
| `SCHEDULER_MIN_TASK_GAP_MINUTES` | see `DEFAULT_MIN_SCHEDULE_GAP_MINUTES` in `src/scheduler/repository.ts` | Minimum spacing enforced between tasks on one device. |
| `SCHEDULER_HISTORY_DAYS` | `30` | Execution history kept by the cleanup pass. |
| `SCHEDULER_ORPHAN_ASSET_HOURS` | — | Age after which uploaded media with no remaining schedule is deleted. |
| `PUBLIC_ORIGIN` | — | The browser-facing origin (`https://farm.example`) when the dashboard sits behind a reverse proxy; counted as trusted by the CSRF guard. |
| `PHONE_FARM_RELEASE_FILE` | `RELEASED` | JSON file whose contents `/health` reports as `release` (deploy stamps). |
| `WDA_SERVICE_SOCKET` | `.wda/wda-service.sock` | Path of the supervisor's control socket. |
| `WDA_PROJECT_PATH`, `XCUITEST_DRIVER_PATH`, `WDA_BOOTSTRAP_PATH` | derived from `.appium2` | Override where the WebDriverAgent project / XCUITest driver are found. |
| `WDA_URL`, `WDA_REMOTE_PORT`, `MJPEG_REMOTE_PORT` | — / `8100` / `9100` | Used by the standalone TikTok entrypoints when run by hand outside the worker. |
| `ALLOW_PROVISIONING_DEVICE_REGISTRATION` | `false` | `true` lets `xcodebuild` register a newly connected UDID with the Team automatically during `wda:prepare`. |
| `SHOW_XCODE_LOG` | `false` | Verbose Xcode output from Appium sessions (debugging only). |
| `DOOMSCROLL_PERSONALITY`, `TIKTOK_SWITCH_ACCOUNT` | set per task | Internal: passed from the task payload to the subprocess by the plugin. Not operator configuration. |

## `devices.json`

The fleet. Written by the registration wizard and the API; hand-editable
while the processes are stopped. Mode `0600`.

```jsonc
[
  {
    "name": "Rack A · 03",                       // label shown everywhere
    "udid": "00008101-001964122660001E",          // from `xcrun xctrace list devices`
    "coordinateProfile": "iphone8",              // tap layout; see coordinates.md
    "coordinates": { "like": { "x": 350, "y": 320 } },   // optional per-device overrides of the 15 calibratable TikTok points
    "wdaLocalPort": 8101,                        // unique per device
    "mjpegLocalPort": 9101,                      // unique per device
    "passcode": "123456",                        // unlock code; never returned by the API
    "disabled": false,                           // true = keep the entry, supervise nothing
    "pluginData": {
      "com.git-agni.tiktok": { "accounts": ["@handle"] }   // per-plugin, per-device, non-secret
    }
  }
]
```

Rules:

- `udid`, `wdaLocalPort`, `mjpegLocalPort` must be unique across entries.
- `coordinateProfile` must exist in `src/devices/coordinates.ts` (only
  `iphone8` ships); an unknown key fails at load with a clear message.
- `pluginData` is per plugin id and never holds secrets.
- The worker re-reads the file every 30 s; `wda-service` and `web` watch it
  too. Prefer `PATCH /api/devices/:udid` over editing while running.

## Ports (all loopback)

| Port | Process |
| --- | --- |
| 3000 | `web` dashboard + API |
| 4725 | Appium |
| 5432 | PostgreSQL (docker, bound to 127.0.0.1) |
| 8100 + n | WebDriverAgent of device *n* (USB forward) |
| 9100 + n | MJPEG stream of device *n* (USB forward) |
| `.wda/wda-service.sock` | `wda-service` control socket (`/health`) |

## Exposure — reaching the dashboard from another machine

The safe default is loopback only. Options, in order of preference:

1. **SSH tunnel** from the operator's laptop: `ssh -N -L 3000:127.0.0.1:3000 farm@<mac-mini>` then open `http://127.0.0.1:3000`. No config change.
2. **Tailscale / VPN** plus an auth provider: set `PHONE_FARM_AUTH_PLUGIN`, then `WEB_HOST=<tailscale-ip>`. Add the browser origin to `PHONE_FARM_TRUSTED_ORIGINS` if it differs from the bind host.
3. Never publish port 3000 to the internet. Appium and Postgres stay on loopback in every configuration.

## State directories

| Path | Contents | Back up? |
| --- | --- | --- |
| `.env` | settings + secrets | yes (encrypted) |
| `devices.json` | fleet, passcodes, calibration | yes (encrypted) |
| PostgreSQL volume `phone-farm-postgres` | schedules, executions, logs, asset index | yes — `pg_dump` |
| `.scheduler-data/assets/` | uploaded media for post tasks | yes |
| `.wda/` | socket + locks | no |
| `.appium2/` | pinned XCUITest driver | no (re-run `appium:install-driver`) |
| `~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*` | signed WDA build | no (re-run `wda:prepare`) |
| `logs/` | launchd agent logs | no |

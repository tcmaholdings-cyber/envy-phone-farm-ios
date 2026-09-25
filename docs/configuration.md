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

### Fleet-scale polling

Defaults are tuned for a rack of twenty phones behind one hub. Every value here
trades dashboard freshness against USB and lockdown traffic; raise them on a
big rack that feels sluggish, lower them on a two-phone bench.

| Key | Default | Meaning |
| --- | --- | --- |
| `PHONE_FARM_DISCOVERY_TTL_MS` | `2000` | How long a usbmux device sweep is reused. One sweep costs three lockdown round trips *per attached phone*; the grid, the WDA supervisor and every `/api/devices` caller share it. `0` disables the cache. The registration wizard's **Recheck** always forces a fresh sweep regardless. |
| `PHONE_FARM_SCREENSHOT_TTL_MS` | `4000` | How long a device's grid still is reused. Concurrent requests for the same phone are always coalesced onto one WebDriverAgent round trip, so extra dashboard tabs are free either way. `GET …/remote/screenshot?fresh=1` bypasses it. |
| `PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS` | `20000` | After a phone's screenshot fails (WebDriverAgent down or wedged), how long further requests for it fail at once instead of waiting on the phone again. `…/remote/screenshot?fresh=1`, a registry change and **Reconnect** clear it. `0` disables it. |
| `PHONE_FARM_GRID_SCREENSHOT_TIMEOUT_MS` | `3000` | WebDriverAgent deadline for a grid thumbnail. A phone slower than this shows its last still, marked stale, instead of holding a browser connection for the 10 s default. Other WDA calls keep the 10 s default: a full-size `/remote/screenshot` never joins an in-flight grid fetch, and a grid timeout does not put it into the failure cooldown. |
| `PHONE_FARM_GRID_POLL_SECONDS` | `5`, or `10` above ten active phones | How often the device grid refreshes its cards (status, slot, accounts), and how often each visible card's thumbnail is revalidated. Thumbnails are fetched by the browser on staggered per-card timers, at most four at a time, and are skipped while the tab is hidden or the card is scrolled off screen. |

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
| `PHONE_FARM_AUTH_PLUGIN` | `builtin` for the accounts shipped with the farm (users, groups and per-phone access in Postgres — see [Built-in accounts](#built-in-accounts)), or an ESM module exporting an `AuthProvider` (`src/plugin.ts`). Unset = no sign-in (loopback only). Mandatory before `WEB_HOST` leaves loopback, **and before the dashboard is published through a tunnel**. |
| `PHONE_FARM_SESSION_IDLE_HOURS` | Built-in accounts only. A session ends after this many hours without a request (default `12`). |
| `PHONE_FARM_SESSION_MAX_DAYS` | Built-in accounts only. A session ends this many days after sign-in however active it is (default `7`). |
| `TIKTOK_BUNDLE_ID` | `com.zhiliaoapp.musically` — the TikTok app the built-in plugin drives. |

### Built-in accounts

`PHONE_FARM_AUTH_PLUGIN=builtin` turns on sign-in with accounts stored in the
same Postgres database (schema `auth`, created by `npm run db:migrate` —
migration `drizzle/0002_builtin_auth.sql`). Nothing else is required; the
database connection is `DATABASE_URL`.

- **Users** have a username (lower-case), a display name, a role and a password
  hash (scrypt, per-user salt). Passwords are at least 12 characters. New users
  and reset passwords get a generated temporary password that is shown once and
  must be changed at first sign-in.
- **Roles**: `admin` can do everything, including the Team page, registering
  phones and device settings. `operator` sees and acts only on the phones
  granted to them — see [the access model](operations.md#team-access-and-vas).
- **Sessions** are server-side: the browser holds an `HttpOnly`,
  `SameSite=Lax` cookie `pf_session`; the database holds only a SHA-256 hash of
  it. The cookie is `Secure` whenever the request arrived over HTTPS — directly,
  or from a loopback proxy that says so (`X-Forwarded-Proto: https` or
  Cloudflare's `CF-Visitor`) — and stays usable on plain `http://127.0.0.1`.
- **Sign-in throttling**: after 5 failed attempts for one username, or 20 from
  one client IP, further attempts wait 30 s, doubling up to 15 min. Behind a
  Cloudflare tunnel the client IP is `CF-Connecting-IP`, trusted **only** when
  the TCP peer is loopback (the local `cloudflared`). Throttle state is in
  memory and resets when `web` restarts.
- **Audit**: sign-ins (success, failure, throttled), sign-outs, password
  changes and every user / group / grant change are logged by `web` as
  `audit` entries naming the actor. Passwords and tokens never appear.

Public without a session: `/login`, `/logout`, `/health`, `/health/ready`,
and the stylesheet, fonts and logo the sign-in page uses. `/metrics` needs no
session either but checks its own bearer token (`PHONE_FARM_METRICS_TOKEN`).
Everything else redirects a browser to `/login` or answers `401`.

A third-party `AuthProvider` keeps working as before: every user it signs in
can do everything, unless it returns `access` (`UserAccess` in
`src/plugin.ts`) with the user, in which case the same per-phone rules apply.

### Branding

`PHONE_FARM_BRAND_NAME`, `PHONE_FARM_BRAND_TITLE`, `PHONE_FARM_BRAND_BY`,
`PHONE_FARM_BRAND_BY_URL`, `PHONE_FARM_BRAND_LOGO`, `PHONE_FARM_FOOTER_TEXT`,
`PHONE_FARM_BRAND_URL` — see [branding.md](branding.md).

### launchd

`PHONE_FARM_LAUNCHD_PREFIX` (default `com.phone-farm`) — label prefix used by
`deploy/launchd/install-agents.sh`; not read by the application itself.

`PHONE_FARM_WORKER_EXIT_TIMEOUT` (default `180`) — seconds launchd waits after
SIGTERM before it SIGKILLs the worker (the plist's `ExitTimeOut`). Keep it above
`WORKER_DRAIN_SECONDS` + `WORKER_KILL_GRACE_SECONDS` + about 20 s, and re-run the
installer after changing either.

### Monitoring

See *Monitoring and alerts* in [operations.md](operations.md#monitoring-and-alerts).

| Key | Default | Meaning |
| --- | --- | --- |
| `PHONE_FARM_METRICS_TOKEN` | — | Bearer token for `GET /metrics` (Prometheus). Unset = the endpoint answers 404. Long and random (`openssl rand -hex 32`); it is a secret. |
| `PHONE_FARM_HEARTBEAT_URL` | — | Healthchecks.io / Uptime Kuma push URL. When set, `install-agents.sh` installs the `<prefix>.heartbeat` agent, which pings it every 60 s while `GET /health/ready` answers 200. It is a credential: keep it in `.env`; it is never written into a plist. |
| `PHONE_FARM_READY_URL` | `http://127.0.0.1:$WEB_PORT/health/ready` | What the heartbeat agent checks. Change it only when the dashboard is not reachable on loopback. |
| `PHONE_FARM_WORKER_STALE_SECONDS` | `60` | `/health/ready` fails the `worker` check when the freshest worker heartbeat (written every 15 s) is older than this. |
| `WDA_LOG_DIR` | `.wda/logs` | Where `wda-service` writes each phone's supervisor + xcodebuild output, `<udid>.log`. |
| `WDA_LOG_MAX_BYTES` / `WDA_LOG_FILES` | `5242880` / `3` | Rotate a phone's log at 5 MB, keeping `<udid>.log.1` … `.3`. |
| `WDA_LOG_RECENT_LINES` | `200` | Lines per phone kept in memory for the socket and `GET /api/devices/:udid/wda-log`. |

### Advanced / tuning (rarely needed)

| Key | Default | Meaning |
| --- | --- | --- |
| `DATABASE_POOL_SIZE` | `10` | Max Postgres connections per process (`web` and `worker` each open a pool). |
| `SCHEDULER_RUN_WINDOW_MINUTES` | `30` | Grace period after a schedule's time before the execution is abandoned as "window expired". A schedule's own `runWindowMinutes` overrides it. |
| `SCHEDULER_MIN_TASK_GAP_MINUTES` | see `DEFAULT_MIN_SCHEDULE_GAP_MINUTES` in `src/scheduler/repository.ts` | Minimum spacing enforced between tasks on one device. |
| `SCHEDULER_HISTORY_DAYS` | `30` | Execution history kept by the cleanup pass. |
| `SCHEDULER_ORPHAN_ASSET_HOURS` | — | Age after which uploaded media with no remaining schedule is deleted. |
| `WORKER_DRAIN_SECONDS` | `120` | On SIGTERM the worker stops taking jobs and waits this long for running tasks. Stoppable tasks (doomscroll) are asked to stop at once; tasks that cannot be stopped safely (a post) are left to finish, then stopped when the time is up. |
| `WORKER_KILL_GRACE_SECONDS` | `15` | After a task subprocess is sent SIGTERM (a Stop, or the drain deadline), how long before it is SIGKILLed. |
| `PUBLIC_ORIGIN` | — | The browser-facing origin (`https://farm.example`) when the dashboard sits behind a reverse proxy; counted as trusted by the CSRF guard. |
| `PHONE_FARM_RELEASE_FILE` | `RELEASED` | JSON file (deploy stamp) whose `sha` `/health` reports as `release`. |
| `WDA_SERVICE_SOCKET` | `.wda/wda-service.sock` | Path of the supervisor's control socket. |
| `WDA_PROJECT_PATH`, `XCUITEST_DRIVER_PATH`, `WDA_BOOTSTRAP_PATH` | derived from `.appium2` | Override where the WebDriverAgent project / XCUITest driver are found. |
| `WDA_URL`, `WDA_REMOTE_PORT`, `MJPEG_REMOTE_PORT` | — / `8100` / `9100` | Used by the standalone TikTok entrypoints when run by hand outside the worker. |
| `WDA_XCTESTRUN` | — | Path to a copied `.xctestrun` from `wda:prepare -- --generic` on another Mac. When set, WDA runs that pre-signed build and this host needs no Team, signing identity or Apple ID — only Xcode. See *Signing on another Mac* in `operations.md`. |
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
    "rackSlot": "hub 2 · port 7",                // optional: where the phone physically sits
    "rack": "1",                                 // optional: which rack (short label); access can be granted per rack
    "model": "iPhone 12 mini",                   // filled in from USB discovery; access can be granted per model
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
- `rackSlot` is free text (trimmed, 40 characters), purely an operator label:
  nothing resolves it. It exists so "Rack A · 03 is offline" maps to a phone
  someone can walk up to. Set it in the registration wizard, on the device page
  (*Rack slot*), or with `PATCH /api/devices/:udid`; `""` clears it.
- `rack` is a short label (trimmed, 20 characters) shared by every phone in
  one rack, e.g. `1`. Team access can be granted per rack, so keep it
  consistent. Set it in the registration wizard, on the device page
  (*Rack & slot*), with `PATCH /api/devices/:udid` (`{"rack":"1"}`, `""` clears
  it), or for many phones at once with `npm run devices -- set-rack 1 --all`.
- `model` is the marketing name (`iPhone 12 mini`). The dashboard fills it in
  the first time it sees the phone connected over USB and the field is empty;
  it never overwrites a value. The registration wizard sets it at once. Team
  access can be granted per model.
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
| `.wda/wda-service.sock` | `wda-service` control socket (`/health`, `/devices`, `/devices/:udid/logs`) |

## Exposure — reaching the dashboard from another machine

The safe default is loopback only. Options, in order of preference:

1. **SSH tunnel** from the operator's laptop: `ssh -N -L 3000:127.0.0.1:3000 farm@<mac-mini>` then open `http://127.0.0.1:3000`. No config change.
2. **Tailscale / VPN** plus an auth provider: set `PHONE_FARM_AUTH_PLUGIN`, then `WEB_HOST=<tailscale-ip>`. Add the browser origin to `PHONE_FARM_TRUSTED_ORIGINS` if it differs from the bind host.
3. **Cloudflare Tunnel** (`cloudflared` → `http://127.0.0.1:3000`) plus `PHONE_FARM_AUTH_PLUGIN=builtin`. `WEB_HOST` stays `127.0.0.1`, so the startup check (`assertSafeBind`) cannot tell the dashboard is public: **turning on sign-in is on you**. The CSRF guard compares the browser's `Origin` with the `Host` cloudflared forwards, which is the public hostname by default; only if the tunnel rewrites `Host` (`httpHostHeader`) set `PUBLIC_ORIGIN=https://<your hostname>` — and then also `PHONE_FARM_TRUSTED_ORIGINS=http://127.0.0.1:3000` if people still use the dashboard locally. Session cookies become `Secure` automatically and sign-in throttling uses the visitor's `CF-Connecting-IP`.
4. Never publish port 3000 directly (port forward, `0.0.0.0` without auth). Appium and Postgres stay on loopback in every configuration.

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

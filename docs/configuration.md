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
| `PHONE_FARM_MAX_UPLOAD_BYTES` | Largest single uploaded file, in bytes (default `209715200`, 200 MiB). A bigger file fails the upload with 413. Each tenant's total is limited separately by its `maxUploadBytes` quota (default 5 GiB) — see [tenants.md](tenants.md#quotas). |
| `XCODE_ORG_ID` | Apple Developer **Team ID** used to sign WebDriverAgent. |
| `XCODE_SIGNING_ID` | Signing identity, normally `Apple Development`. |
| `WDA_BUNDLE_ID` | Bundle id of the signed WebDriverAgent runner, unique per Team. |
| `XCODE_AUTH_KEY_PATH`, `XCODE_AUTH_KEY_ID`, `XCODE_AUTH_KEY_ISSUER_ID` | Optional App Store Connect API key (`.p8` path, key id, issuer id) passed to `xcodebuild` by `wda:prepare`, so signing works without an Apple ID signed in to Xcode. Set all three or none. Create the key in App Store Connect → Users and Access → Integrations with the Admin role. |
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
| `PHONE_FARM_AUDIT_RETENTION_DAYS` | Built-in accounts only. The worker deletes audit rows older than this (default `365`; at least `30`, which the database enforces; `0` keeps them forever). |
| `TIKTOK_BUNDLE_ID` | `com.zhiliaoapp.musically` — the TikTok app the built-in plugin drives. |

### Built-in accounts

`PHONE_FARM_AUTH_PLUGIN=builtin` turns on sign-in with accounts stored in the
same Postgres database (schema `auth`, created by `npm run db:migrate` —
migrations `drizzle/0002_builtin_auth.sql` and `drizzle/0006_tenants.sql`).
Nothing else is required; the database connection is `DATABASE_URL`.

- **Users** have a username (lower-case), a display name, a role and a password
  hash (scrypt, per-user salt). Passwords are at least 12 characters. New users
  and reset passwords get a generated temporary password that is shown once and
  must be changed at first sign-in.
- **Tenants and roles**: every person except platform staff belongs to one
  tenant (organisation). `platform` (the farm operator's staff) sees every
  tenant and alone registers and configures phones; `admin` runs one tenant
  (its phones, people, groups and grants); `operator` sees and acts only on the
  phones granted to them in their tenant. Another tenant's things answer 404.
  See [tenants.md](tenants.md) and [the access model](operations.md#team-access-and-vas).
- **Sessions** are server-side: the browser holds an `HttpOnly`,
  `SameSite=Lax` cookie `pf_session`; the database holds only a SHA-256 hash of
  it. The cookie is `Secure` whenever the request arrived over HTTPS — directly,
  or from a loopback proxy that says so (`X-Forwarded-Proto: https` or
  Cloudflare's `CF-Visitor`) — and stays usable on plain `http://127.0.0.1`.
- **Sign-in throttling**: after 5 failed attempts for one username, or 20 from
  one client IP, further attempts wait 30 s, doubling up to 15 min. Behind a
  Cloudflare tunnel the client IP is `CF-Connecting-IP`, trusted **only** when
  the TCP peer is loopback (the local `cloudflared`). The counts live in
  `auth.login_throttle`: they survive a restart and are shared by every web replica.
- **Audit**: every state-changing request, and every sign-in (success,
  failure, throttled), sign-out, password change and user / group / grant /
  tenant change, is written to the append-only `auth.audit_log` (and the
  server log) with the actor, tenant, route pattern, target and outcome.
  Request bodies, passwords, tokens and typed text never appear. Read it on
  the **Audit** page or `GET /api/audit` ([tenants.md](tenants.md#audit-log)).

Public without a session: `/login`, `/logout`, `/health`, `/health/ready`,
and the stylesheet, fonts and logo the sign-in page uses. `/metrics` needs no
session either but checks its own bearer token (`PHONE_FARM_METRICS_TOKEN`).
Everything else redirects a browser to `/login` or answers `401`.

A third-party `AuthProvider` keeps working as before: every user it signs in
can do everything, unless it returns `access` (`UserAccess` in
`src/plugin.ts`) with the user, in which case the same per-phone rules apply
(and, with a `tenantId`, the tenant rules; an `admin` without one stays farm-wide).

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

### Multi-host

Several Macs sharing one Postgres, each owning its phones — see
[multi-host.md](multi-host.md). A single Mac needs none of these.

| Key | Default | Meaning |
| --- | --- | --- |
| `PHONE_FARM_REGISTRY` | `file` | Where registered phones live: `file` (`devices.json` on this host) or `postgres` (`fleet.devices`, shared by every host; run `npm run devices -- import-to-db` first). Every process on every host must agree. Anything else fails at startup. |
| `PHONE_FARM_HOST_ID` | the hostname | This Mac's id: letters, digits, `.`, `_`, `-`, up to 63. The worker works and `wda-service` supervises only phones with this `host_id`. Set it explicitly on multi-host farms. |
| `PHONE_FARM_HOST_NAME` | the id | Display name shown on other hosts' grid cards (`fleet.hosts.display_name`). |
| `PHONE_FARM_DEVICE_SECRETS_PATH` | `device-secrets.json` beside the real `devices.json` | With the Postgres registry, this host's passcodes (0600, git-ignored). Postgres only stores `has_passcode`. |
| `PHONE_FARM_AGENT_TOKEN` | — | Shared bearer token for the `/agent/*` host-agent routes, identical on every host, at least 32 characters (`openssl rand -hex 32`). Unset = the agent answers 404 and this dashboard cannot reach other hosts' phones. A secret. |
| `PHONE_FARM_AGENT_BIND` | — | `<ip>:<port>` for the agent listener, normally this Mac's Tailscale IP (`100.101.74.35:3001`). Serves only `/agent/*`. Refuses `0.0.0.0`/`::`, hostnames, and a missing or short token. The dashboard's own bind (`WEB_HOST`) is unaffected. |
| `PHONE_FARM_AGENT_URL` | — | The URL other dashboards use to reach this host's agent, published in `fleet.hosts` by the lease (`http://100.101.74.35:3001`). Plain `http(s)://host:port`, no credentials. |
| `PHONE_FARM_REGISTRY_POOL_SIZE` | `3` | Postgres connections the registry opens per process. |
| `PHONE_FARM_REGISTRY_CACHE_MS` | `2000` | How long a registry read is reused within a process. Writes in the same process invalidate it at once; other processes and hosts see a change within this time. |
| `WDA_XCTESTRUN_<TEAM>` | — | Prebuilt WDA for phones whose `signingTeam` is `<TEAM>` (upper-cased; other characters become `_`). Falls back to `WDA_XCTESTRUN`. Build with `npm run wda:prepare -- --generic --team <TEAMID>`. |

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
| `WDA_XCTESTRUN` | — | Path to a copied `.xctestrun` from `wda:prepare -- --generic` on another Mac. When set, WDA runs that pre-signed build and this host needs no Team, signing identity or Apple ID — only Xcode. See *Signing on another Mac* in `operations.md`. A phone with a `signingTeam` prefers `WDA_XCTESTRUN_<TEAM>` (see [Multi-host](#multi-host)). |
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
    "signingTeam": "ABCDE12345",                 // optional: Apple Team whose WDA build it runs (WDA_XCTESTRUN_<TEAM>)
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
- `signingTeam` (optional) is an Apple Team ID or alias (letters, digits, `_`;
  stored upper-case). The phone's WDA is launched from `WDA_XCTESTRUN_<TEAM>`,
  else `WDA_XCTESTRUN`; changing it relaunches the phone's WDA. Set it with
  `PATCH /api/devices/:udid` (`""` clears it). See [multi-host.md](multi-host.md#signing-teams).
- `pluginData` is per plugin id and never holds secrets.
- With `PHONE_FARM_REGISTRY=postgres` this file is no longer read: the same
  fields live in `fleet.devices` with a `hostId`, and passcodes move to
  `device-secrets.json` (see [multi-host.md](multi-host.md)).
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
| `PHONE_FARM_AGENT_BIND` (e.g. 3001) | Multi-host only, and the one exception to loopback: the host agent (`/agent/*` only, bearer token) on this Mac's Tailscale IP, never `0.0.0.0` |

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
| `device-secrets.json` | this host's passcodes with `PHONE_FARM_REGISTRY=postgres` (beside the real `devices.json`) | yes (encrypted) |
| PostgreSQL volume `phone-farm-postgres` | schedules, executions, logs, asset index | yes — `pg_dump` |
| `.scheduler-data/assets/` | uploaded media for post tasks | yes |
| `.wda/` | socket + locks | no |
| `.appium2/` | pinned XCUITest driver | no (re-run `appium:install-driver`) |
| `~/Library/Developer/Xcode/DerivedData/WebDriverAgent-*` | signed WDA build | no (re-run `wda:prepare`) |
| `logs/` | launchd agent logs | no |

# Architecture — what does what

Phone Farm iOS is four cooperating processes over one PostgreSQL database and a
few local state files. There is no client framework: the dashboard is
server‑rendered HTML with HTMX, and live video is MJPEG, not WebSockets.

```
                         ┌───────────────────────────────┐
  browser  ── HTTP ─────▶│  web  (Fastify + HTMX)  :3000 │
                         │  dashboard, JSON API,         │
                         │  plugin panels & routes       │
                         └───────┬───────────────┬───────┘
                                 │ SQL           │ HTTP (Unix socket)
                                 ▼               ▼
        ┌────────────────────────────┐   ┌──────────────────────────┐
        │ PostgreSQL                 │   │ wda-service              │
        │  scheduler.*  pgboss.*     │   │  1 WebDriverAgent / phone│
        │  drizzle.*                 │   │  forwards :8100+ / :9100+ │
        └───────▲────────────────────┘   └───────────┬──────────────┘
                │ SQL / pg-boss                      │ USB
        ┌───────┴────────────┐              ┌────────▼─────────┐
        │ worker             │── Appium ───▶│ Appium :4725     │──▶ iPhone
        │  runs due tasks    │   (webdriverio in task procs)   │
        └────────────────────┘              └──────────────────┘
```

That is one host. Several Macs can share one PostgreSQL, each running these
four processes for the phones on its own USB tree, with every dashboard able
to show and drive every phone: see [multi-host.md](multi-host.md) (shared
`fleet.devices` registry, host leases in `fleet.hosts`, `/agent/*` routes over
Tailscale, per-phone Apple signing team).

## The four processes

### `web` — `src/api/server.ts` → `startServer()` → `src/api/app.ts`
Fastify app on `WEB_PORT` (default 3000).

- Server‑rendered dashboard (`/`, `/devices/:udid`, `/tasks`, `/devices/register`).
- JSON API under `/api/*` (devices, registrations, schedules, executions,
  assets, remote control).
- Live device screen: `GET /api/devices/:udid/remote/stream` proxies the
  phone's MJPEG feed (used on the device page). The device **grid** uses
  stills instead: `GET …/remote/thumbnail` is a 240 px JPEG of the cached
  screenshot with an ETag (an unchanged screen costs a 304), refreshed per card
  by `static/dashboard/assets/grid.js`, and only for phones whose WDA the
  supervisor reports ready; the rest show **WDA not ready**. The full-size PNG
  `…/remote/screenshot` stays for the device page and calibration. The proxy aborts the
  upstream feed when the browser disconnects. `POST …/remote/action` forwards
  tap/swipe to WDA.
- Static assets are content-hashed: templates reference `/assets/<file>?v=<hash>`
  (immutable caching), and a bare URL revalidates by ETag. The theme's fonts
  (Oswald and Poppins, SIL OFL, `static/dashboard/fonts/`) are served by
  `GET /assets/fonts/:file` from a fixed whitelist (`DASHBOARD_FONTS` in
  `app.ts`); the stylesheet's `url()` references are rewritten to the same
  hashed URLs the templates preload. Nothing is loaded from an external host.
- **Shared polling.** Everything that repeats per phone is pooled, because the
  whole rack sits on one USB tree: one usbmux sweep is shared by the grid, the
  API and the WDA supervisor (`connectedDevices()` in `src/devices/discovery.ts`),
  and concurrent screenshot requests for a device collapse onto one WDA round
  trip (`src/devices/screenshot-cache.ts`). The grid's own cadence widens past
  ten phones. See *Fleet-scale polling* in [configuration.md](configuration.md).
- Health and monitoring (`src/observability/`): `GET /health` (liveness +
  release sha), `GET /health/ready` (Postgres, Appium, wda-service socket,
  worker heartbeat; 200/503) and `GET /metrics` (Prometheus text, bearer
  `PHONE_FARM_METRICS_TOKEN`). See *Monitoring and alerts* in
  [operations.md](operations.md#monitoring-and-alerts).
- Serves `/agent/*` (bearer `PHONE_FARM_AGENT_TOKEN`) for its own phones, and
  forwards requests for another host's phones to that host's agent after the
  usual grant check; `PHONE_FARM_AGENT_BIND` opens an `/agent/*`-only listener on
  the Tailscale IP ([multi-host.md](multi-host.md)).
- Loads plugins (`PHONE_FARM_PLUGINS`) and the auth provider
  (`PHONE_FARM_AUTH_PLUGIN`); mounts each plugin's **panels** on the device
  page and its **routes** under `/plugins/<pluginId>`.
- `assertSafeBind(host, authProvider)` refuses a non‑loopback bind with no
  auth provider.
- **Authentication then authorization.** An `onRequest` hook asks the auth
  provider who is calling; a `preHandler` looks the matched route up in one
  table (`src/auth/route-access.ts`) and checks the caller's level on the phone
  the route touches (`src/auth/policy.ts`). List routes filter to the caller's
  tenant and phones; another tenant's phone, schedule, run, upload, person or
  group is a 404 ([tenants.md](tenants.md)). With `PHONE_FARM_AUTH_PLUGIN=builtin`
  tenants, users, groups, grants, phone ownership and sessions live in Postgres
  schema `auth`; with no provider everything is allowed (loopback-only use).
  The worker is system-level and never checks users (it does skip a suspended
  tenant's schedules).
- **Audit.** An `onResponse` hook writes every state-changing request to the
  append-only `auth.audit_log` (route pattern and ids, never bodies);
  account events get rows of their own ([tenants.md](tenants.md#audit-log)).
- Owns device **registration** (`DeviceRegistrationService`) and creates the
  scheduler runtime used to enqueue work.

### `worker` — `src/scheduler/worker.ts` → `startWorker()`
Headless. Owns task execution.

- One pg-boss worker per **active** registered device, queue
  `ios-device-<hash(udid)>`. A device with `disabled: true` in `devices.json`
  is skipped here and by `wda-service` — the entry stays but nothing supervises
  it. Only phones this host owns are worked (`PHONE_FARM_HOST_ID`; every phone
  in `devices.json` is local); another host's worker takes the rest.
- Every 5 s, `materializeDue()` turns due schedules into `executions` rows and
  enqueues jobs; every 30 s it picks up newly registered devices and stops
  working the queues of removed or disabled ones (one failing device does not
  hold up the rest).
- For each job: `executeAutomation()` (`src/scheduler/executor.ts`) waits for
  the device + WDA + Appium to be ready, builds a `TaskExecutionContext`, and
  calls the task's `execute()`. Handles attempts, retry policy, stop requests,
  and the run‑window deadline. Presence comes from the shared, cached usbmux
  sweep, so waiting jobs do not each sweep every phone over lockdown.
- A schedule is materialized in its own savepoint; a task version that is not
  installed records a `skipped` execution instead of blocking the batch. The
  pg-boss job expiry covers run window + task duration + 10 min.
- A task that reports its irreversible side effect (the TikTok Post/Drafts tap)
  sets `executions.effect_committed_at`; such an execution is never retried or
  re-run.
- On SIGTERM it drains (see `operations.md`): no new jobs, waiting tasks are
  re-queued, running ones get `WORKER_DRAIN_SECONDS` before SIGTERM → SIGKILL,
  and orphaned Appium sessions for the phone are deleted.
- Every 15 s it upserts its host's row in `scheduler.worker_heartbeats` (and,
  with `PHONE_FARM_REGISTRY=postgres`, the host lease in `fleet.hosts`)
  (pid, start time, queue count); `/health/ready` fails when it goes stale.
- Must load the **same plugin versions** as `web`.

### `wda-service` — `src/devices/wda-service.ts`
Persistent WebDriverAgent supervisor, controlled over a Unix socket
(`.wda/wda-service.sock`).

- Keeps one WDA session alive per registered device, (re)launching
  `xcodebuild test-without-building` as needed and USB‑forwarding WDA
  (`8100`, `8101`, …) and MJPEG (`9100`, `9101`, …). Only this host's phones;
  each is launched from its signing team's build (`WDA_XCTESTRUN_<TEAM>`).
- `GET /health` on the socket reports per‑device `{ physical, wda, appium,
  message, restarts, notReadySince, disconnectedSince }`. States: `ready`,
  `unlock-required`, `error`, …
- Every line a phone's supervisor child prints (its xcodebuild output and
  `[wda-state]` markers) goes to `.wda/logs/<udid>.log`, rotated at 5 MB × 3,
  and the last 200 lines stay in memory: `GET /devices/:udid/logs` on the
  socket, `GET /api/devices/:udid/wda-log` (platform staff) on the dashboard.
- Single‑supervisor by design; a lock prevents duplicates.

### `appium` — `appium --address 127.0.0.1 --port 4725`
Appium 3 with the XCUITest driver, isolated in `APPIUM_HOME=.appium2`. Task
subprocesses (e.g. `src/tiktok/doomscroll.ts`) connect to it with
`webdriverio`. The dashboard's remote control does **not** go through Appium —
it talks to WDA directly. Binds loopback only.

## Xcode, signing, and device pairing

The farm never talks to a device directly at the USB level for *control* — it
delegates the whole pair/trust/sign/launch chain to Xcode's toolchain:

- **Pairing & trust** are the OS's job. An iPhone must be paired (USB + "Trust
  This Computer") and, on iOS 16+, have **Developer Mode** enabled before any
  of this works. `xcrun xctrace list devices` / `discoverConnectedDevices()`
  (`appium-ios-device`, over `usbmuxd`) is how the app learns a device is
  attached; it does not initiate pairing.
- **The Developer Disk Image** for the device's iOS version is mounted by
  Xcode on first pair. `xcodebuild` needs it present to launch a test bundle.
- **Signing.** `src/devices/wda/prepare.ts` runs `xcodebuild build-for-testing`
  with `CODE_SIGN_STYLE=Automatic` and `DEVELOPMENT_TEAM=$XCODE_ORG_ID`. Xcode
  automatic signing creates/refreshes a development provisioning profile that
  lists the connected UDIDs and embeds it in `WebDriverAgentRunner-Runner.app`.
  This is why a new device must be plugged in (and the Apple ID have a free
  slot — the 100-UDID limit) when `wda:prepare` runs. Signing reads a
  certificate from the **login keychain**, which is only unlocked in a
  graphical session — hence the "run from Terminal.app, not SSH" rule.
- **Launch.** `wda-service` runs `xcodebuild test-without-building
  -destination id=<udid>` per active device: it installs the pre-signed
  `WebDriverAgentRunner` and starts it as a UI test. WDA then serves HTTP on
  the device's `:8100` and MJPEG on `:9100`, which `wda-service` USB-forwards
  to the host's `:81xx` / `:91xx`.

The **registration wizard** (`src/devices/registration.ts`) is a UI over this
chain: its `host` / `connection` / `signing` / `developer` / `wda` checks each
probe one link (Xcode selected, device visible over usbmux, a signing identity
present, the DDI mounted, WDA reachable) and surface a specific fix before the
device is written to `devices.json`. `wda:prepare` is the same signing step
without the UI, for scripted or bulk (`--all`) setup.

## Data & state

| Store | Contents |
| --- | --- |
| PostgreSQL `scheduler.*` | `schedules`, `executions`, `execution_attempts`, `execution_logs`, `assets`, `worker_heartbeats` (one row per host, refreshed every 15 s). Drizzle ORM; migrations in `drizzle/`. |
| PostgreSQL `pgboss.*` | Job queue (one partitioned queue per device). |
| PostgreSQL `drizzle.*` | Applied‑migration ledger. |
| PostgreSQL `auth.*` | Built-in accounts: `tenants`, `tenant_devices` (phone → tenant by UDID; none = the default tenant), `users`, `groups`, `group_members`, `grants`, `sessions`, `login_throttle`, and the append-only `audit_log`. `tenant_id` also sits on `scheduler.schedules`, `executions` and `assets`. See [tenants.md](tenants.md). |
| PostgreSQL `fleet.*` | With `PHONE_FARM_REGISTRY=postgres`: `devices` (every host's phones, each with its `host_id`; ports unique per host; `has_passcode` but never the passcode) and `hosts` (one row per Mac, lease refreshed every 15 s, agent URL). See [multi-host.md](multi-host.md). |
| `devices.json` | Registered devices (default `file` registry): `udid`, `name`, ports, `coordinateProfile`, per‑device `coordinates` overrides, `passcode`, `disabled`, `signingTeam`, `pluginData`. Git‑ignored, `0600`. |
| `device-secrets.json` | With the Postgres registry: this host's device passcodes, beside the real `devices.json`. Git‑ignored, `0600`. |
| `.env` | Configuration and secrets (DB URL, signing IDs, auth keys). Git‑ignored. Device passcodes live in `devices.json`, not here. |
| `.scheduler-data/assets/` | Uploaded media for `post`‑style tasks, content‑addressed. |
| `.wda/` | wda-service socket and locks; `.wda/logs/<udid>.log` per-phone WDA output. |
| `.appium2/` | Isolated Appium home with the pinned XCUITest driver. |

## The task model

Every schedule and execution row carries a **task envelope**:

```
pluginId : string        e.g. "com.git-agni.tiktok"
taskType : string        e.g. "doomscroll"
taskVersion : integer     e.g. 1
payload : jsonb          validated, version-specific shape
```

`PluginRegistry.task({pluginId, taskType, taskVersion})` resolves the envelope
to a `TaskDefinition`. Because the version is stored, **an old schedule can
never silently run a new contract** — if `taskVersion` 1 is no longer
installed, that schedule fails loudly instead of executing v2 logic.

## Scheduling

`ScheduleTiming` (`src/types.ts`):

| kind | fields |
| --- | --- |
| `now` | — |
| `once` | `runAt` (ISO) |
| `daily` | `localTime` `"HH:MM"`, `timezone` (IANA) |
| `weekly` | `localTime`, `timezone`, `weekdays` (0–6) |

`run_window_minutes` (default 30) is the grace period after the scheduled time;
past it, the execution is abandoned as "window expired". Recurrence is computed
in `src/scheduler/recurrence.ts`; the next occurrence is written to
`schedules.next_run_at`.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/api/` | Fastify app factory, controllers, middleware, HTTP routes |
| `src/scheduler/` | runtime, repository, pg-boss queue, recurrence, worker, executor |
| `src/database/` | Drizzle client, schema, migrate/setup entrypoints |
| `src/devices/` | discovery, registry (`registry.ts`: `devices.json` or Postgres via `registry-pg.ts`), host identity, local passcode store (`device-secrets.ts`), `import-to-db`, registration flow, WDA remote, wda-service, coordinate profiles |
| `src/hosts/` | Multi-host: the host lease (`fleet.hosts` upsert) and the host directory dashboards read |
| `src/agent/` | Multi-host: the host agent's token check, its `/agent/*`-only listener (`PHONE_FARM_AGENT_BIND`) and the client that reaches other hosts' phones |
| `src/devices/wda/` | `prepare.ts` (patch + build + sign WDA), `start.ts` (single-device WDA supervisor), `target-device.ts` (resolve which device a CLI command targets), diagnostics |
| `src/tiktok/` | TikTok automation entrypoints (`doomscroll.ts`, `post.ts`), OCR, coordinates |
| `src/tiktok-plugin.ts` | The built‑in plugin: task definitions, device panel, routes |
| `src/plugin.ts` | **Stable plugin & auth interfaces** |
| `src/observability/` | Readiness probes, Prometheus text rendering, the worker heartbeat |
| `src/auth/` | Built-in accounts: access policy (roles and tenants), route requirement table, sessions and sign-in, Team, Organisations and Audit pages/API, the audit log (`audit.ts`), tenants (`tenants.ts`), the Postgres sign-in throttle, `npm run users` |
| `src/tenancy.ts` | The default tenant, quota types and upload limits |
| `src/registry.ts` | `PluginRegistry` — task resolution and validation |
| `src/loader.ts` | Dynamic import of `PHONE_FARM_PLUGINS` / `PHONE_FARM_AUTH_PLUGIN` |
| `src/example-plugin.ts` | Minimal reference plugin |
| `static/dashboard/` | HTML templates, `styles.css` (the Envy theme: all colours are `:root` tokens), `fonts/`, browser TS (`tsconfig.web.json` → `static/dashboard/assets/*.js`, including the grid thumbnail loader `grid.js`) |
| `Patches/` | WDA source patches applied by `wda:prepare` |
| `drizzle/` | SQL migrations + journal |

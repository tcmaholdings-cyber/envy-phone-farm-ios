# Multi-host farms

One Mac drives the phones on its own USB tree; a 16 GB Mac tops out at a few
dozen. To go further, run several Macs ("hosts") against **one Postgres**.
Each host keeps owning its own phones — its worker runs their tasks, its
`wda-service` keeps their WebDriverAgents alive — while every host's dashboard
lists, shows and drives **every** phone.

A single Mac needs none of this. The defaults (`PHONE_FARM_REGISTRY=file`,
devices in `devices.json`) are unchanged.

```
                    ┌──────────── Tailscale (tailnet) ────────────┐
                    │                                              │
  Mac A  (PHONE_FARM_HOST_ID=mini-a)            Mac B  (PHONE_FARM_HOST_ID=mini-b)
  ┌──────────────────────────────┐              ┌──────────────────────────────┐
  │ web :3000 (loopback)         │  /agent/* ──▶│ agent listener 100.x.y.b:3001│
  │ agent listener 100.x.y.a:3001│◀── /agent/*  │ web :3000 (loopback)         │
  │ worker   → mini-a's queues   │              │ worker   → mini-b's queues   │
  │ wda-service → mini-a's phones│              │ wda-service → mini-b's phones│
  │ device-secrets.json (0600)   │              │ device-secrets.json (0600)   │
  └──────────────┬───────────────┘              └──────────────┬───────────────┘
                 │ SQL                                          │ SQL
                 └──────────────▶  PostgreSQL  ◀────────────────┘
                     scheduler.* pgboss.* auth.*  fleet.hosts  fleet.devices
```

## How it works

- **Shared registry.** With `PHONE_FARM_REGISTRY=postgres` the phones live in
  `fleet.devices` (migration 0005), not in `devices.json`. Each row has a
  `host_id`: the Mac the phone is plugged into. Changes run in one
  transaction under an advisory lock and row locks, so the dashboard, the CLI
  and the registration wizard on any host cannot overwrite each other.
- **Ownership.** A host's worker subscribes only to the queues of phones whose
  `host_id` is its own, and its `wda-service` supervises only those. Schedules
  can be created from any dashboard; the job lands on the phone's queue and
  only the owning host picks it up. WDA/MJPEG ports are unique **per host**
  (both Macs can forward a phone to `:8100`).
- **Passcodes stay on the owning Mac.** Postgres stores only `has_passcode`.
  The passcode itself is in `device-secrets.json` (0600, git-ignored) beside the
  real `devices.json` — in the release layout that is `~/phone-farm/shared/`.
  Set a phone's passcode from **its own host's** dashboard or with `npm run
  devices` there; other hosts refuse (409) rather than write it to the wrong
  Mac.
- **Host lease.** Every 15 s a host's worker and `wda-service` refresh its row
  in `fleet.hosts` (`last_seen_at` on the database clock, display name, agent
  URL, release). Dashboards find other hosts' agents there.
- **Host agent.** Each web process also serves `/agent/*` for its own phones:
  status, screen info, screenshot, grid thumbnail, MJPEG stream, lock state,
  remote tap/swipe, WDA log and connection state. A dashboard showing a phone
  that another host owns first checks the user's grant (an ungranted phone is
  still a 404), then forwards the request to that host's agent with the shared
  token. Thumbnails are made on the owning host, so only the small JPEG crosses
  the network, and its ETag/304 still works. A host that does not answer shows
  its phones **Offline** ("Host … is not answering") instead of breaking the
  page.
- **Loopback stays the default.** The dashboard still binds `127.0.0.1` and
  `assertSafeBind` is unchanged. The agent gets its **own** listener, opened only
  when `PHONE_FARM_AGENT_BIND` is set, on the Mac's Tailscale address. It
  forwards only well-formed `/agent/*` paths into the app and answers 404 to
  everything else (the dashboard, `/health`, `..` or encoded-slash tricks). It
  refuses to start on `0.0.0.0`/`::`, on a hostname, or with a token shorter than
  32 characters.

## Configuration

Set these in each host's `.env` (full reference: [configuration.md](configuration.md#multi-host)).

| Key | Example | Meaning |
| --- | --- | --- |
| `PHONE_FARM_REGISTRY` | `postgres` | `file` (default: `devices.json`) or `postgres` (`fleet.devices`, shared). Same value on every process of every host. |
| `PHONE_FARM_HOST_ID` | `mini-a` | This Mac's id (letters, digits, `.`, `_`, `-`). Defaults to the hostname — set it explicitly, because macOS renames a machine on a network name clash. |
| `PHONE_FARM_HOST_NAME` | `Rack room A` | Display name on the grid cards. Default: the id. |
| `DATABASE_URL` | `postgresql://phone_farm:…@100.x.y.db:5432/phone_farm` | The **shared** database, the same on every host. |
| `PHONE_FARM_AGENT_TOKEN` | `openssl rand -hex 32` | The shared service token, identical on every host. At least 32 characters. A secret: `.env` only. |
| `PHONE_FARM_AGENT_BIND` | `100.101.74.35:3001` | Open the agent listener on this Mac's Tailscale IP. Unset = other hosts cannot reach this host's phones. |
| `PHONE_FARM_AGENT_URL` | `http://100.101.74.35:3001` | What this host publishes in `fleet.hosts` for other dashboards to call. Normally `http://` + `PHONE_FARM_AGENT_BIND`. |
| `PHONE_FARM_DEVICE_SECRETS_PATH` | — | Override where this host's passcodes are kept. Default: `device-secrets.json` beside the real `devices.json`. |
| `WDA_XCTESTRUN_<TEAM>` | `…/prebuilt-ABCDE12345/…xctestrun` | Prebuilt WDA per Apple signing team; see [Signing teams](#signing-teams). |

## Moving a single host to Postgres

The steps are safe to repeat; `devices.json` is never modified, which is
your way back.

1. **Back up** (see *Backups* in [operations.md](operations.md#backups)).
2. **Migrate the schema**: `npm run db:migrate` (adds `fleet.*`, migration 0005).
3. **Name the host** in `.env`: `PHONE_FARM_HOST_ID=mini-a` (and optionally
   `PHONE_FARM_HOST_NAME`).
4. **Preview the import**: `npm run devices -- import-to-db --dry-run`. It
   checks every phone as the real import would (coordinate profile, passcode,
   per-host ports) and writes nothing. A phone without explicit ports keeps the
   ones it used before (`WDA_LOCAL_PORT`/`MJPEG_LOCAL_PORT`, default 8100/9100);
   two such phones were already colliding and the import names them — give one
   explicit ports in `devices.json` first.
5. **Import**: `npm run devices -- import-to-db`. Rows go to `fleet.devices`
   with `host_id = mini-a`; passcodes go to `device-secrets.json`, never to
   Postgres. A phone another host already owns is skipped, not taken over.
   Running it again reports everything *unchanged*.
6. **Switch**: `PHONE_FARM_REGISTRY=postgres` in `.env`, then restart `web`,
   `worker` and `wda-service` (`deploy/launchd/install-agents.sh` or
   `launchctl kickstart -k …` for each).
7. **Check**: `npm run devices -- list` shows a `HOST` column;
   `select id, last_seen_at from fleet.hosts;` shows the host refreshing every
   15 s; the grid looks as before.

**Rolling back**: unset `PHONE_FARM_REGISTRY` (or set `file`) and restart.
The farm reads `devices.json` again, as it was at step 5 — changes made while
on Postgres (new phones, renamed racks) are not copied back.

## Adding a second host

1. Install the farm on the new Mac as usual ([install-mac-mini.md](install-mac-mini.md)),
   with the **same** plugins and version as the other hosts (`web` and `worker`
   everywhere must load identical plugins).
2. Point `DATABASE_URL` at the shared Postgres. The bundled Postgres binds
   `127.0.0.1` and must stay that way; make it reachable over the tailnet
   without listening on a public interface — for example by forwarding the
   port into the tailnet with Tailscale on the database host, or by using a
   managed Postgres with TLS. Budget connections: a host already opens about
   40 (a `DATABASE_POOL_SIZE`=10 pool and a pg-boss pool in both `web` and
   `worker`); the registry adds up to 3 per process
   (`PHONE_FARM_REGISTRY_POOL_SIZE`) and the lease and host directory 1 each.
   Around three hosts the default `max_connections=100` runs out — raise it or
   put PgBouncer in front.
3. Set `PHONE_FARM_REGISTRY=postgres`, a unique `PHONE_FARM_HOST_ID`, and the
   same `PHONE_FARM_AGENT_TOKEN` as the other hosts.
4. Open the agent on its Tailscale IP: `PHONE_FARM_AGENT_BIND=<tailscale-ip>:3001`
   and `PHONE_FARM_AGENT_URL=http://<tailscale-ip>:3001` (`tailscale ip -4`
   prints the address). Do the same on every host whose phones others should see.
5. Register its phones from **its own** dashboard (the wizard talks to the
   local USB tree and local Xcode). They appear on every host's grid with
   "Host · <name>".

## Tailscale and tokens

- The agent is plain HTTP on the Tailscale address; WireGuard encrypts it
  between Macs. Restrict it further with a Tailscale ACL that lets only the
  farm Macs reach `tcp:3001` on each other.
- One token for the whole farm. Generate it with `openssl rand -hex 32`. It is
  compared in constant time, only on `/agent/*`, and never accepted in place
  of a dashboard sign-in (or vice versa). It never appears in logs, HTML or API
  responses.
- **Rotating** it: set the new value in every host's `.env`, then restart
  `web` on every host. During the few seconds in between, cross-host views
  answer 502 and the grid shows the other hosts' phones offline.
- Without `PHONE_FARM_AGENT_TOKEN` the `/agent/*` routes answer 404 and a
  dashboard answers 502 for phones on other hosts, naming the missing setting.

## Signing teams

Apple allows **100 devices per Team per membership year**, so a farm past
~100 phones runs several Teams. Each phone can name the Team whose WDA build
its UDID is provisioned in:

1. Build each Team's WDA once, on a Mac signed into it:
   `npm run wda:prepare -- --generic --team ABCDE12345` → `.wda/prebuilt-ABCDE12345/Build/Products`,
   and it prints the line to set.
2. Copy that folder to the hosts and set, per Team,
   `WDA_XCTESTRUN_ABCDE12345=/Users/<user>/phone-farm/shared/.wda/prebuilt-ABCDE12345/<name>.xctestrun`.
3. Give each phone its team: `PATCH /api/devices/<udid>` with
   `{"signingTeam": "ABCDE12345"}` (admins; `""` goes back to the host default).

`wda-service` launches a phone with `WDA_XCTESTRUN_<TEAM>`, else the host-wide
`WDA_XCTESTRUN`, else a local build signed with that Team; changing the team
relaunches the phone's WDA. The team is upper-cased, and any character other
than a letter, digit or `_` becomes `_` in the variable name. This works on a
single host too.

## Limits (today)

- **Passcodes** are set on the owning host only. **Registration** and plugin
  registration checks run on the owning host only (409 elsewhere).
- **Moving a phone to another Mac** has no UI yet: stop both hosts' `wda-service`,
  `update fleet.devices set host_id = 'mini-b', wda_local_port = …, mjpeg_local_port = … where udid = '…';`
  (ports free on the new host), move its entry from the old host's
  `device-secrets.json` to the new host's, and start them again. The old host's
  worker stops working the phone's queue within 30 s.
- The **full-size screenshot** of another host's phone (device page,
  calibration) is fetched through the agent as a PNG; the grid only moves
  thumbnails.
- Deleting another host's phone from a dashboard removes its row; its passcode
  stays in the owning host's `device-secrets.json` until removed by hand.
- **Deploy tooling**: the release layout links `devices.json` from `shared/`;
  `device-secrets.json` follows it there by default. Include it in backups
  (see *Backups* in [operations.md](operations.md#backups)).

# Tenants, roles and the audit log

The farm can be run for several paying customers at once. Each customer is a
**tenant** (an *organisation* in the dashboard): it gets its own phones, its
own people (admins and operators), its own schedules, run history and uploaded
media — and never sees another tenant's. The farm operator's own staff are
**platform** users: they see every tenant and are the only ones who set up
the farm itself.

All of this needs the built-in accounts (`PHONE_FARM_AUTH_PLUGIN=builtin`,
[configuration](configuration.md#built-in-accounts)). Without sign-in there is
one tenant and everything is allowed, as before.

## Roles

| | Platform | Tenant admin | Operator |
| --- | --- | --- | --- |
| Belongs to a tenant | No | Yes, one | Yes, one |
| Phones | Every phone of every tenant | Every phone of their tenant | Only phones granted to them (or their groups) in their tenant, at the granted level |
| Drive phones, schedule and run tasks, stop/retry runs | Yes | Yes (own tenant) | With **operate** on the phone |
| Upload media | Yes (for a tenant, `?tenant=`) | Yes (own tenant) | With **operate** on at least one phone |
| Delete media | Yes | Own tenant's | No |
| Team page: people, groups, grants | Every tenant, plus the platform accounts | Own tenant | No |
| Create platform accounts | Yes | No | No |
| Audit log | Every tenant | Own tenant | No |
| Register, configure, disconnect, remove phones; WDA logs | Yes | No | No |
| Organisations page: create, suspend, quotas, assign phones | Yes | No | No |

The rules live in one place, `src/auth/policy.ts` (pure functions with
exhaustive tests in `test/tenant-policy.test.ts`); every route declares what it
needs in `src/auth/route-access.ts`.

**Another tenant's things do not exist.** A phone, schedule, run, upload,
person, group or grant of another tenant answers **404** — exactly like an id
that was never created — never 403, so ids cannot be probed. Lists (phones,
schedules, runs, the grid, the Team page, the audit log) contain only the
caller's tenant, whatever `?tenant=` they send. `test/tenant-isolation.test.ts`
calls every id-taking route in the access table with the other tenant's ids
and fails on any route kind it does not know, so a new route cannot skip the
check. Platform-only routes answer a uniform **403** to everyone else.

Platform users see every tenant by default and narrow a list with
`?tenant=<tenant id>` (`GET /api/devices`, `/api/schedules`,
`/api/executions`, `/api/audit`; the Team page's switcher does the same).

## What belongs to a tenant

| Thing | How its tenant is decided |
| --- | --- |
| Phone | Its row in `auth.tenant_devices` (keyed by UDID, so it works with the `file` and `postgres` registries alike). **A phone with no row belongs to the default tenant.** |
| Schedule | The phone's tenant when the schedule is created — whoever creates it. |
| Run (execution) | Its schedule's (a retry keeps it). |
| Upload | The uploader's tenant (platform users name one); the TikTok post form uses the phone's. Uploader recorded as `uploaded_by`. |
| Person | Chosen at creation; a tenant admin always creates people in their own tenant. Platform users have none. |
| Group | Its tenant; names are unique within a tenant. Members must be in the same tenant. |
| Grant | Its person's or group's tenant. A one-phone grant must name a phone of that tenant. |
| Audit row | The actor's tenant; a platform user's action on a tenant's phone is recorded under that tenant, so its admin sees it. |

**Moving a phone** to another tenant (Organisations page → *Assign a phone*,
or `POST /api/tenant-devices`) is refused while the phone runs a task, and
cancels the old tenant's open schedules on it. The old tenant's run history
stays theirs: the phone's activity panel and lists show only the current
owner's runs. Old grants naming the phone stay in place but reach nothing.

**Suspending** a tenant ends its people's sessions, refuses their sign-ins
(with the same message as a wrong password) and stops its schedules from being
queued until it is active again. The default tenant cannot be suspended.

## Quotas

Each tenant carries optional limits (`auth.tenants.quotas`, set on the
Organisations page or through `PATCH /api/tenants/:id`):

| Quota | Default | Enforced when |
| --- | --- | --- |
| `maxPhones` | no limit | assigning a phone to the tenant |
| `maxUsers` | no limit | creating a person in the tenant |
| `maxUploadBytes` | 5 GiB | uploading: the tenant's stored media may not exceed it |

Separately, **one uploaded file** is capped by `PHONE_FARM_MAX_UPLOAD_BYTES`
(default 200 MiB) for every tenant. An upload over either limit answers
**413** and leaves nothing behind (no file on disk, no asset row). Files are
stored under random UUIDs, never the name the browser sent; attaching an
upload to a schedule, or deleting one, checks that it is the caller's
tenant's.

## Upgrading an existing farm (migration 0006)

`npm run db:migrate` (or a normal deploy, which runs it) applies
`drizzle/0006_tenants.sql`:

1. Creates the **default tenant `beloura`** (a fixed id,
   `00000000-0000-0000-0000-000000000001`).
2. Assigns every existing schedule, run, upload, group and operator to it. No
   phone needs a row: unassigned phones belong to it.
3. **Turns every existing `admin` into `platform`** (farm-operator staff, no
   tenant). This is deliberate: the people who were admins before tenants
   existed are the operator's own staff.
4. Creates the append-only `auth.audit_log` and the shared
   `auth.login_throttle`.

After it the farm works exactly as before: the same people see the same
phones. To take on a customer:

```sh
# 1. The organisation: on the Organisations page (Add organisation), or
curl -X POST https://farm.example/api/tenants -H 'content-type: application/json' \
  -H "Origin: https://farm.example" -b pf_session=… -d '{"slug":"acme","name":"Acme Media","quotas":{"maxPhones":10}}'
# 2. Its first admin (prints a temporary password once)
npm run users -- create acme-boss --role admin --tenant acme --name "Acme boss"
# 3. Its phones: Organisations page → Assign a phone
```

The customer's admin then adds their own operators and grants on the Team page.

New platform staff: `npm run users -- create <name> --role platform`, or on
the Team page with the switcher on *Platform staff*. A platform account and a
tenant account cannot be converted into each other; create a new account.

**Rolling back past this release.** The previous release does not know the
`platform` role: platform users would sign in but see no phones and no Team
page. Before rolling back, make them old-style admins of the default tenant:

```sql
update auth.users set role = 'admin', tenant_id = '00000000-0000-0000-0000-000000000001' where role = 'platform';
```

and after rolling forward again, reverse it
(`update auth.users set role = 'platform', tenant_id = null where role = 'admin' and tenant_id = '00000000-0000-0000-0000-000000000001';`
— check first that no *customer* admin sits in the default tenant). The
previous release has no tenants at all: **once a second tenant has people,
do not roll back past this release** — every tenant's admins would become
farm-wide admins. Suspend the tenant or fix forward instead.

## Audit log

Every state-changing request (anything but `GET`/`HEAD`/`OPTIONS`) leaves one
row in `auth.audit_log`, written after the response: when, tenant, actor id
and role, client IP (`CF-Connecting-IP` behind the local tunnel), method,
**route pattern** (`/api/devices/:udid/remote/action` — never the raw URL or
query string), target UDID and ids, response status, and a random request id
that is also sent back as `X-Request-Id` and appears in the server log.
Refused requests (401/403/404) and cross-site posts blocked by the Origin
check are recorded too. **No request body is ever stored**: a remote-control
action records only its kind (`action=tap`), never coordinates or typed text;
passwords, tokens and passcodes never reach it.

Account events get rows of their own, named by `event`: `login.success`,
`login.failure` (with the reason: unknown user, wrong password, disabled,
organisation suspended), `login.throttled`, `logout`, `password.changed`,
`user.*`, `group.*`, `grant.*`, `tenant.*`.

Reading it:

- **Audit** in the navigation (platform users and tenant admins): newest
  first, with *Older entries* and *Download CSV*.
- `GET /api/audit?limit=100&before=<id>&tenant=<id>` → `{ entries, nextBefore }`
  (keyset pagination: pass `nextBefore` as `before`). `?format=csv` downloads
  up to 10,000 rows; cells that a spreadsheet would run as a formula are
  neutralised. A tenant admin always gets their own tenant's rows.

**Append-only in the database.** A trigger refuses every `UPDATE`, every
`TRUNCATE`, and `DELETE` of any row younger than 30 days — so neither an
application bug nor an injected query can rewrite recent history. If the app
connects as a separate, non-owner role named `phone_farm_app`, the migration
also revokes `UPDATE`/`DELETE`/`TRUNCATE` from it. (A table **owner** can
disable triggers; for a guarantee against a compromised host, run the app as
a non-owner role and keep the owner's credentials off the host.)

**Retention.** The worker deletes rows older than
`PHONE_FARM_AUDIT_RETENTION_DAYS` (default **365**) once an hour. Values below
30 are raised to 30 (the trigger would refuse them anyway); `0` keeps rows
forever. Export the CSV first if you need longer records elsewhere.

## Sign-in throttle

Failed sign-ins are counted per username and per client IP in
`auth.login_throttle`, shared by every web replica and kept across restarts
(5 failures per username or 20 per IP, then 30 s doubling to 15 min, forgotten
after an hour of quiet). A restart or a second replica no longer hands an
attacker fresh attempts.

## API

| Route | Who | What |
| --- | --- | --- |
| `GET /api/tenants` | platform | Every tenant with its phone and people counts |
| `POST /api/tenants` | platform | `{ slug, name, quotas? }` → 201 |
| `PATCH /api/tenants/:id` | platform | `{ name?, status?: 'active' \| 'suspended', quotas? }` (a `null` quota restores the default) |
| `POST /api/tenant-devices` | platform | `{ udid, tenantId }` — move a phone; answers `cancelledSchedules` |
| `GET /api/team?tenant=<id>` | tenant admin (own) / platform (any; `platform` = platform accounts) | The Team snapshot |
| `POST /api/team/users?tenant=<id>` | tenant admin / platform | `role`: `operator`, `admin`, or (platform only) `platform` |
| `GET /api/audit` | tenant admin (own) / platform | See above |
| `GET /api/me` | anyone signed in | Now includes `tenantId` (`null` for platform) |

## Multi-host

A phone on another Mac is forwarded to that host's `/agent/*` routes only after
the same tenant check as a local phone (`test/tenant-multi-host.test.ts`). The
agent routes accept only the fleet bearer token (`PHONE_FARM_AGENT_TOKEN`),
never a dashboard session — not even a platform user's. That token is a
platform secret: it reaches every phone on the host, so never give it to a
tenant.

## For plugin authors

- `routeAccess` kinds are unchanged; an `admin` route (or an undeclared one) is
  now **platform-only**. A `device` route gets the tenant check for free.
- A `signed-in` route that returns data must filter it to the caller's tenant
  and phones itself. `context.requestActor(request)` gives the caller's user id
  and tenant id; `scheduler.listExecutions(limit, udid)` for one phone already
  returns only the phone's current tenant's runs.
- `UserAccess` (for your own `AuthProvider`) gained `role: 'platform'` and
  `tenantId`. An `admin` without a `tenantId` keeps its old farm-wide meaning.

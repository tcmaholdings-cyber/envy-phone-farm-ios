# Releases, deploys and rollbacks

The farm host runs **releases**: immutable, versioned copies of the code, one
per commit, switched by a symlink. A deploy never edits the running code in
place and a rollback takes seconds. This replaces copying a working tree onto
the host with `rsync`.

## Layout on the host

```
~/phone-farm/
  current -> releases/1a2b3c4d5e6f      the live release; every launchd agent runs from here
  releases/
    1a2b3c4d5e6f/                        code + node_modules for one commit (12-char sha)
      RELEASE.json                       what was built: id, sha, version, subject, builtAt
      RELEASED                           when it went live; GET /health reports its sha
      .env -> ../../shared/.env          host state, linked (see below)
      ...
    0f9e8d7c6b5a/                        the previous releases (the newest 5 are kept)
  shared/                                host state; survives every deploy
    .env  .env.devices  devices.json     configuration, secrets, registered phones (0600)
    .wda/                                signed WebDriverAgent build, supervisor locks, socket, per-phone logs
    .appium2/                            the pinned XCUITest driver
    .scheduler-data/                     uploaded media (uploads/, assets/)
    logs/                                agent logs and deploy.log (every deploy and rollback)
    backups/
  incoming/                              uploaded tarballs (the newest 5 are kept)
  bin/                                   deploy.sh, rollback.sh: copies from the newest deployed release,
                                         usable whatever current points at
  .history                               release ids in the order they went live
  .env, devices.json, .wda, logs, ...    compatibility links into shared/ (made by the migration)
```

Run day-to-day commands from `~/phone-farm/current` (`cd ~/phone-farm/current && npm run devices -- list`).
Tail logs in `~/phone-farm/shared/logs/` (also reachable as `~/phone-farm/logs/`).

The launchd agents' plists name `~/phone-farm/current`, never a release, so a
deploy only re-points `current` and restarts processes; the plists stay as
they are. A process started before a deploy keeps running the release it
started in (its working directory is that release), which is why releases in
use are never pruned.

## Building a release

A release is a tarball built from a **clean commit** (uncommitted changes to
tracked files are refused):

```sh
scripts/release.sh                         # dist/phone-farm-<sha12>.tgz (+ .sha256)
scripts/release.sh --version v1.4.0        # dist/phone-farm-v1.4.0.tgz; a tagged HEAD is named after its tag
```

It holds only committed files (`git archive`) from `package.json`,
`package-lock.json`, `src/`, `static/` (with the compiled browser assets),
`drizzle/` (migrations), `Patches/`, `deploy/`, `scripts/`, `docs/` and the
top-level configuration, plus `RELEASE.json`. Host state (`.env*`,
`devices.json`, `.wda/`, `.appium2/`, `.scheduler-data/`, `logs/`,
`node_modules/`) cannot ship: it is git-ignored, outside the allowlist, and the
build fails if any of it is found. It first checks that the committed
`static/dashboard/assets` match `npm run build:web`, exactly like CI.
`--with-node-modules` bundles dependencies (built for the building machine's
Node; `deploy.sh` reinstalls on a mismatch).

**CI** (`.github/workflows/ci.yml`, GitHub-hosted macOS, no secrets) runs
`npm run check`, the asset check and a release build on every pull request and
on pushes to `main` and `feat/**`. **Tagging** `vX.Y.Z` and pushing the tag runs
`.github/workflows/release.yml`, which attaches `phone-farm-vX.Y.Z.tgz` and its
`.sha256` to a GitHub release. Neither workflow can reach the farm.

## Deploying

From the laptop, one command builds, copies and deploys:

```sh
scripts/deploy-remote.sh fidelity@100.119.132.42
scripts/deploy-remote.sh --tarball ~/Downloads/phone-farm-v1.4.0.tgz fidelity@100.119.132.42   # a CI-built release
```

It copies the tarball and its checksum to `~/phone-farm/incoming/` over SSH,
then runs the `deploy.sh` **shipped inside that tarball** on the host, so the
deploy logic always matches the release. Options it does not know are passed to
`deploy.sh`. On the host directly:

```sh
~/phone-farm/bin/deploy.sh ~/phone-farm/incoming/phone-farm-v1.4.0.tgz
```

What `deploy.sh` does, in order (it holds a lock, and every step is safe to
re-run; deploying the release that is already live only re-checks health):

1. **Unpack** to `releases/<id>/`, after checking the `.sha256` next to the tarball.
2. **Link** host state from `shared/` into the release.
3. **Dependencies.** Same `package-lock.json` and Node ABI as the live release →
   `node_modules` is cloned from it (instant on APFS). Otherwise `npm ci`.
   Dev dependencies are installed on purpose: `tsx` loads every process,
   `typescript` recompiles the browser assets when `npm run web` starts, and
   `appium` runs the Appium agent; all three are devDependencies.
4. **Appium driver.** If the pinned `appium:install-driver` changed,
   `npm run appium:install-driver` updates `shared/.appium2`, and Appium is
   restarted in step 8.
5. **Smoke check** (`npm run deploy:smoke`): imports the server and worker
   modules, loads the plugins and the auth provider, and validates
   `devices.json` under the new code, with the host's `.env`. It starts
   nothing. A failure stops here; nothing live has changed.
6. **Migrations** (`npm run db:migrate`), while the previous release is still live.
7. **Flip**: write `RELEASED`, point `current` at the release (one `rename`).
8. **Restart and verify**:
   - `web` is restarted and `GET /health` must report the new sha;
   - the `worker` is sent SIGTERM: it stops taking jobs and lets running
     tasks finish for its drain window (`WORKER_DRAIN_SECONDS`, 120 s, then
     `WORKER_KILL_GRACE_SECONDS`), and exits; launchd starts it again from the
     new release. The deploy waits that long plus 30 s
     (`PHONE_FARM_WORKER_STOP_TIMEOUT` overrides) before forcing it;
   - `wda-service` is restarted only when its code changed (`src/devices/`,
     `src/types.ts`, `Patches/` or the lockfile; `--restart-wda always|never`
     overrides). Restarting it relaunches WebDriverAgent on every phone;
   - `appium` only when step 4 changed it;
   - `GET /health/ready` must answer 200 (database, Appium, wda-service socket,
     a worker heartbeat under 60 s). It is polled for
     `PHONE_FARM_HEALTH_TIMEOUT` (120 s) because the new worker takes ~15 s to
     write its first heartbeat. A 404 (a build from before readiness existed)
     is accepted.
9. **Keep** the newest 5 releases (`PHONE_FARM_KEEP_RELEASES`), the live one, and any a process still runs in.

**Automatic rollback.** If either health gate fails, `deploy.sh` points
`current` back at the previous release, restarts the same way and checks
health again. Exit codes: `0` live · `1` stopped before the flip (nothing
changed) · `2` unhealthy and rolled back · `3` the rollback is unhealthy too.
The failed release stays in `releases/` for inspection; `shared/logs/deploy.log`
records each step.

`--skip-ready` drops the readiness gate (the `/health` check stays) for when
Appium or a phone-side dependency is down for reasons the deploy cannot fix.
`--no-restart` only flips. `--install-agents` reinstalls the launchd agents from
the new release instead of restarting them (the first deploy after the
migration, or when `deploy/launchd/install-agents.sh` changed).

### Migrations must be backward compatible

Step 6 runs before the flip and a rollback does not undo it, so the previous
release must keep working on the new schema: add tables and nullable columns,
backfill, and drop or rename only in a later release once nothing reads the old
shape (expand, then contract). The same rule already holds for task versions
(`PLUGIN_DEVELOPMENT.md`).

## Rolling back

```sh
~/phone-farm/bin/rollback.sh --list     # releases on disk, * = live
~/phone-farm/bin/rollback.sh            # the release that was live before this one
~/phone-farm/bin/rollback.sh 0f9e8d7c6b5a
```

It re-points `current`, rewrites `RELEASED` with `rolledBackFrom`, restarts web
→ worker (drained) → wda-service if its code differs, and runs the same health
gates. Running it again with the release you left returns you there. Database
migrations are not reversed (see above).

## What is live?

```sh
curl -s http://127.0.0.1:3000/health               # {"ok":true,"release":"<sha>"}
cat ~/phone-farm/current/RELEASED                   # id, sha, version, subject, deployedAt
tail ~/phone-farm/shared/logs/deploy.log
```

## One-time migration of an existing host

A host set up from a plain checkout (the Mac mini, rsynced) has the code and
its state mixed in `~/phone-farm`. `scripts/migrate-to-releases.sh` converts it
once, in place:

1. **Backs up** `.env*`, `devices.json`, `.wda/`, `.scheduler-data/` and
   `backups/` to `~/phone-farm-backups/migrate-<timestamp>/state.tgz` (0700),
   plus a `pg_dump` when the Docker Postgres answers, the launchd plists and a
   listing of the tree. `.appium2/` and `logs/` are moved but not archived.
2. **Stops** the web, worker, wda-service and appium agents. The worker gets
   its drain window (`WORKER_DRAIN_SECONDS`) to finish running tasks; longer
   ones are stopped, so pick a quiet moment. `db` and any other agent, such as a
   tunnel, are left alone.
3. **Moves** host state into `shared/` and everything else, `node_modules`
   included, into `releases/<id>/` (`<id>` = the checkout's git sha, or
   `initial-<timestamp>` for a tree without `.git`). Moves, not copies: the
   same volume, so it is instant and no secret is duplicated. Files it does not
   recognise move with the code; nothing is deleted.
4. **Links** the state into the release, points `current` at it, and leaves
   compatibility links (`~/phone-farm/.env`, `.wda`, `logs`, ...) so absolute
   paths such as `WDA_XCTESTRUN=/Users/<user>/phone-farm/.wda/...` in `.env`
   keep working.
5. **Reinstalls** the agents from `current` (with the installer the old code
   shipped) and waits for `/health`.

It is idempotent: a finished migration is detected and left alone, and an
interrupted one resumes (`~/phone-farm/.migrating` holds its state).
`--dry-run` shows the plan without changing anything.

Then deploy the current code with `--install-agents`, so the agents are
reinstalled by the new installer (logs move to `shared/logs`, the heartbeat
agent follows `current`).

### Commands for the Mac mini

From the laptop, in a clean checkout of the branch or tag to deploy:

```sh
# 0. Preview (read-only): copy the script over and ask for the plan.
scp -r scripts fidelity@100.119.132.42:/tmp/pf-scripts
ssh fidelity@100.119.132.42 'PATH=/opt/homebrew/bin:$PATH /tmp/pf-scripts/migrate-to-releases.sh --dry-run'

# 1. Migrate and deploy in one go: build, copy, migrate (backup + move), deploy
#    with --install-agents, health-check.
scripts/deploy-remote.sh --migrate fidelity@100.119.132.42

# 2. Check.
ssh fidelity@100.119.132.42 'ls -l ~/phone-farm; cat ~/phone-farm/current/RELEASED; curl -s http://127.0.0.1:3000/health/ready'
```

Afterwards, every deploy is `scripts/deploy-remote.sh fidelity@100.119.132.42`.

Check after migrating:

- Anything else on the host that ran code from `~/phone-farm` directly (the
  `tunnel` agent, `~/phone-farm-tools/auto-register.sh`, cron jobs) must now use
  `~/phone-farm/current`; the migration prints a note for every other launchd
  plist that still names `~/phone-farm`. Paths to state (`.env`,
  `devices.json`, `.wda`) keep working through the compatibility links.
- Docker Postgres: `docker-compose.yml` now pins the project name
  `phone-farm`, so the volume is `phone-farm_phone-farm-postgres`, the one a
  checkout in `~/phone-farm` always used. The migration warns if it does not
  exist; then set `COMPOSE_PROJECT_NAME` in `shared/.env` to the old name.
- `~/phone-farm-backups/migrate-*` holds secrets: delete it once the new layout
  has run for a while.

To undo a migration by hand: stop the agents
(`deploy/launchd/uninstall-agents.sh`), remove the compatibility links and
`current`, move `shared/*` and `releases/<initial>/*` back into `~/phone-farm`,
and run `deploy/launchd/install-agents.sh` from there.

## New hosts

Install from a checkout as in [install-mac-mini.md](install-mac-mini.md), then
run `scripts/migrate-to-releases.sh` once, and deploy with
`scripts/deploy-remote.sh --install-agents <host>` from then on.

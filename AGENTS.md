# Working in this repository — for engineers and AI coding agents

Phone Farm iOS Core drives physical iPhones over USB from a Mac: a Fastify +
HTMX dashboard, a pg-boss scheduler, one WebDriverAgent per phone, Appium for
task subprocesses, and a versioned plugin model (TikTok ships built in).
Read `docs/architecture.md` first; it is short and accurate.

## Commands you will use

```sh
npm install && npm run appium:install-driver   # deps + pinned XCUITest 12.9.0 into ./.appium2
npm run check                                  # typecheck (server + browser TS) + node:test suite — run before every commit
npm test -- test/branding.test.ts              # one file
npm run web / worker / wda:service / appium    # the four processes (see docs/getting-started.md)
npm run db:up && npm run db:migrate            # bundled Postgres + schema
npm run db:generate                            # after editing src/database/schema.ts -> new drizzle migration
npm run wda:prepare -- --udid <udid>           # sign/build WebDriverAgent (graphical session only)
```

There is no server build step: TypeScript runs through `tsx`. Browser code in
`static/dashboard/ts/` compiles to `static/dashboard/assets/*.js` with
`npm run build:web` (run automatically by `npm run web`); commit both.

## Layout

| Path | What |
| --- | --- |
| `src/api/app.ts` | the whole HTTP surface: dashboard pages, `/api/*`, fragments, remote control, CSRF guard, asset routes |
| `src/branding.ts` | env-driven white-label (name, credit, logo, footer) |
| `src/plugin.ts` | **stable** plugin + auth interfaces; `src/registry.ts` resolves `{pluginId, taskType, taskVersion}` |
| `src/scheduler/` | pg-boss queue, recurrence, executor, worker |
| `src/devices/` | discovery (usbmux), `devices.json` registry, registration wizard, WDA supervisor + remote, coordinate profiles |
| `src/tiktok/`, `src/tiktok-plugin.ts` | the built-in plugin and its standalone entrypoints |
| `static/dashboard/templates/*.html` | server templates with `__PLACEHOLDER__` slots (`__BRAND__`, `__BRAND_TITLE__`, `__FOOTER__`, `__PLUGIN_NAV__`, `__AUTH_NAV__`, TikTok slots) |
| `test/` | `node:test` suites; `test/support.ts` has the CSRF-aware `inject()` |
| `deploy/launchd/` | agent installer for always-on hosts |
| `docs/` | user-facing documentation (keep it truthful; it is part of the product) |

## Invariants — do not break these

1. **Task versions are frozen contracts.** Never change what `type@version`
   validates or does once it has shipped; add `@N+1` and keep `@N` installed
   while schedules reference it (`PLUGIN_DEVELOPMENT.md`).
2. **`web` and `worker` load identical plugins.** A schedule that can be created must be executable.
3. **Loopback by default.** `assertSafeBind` refuses a non-loopback `WEB_HOST`
   without `PHONE_FARM_AUTH_PLUGIN`. Appium and Postgres bind 127.0.0.1. Keep it so.
4. **Secrets never enter the tree, logs, summaries or HTML.** Passcodes live only
   in `devices.json` (0600) and are redacted by the API (`hasPasscode`).
   `.env`, `devices.json`, `.appium2/`, `static/brand/*` are git-ignored on purpose.
5. **Escape everything rendered.** Templates are trusted code; device/user values
   go through `escapeHtml`. Plugin panels too.
6. **Persisted contract keys are not branding.** `com.git-agni.tiktok` and the
   package name `@git-agni/phone-farm-core` stay as they are; the UI brand is
   configured through `src/branding.ts`, not by editing templates.
7. **Coordinate profiles are typed constants** in two files that must match
   (`src/devices/coordinates.ts`, `src/tiktok/coordinates.ts`). Per-device
   overrides cover only the 15 calibratable points.
8. **Idempotent operations.** Migrations, `wda:prepare`, the launchd installer
   and the registry mutators are safe to re-run; keep new operations that way.

## Conventions

- TypeScript strict, ESM, 4-space indent, single quotes, no default exports except plugins.
- Tests: `node:test` + `node:assert/strict`, no network, no real devices; mock
  `SchedulerRepository` / `DeviceRegistrationManager` as `test/app.test.ts` does.
- A change to behaviour ships with a test and, when user-visible, a docs update.
- Commit messages: imperative, one topic, explain *why* in the body when it is not obvious.
- CI is GitHub-hosted only. Never attach devices, signing material or
  production databases to PR-triggered workflows (`SECURITY.md`).

## Things that look like bugs but are not

- A schedule failing with "task version not installed" after an upgrade — by design (invariant 1).
- `wda:prepare` failing over SSH with `errSecInternalComponent` — keychain needs a GUI session.
- `403 Cross-origin write blocked` from a script — send `Authorization: Bearer …` or set `PHONE_FARM_TRUSTED_ORIGINS`.
- The device grid showing stills, not video — intentional; live MJPEG is only on the device page.

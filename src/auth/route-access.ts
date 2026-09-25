import type { PluginRouteAccess } from '../plugin.js';
import type { AccessLevel } from './policy.js';

/**
 * Every HTTP route and what a caller needs to reach it. The dashboard's
 * preHandler looks each request up here (src/api/app.ts), so authorization
 * lives in one table rather than in forty handlers, and
 * test/auth-route-coverage.test.ts fails when a route is added without an entry.
 *
 * Kinds:
 * - `public`            — no session (the sign-in page and what it needs).
 * - `signed-in`         — any signed-in user; list handlers filter to the user's phones.
 * - `admin`             — admins only.
 * - `device`            — the user's level on the phone in `:udid`.
 * - `device-settings`   — PATCH /api/devices/:udid: admin, except a body that only
 *                         carries `coordinates` (touch-point calibration) needs `operate`.
 * - `schedule-create`   — `operate` on the phone named by `body.deviceUdid`.
 * - `schedule` / `execution` — the level on the phone that schedule/run belongs to.
 * - `any-operate`       — `operate` on at least one phone (asset uploads).
 * - `token`             — no session; the handler checks its own bearer token
 *                         (GET /metrics and PHONE_FARM_METRICS_TOKEN).
 *
 * An unknown or ungranted phone answers 404, not 403, so ids cannot be probed.
 */
export type RouteRequirement =
    | { kind: 'public' }
    | { kind: 'signed-in' }
    | { kind: 'admin' }
    | { kind: 'device'; level: AccessLevel }
    | { kind: 'device-settings' }
    | { kind: 'schedule-create' }
    | { kind: 'schedule'; level: AccessLevel }
    | { kind: 'execution'; level: AccessLevel }
    | { kind: 'any-operate' }
    | { kind: 'token' };

const PUBLIC: RouteRequirement = { kind: 'public' };
const SIGNED_IN: RouteRequirement = { kind: 'signed-in' };
const ADMIN: RouteRequirement = { kind: 'admin' };
const VIEW: RouteRequirement = { kind: 'device', level: 'view' };
const OPERATE: RouteRequirement = { kind: 'device', level: 'operate' };
const TOKEN: RouteRequirement = { kind: 'token' };

export const ROUTE_REQUIREMENTS: Readonly<Record<string, RouteRequirement>> = {
    // service
    'GET /health': PUBLIC,
    // readiness: pass/fail per dependency with fixed reasons, nothing sensitive
    'GET /health/ready': PUBLIC,
    // Prometheus scrape: bearer PHONE_FARM_METRICS_TOKEN, 404 when unset
    'GET /metrics': TOKEN,
    'GET /api/plugins': SIGNED_IN,
    'GET /docs': SIGNED_IN,

    // sign-in (src/auth/routes.ts)
    'GET /login': PUBLIC,
    'POST /login': PUBLIC,
    'POST /logout': PUBLIC,
    'GET /account/password': SIGNED_IN,
    'POST /account/password': SIGNED_IN,
    'GET /api/me': SIGNED_IN,

    // Team panel
    'GET /team': ADMIN,
    'GET /api/team': ADMIN,
    'POST /api/team/users': ADMIN,
    'PATCH /api/team/users/:id': ADMIN,
    'DELETE /api/team/users/:id': ADMIN,
    'POST /api/team/users/:id/reset-password': ADMIN,
    'POST /api/team/groups': ADMIN,
    'PATCH /api/team/groups/:id': ADMIN,
    'DELETE /api/team/groups/:id': ADMIN,
    'POST /api/team/groups/:id/members': ADMIN,
    'DELETE /api/team/groups/:id/members/:userId': ADMIN,
    'POST /api/team/grants': ADMIN,
    'DELETE /api/team/grants/:id': ADMIN,

    // pages
    'GET /': SIGNED_IN,
    'GET /tasks': SIGNED_IN,
    'GET /devices/register': ADMIN,
    'GET /devices/:udid': VIEW,

    // static assets: the stylesheet, fonts and logo render the sign-in page
    'GET /assets/styles.css': PUBLIC,
    'GET /assets/brand-logo': PUBLIC,
    'GET /assets/fonts/:file': PUBLIC,
    'GET /assets/device.js': SIGNED_IN,
    'GET /assets/tasks.js': SIGNED_IN,
    'GET /assets/register-device.js': SIGNED_IN,
    'GET /assets/grid.js': SIGNED_IN,
    'GET /assets/team.js': SIGNED_IN,
    'GET /assets/htmx.min.js': SIGNED_IN,

    // devices
    'GET /api/devices': SIGNED_IN,
    'GET /api/fragments/devices': SIGNED_IN,
    'GET /api/devices/discovered': ADMIN,
    'POST /api/devices': ADMIN,
    'PATCH /api/devices/:udid': { kind: 'device-settings' },
    'DELETE /api/devices/:udid': ADMIN,
    'GET /api/devices/:udid/coordinates': VIEW,
    'POST /api/devices/:udid/checks': OPERATE,
    'GET /api/devices/:udid/connection': VIEW,
    'POST /api/devices/:udid/reconnect': OPERATE,
    // raw xcodebuild output (team ids, host paths): admins only
    'GET /api/devices/:udid/wda-log': ADMIN,
    'GET /api/devices/:udid/fragments/summary': VIEW,
    'GET /api/devices/:udid/fragments/activity': VIEW,

    // remote control
    'GET /api/devices/:udid/remote/info': VIEW,
    'GET /api/devices/:udid/remote/screenshot': VIEW,
    'GET /api/devices/:udid/remote/thumbnail': VIEW,
    'GET /api/devices/:udid/remote/stream': VIEW,
    'POST /api/devices/:udid/remote/action': OPERATE,

    // registration wizard
    'GET /api/device-registrations/candidates': ADMIN,
    'POST /api/device-registrations': ADMIN,
    'GET /api/device-registrations/:id': ADMIN,
    'PATCH /api/device-registrations/:id': ADMIN,
    'POST /api/device-registrations/:id/actions/:action': ADMIN,
    'DELETE /api/device-registrations/:id': ADMIN,

    // scheduling
    'GET /api/schedules': SIGNED_IN,
    'POST /api/schedules': { kind: 'schedule-create' },
    'PATCH /api/schedules/:id': { kind: 'schedule', level: 'operate' },
    'POST /api/schedules/:id/status': { kind: 'schedule', level: 'operate' },
    'POST /api/schedules/:id/pause': { kind: 'schedule', level: 'operate' },
    'POST /api/schedules/:id/resume': { kind: 'schedule', level: 'operate' },
    'POST /api/schedules/:id/cancel': { kind: 'schedule', level: 'operate' },
    'GET /api/executions': SIGNED_IN,
    'GET /api/executions/:id': { kind: 'execution', level: 'view' },
    'POST /api/executions/:id/stop': { kind: 'execution', level: 'operate' },
    'POST /api/executions/:id/retry': { kind: 'execution', level: 'operate' },
    'POST /api/assets': { kind: 'any-operate' },
    'DELETE /api/assets': ADMIN,
};

export function routeKey(method: string, url: string): string {
    const verb = method.toUpperCase();
    // Fastify answers HEAD with the GET handler; it needs exactly what GET needs.
    return `${verb === 'HEAD' ? 'GET' : verb} ${url}`;
}

function fromPlugin(access: PluginRouteAccess): RouteRequirement {
    switch (access.kind) {
        case 'signed-in': return SIGNED_IN;
        case 'device': return { kind: 'device', level: access.level === 'view' ? 'view' : 'operate' };
        default: return ADMIN;
    }
}

/**
 * The requirement table for this process: the core table plus what plugins
 * declare for their own routes. A plugin cannot loosen a core route.
 */
export function buildRouteRequirements(
    plugins: ReadonlyArray<{ routeAccess?: Readonly<Record<string, PluginRouteAccess>> }>,
): Map<string, RouteRequirement> {
    const table = new Map(Object.entries(ROUTE_REQUIREMENTS));
    for (const plugin of plugins) {
        for (const [key, access] of Object.entries(plugin.routeAccess ?? {})) {
            const [method, ...rest] = key.trim().split(/\s+/);
            const normalized = routeKey(method ?? '', rest.join(' '));
            if (!table.has(normalized)) table.set(normalized, fromPlugin(access));
        }
    }
    return table;
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthApp, TEST_DEVICES, useDevicesFile } from './auth-support.js';

await useDevicesFile(TEST_DEVICES);
const { routeAccessReport } = await import('../src/api/app.js');
const { isBuiltinPublicPath } = await import('../src/auth/builtin.js');
const { ROUTE_REQUIREMENTS, buildRouteRequirements, routeKey } = await import('../src/auth/route-access.js');

// The authorization hook looks every request up in one table. A route without
// an entry is admin-only at runtime, which fails safe but silently locks
// operators out — so every route must be declared, and this test is the gate.
test('every registered route has a declared access requirement', async (context) => {
    const { app } = await createAuthApp();
    context.after(() => app.close());
    const report = routeAccessReport(app);
    assert.ok(report.length > 60, `expected the full dashboard, saw ${report.length} routes`);
    const undeclared = report.filter(({ requirement }) => !requirement).map(({ method, url }) => `${method} ${url}`);
    assert.deepEqual(undeclared, [], 'add these to ROUTE_REQUIREMENTS (src/auth/route-access.ts) or the plugin\'s routeAccess');
});

test('public routes are exactly the sign-in page and what it needs to render', async (context) => {
    const { app } = await createAuthApp();
    context.after(() => app.close());
    const report = routeAccessReport(app).filter(({ method }) => method !== 'HEAD');
    const publicRoutes = report.filter(({ requirement }) => requirement?.kind === 'public').map(({ method, url }) => `${method} ${url}`).sort();
    assert.deepEqual(publicRoutes, [
        'GET /assets/fonts/:file', 'GET /assets/styles.css', 'GET /health', 'GET /health/ready', 'GET /login', 'POST /login', 'POST /logout',
    ]);
    // The provider's own notion of "public" (checked before authentication) must agree with the table.
    for (const { url, requirement } of report) {
        const concrete = url.replace(':file', 'poppins-latin-400.woff2');
        assert.equal(isBuiltinPublicPath(concrete), requirement?.kind === 'public', url);
    }
    assert.equal(isBuiltinPublicPath('/assets/brand-logo'), true, 'the logo, when configured, renders on the sign-in page');
    assert.equal(isBuiltinPublicPath('/assets/fonts/../../devices.json'), false);
});

test('the requirement table has no stale entries', async (context) => {
    const { app } = await createAuthApp();
    context.after(() => app.close());
    const registered = new Set(routeAccessReport(app).map(({ method, url }) => routeKey(method, url)));
    // Registered only when PHONE_FARM_BRAND_LOGO points at a file.
    const conditional = new Set(['GET /assets/brand-logo']);
    const stale = Object.keys(ROUTE_REQUIREMENTS).filter((key) => !registered.has(key) && !conditional.has(key));
    assert.deepEqual(stale, []);
});

test('a plugin can declare its own routes but cannot loosen a core route', () => {
    const table = buildRouteRequirements([{
        routeAccess: {
            'GET /plugins/x/report': { kind: 'signed-in' },
            'POST  /plugins/x/devices/:udid/run': { kind: 'device', level: 'operate' },
            'DELETE /api/devices/:udid': { kind: 'signed-in' },
            'HEAD /plugins/x/ping': { kind: 'admin' },
        },
    }]);
    assert.deepEqual(table.get('GET /plugins/x/report'), { kind: 'signed-in' });
    assert.deepEqual(table.get('POST /plugins/x/devices/:udid/run'), { kind: 'device', level: 'operate' });
    assert.deepEqual(table.get('DELETE /api/devices/:udid'), { kind: 'platform' });
    assert.deepEqual(table.get('GET /plugins/x/ping'), { kind: 'platform' }, 'HEAD is keyed as GET; a plugin `admin` route is platform-only');
});

test('HEAD requests need what GET needs', () => {
    assert.equal(routeKey('HEAD', '/api/devices'), 'GET /api/devices');
    assert.equal(routeKey('get', '/x'), 'GET /x');
});

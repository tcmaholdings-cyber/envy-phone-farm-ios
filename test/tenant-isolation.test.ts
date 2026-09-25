import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_DEVICES, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';
import { twoTenantFarm, type FarmTenant, type TwoTenantFarm } from './tenant-support.js';

await useDevicesFile(TEST_DEVICES);
const { routeAccessReport } = await import('../src/api/app.js');

/**
 * Tenant isolation, route by route. Every route in the access table that takes
 * an id is called by each tenant's admin and operator with the OTHER tenant's
 * ids. A tenant-scoped id must be a 404 (it does not exist for them), a
 * platform-only route a uniform 403. A route kind this walk does not know fails
 * the test, so a new kind of route cannot skip the check.
 */

type Who = 'admin' | 'operator';

/** The route's pattern with the victim tenant's ids filled in, and a body naming them. */
function concrete(url: string, method: string, victim: FarmTenant, farm: TwoTenantFarm): { url: string; payload?: Record<string, unknown> } {
    const ids = victim === farm.acme ? farm.ids.acme : farm.ids.beloura;
    const id = url.startsWith('/api/schedules/') ? ids.schedule
        : url.startsWith('/api/executions/') ? ids.execution
            : url.startsWith('/api/team/users/') ? victim.admin.id
                : url.startsWith('/api/team/groups/') ? victim.group.id
                    : url.startsWith('/api/team/grants/') ? victim.grant.id
                        : url.startsWith('/api/tenants/') ? victim.tenantId
                            : 'draft-1';
    const filled = url.replace(':udid', encodeURIComponent(victim.phone)).replace(':userId', victim.operator.id)
        .replace(':action', 'refresh').replace(':id', id);
    if (method === 'GET' || method === 'HEAD') return { url: filled };
    return { url: filled, payload: { deviceUdid: victim.phone, assetIds: [victim.asset.id], userId: victim.operator.id, udid: victim.phone } };
}

test('every id-taking route answers another tenant\'s ids with 404 (or 403 when platform-only)', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const routes = routeAccessReport(farm.app).filter(({ method }) => method !== 'HEAD');
    let checked = 0;
    for (const { method, url, requirement } of routes) {
        const takesId = url.includes(':') || url === '/api/schedules' && method === 'POST' || url === '/api/assets' && method === 'DELETE';
        if (!takesId || !requirement) continue;
        for (const [attacker, victim] of [[farm.beloura, farm.acme], [farm.acme, farm.beloura]] as const) {
            for (const who of ['admin', 'operator'] as Who[]) {
                let expected: number;
                switch (requirement.kind) {
                    case 'public':
                    case 'token':
                        continue;
                    case 'platform':
                        expected = 403;
                        break;
                    case 'tenant-admin':
                        expected = who === 'admin' ? 404 : 403;
                        break;
                    case 'device':
                    case 'device-settings':
                    case 'schedule':
                    case 'execution':
                    case 'schedule-create':
                        expected = 404;
                        break;
                    default:
                        assert.fail(`${method} ${url}: the isolation walk does not know route kind "${requirement.kind}" — teach it`);
                }
                const request = concrete(url, method, victim, farm);
                const response = await inject(farm.app, {
                    method: method as 'GET', url: request.url, cookies: attacker.cookies[who],
                    headers: { accept: 'application/json' }, ...(request.payload ? { payload: request.payload } : {}),
                });
                assert.equal(response.statusCode, expected, `${attacker.admin.username.split('-')[0]} ${who}: ${method} ${request.url} → ${response.statusCode} ${response.body.slice(0, 120)}`);
                checked++;
            }
        }
    }
    assert.ok(checked > 120, `walked ${checked} requests`);
    // Nothing was created, changed or deleted on anybody's behalf.
    assert.deepEqual(farm.scheduler.calls, []);
    assert.deepEqual(farm.remote.actions, []);
    assert.equal(farm.store.users.length, 5);
    assert.equal(farm.store.groups.length, 2);
    assert.equal(farm.store.grants.length, 2);
    assert.equal(farm.scheduler.assets.length, 2);
});

test('the same requests from the owning tenant get through (the walk is testing tenancy, not typos)', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const as = (tenant: FarmTenant, who: Who, method: string, url: string, payload?: unknown) => inject(farm.app, {
        method: method as 'GET', url, cookies: tenant.cookies[who], ...(payload === undefined ? {} : { payload: payload as object }),
    });
    assert.equal((await as(farm.acme, 'operator', 'GET', '/api/devices/udid-r2-mini/coordinates')).statusCode, 200);
    assert.equal((await as(farm.acme, 'admin', 'GET', '/api/executions/e-acme')).statusCode, 200);
    assert.equal((await as(farm.acme, 'operator', 'POST', '/api/schedules/s-acme/pause', {})).statusCode, 200);
    assert.equal((await as(farm.acme, 'admin', 'PATCH', `/api/team/users/${farm.acme.operator.id}`, { displayName: 'Acme VA' })).statusCode, 200);
    assert.equal((await as(farm.acme, 'admin', 'POST', `/api/team/groups/${farm.acme.group.id}/members`, { userId: farm.acme.admin.id })).statusCode, 204);
    assert.equal((await as(farm.acme, 'admin', 'DELETE', '/api/assets', { assetIds: [farm.acme.asset.id] })).statusCode, 204);
    assert.equal((await as(farm.beloura, 'admin', 'GET', '/api/executions/e-bel')).statusCode, 200);
    // Platform staff reach both.
    for (const url of ['/api/executions/e-acme', '/api/executions/e-bel', '/api/devices/udid-r2-mini/coordinates']) {
        assert.equal((await inject(farm.app, { method: 'GET', url, cookies: farm.platformCookie })).statusCode, 200, url);
    }
});

test('lists hold only the caller\'s tenant: phones, schedules, executions, the grid, the Team', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const get = (cookies: Record<string, string>, url: string) => inject(farm.app, { method: 'GET', url, cookies });
    for (const [tenant, other] of [[farm.beloura, farm.acme], [farm.acme, farm.beloura]] as const) {
        for (const who of ['admin', 'operator'] as Who[]) {
            const cookies = tenant.cookies[who];
            const phones = (await get(cookies, '/api/devices')).json() as Array<{ udid: string; tenantId: string }>;
            assert.ok(phones.length > 0);
            assert.ok(phones.every(({ tenantId }) => tenantId === tenant.tenantId), `${who}: only own phones`);
            assert.ok(!phones.some(({ udid }) => udid === other.phone));
            // Asking for the other tenant changes nothing.
            const asked = (await get(cookies, `/api/devices?tenant=${other.tenantId}`)).json() as Array<{ udid: string }>;
            assert.deepEqual(asked.map(({ udid }) => udid).sort(), phones.map(({ udid }) => udid).sort());
            for (const list of ['schedules', 'executions'] as const) {
                const rows = ((await get(cookies, `/api/${list}?tenant=${other.tenantId}`)).json() as Record<string, Array<{ id: string; tenantId: string }>>)[list]!;
                assert.ok(rows.length > 0, `${who} sees their own ${list}`);
                assert.ok(rows.every(({ tenantId }) => tenantId === tenant.tenantId), `${who}: only own ${list}`);
            }
            const grid = (await get(cookies, '/api/fragments/devices')).body;
            assert.doesNotMatch(grid, new RegExp(other === farm.acme ? 'Rack2 Mini' : 'Rack1 Mini'));
        }
        const team = (await get(tenant.cookies.admin, `/api/team?tenant=${other.tenantId}`)).json() as { users: Array<{ username: string; tenantId: string }>; groups: Array<{ tenantId: string }> };
        assert.ok(team.users.every(({ tenantId }) => tenantId === tenant.tenantId), 'a tenant admin cannot list another tenant\'s people');
        assert.ok(team.groups.every(({ tenantId }) => tenantId === tenant.tenantId));
        assert.ok(!team.users.some(({ username }) => username === 'root'), 'platform staff are not a tenant\'s people');
    }
    // A phone that moved: acme's old run on a beloura phone is gone for beloura, and not shown to acme on a phone it no longer has.
    const belouraRuns = ((await get(farm.beloura.cookies.admin, '/api/executions')).json() as { executions: Array<{ id: string }> }).executions;
    assert.ok(!belouraRuns.some(({ id }) => id === 'e-history'));
    const acmeRuns = ((await get(farm.acme.cookies.admin, '/api/executions')).json() as { executions: Array<{ id: string }> }).executions;
    assert.ok(!acmeRuns.some(({ id }) => id === 'e-history'));
    assert.equal((await get(farm.beloura.cookies.admin, '/api/executions/e-history')).statusCode, 404);
    const activity = (await get(farm.beloura.cookies.admin, '/api/devices/udid-r1-se/fragments/activity')).body;
    assert.doesNotMatch(activity, /e-history/, 'the activity panel shows only the current owner\'s runs');

    // Platform staff see every tenant, and can narrow to one.
    const all = (await get(farm.platformCookie, '/api/devices')).json() as unknown[];
    assert.equal(all.length, TEST_DEVICES.length);
    const acmeOnly = (await get(farm.platformCookie, `/api/devices?tenant=${farm.acme.tenantId}`)).json() as Array<{ udid: string }>;
    assert.deepEqual(acmeOnly.map(({ udid }) => udid), ['udid-r2-mini']);
    const acmeSchedules = ((await get(farm.platformCookie, `/api/schedules?tenant=${farm.acme.tenantId}`)).json() as { schedules: Array<{ id: string }> }).schedules;
    assert.deepEqual(acmeSchedules.map(({ id }) => id), ['s-acme']);
});

test('creating a schedule on another tenant\'s phone, or with another tenant\'s media, is a 404', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const create = (tenant: FarmTenant, deviceUdid: string, assetIds: string[] = []) => inject(farm.app, {
        method: 'POST', url: '/api/schedules', cookies: tenant.cookies.operator,
        payload: { deviceUdid, task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {} }, timing: { kind: 'now' }, assetIds },
    });
    assert.equal((await create(farm.acme, 'udid-r1-mini')).statusCode, 404);
    assert.equal((await create(farm.acme, 'udid-r2-mini', [farm.beloura.asset.id])).statusCode, 404, 'another tenant\'s upload cannot be attached');
    const own = await create(farm.acme, 'udid-r2-mini', [farm.acme.asset.id]);
    assert.equal(own.statusCode, 201);
    assert.equal(own.json().tenantId, farm.acme.tenantId, 'the schedule belongs to the phone\'s tenant');
});

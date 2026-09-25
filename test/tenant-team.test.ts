import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TENANT_ID, sessionCookie, TEST_DEVICES, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';
import { twoTenantFarm } from './tenant-support.js';

await useDevicesFile(TEST_DEVICES);
const { hashPassword } = await import('../src/auth/password.js');

/** The Team rules across tenants: what a tenant admin can and cannot do to people, groups and grants. */

test('a tenant admin creates people only in their own tenant, and never platform staff', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const call = (method: string, url: string, payload?: unknown) => inject(farm.app, {
        method: method as 'POST', url, cookies: farm.acme.cookies.admin, ...(payload === undefined ? {} : { payload: payload as object }),
    });
    const created = await call('POST', `/api/team/users?tenant=${DEFAULT_TENANT_ID}`, { username: 'newva', tenantId: DEFAULT_TENANT_ID });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().user.tenantId, farm.acme.tenantId, 'asking for another tenant lands in your own');
    assert.equal((await call('POST', '/api/team/users', { username: 'boss', role: 'platform' })).statusCode, 403);
    assert.equal((await call('PATCH', `/api/team/users/${farm.acme.operator.id}`, { role: 'platform' })).statusCode, 403);
    assert.equal((await call('PATCH', `/api/team/users/${farm.acme.operator.id}`, { role: 'admin' })).json().role, 'admin', 'tenant roles are fine');
    // Another tenant's group cannot be joined, and another tenant's person cannot be added to your group.
    assert.equal((await call('POST', '/api/team/users', { username: 'x2', groupIds: [farm.beloura.group.id] })).statusCode, 404);
    assert.equal((await call('POST', `/api/team/groups/${farm.acme.group.id}/members`, { userId: farm.beloura.operator.id })).statusCode, 404);
    assert.equal((await call('DELETE', `/api/team/groups/${farm.acme.group.id}/members/${farm.beloura.operator.id}`)).statusCode, 404);
    // Group names are per tenant.
    assert.equal((await call('POST', '/api/team/groups', { name: 'beloura crew' })).statusCode, 201);
    assert.equal((await call('POST', '/api/team/groups', { name: 'beloura crew' })).statusCode, 409);
    assert.equal(farm.store.users.find(({ username }) => username === 'boss'), undefined);
});

test('grants: another tenant\'s person, group or phone is not found', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const grant = (body: Record<string, unknown>) => inject(farm.app, {
        method: 'POST', url: '/api/team/grants', cookies: farm.acme.cookies.admin, payload: { scopeType: 'all', level: 'view', ...body },
    });
    assert.equal((await grant({ subjectType: 'user', subjectId: farm.beloura.operator.id })).statusCode, 404);
    assert.equal((await grant({ subjectType: 'group', subjectId: farm.beloura.group.id })).statusCode, 404);
    assert.equal((await grant({ subjectType: 'user', subjectId: farm.acme.operator.id, scopeType: 'device', scopeValue: 'udid-r1-mini' })).statusCode, 404);
    assert.equal((await grant({ subjectType: 'user', subjectId: farm.acme.operator.id, scopeType: 'device', scopeValue: 'udid-r2-mini' })).statusCode, 201);
    assert.equal((await grant({ subjectType: 'user', subjectId: farm.platform.id })).statusCode, 404, 'platform staff are nobody\'s to grant');
    const platformGrant = await inject(farm.app, {
        method: 'POST', url: '/api/team/grants', cookies: farm.platformCookie,
        payload: { subjectType: 'user', subjectId: farm.platform.id, scopeType: 'all', level: 'view' },
    });
    assert.equal(platformGrant.statusCode, 400, 'platform accounts reach every phone already');
});

test('platform staff manage any tenant\'s team with ?tenant=, and the platform accounts with ?tenant=platform', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const call = (method: string, url: string, payload?: unknown) => inject(farm.app, {
        method: method as 'POST', url, cookies: farm.platformCookie, ...(payload === undefined ? {} : { payload: payload as object }),
    });
    const acmeTeam = (await call('GET', `/api/team?tenant=${farm.acme.tenantId}`)).json() as { users: Array<{ username: string }> };
    assert.deepEqual(acmeTeam.users.map(({ username }) => username).sort(), ['acme-admin', 'acme-va']);
    const staff = (await call('GET', '/api/team?tenant=platform')).json() as { users: Array<{ username: string }> };
    assert.deepEqual(staff.users.map(({ username }) => username), ['root']);
    const admin = await call('POST', `/api/team/users?tenant=${farm.acme.tenantId}`, { username: 'acme-boss', role: 'admin' });
    assert.equal(admin.statusCode, 201);
    assert.equal(admin.json().user.tenantId, farm.acme.tenantId);
    const colleague = await call('POST', '/api/team/users', { username: 'root2', role: 'platform' });
    assert.equal(colleague.json().user.tenantId, null);
    assert.equal((await call('PATCH', `/api/team/users/${farm.acme.operator.id}`, { role: 'platform' })).statusCode, 400, 'no converting accounts across the boundary');
    assert.equal((await call('GET', '/api/team?tenant=00000000-0000-0000-0000-00000000dead')).statusCode, 404);
});

test('the last active admin of a tenant, and the last platform account, cannot be removed', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const byPlatform = (method: string, url: string, payload?: unknown) => inject(farm.app, {
        method: method as 'POST', url, cookies: farm.platformCookie, ...(payload === undefined ? {} : { payload: payload as object }),
    });
    assert.equal((await byPlatform('PATCH', `/api/team/users/${farm.acme.admin.id}`, { role: 'operator' })).statusCode, 409);
    assert.equal((await byPlatform('DELETE', `/api/team/users/${farm.acme.admin.id}`)).statusCode, 409);
    // Beloura's admin does not count as a spare for Acme.
    assert.ok(farm.store.users.some(({ role, tenantId }) => role === 'admin' && tenantId === DEFAULT_TENANT_ID));
    const root2 = await byPlatform('POST', '/api/team/users', { username: 'root2', role: 'platform' });
    assert.equal((await byPlatform('DELETE', `/api/team/users/${root2.json().user.id}`)).statusCode, 204);
});

test('a tenant\'s user limit is enforced', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    await farm.tenantStore.updateTenant(farm.acme.tenantId, { quotas: { maxUsers: 3 } });
    const add = (username: string) => inject(farm.app, { method: 'POST', url: '/api/team/users', cookies: farm.acme.cookies.admin, payload: { username } });
    assert.equal((await add('third')).statusCode, 201);
    const refused = await add('fourth');
    assert.equal(refused.statusCode, 409);
    assert.match(refused.json().error, /limit of 3 people/);
});

test('suspending a tenant ends its sessions and refuses its sign-ins with the usual answer', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const password = 'correct horse battery';
    await farm.store.updateUser(farm.acme.operator.id, { passwordHash: await hashPassword(password) });
    await farm.store.updateUser(farm.beloura.operator.id, { passwordHash: await hashPassword(password) });
    const login = (username: string) => inject(farm.app, {
        method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ username, password }).toString(),
    });
    assert.ok(sessionCookie(await login('acme-va')));
    await farm.tenants.update(null, farm.acme.tenantId, { status: 'suspended' });
    assert.equal((await inject(farm.app, { method: 'GET', url: '/api/devices', cookies: farm.acme.cookies.admin })).statusCode, 401);
    const refused = await login('acme-va');
    assert.equal(refused.statusCode, 401);
    assert.match(refused.body, /That username and password do not match an active account/);
    assert.equal(farm.audit.at(-1)?.detail, 'organisation suspended');
    assert.ok(sessionCookie(await login('beloura-va')), 'other tenants are unaffected');
    await assert.rejects(farm.tenants.update(null, DEFAULT_TENANT_ID, { status: 'suspended' }), /default organisation cannot be suspended/);
});

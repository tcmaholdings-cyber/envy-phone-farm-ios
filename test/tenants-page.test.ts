import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TENANT_ID, TEST_DEVICES, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';
import { twoTenantFarm } from './tenant-support.js';

await useDevicesFile(TEST_DEVICES);

test('the Organisations page is platform-only, escaped, and driven by htmx forms', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    await farm.tenantStore.updateTenant(farm.acme.tenantId, { name: 'Acme <b>Media</b>', quotas: { maxPhones: 3, maxUsers: 10 } });
    const page = await inject(farm.app, { method: 'GET', url: '/tenants', cookies: farm.platformCookie });
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /<b>Media<\/b>/);
    assert.match(page.body, /Acme &lt;b&gt;Media&lt;\/b&gt;/);
    assert.match(page.body, /<script src="\/assets\/htmx\.min\.js\?v=[\w-]+"><\/script>/);
    assert.match(page.body, /hx-post="\/api\/tenants"/);
    assert.match(page.body, /hx-post="\/api\/tenant-devices"/);
    assert.match(page.body, /<td>1 \/ 3<\/td><td>2 \/ 10<\/td>/, 'phones and people against their limits');
    assert.match(page.body, /<a class="nav-link" href="\/tenants" aria-current="page">Organisations<\/a>/);
    assert.doesNotMatch(page.body, new RegExp(`hx-patch="/api/tenants/${DEFAULT_TENANT_ID}"`), 'the default organisation cannot be suspended from here');
    for (const cookies of [farm.acme.cookies.admin, farm.acme.cookies.operator]) {
        assert.equal((await inject(farm.app, { method: 'GET', url: '/tenants', cookies, headers: { accept: 'text/html' } })).statusCode, 403);
        assert.equal((await inject(farm.app, { method: 'GET', url: '/api/tenants', cookies })).statusCode, 403);
    }
    const adminHome = await inject(farm.app, { method: 'GET', url: '/', cookies: farm.acme.cookies.admin });
    assert.doesNotMatch(adminHome.body, /href="\/tenants"/, 'no Organisations link for a tenant admin');
    assert.match(adminHome.body, /<body data-role="admin" class="page-grid">/);
});

test('platform staff create, suspend and re-activate organisations', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => inject(farm.app, {
        method: method as 'POST', url, cookies: farm.platformCookie, headers, ...(payload === undefined ? {} : { payload: payload as object }),
    });
    const created = await call('POST', '/api/tenants', { slug: 'globex', name: 'Globex', quotas: { maxPhones: 2 } });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json().quotas, { maxPhones: 2 });
    assert.equal((await call('POST', '/api/tenants', { slug: 'globex', name: 'Again' })).statusCode, 409);
    assert.equal((await call('POST', '/api/tenants', { slug: 'Not OK!', name: 'x' })).statusCode, 400);
    assert.equal((await call('POST', '/api/tenants', { slug: 'neg', quotas: { maxUsers: -1 } })).statusCode, 400);
    // The htmx form: form-encoded fields, the panel comes back with a banner.
    const form = await call('POST', '/api/tenants', 'slug=initech&name=%3Cscript%3EInitech%3C%2Fscript%3E&maxPhones=&maxUsers=5&maxUploadMb=100', {
        'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true',
    });
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /^<div id="tenants-panel"><div class="banner ok"/);
    assert.doesNotMatch(form.body, /<script>Initech/);
    const initech = farm.tenantStore.tenants.find(({ slug }) => slug === 'initech')!;
    assert.deepEqual(initech.quotas, { maxUsers: 5, maxUploadBytes: 100 * 1024 ** 2 });
    const failed = await call('POST', '/api/tenants', 'slug=initech&name=Again', { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' });
    assert.match(failed.body, /<div class="banner err" role="alert"><strong>An organisation with that short name already exists<\/strong>/);

    assert.equal((await call('PATCH', `/api/tenants/${created.json().id}`, { status: 'suspended' })).json().status, 'suspended');
    assert.equal((await call('PATCH', `/api/tenants/${created.json().id}`, { status: 'active' })).json().status, 'active');
    assert.equal((await call('PATCH', `/api/tenants/${DEFAULT_TENANT_ID}`, { status: 'suspended' })).statusCode, 409);
    assert.equal((await call('PATCH', '/api/tenants/00000000-0000-0000-0000-00000000dead', { status: 'suspended' })).statusCode, 404);
    assert.ok(farm.audit.some(({ event, target }) => event === 'tenant.created' && target === 'globex'));
    // A cross-site post is refused like every other write.
    const csrf = await farm.app.inject({ method: 'POST', url: '/api/tenants', cookies: farm.platformCookie, headers: { origin: 'https://evil.example' }, payload: { slug: 'evil' } });
    assert.equal(csrf.statusCode, 403);
});

test('moving a phone to another organisation cancels the old owner\'s schedules and respects the phone limit', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const assign = (udid: string, tenantId: string) => inject(farm.app, {
        method: 'POST', url: '/api/tenant-devices', cookies: farm.platformCookie, payload: { udid, tenantId },
    });
    const moved = await assign('udid-r1-mini', farm.acme.tenantId);
    assert.equal(moved.statusCode, 200);
    assert.deepEqual(moved.json(), { udid: 'udid-r1-mini', tenantId: farm.acme.tenantId, cancelledSchedules: 1 });
    assert.ok(farm.scheduler.calls.includes('status:s-bel:cancelled'), 'beloura\'s schedule on the phone was cancelled');
    assert.equal(farm.tenantStore.assignments.get('udid-r1-mini'), farm.acme.tenantId);
    // Beloura's people lose the phone at once; Acme's get it.
    assert.equal((await inject(farm.app, { method: 'GET', url: '/api/devices/udid-r1-mini/coordinates', cookies: farm.beloura.cookies.admin })).statusCode, 404);
    assert.equal((await inject(farm.app, { method: 'GET', url: '/api/devices/udid-r1-mini/coordinates', cookies: farm.acme.cookies.operator })).statusCode, 200);
    assert.ok(farm.audit.some(({ event, target }) => event === 'tenant.device_assigned' && target === 'udid-r1-mini'));

    await farm.tenantStore.updateTenant(farm.acme.tenantId, { quotas: { maxPhones: 2 } });
    const full = await assign('udid-r1-se', farm.acme.tenantId);
    assert.equal(full.statusCode, 409);
    assert.match(full.json().error, /limit of 2 phones/);
    assert.equal((await assign('no-such-phone', farm.acme.tenantId)).statusCode, 404);
    assert.equal((await assign('udid-r1-se', '00000000-0000-0000-0000-00000000dead')).statusCode, 404);
    assert.equal((await inject(farm.app, { method: 'POST', url: '/api/tenant-devices', cookies: farm.acme.cookies.admin, payload: { udid: 'udid-r1-se', tenantId: farm.acme.tenantId } })).statusCode, 403);
});

test('the Team page names the organisation; platform staff switch between them and see the platform accounts', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const acme = (await inject(farm.app, { method: 'GET', url: '/team', cookies: farm.acme.cookies.admin })).body;
    assert.match(acme, /<span class="eyebrow">Access · Acme<\/span>/);
    assert.doesNotMatch(acme, /tenant-switch/, 'a tenant admin has no switcher');
    assert.doesNotMatch(acme, /value="platform"/, 'and cannot pick the platform role');
    assert.doesNotMatch(acme, /beloura-va/);
    const platform = (await inject(farm.app, { method: 'GET', url: `/team?tenant=${farm.acme.tenantId}`, cookies: farm.platformCookie })).body;
    assert.match(platform, /<span class="eyebrow">Access · Acme<\/span>/);
    assert.match(platform, new RegExp(`<option value="${farm.acme.tenantId}" selected>Acme</option>`));
    assert.match(platform, /acme-va/);
    assert.doesNotMatch(platform, /beloura-va/);
    const staff = (await inject(farm.app, { method: 'GET', url: '/team?tenant=platform', cookies: farm.platformCookie })).body;
    assert.match(staff, /<span class="eyebrow">Access · Platform staff<\/span>/);
    assert.match(staff, /<option value="platform">Platform — every organisation and the farm itself<\/option>/);
    assert.match(staff, /<code>root<\/code>/);
    assert.doesNotMatch(staff, /groups-title/, 'platform accounts have no groups or grants');
    assert.match(staff, /<span class="role-badge admin">Platform<\/span>/);
});

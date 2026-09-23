import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthApp, seedUser, sessionFor, TEST_DEVICES, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';

await useDevicesFile(TEST_DEVICES);
const { verifyPassword } = await import('../src/auth/password.js');

async function team() {
    const harness = await createAuthApp();
    const kash = await seedUser(harness.store, 'kash', 'admin', 'Kash');
    const cookies = { pf_session: await sessionFor(harness.store, kash.id) };
    const call = (method: string, url: string, payload?: unknown) =>
        inject(harness.app, { method: method as 'POST', url, cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { ...harness, kash, cookies, call };
}

test('adding a person returns a temporary password once and stores only its hash', async (context) => {
    const t = await team();
    context.after(() => t.app.close());
    const group = (await t.call('POST', '/api/team/groups', { name: 'Night shift', description: 'VAs 22:00–06:00' })).json();
    const response = await t.call('POST', '/api/team/users', { username: '  Maria.VA ', displayName: 'Maria', role: 'operator', groupIds: [group.id] });
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['cache-control'], 'no-store');
    const { user, temporaryPassword } = response.json();
    assert.equal(user.username, 'maria.va');
    assert.equal(user.mustChangePassword, true);
    assert.equal(user.passwordHash, undefined);
    const stored = t.store.users.find(({ id }) => id === user.id)!;
    assert.ok(await verifyPassword(temporaryPassword, stored.passwordHash));
    assert.ok(!stored.passwordHash.includes(temporaryPassword));
    assert.deepEqual(t.store.memberships, [{ groupId: group.id, userId: user.id }]);
    assert.deepEqual(t.audit.find(({ event }) => event === 'user.created'), { event: 'user.created', actor: 'kash', target: 'maria.va', detail: 'role=operator' });
    assert.ok(!JSON.stringify(t.audit).includes(temporaryPassword), 'never in the audit log');
    const page = await t.call('GET', '/team');
    assert.ok(!page.body.includes(temporaryPassword), 'never in the page');
    const listed = await t.call('GET', '/api/team');
    assert.ok(!listed.body.includes('passwordHash') && !listed.body.includes(temporaryPassword));

    assert.equal((await t.call('POST', '/api/team/users', { username: 'maria.va' })).statusCode, 409);
    assert.equal((await t.call('POST', '/api/team/users', { username: 'no spaces allowed' })).statusCode, 400);
    assert.equal((await t.call('POST', '/api/team/users', { username: 'ok-name', role: 'root' })).statusCode, 400);
    assert.equal((await t.call('POST', '/api/team/users', { username: 'ok-name', groupIds: ['missing'] })).statusCode, 404);
});

test('resetting a password issues a new temporary one and signs the person out everywhere', async (context) => {
    const t = await team();
    context.after(() => t.app.close());
    const va = await seedUser(t.store, 'va', 'operator');
    const vaCookie = await sessionFor(t.store, va.id);
    const response = await t.call('POST', `/api/team/users/${va.id}/reset-password`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const { temporaryPassword } = response.json();
    assert.ok(await verifyPassword(temporaryPassword, t.store.users.find(({ id }) => id === va.id)!.passwordHash));
    assert.equal(t.store.users.find(({ id }) => id === va.id)!.mustChangePassword, true);
    assert.equal((await inject(t.app, { method: 'GET', url: '/api/devices', cookies: { pf_session: vaCookie } })).statusCode, 401);
    assert.equal(t.audit.at(-1)?.event, 'user.password_reset');
});

test('the last active admin cannot be demoted, disabled or deleted', async (context) => {
    const t = await team();
    context.after(() => t.app.close());
    const self = t.kash.id;
    const demote = await t.call('PATCH', `/api/team/users/${self}`, { role: 'operator' });
    assert.equal(demote.statusCode, 409);
    assert.match(demote.json().error, /last active admin/);
    assert.equal((await t.call('PATCH', `/api/team/users/${self}`, { disabled: true })).statusCode, 409);
    assert.equal((await t.call('DELETE', `/api/team/users/${self}`)).statusCode, 409);

    // A disabled admin does not count as a spare.
    const rex = await seedUser(t.store, 'rex', 'admin');
    await t.store.updateUser(rex.id, { disabled: true });
    assert.equal((await t.call('PATCH', `/api/team/users/${self}`, { role: 'operator' })).statusCode, 409);

    // With another active admin, rex can be demoted and kash can be demoted by rex.
    await t.store.updateUser(rex.id, { disabled: false });
    const rexCookie = { pf_session: await sessionFor(t.store, rex.id) };
    const byRex = await inject(t.app, { method: 'PATCH', url: `/api/team/users/${self}`, cookies: rexCookie, payload: { role: 'operator' } });
    assert.equal(byRex.statusCode, 200);
    assert.equal(byRex.json().role, 'operator');
    const rexAlone = await inject(t.app, { method: 'PATCH', url: `/api/team/users/${rex.id}`, cookies: rexCookie, payload: { role: 'operator' } });
    assert.equal(rexAlone.statusCode, 409, 'rex is now the last admin');
    const deleteRex = await inject(t.app, { method: 'DELETE', url: `/api/team/users/${rex.id}`, cookies: rexCookie });
    assert.equal(deleteRex.statusCode, 409);
});

test('admins can disable, enable, edit and delete other people', async (context) => {
    const t = await team();
    context.after(() => t.app.close());
    const va = await seedUser(t.store, 'va', 'operator');
    assert.equal((await t.call('PATCH', `/api/team/users/${va.id}`, { disabled: true })).json().disabled, true);
    assert.equal((await t.call('PATCH', `/api/team/users/${va.id}`, { disabled: false })).json().disabled, false);
    const edited = (await t.call('PATCH', `/api/team/users/${va.id}`, { displayName: '  Ana   (VA) ', role: 'admin' })).json();
    assert.equal(edited.displayName, 'Ana (VA)');
    assert.equal(edited.role, 'admin');
    assert.equal((await t.call('PATCH', `/api/team/users/${va.id}`, { displayName: '   ' })).statusCode, 400);
    assert.equal((await t.call('PATCH', `/api/team/users/${va.id}`, { disabled: 'yes' })).statusCode, 400);
    assert.equal((await t.call('DELETE', `/api/team/users/${va.id}`)).statusCode, 204);
    assert.equal((await t.call('DELETE', `/api/team/users/${va.id}`)).statusCode, 404);
    assert.deepEqual(t.audit.map(({ event }) => event), ['user.updated', 'user.updated', 'user.updated', 'user.deleted']);
    assert.ok(t.audit.every(({ actor }) => actor === 'kash'), 'every change names its actor');
});

test('groups: create, rename, add and remove members, delete', async (context) => {
    const t = await team();
    context.after(() => t.app.close());
    const va = await seedUser(t.store, 'va', 'operator');
    const group = (await t.call('POST', '/api/team/groups', { name: 'Rack 1 team' })).json();
    assert.equal((await t.call('POST', '/api/team/groups', { name: 'Rack 1 team' })).statusCode, 409);
    assert.equal((await t.call('POST', '/api/team/groups', { name: '  ' })).statusCode, 400);
    const other = (await t.call('POST', '/api/team/groups', { name: 'Other' })).json();
    assert.equal((await t.call('PATCH', `/api/team/groups/${other.id}`, { name: 'Rack 1 team' })).statusCode, 409);
    assert.equal((await t.call('PATCH', `/api/team/groups/${group.id}`, { name: 'Rack one' })).json().name, 'Rack one');
    assert.equal((await t.call('POST', `/api/team/groups/${group.id}/members`, { userId: va.id })).statusCode, 204);
    assert.equal((await t.call('POST', `/api/team/groups/${group.id}/members`, { userId: va.id })).statusCode, 204, 'idempotent');
    assert.equal(t.store.memberships.length, 1);
    assert.equal((await t.call('POST', `/api/team/groups/${group.id}/members`, { userId: 'nobody' })).statusCode, 404);
    assert.equal((await t.call('DELETE', `/api/team/groups/${group.id}/members/${va.id}`)).statusCode, 204);
    assert.equal((await t.call('DELETE', `/api/team/groups/${group.id}/members/${va.id}`)).statusCode, 404);
    assert.equal((await t.call('DELETE', `/api/team/groups/${group.id}`)).statusCode, 204);
    assert.equal(t.store.groups.length, 1);
});

test('grants: validated, one per subject and scope (re-granting changes the level), removable', async (context) => {
    const t = await team();
    context.after(() => t.app.close());
    const va = await seedUser(t.store, 'va', 'operator');
    const grant = (body: Record<string, unknown>) => t.call('POST', '/api/team/grants', { subjectType: 'user', subjectId: va.id, ...body });
    assert.equal((await grant({ scopeType: 'rack', scopeValue: '1', level: 'view' })).statusCode, 201);
    const upgraded = await grant({ scopeType: 'rack', scopeValue: ' 1 ', level: 'operate' });
    assert.equal(upgraded.statusCode, 201);
    assert.deepEqual(t.store.grants.map(({ scopeType, scopeValue, level }) => `${scopeType}=${scopeValue}:${level}`), ['rack=1:operate']);
    assert.equal(t.audit.at(-1)?.event, 'grant.replaced');
    assert.equal((await grant({ scopeType: 'all', scopeValue: 'ignored', level: 'view' })).json().scopeValue, null);
    assert.equal((await grant({ scopeType: 'model', level: 'view' })).statusCode, 400, 'a model grant needs a model');
    assert.equal((await grant({ scopeType: 'planet', scopeValue: 'x', level: 'view' })).statusCode, 400);
    assert.equal((await grant({ scopeType: 'all', level: 'admin' })).statusCode, 400);
    assert.equal((await t.call('POST', '/api/team/grants', { subjectType: 'group', subjectId: 'missing', scopeType: 'all', level: 'view' })).statusCode, 404);
    assert.equal((await t.call('DELETE', `/api/team/grants/${upgraded.json().id}`)).statusCode, 204);
    assert.equal((await t.call('DELETE', `/api/team/grants/${upgraded.json().id}`)).statusCode, 404);
});

test('the Team page escapes every name and shows what each operator can reach', async (context) => {
    const t = await team();
    context.after(() => t.app.close());
    const hostile = await seedUser(t.store, 'hostile', 'operator', '<img src=x onerror=alert(1)>');
    const group = await t.store.createGroup({ name: '"><script>alert(2)</script>', description: '<b>bold</b>' });
    await t.store.addMember(group.id, hostile.id);
    await t.store.createGrant({ userId: null, groupId: group.id, scopeType: 'rack', scopeValue: '1', level: 'view' });
    await t.store.createGrant({ userId: hostile.id, groupId: null, scopeType: 'device', scopeValue: 'udid-loose', level: 'operate' });
    const response = await t.call('GET', '/team', undefined);
    assert.equal(response.statusCode, 200);
    const html = response.body;
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<b>bold<\/b>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.match(html, /Phone · Loose &lt;b&gt;phone&lt;\/b&gt;/);
    const scopes = /<script type="application\/json" id="team-scopes">([^<]*)<\/script>/.exec(html);
    assert.ok(scopes, 'the scope choices are inline JSON that cannot break out of its tag');
    const parsed = JSON.parse(scopes[1]!) as { rack: string[]; model: string[]; device: Array<{ label: string }> };
    assert.deepEqual(parsed.rack, ['1', '2']);
    assert.deepEqual(parsed.model, ['iPhone 12 mini', 'iPhone SE (2nd generation)']);
    assert.ok(parsed.device.some(({ label }) => label === 'Loose <b>phone</b>'));
    const effective = /<article class="effective-card"><h3>&lt;img[^]*?<\/article>/.exec(html)?.[0] ?? '';
    assert.match(effective, /Rack1 Mini<\/span><span class="level-chip view">View/);
    assert.match(effective, /Rack1 SE<\/span><span class="level-chip view">View/);
    assert.match(effective, /Loose &lt;b&gt;phone&lt;\/b&gt;<\/span><span class="level-chip operate">Operate/);
    assert.doesNotMatch(effective, /Rack2 Mini/);
    assert.match(html, /<a class="nav-link" href="\/team" aria-current="page">Team<\/a>/);
    assert.match(html, /<script type="module" src="\/assets\/team\.js\?v=[\w-]+"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/styles\.css\?v=[\w-]+">/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createAuthApp, seedUser, sessionFor, TEST_DEVICES, useDevicesFile, type FakeExecution, type FakeSchedule,
} from './auth-support.js';
import { inject } from './support.js';

await useDevicesFile(TEST_DEVICES);

const row = { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {}, createdAt: new Date(0) };
const schedule = (id: string, deviceUdid: string): FakeSchedule => ({ ...row, id, deviceUdid, status: 'active', timing: { kind: 'now' }, nextRunAt: null, runWindowMinutes: 30 });
const execution = (id: string, deviceUdid: string, status = 'queued'): FakeExecution => ({ ...row, id, deviceUdid, status, scheduledFor: new Date(0), error: null });

/**
 * The farm used by every test here:
 * - va1: operate on udid-r1-mini (own grant), view on rack 1 (through group "rack1")
 * - va2: operate on model "iPhone 12 mini"
 * - va3: no grants at all
 */
async function farm() {
    const harness = await createAuthApp({
        schedules: [schedule('s-r1-mini', 'udid-r1-mini'), schedule('s-r2-mini', 'udid-r2-mini'), schedule('s-loose', 'udid-loose')],
        executions: [execution('e-r1-se', 'udid-r1-se'), execution('e-loose', 'udid-loose'), execution('e-r1-mini', 'udid-r1-mini', 'failed')],
    });
    const { store } = harness;
    const admin = await seedUser(store, 'kash', 'admin');
    const va1 = await seedUser(store, 'va1', 'operator', 'VA One');
    const va2 = await seedUser(store, 'va2', 'operator');
    const va3 = await seedUser(store, 'va3', 'operator');
    const rack1 = await store.createGroup({ name: 'rack1', description: '' });
    await store.addMember(rack1.id, va1.id);
    await store.createGrant({ userId: null, groupId: rack1.id, scopeType: 'rack', scopeValue: '1', level: 'view' });
    await store.createGrant({ userId: va1.id, groupId: null, scopeType: 'device', scopeValue: 'udid-r1-mini', level: 'operate' });
    await store.createGrant({ userId: va2.id, groupId: null, scopeType: 'model', scopeValue: 'iPhone 12 mini', level: 'operate' });
    const cookies = {
        admin: { pf_session: await sessionFor(store, admin.id) },
        va1: { pf_session: await sessionFor(store, va1.id) },
        va2: { pf_session: await sessionFor(store, va2.id) },
        va3: { pf_session: await sessionFor(store, va3.id) },
    };
    return { ...harness, users: { admin, va1, va2, va3 }, groups: { rack1 }, cookies };
}

type Farm = Awaited<ReturnType<typeof farm>>;
const get = (f: Farm, who: keyof Farm['cookies'], url: string, headers: Record<string, string> = {}) =>
    inject(f.app, { method: 'GET', url, cookies: f.cookies[who], headers });
const send = (f: Farm, who: keyof Farm['cookies'], method: string, url: string, payload?: unknown) =>
    inject(f.app, { method: method as 'POST', url, cookies: f.cookies[who], ...(payload === undefined ? {} : { payload: payload as object }) });

test('the device list holds only granted phones, each with the caller\'s level', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const levels = async (who: keyof Farm['cookies']) =>
        Object.fromEntries(((await get(f, who, '/api/devices')).json() as Array<{ udid: string; access: string }>).map(({ udid, access }) => [udid, access]));
    assert.deepEqual(await levels('va1'), { 'udid-r1-mini': 'operate', 'udid-r1-se': 'view' }, 'own operate beats the group\'s view');
    assert.deepEqual(await levels('va2'), { 'udid-r1-mini': 'operate', 'udid-r2-mini': 'operate' });
    assert.deepEqual(await levels('va3'), {});
    assert.deepEqual(Object.keys(await levels('admin')).sort(), TEST_DEVICES.map(({ udid }) => udid).sort());
    assert.ok(!(await get(f, 'va1', '/api/devices')).body.includes('passcode'), 'no passcode field for anyone');
});

test('the grid shows an operator only their phones, without the admin-only controls', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const va1 = (await get(f, 'va1', '/api/fragments/devices')).body;
    assert.equal((va1.match(/<article class="device-card"/g) ?? []).length, 2);
    assert.match(va1, /Rack1 Mini/);
    assert.doesNotMatch(va1, /Rack2 Mini|Loose/);
    assert.doesNotMatch(va1, /data-toggle-device/, 'Disconnect/Reconnect are admin-only');
    assert.match(va1, /Rack 1 · Slot A1/);
    const admin = (await get(f, 'admin', '/api/fragments/devices')).body;
    assert.equal((admin.match(/<article class="device-card"/g) ?? []).length, 4);
    assert.match(admin, /data-toggle-device/);
    assert.match(admin, /Loose &lt;b&gt;phone&lt;\/b&gt;/);
    const none = (await get(f, 'va3', '/api/fragments/devices')).body;
    assert.match(none, /No phones shared with you/);
    assert.doesNotMatch(none, /Register a phone/);
    const page = (await get(f, 'va1', '/')).body;
    assert.match(page, /<body data-role="operator" class="page-grid">/);
    assert.doesNotMatch(page, /href="\/team"/);
});

test('an ungranted phone is indistinguishable from one that does not exist', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    for (const suffix of ['/remote/thumbnail', '/remote/screenshot', '/remote/stream', '/remote/info', '/connection', '/coordinates', '/fragments/summary', '/posts/current']) {
        const hidden = await get(f, 'va1', `/api/devices/udid-r2-mini${suffix}`);
        const missing = await get(f, 'va1', `/api/devices/no-such-phone${suffix}`);
        assert.equal(hidden.statusCode, 404, suffix);
        assert.equal(hidden.body, missing.body, suffix);
    }
    const hiddenAction = await send(f, 'va1', 'POST', '/api/devices/udid-loose/remote/action', { type: 'home' });
    assert.equal(hiddenAction.statusCode, 404);
    const page = await get(f, 'va1', '/devices/udid-r2-mini', { accept: 'text/html' });
    assert.equal(page.statusCode, 404);
    assert.match(page.headers['content-type'] as string, /text\/html/);
    assert.equal(f.remote.actions.length, 0);
});

test('view shows the screen; only operate drives it', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    assert.equal((await get(f, 'va1', '/api/devices/udid-r1-se/remote/screenshot')).statusCode, 200);
    assert.equal((await get(f, 'va1', '/api/devices/udid-r1-se/remote/stream')).statusCode, 200);
    const refused = await send(f, 'va1', 'POST', '/api/devices/udid-r1-se/remote/action', { type: 'unlock' });
    assert.equal(refused.statusCode, 403);
    assert.deepEqual(refused.json(), { error: 'You have view-only access to this phone' });
    assert.equal((await send(f, 'va1', 'POST', '/api/devices/udid-r1-se/reconnect', {})).statusCode, 403);
    const allowed = await send(f, 'va1', 'POST', '/api/devices/udid-r1-mini/remote/action', { type: 'unlock' });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(f.remote.actions, ['udid-r1-mini:unlock']);
    assert.equal((await send(f, 'va2', 'POST', '/api/devices/udid-r2-mini/remote/action', { type: 'home' })).statusCode, 200, 'model grant');
});

test('the device page marks view-only access and the activity panel offers no Stop', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const viewOnly = (await get(f, 'va1', '/devices/udid-r1-se')).body;
    assert.match(viewOnly, /<body data-role="operator" data-device-access="view" class="page-device">/);
    const operate = (await get(f, 'va1', '/devices/udid-r1-mini')).body;
    assert.match(operate, /<body data-role="operator" class="page-device">/);
    const admin = (await get(f, 'admin', '/devices/udid-r1-se')).body;
    assert.match(admin, /<body class="page-device">/);
    const activity = (await get(f, 'va1', '/api/devices/udid-r1-se/fragments/activity')).body;
    assert.match(activity, /queued/);
    assert.doesNotMatch(activity, /\/stop"/);
    const adminActivity = (await get(f, 'admin', '/api/devices/udid-r1-se/fragments/activity')).body;
    assert.match(adminActivity, /\/api\/executions\/e-r1-se\/stop/);
});

test('schedules and runs are listed only for visible phones, with the level to act on them', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const schedules = (await get(f, 'va1', '/api/schedules')).json().schedules as Array<{ id: string; access: string }>;
    assert.deepEqual(schedules.map(({ id, access }) => `${id}:${access}`), ['s-r1-mini:operate']);
    const runs = (await get(f, 'va1', '/api/executions')).json().executions as Array<{ id: string; access: string }>;
    assert.deepEqual(runs.map(({ id, access }) => `${id}:${access}`).sort(), ['e-r1-mini:operate', 'e-r1-se:view']);
    assert.deepEqual((await get(f, 'va1', '/api/schedules?deviceUdid=udid-loose')).json(), { schedules: [] }, 'asking for a hidden phone yields nothing');
    assert.deepEqual((await get(f, 'va3', '/api/executions')).json(), { executions: [] });
    assert.equal(((await get(f, 'admin', '/api/schedules')).json().schedules as unknown[]).length, 3);
    assert.equal((await get(f, 'va1', '/api/executions/e-r1-se')).statusCode, 200);
    assert.equal((await get(f, 'va1', '/api/executions/e-loose')).statusCode, 404);
});

test('creating and changing schedules needs operate on that phone', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const task = { task: { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {} }, timing: { kind: 'now' } };
    assert.equal((await send(f, 'va1', 'POST', '/api/schedules', { ...task, deviceUdid: 'udid-r1-se' })).statusCode, 403);
    assert.equal((await send(f, 'va1', 'POST', '/api/schedules', { ...task, deviceUdid: 'udid-r2-mini' })).statusCode, 404);
    assert.equal((await send(f, 'va1', 'POST', '/api/schedules', { ...task })).statusCode, 404);
    assert.equal((await send(f, 'va1', 'POST', '/api/schedules', { ...task, deviceUdid: 'udid-r1-mini' })).statusCode, 201);
    assert.deepEqual(f.scheduler.calls, ['create:udid-r1-mini']);

    const form = { durationMinutes: '5', personality: 'casual', scheduleKind: 'now' };
    const scroll = (udid: string) => inject(f.app, {
        method: 'POST', url: `/api/devices/${udid}/fragments/scroll-run`, cookies: f.cookies.va1,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString(),
    });
    assert.equal((await scroll('udid-r1-se')).statusCode, 403, 'plugin routes declare their level too');
    assert.equal((await scroll('udid-r1-mini')).statusCode, 202);
    assert.equal((await send(f, 'va1', 'PATCH', '/api/devices/udid-r1-se/accounts', { accounts: ['@x'] })).statusCode, 403);

    for (const action of ['pause', 'resume', 'cancel']) {
        assert.equal((await send(f, 'va1', 'POST', `/api/schedules/s-r2-mini/${action}`, {})).statusCode, 404, action);
    }
    assert.equal((await send(f, 'va1', 'POST', '/api/schedules/s-r1-mini/pause', {})).statusCode, 200);
    assert.equal((await send(f, 'va1', 'POST', '/api/schedules/s-missing/pause', {})).statusCode, 404);
    assert.equal((await send(f, 'va1', 'POST', '/api/executions/e-r1-se/stop', {})).statusCode, 403, 'view cannot stop');
    assert.equal((await send(f, 'va1', 'POST', '/api/executions/e-loose/stop', {})).statusCode, 404);
    assert.equal((await send(f, 'va1', 'POST', '/api/executions/e-r1-mini/retry', {})).statusCode, 200);
    assert.ok(!f.scheduler.calls.some((call) => call.includes('s-r2-mini') || call.includes('e-loose') || call.includes('e-r1-se')));
});

test('device setup, registration, team and asset deletion are admin-only', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const refusals: Array<[string, string, unknown?]> = [
        ['POST', '/api/devices', { udid: 'new', name: 'New' }],
        ['DELETE', '/api/devices/udid-r1-mini'],
        ['PATCH', '/api/devices/udid-r1-mini', { passcode: '1234' }],
        ['PATCH', '/api/devices/udid-r1-mini', { rack: '9' }],
        ['PATCH', '/api/devices/udid-r1-mini', { disabled: true }],
        ['PATCH', '/api/devices/udid-r1-mini', { name: 'x', coordinates: {} }],
        ['GET', '/api/devices/discovered'],
        ['GET', '/api/device-registrations/candidates'],
        ['POST', '/api/device-registrations', { udid: 'x' }],
        ['GET', '/api/team'],
        ['POST', '/api/team/users', { username: 'sneaky', role: 'admin' }],
        ['POST', '/api/team/grants', { subjectType: 'user', subjectId: 'x', scopeType: 'all', level: 'operate' }],
        ['DELETE', '/api/assets', { assetIds: ['a'] }],
    ];
    for (const [method, url, payload] of refusals) {
        const response = await send(f, 'va2', method, url, payload);
        assert.equal(response.statusCode, 403, `${method} ${url}`);
    }
    assert.equal((await send(f, 'va1', 'PATCH', '/api/devices/udid-r2-mini', { rack: '9' })).statusCode, 404, 'an unseen phone stays a 404');
    for (const url of ['/devices/register', '/team']) {
        const page = await get(f, 'va2', url, { accept: 'text/html' });
        assert.equal(page.statusCode, 403, url);
        assert.match(page.body, /Admin access required/);
    }
    assert.equal(f.store.users.some(({ username }) => username === 'sneaky'), false);
    assert.deepEqual(f.scheduler.calls, []);
});

test('calibration (coordinates only) is an operate action on the phone', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    assert.equal((await send(f, 'va1', 'PATCH', '/api/devices/udid-r1-se', { coordinates: {} })).statusCode, 403);
    assert.equal((await send(f, 'va1', 'PATCH', '/api/devices/udid-r1-mini', { coordinates: {} })).statusCode, 200);
});

test('uploads need operate somewhere; an operator with none is refused', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const boundary = 'x-boundary';
    const upload = (who: 'va3') => inject(f.app, {
        method: 'POST', url: '/api/assets', cookies: f.cookies[who],
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--\r\n`,
    });
    assert.equal((await upload('va3')).statusCode, 403);
});

test('access follows group membership and grants live, without signing in again', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const actor = { id: f.users.admin.id, username: 'kash' };
    await f.accounts.removeMember(actor, f.groups.rack1.id, f.users.va1.id);
    const after = (await get(f, 'va1', '/api/devices')).json() as Array<{ udid: string }>;
    assert.deepEqual(after.map(({ udid }) => udid), ['udid-r1-mini']);
    await f.accounts.createGrant(actor, { subjectType: 'user', subjectId: f.users.va3.id, scopeType: 'all', level: 'view' });
    assert.equal(((await get(f, 'va3', '/api/devices')).json() as unknown[]).length, 4);
    await f.accounts.updateUser(actor, f.users.va3.id, { role: 'admin' });
    assert.equal((await get(f, 'va3', '/api/team')).statusCode, 200, 'a promotion takes effect on the next request');
});

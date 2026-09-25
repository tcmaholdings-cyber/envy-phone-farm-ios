import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import sharp from 'sharp';

import { createAuthApp, fakeRemote, seedUser, sessionFor, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';

/**
 * Two hosts sharing one registry (both read the same devices.json here, as both
 * would read fleet.devices): mini-a runs the dashboard, mini-b owns phone-b and
 * serves it through its /agent/* routes on a real loopback listener. Nothing
 * leaves 127.0.0.1.
 */
const TOKEN = 'a'.repeat(40);
process.env.PHONE_FARM_AGENT_TOKEN = TOKEN;
await useDevicesFile([
    { name: 'Phone A', udid: 'phone-a', hostId: 'mini-a', rack: '1', pluginData: {} },
    { name: 'Phone B <i>', udid: 'phone-b', hostId: 'mini-b', rack: '2', pluginData: {} },
]);
const { createApp } = await import('../src/api/app.js');
const { PluginRegistry } = await import('../src/registry.js');
const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
const { staticHostDirectory } = await import('../src/hosts/directory.js');
const { assertSafeAgentBind, isAgentRequestPath, parseAgentBind, startAgentListener } = await import('../src/agent/listener.js');

const screenPng = await sharp({ create: { width: 390, height: 844, channels: 3, background: { r: 10, g: 200, b: 90 } } }).png().toBuffer();

/** mini-b: the host that owns phone-b, reachable only through its agent listener. */
async function hostB(context: TestContext, { busy = false } = {}) {
    const actions: string[] = [];
    const remote = {
        async getScreenInfo() { return { screenSize: { width: 390, height: 844 }, scale: 3 }; },
        async getScreenshot() { return screenPng; },
        async getMjpegStream() { return new Response('--x\r\nframe-b', { headers: { 'content-type': 'multipart/x-mixed-replace; boundary=x' } }); },
        async performAction(udid: string, action: { type: string }) { actions.push(`${udid}:${action.type}`); },
        async isLocked() { return false; },
    };
    const scheduler = { async activeExecution(udid: string) { return busy && udid === 'phone-b' ? { id: 'x' } : null; } };
    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler: scheduler as never, hostId: 'mini-b', remote,
        discoverDevices: async () => [{ udid: 'phone-b', name: 'Phone B', osVersion: '17.5' }] as never,
        wdaStatuses: async () => [{ udid: 'phone-b', physical: 'connected', wda: 'ready', appium: 'ready', managed: true, message: 'WDA is ready', retryCount: 0, updatedAt: new Date(0).toISOString() }],
        wdaLogs: async (udid) => (udid === 'phone-b' ? ['xcodebuild line'] : undefined),
        hosts: staticHostDirectory([]),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const listener = await startAgentListener(app, { host: '127.0.0.1', port: 0 });
    context.after(async () => { await listener.close(); await app.close(); });
    return { app, actions, url: `http://127.0.0.1:${listener.address.port}` };
}

/** mini-a: the dashboard an operator uses; phone-b is on another host. */
async function hostA(context: TestContext, agentUrl: string | null) {
    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler: { async activeExecution() { return null; } } as never, hostId: 'mini-a',
        remote: fakeRemote() as never, dashboardTheme: defaultDashboardTheme,
        discoverDevices: async () => [{ udid: 'phone-a', name: 'Phone A', osVersion: '16.7' }] as never, wdaStatuses: async () => [],
        hosts: staticHostDirectory([{ id: 'mini-b', displayName: 'Rack room B', agentUrl, ageSeconds: 3 }]),
    });
    context.after(() => app.close());
    return app;
}

test('the agent refuses a missing or wrong token, and every phone that is not its own', async (context) => {
    const b = await hostB(context);
    assert.equal((await fetch(`${b.url}/agent/status`)).status, 401);
    assert.equal((await fetch(`${b.url}/agent/status`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const ok = await fetch(`${b.url}/agent/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    const status = await ok.json() as { hostId: string; devices: Array<{ udid: string; connected: unknown; status: { wda: string } | null }> };
    assert.equal(status.hostId, 'mini-b');
    assert.deepEqual(status.devices.map(({ udid }) => udid), ['phone-b'], 'only its own phones');
    assert.equal(status.devices[0]!.status?.wda, 'ready');
    // phone-a belongs to mini-a: mini-b will not serve (or forward) it.
    const foreign = await fetch(`${b.url}/agent/devices/phone-a/remote/screenshot`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(foreign.status, 404);
});

test('the agent is off (404) when PHONE_FARM_AGENT_TOKEN is unset', async (context) => {
    const b = await hostB(context);
    delete process.env.PHONE_FARM_AGENT_TOKEN;
    context.after(() => { process.env.PHONE_FARM_AGENT_TOKEN = TOKEN; });
    assert.equal((await fetch(`${b.url}/agent/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
});

test('the agent listener serves /agent/* only: the dashboard and path tricks are a 404', async (context) => {
    const b = await hostB(context);
    for (const target of ['/', '/api/devices', '/health', '/agent/../api/devices', '/agent/%2e%2e/api/devices', '/agent//status', '/agent/devices/phone-b/..%2f..%2fapi']) {
        const response = await fetch(`${b.url}${target}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        assert.equal(response.status, 404, target);
    }
    assert.equal(isAgentRequestPath('/agent/status?x=..'), true, 'a query string is not a path');
    assert.equal(isAgentRequestPath('/agent/./status'), false);
    assert.equal(isAgentRequestPath('/agentx/status'), false);
});

test('the dashboard shows another host\'s phone through its agent: screenshot, thumbnail with 304, stream, action, log', async (context) => {
    const b = await hostB(context);
    const a = await hostA(context, b.url);

    const shot = await inject(a, { method: 'GET', url: '/api/devices/phone-b/remote/screenshot' });
    assert.equal(shot.statusCode, 200);
    assert.deepEqual(shot.rawPayload, screenPng);

    const thumb = await inject(a, { method: 'GET', url: '/api/devices/phone-b/remote/thumbnail?w=120' });
    assert.equal(thumb.statusCode, 200);
    assert.equal(thumb.headers['content-type'], 'image/jpeg');
    assert.equal((await sharp(thumb.rawPayload).metadata()).width, 120, 'thumbnailed on the owning host');
    const etag = String(thumb.headers.etag);
    assert.ok(etag);
    const again = await inject(a, { method: 'GET', url: '/api/devices/phone-b/remote/thumbnail?w=120', headers: { 'if-none-match': etag } });
    assert.equal(again.statusCode, 304);

    const stream = await inject(a, { method: 'GET', url: '/api/devices/phone-b/remote/stream' });
    assert.equal(stream.statusCode, 200);
    assert.match(String(stream.headers['content-type']), /multipart\/x-mixed-replace/);
    assert.match(stream.body, /frame-b/);

    const tap = await inject(a, { method: 'POST', url: '/api/devices/phone-b/remote/action', payload: { type: 'home' } });
    assert.equal(tap.statusCode, 200);
    assert.deepEqual(b.actions, ['phone-b:home']);

    const info = await inject(a, { method: 'GET', url: '/api/devices/phone-b/remote/info' });
    assert.equal(info.json().screen.scale, 3);
    const log = await inject(a, { method: 'GET', url: '/api/devices/phone-b/wda-log?lines=5' });
    assert.deepEqual(log.json(), { udid: 'phone-b', lines: ['xcodebuild line'] });
    const connection = await inject(a, { method: 'GET', url: '/api/devices/phone-b/connection' });
    assert.equal(connection.statusCode, 200);
});

test('remote input is refused while the owning host runs an automation on that phone', async (context) => {
    const b = await hostB(context, { busy: true });
    const a = await hostA(context, b.url);
    const tap = await inject(a, { method: 'POST', url: '/api/devices/phone-b/remote/action', payload: { type: 'home' } });
    assert.equal(tap.statusCode, 409);
    assert.match(tap.json().error, /automation is running/);
    assert.deepEqual(b.actions, []);
});

test('the grid lists every host\'s phones with their host, and live state from the owning host', async (context) => {
    const b = await hostB(context);
    const a = await hostA(context, b.url);
    const grid = await inject(a, { method: 'GET', url: '/api/fragments/devices' });
    assert.equal(grid.statusCode, 200);
    const card = grid.body.match(/<article class="device-card"[^>]*>(?:(?!<\/article>).)*\/devices\/phone-b"(?:(?!<\/article>).)*<\/article>/)?.[0];
    assert.ok(card, 'phone-b has a card on mini-a');
    assert.match(card, /data-state="ready"/);
    assert.match(card, /Host · Rack room B/);
    assert.match(card, /Phone B &lt;i&gt;/, 'names are escaped');
    const devices = (await inject(a, { method: 'GET', url: '/api/devices' })).json() as Array<{ udid: string; hostId?: string; hostName?: string; connected: unknown }>;
    const remote = devices.find(({ udid }) => udid === 'phone-b')!;
    assert.equal(remote.hostId, 'mini-b');
    assert.equal(remote.hostName, 'Rack room B');
    assert.ok(remote.connected);
});

test('a host that does not answer shows its phones offline instead of failing the page', async (context) => {
    const a = await hostA(context, 'http://127.0.0.1:9');
    const grid = await inject(a, { method: 'GET', url: '/api/fragments/devices' });
    assert.equal(grid.statusCode, 200);
    assert.match(grid.body, /data-state="offline"(?:(?!<\/article>).)*Host · Rack room B/);
    assert.match(grid.body, /Host Rack room B is not answering/);
    const thumb = await inject(a, { method: 'GET', url: '/api/devices/phone-b/remote/thumbnail' });
    assert.equal(thumb.statusCode, 503);
    assert.equal(thumb.headers['x-device-state'], 'not-ready');
    const summary = await inject(a, { method: 'GET', url: '/api/devices/phone-b/fragments/summary' });
    assert.match(summary.body, /hangs off host mini-b/);
});

test('a host with no agent URL, or a dashboard without the token, answers 502 with the reason', async (context) => {
    const a = await hostA(context, null);
    const shot = await inject(a, { method: 'GET', url: '/api/devices/phone-b/wda-log' });
    assert.equal(shot.statusCode, 502);
    assert.match(shot.json().error, /PHONE_FARM_AGENT_URL/);
    delete process.env.PHONE_FARM_AGENT_TOKEN;
    context.after(() => { process.env.PHONE_FARM_AGENT_TOKEN = TOKEN; });
    const noToken = await inject(a, { method: 'GET', url: '/api/devices/phone-b/connection' });
    assert.equal(noToken.statusCode, 502);
    assert.match(noToken.json().error, /PHONE_FARM_AGENT_TOKEN is not set/);
    assert.ok(!noToken.body.includes(TOKEN));
});

test('another host\'s passcode cannot be set from this dashboard', async (context) => {
    const a = await hostA(context, null);
    const response = await inject(a, { method: 'PATCH', url: '/api/devices/phone-b', payload: { passcode: '1234' } });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /host mini-b/);
});

test('grants still apply before any proxying: an ungranted remote phone is a 404', async (context) => {
    const b = await hostB(context);
    const { app, store } = await createAuthApp({
        extra: { hostId: 'mini-a', hosts: staticHostDirectory([{ id: 'mini-b', displayName: 'B', agentUrl: b.url, ageSeconds: 1 }]) },
    });
    context.after(() => app.close());
    const va = await seedUser(store, 'va', 'operator');
    await store.createGrant({ userId: va.id, groupId: null, scopeType: 'rack', scopeValue: '1', level: 'operate' });
    const cookies = { pf_session: await sessionFor(store, va.id) };
    const denied = await inject(app, { method: 'GET', url: '/api/devices/phone-b/remote/screenshot', cookies });
    assert.equal(denied.statusCode, 404);
    const list = (await inject(app, { method: 'GET', url: '/api/devices', cookies })).json() as Array<{ udid: string }>;
    assert.deepEqual(list.map(({ udid }) => udid), ['phone-a']);
    // The agent's own routes never accept a dashboard session in place of the token.
    const agentViaSession = await inject(app, { method: 'GET', url: '/agent/status', cookies });
    assert.equal(agentViaSession.statusCode, 401);
});

test('PHONE_FARM_AGENT_BIND refuses wildcard addresses, hostnames and weak tokens', () => {
    const env = { PHONE_FARM_AGENT_TOKEN: TOKEN };
    assert.deepEqual(assertSafeAgentBind('100.101.74.35:3001', env), { host: '100.101.74.35', port: 3001 });
    assert.deepEqual(parseAgentBind('[fd7a:115c:a1e0::1]:3001'), { host: 'fd7a:115c:a1e0::1', port: 3001 });
    for (const bad of ['0.0.0.0:3001', '[::]:3001', '*:3001']) assert.throws(() => assertSafeAgentBind(bad, env), /every interface/, bad);
    assert.throws(() => assertSafeAgentBind('mac-mini.local:3001', env), /IP address/);
    assert.throws(() => assertSafeAgentBind('100.101.74.35', env), /<ip>:<port>/);
    assert.throws(() => assertSafeAgentBind('100.101.74.35:3001', {}), /PHONE_FARM_AGENT_TOKEN/);
    assert.throws(() => assertSafeAgentBind('100.101.74.35:3001', { PHONE_FARM_AGENT_TOKEN: 'short' }), /at least 32/);
});

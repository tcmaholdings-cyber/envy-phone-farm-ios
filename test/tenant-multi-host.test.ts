import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createAuthApp, DEFAULT_TENANT_ID, seedUser, sessionFor, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';

/**
 * Multi-host and tenants: the dashboard forwards another host's phone to that
 * host's agent only after the same tenant check as a local phone, and the
 * agent's /agent/* routes stay service-to-service (bearer token), whoever's
 * session cookie comes along.
 */
const TOKEN = 'b'.repeat(40);
process.env.PHONE_FARM_AGENT_TOKEN = TOKEN;
await useDevicesFile([
    { name: 'Phone A', udid: 'phone-a', hostId: 'mini-a', pluginData: {} },
    { name: 'Phone B', udid: 'phone-b', hostId: 'mini-b', pluginData: {} },
]);
const { staticHostDirectory } = await import('../src/hosts/directory.js');

async function farm() {
    const forwarded: string[] = [];
    const agentFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        // The grid's host status poll is not a per-phone request.
        if (url.endsWith('/agent/status')) return Response.json({ hostId: 'mini-b', devices: [] });
        forwarded.push(url);
        return Response.json({ device: { udid: 'phone-b' }, screen: { screenSize: { width: 1, height: 1 }, scale: 1 } });
    }) as typeof fetch;
    const harness = await createAuthApp({
        extra: {
            hostId: 'mini-a', agentFetch,
            hosts: staticHostDirectory([{ id: 'mini-b', displayName: 'Rack room B', agentUrl: 'http://127.0.0.1:9', ageSeconds: 1 }]),
        },
    });
    const acmeId = crypto.randomUUID();
    harness.tenantStore.tenants.push({ id: acmeId, slug: 'acme', name: 'Acme', status: 'active', quotas: {}, createdAt: new Date(0) });
    await harness.tenantStore.assignDevice('phone-b', acmeId);
    const operator = async (username: string, tenantId: string) => {
        const user = await seedUser(harness.store, username, 'operator', username, tenantId);
        await harness.store.createGrant({ userId: user.id, groupId: null, scopeType: 'all', scopeValue: null, level: 'operate' });
        return { pf_session: await sessionFor(harness.store, user.id) };
    };
    const platform = await seedUser(harness.store, 'root', 'platform');
    return {
        ...harness, forwarded,
        beloura: await operator('bel-va', DEFAULT_TENANT_ID),
        acme: await operator('acme-va', acmeId),
        platform: { pf_session: await sessionFor(harness.store, platform.id) },
    };
}

test('another host\'s phone is forwarded to its agent only for its own tenant', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    const call = (cookies: Record<string, string>, method: string, url: string, payload?: unknown) =>
        inject(f.app, { method: method as 'GET', url, cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
    for (const [method, url, payload] of [
        ['GET', '/api/devices/phone-b/remote/info'],
        ['GET', '/api/devices/phone-b/remote/screenshot'],
        ['GET', '/api/devices/phone-b/connection'],
        ['POST', '/api/devices/phone-b/remote/action', { type: 'home' }],
    ] as Array<[string, string, unknown?]>) {
        assert.equal((await call(f.beloura, method, url, payload)).statusCode, 404, `${method} ${url}`);
    }
    assert.deepEqual(f.forwarded, [], 'nothing reached the other host for the wrong tenant');
    const own = await call(f.acme, 'GET', '/api/devices/phone-b/remote/info');
    assert.equal(own.statusCode, 200);
    assert.equal(f.forwarded.length, 1);
    assert.match(f.forwarded[0]!, /\/agent\/devices\/phone-b\/remote\/info$/);
    const list = (await call(f.beloura, 'GET', '/api/devices')).json() as Array<{ udid: string }>;
    assert.deepEqual(list.map(({ udid }) => udid), ['phone-a']);
});

test('/agent/* answers only the fleet bearer token, never a dashboard session — not even platform staff\'s', async (context) => {
    const f = await farm();
    context.after(() => f.app.close());
    for (const cookies of [f.acme, f.beloura, f.platform]) {
        for (const url of ['/agent/status', '/agent/devices/phone-a/remote/info']) {
            const response = await inject(f.app, { method: 'GET', url, cookies });
            assert.equal(response.statusCode, 401, url);
        }
        const action = await inject(f.app, { method: 'POST', url: '/agent/devices/phone-a/remote/action', cookies, payload: { type: 'home' } });
        assert.ok([401, 403].includes(action.statusCode), `a session cannot drive a phone through the agent (${action.statusCode})`);
    }
    assert.deepEqual(f.remote.actions, []);
    const serviced = await inject(f.app, { method: 'GET', url: '/agent/status', headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(serviced.statusCode, 200);
});

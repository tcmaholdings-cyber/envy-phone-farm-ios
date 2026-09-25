import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAuthApp, seedUser, sessionFor, TEST_DEVICES, useDevicesFile } from './auth-support.js';
import type { CreateAppOptions } from '../src/api/app.js';
import type { DeviceConnectionStatus } from '../src/devices/connection-manager.js';
import type { WorkerHeartbeatRow } from '../src/observability/heartbeat.js';
import type { ObservabilityProbes, QueueStat } from '../src/observability/probes.js';

await useDevicesFile(TEST_DEVICES);
const { routeAccessReport } = await import('../src/api/app.js');
const { escapeLabelValue, renderMetrics } = await import('../src/observability/metrics.js');
const { checkReadiness } = await import('../src/observability/probes.js');
const { queueNameForDevice } = await import('../src/scheduler/queue.js');

const fresh: WorkerHeartbeatRow = { host: 'mini-1', pid: 7, startedAt: new Date(0), queues: 4, ageSeconds: 9 };

function probes(overrides: Partial<ObservabilityProbes> = {}): ObservabilityProbes {
    return {
        async database() {},
        async appium() {},
        async wdaService() {},
        async workerHeartbeats() { return [fresh]; },
        async queueStats(): Promise<QueueStat[]> {
            return [{ queue: queueNameForDevice('udid-r1-mini'), queued: 2, deferred: 1, active: 1, oldestQueuedSeconds: 125 }];
        },
        async executionsLastHour() { return { succeeded: 5, failed: 1 }; },
        async close() {},
        ...overrides,
    };
}

const now = Date.parse('2026-09-25T12:00:00Z');
const statuses: DeviceConnectionStatus[] = [
    { udid: 'udid-r1-mini', physical: 'connected', wda: 'ready', appium: 'ready', managed: true, message: 'WDA is ready', retryCount: 0, updatedAt: new Date(now).toISOString(), restarts: 2 },
    {
        udid: 'udid-r1-se', physical: 'disconnected', wda: 'disconnected', appium: 'ready', managed: true, message: 'Reconnect the USB cable', retryCount: 0,
        updatedAt: new Date(now).toISOString(), restarts: 0,
        notReadySince: new Date(now - 20 * 60_000).toISOString(), disconnectedSince: new Date(now - 11 * 60_000).toISOString(),
    },
];

async function harness(extra: Partial<CreateAppOptions> = {}) {
    const built = await createAuthApp({
        extra: {
            observability: probes(),
            discoverDevices: async () => [{ udid: 'udid-r1-mini' }] as never,
            wdaStatuses: async () => statuses,
            ...extra,
        },
    });
    return built;
}

test('GET /health is minimal for anonymous callers: ok and the release sha, no plugin versions', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-release-'));
    const releaseFile = path.join(directory, 'RELEASED');
    await writeFile(releaseFile, JSON.stringify({ sha: 'abc1234def', subject: 'secret subject', deployedAt: 'x' }));
    const previous = process.env.PHONE_FARM_RELEASE_FILE;
    process.env.PHONE_FARM_RELEASE_FILE = releaseFile;
    context.after(() => {
        if (previous === undefined) delete process.env.PHONE_FARM_RELEASE_FILE;
        else process.env.PHONE_FARM_RELEASE_FILE = previous;
    });
    const { app } = await harness();
    context.after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, release: 'abc1234def' });
    assert.doesNotMatch(response.body, /plugins|tiktok|subject/);
});

test('GET /health/ready is 200 when every dependency checks out, without a session', async (context) => {
    const { app } = await harness();
    context.after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
        ok: true,
        checks: { database: { ok: true }, appium: { ok: true }, wdaService: { ok: true }, worker: { ok: true, ageSeconds: 9 } },
    });
});

test('GET /health/ready is 503 with fixed per-check reasons and never leaks error text', async (context) => {
    const { app } = await harness({
        observability: probes({
            async appium() { throw new Error('connect ECONNREFUSED 127.0.0.1:4725 /Users/farm/secret'); },
            async wdaService() { await new Promise((resolve) => setTimeout(resolve, 5_000).unref()); },
            async workerHeartbeats() { return [{ ...fresh, ageSeconds: 600 }]; },
        }),
    });
    context.after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(response.statusCode, 503);
    const body = response.json() as { ok: boolean; checks: Record<string, { ok: boolean; reason?: string }> };
    assert.equal(body.ok, false);
    assert.deepEqual(body.checks.database, { ok: true });
    assert.deepEqual(body.checks.appium, { ok: false, reason: 'unreachable' });
    assert.deepEqual(body.checks.wdaService, { ok: false, reason: 'timeout' });
    assert.deepEqual(body.checks.worker, { ok: false, reason: 'stale', ageSeconds: 600 });
    assert.doesNotMatch(response.body, /ECONNREFUSED|Users|secret/);
});

test('checkReadiness reports a missing heartbeat and honours the stale threshold', async () => {
    const none = await checkReadiness(probes({ async workerHeartbeats() { return []; } }));
    assert.deepEqual(none.checks.worker, { ok: false, reason: 'no heartbeat' });
    const lenient = await checkReadiness(probes({ async workerHeartbeats() { return [{ ...fresh, ageSeconds: 100 }]; } }), { staleSeconds: 120 });
    assert.equal(lenient.ok, true);
    const failures: string[] = [];
    const down = await checkReadiness(probes({ async database() { throw new Error('boom'); } }), { onFailure: (check) => failures.push(check) });
    assert.deepEqual(down.checks.database, { ok: false, reason: 'unreachable' });
    assert.deepEqual(failures, ['database']);
});

test('GET /metrics is 404 without PHONE_FARM_METRICS_TOKEN and 401 with a wrong or missing token', async (context) => {
    const previous = process.env.PHONE_FARM_METRICS_TOKEN;
    context.after(() => {
        if (previous === undefined) delete process.env.PHONE_FARM_METRICS_TOKEN;
        else process.env.PHONE_FARM_METRICS_TOKEN = previous;
    });
    const { app } = await harness();
    context.after(() => app.close());
    delete process.env.PHONE_FARM_METRICS_TOKEN;
    assert.equal((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer anything' } })).statusCode, 404);
    process.env.PHONE_FARM_METRICS_TOKEN = 'scrape-token-123';
    assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
    const wrong = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.statusCode, 401);
    assert.match(String(wrong.headers['www-authenticate']), /Bearer/);
    assert.doesNotMatch(wrong.body, /scrape-token-123/);
});

test('GET /metrics serves Prometheus text with the fleet, queue, execution and heartbeat series', async (context) => {
    const previous = process.env.PHONE_FARM_METRICS_TOKEN;
    process.env.PHONE_FARM_METRICS_TOKEN = 'scrape-token-123';
    context.after(() => {
        if (previous === undefined) delete process.env.PHONE_FARM_METRICS_TOKEN;
        else process.env.PHONE_FARM_METRICS_TOKEN = previous;
    });
    const { app } = await harness();
    context.after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer scrape-token-123' } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /^text\/plain; version=0\.0\.4/);
    const body = response.body;
    for (const line of [
        'phone_farm_phones_registered{state="active"} 4',
        'phone_farm_phones_usb_connected 1',
        'phone_farm_wda_phones{state="ready"} 1',
        'phone_farm_wda_phones{state="disconnected"} 1',
        'phone_farm_wda_restarts_total{udid="udid-r1-mini",name="Rack1 Mini"} 2',
        `phone_farm_queue_depth{queue="${queueNameForDevice('udid-r1-mini')}",udid="udid-r1-mini",name="Rack1 Mini"} 2`,
        'phone_farm_queue_oldest_job_age_seconds_max 125',
        'phone_farm_executions_last_hour{status="succeeded"} 5',
        'phone_farm_executions_last_hour{status="running"} 0',
        'phone_farm_worker_heartbeat_age_seconds 9',
        'phone_farm_metrics_source_up{source="database"} 1',
    ]) assert.ok(body.includes(`${line}\n`), `missing: ${line}`);
    assert.match(body, /# TYPE phone_farm_wda_restarts_total counter/);
    assert.match(body, /phone_farm_process_uptime_seconds \d/);
    // Device names are user input: label values are escaped, never raw.
    assert.ok(body.includes('name="Loose <b>phone</b>"'));
});

test('a failing source is reported as down instead of failing the scrape', async (context) => {
    const previous = process.env.PHONE_FARM_METRICS_TOKEN;
    process.env.PHONE_FARM_METRICS_TOKEN = 't';
    context.after(() => {
        if (previous === undefined) delete process.env.PHONE_FARM_METRICS_TOKEN;
        else process.env.PHONE_FARM_METRICS_TOKEN = previous;
    });
    const { app } = await harness({
        wdaStatuses: async () => { throw new Error('socket gone'); },
        observability: probes({ async queueStats() { throw new Error('db down'); } }),
    });
    context.after(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer t' } });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /phone_farm_metrics_source_up\{source="wda_service"\} 0/);
    assert.match(response.body, /phone_farm_metrics_source_up\{source="database"\} 0/);
    assert.doesNotMatch(response.body, /phone_farm_wda_phones/);
    assert.doesNotMatch(response.body, /phone_farm_queue_depth/);
});

test('renderMetrics measures how long a phone has been off USB and WDA not ready', () => {
    const text = renderMetrics({
        now, uptimeSeconds: 1, devices: TEST_DEVICES, usbUdids: new Set(), wda: statuses,
        queues: [], executionsLastHour: {}, heartbeats: [],
    });
    assert.ok(text.includes('phone_farm_phone_usb_disconnected_seconds{udid="udid-r1-se",name="Rack1 SE"} 660\n'));
    assert.ok(text.includes('phone_farm_phone_wda_not_ready_seconds{udid="udid-r1-se",name="Rack1 SE"} 1200\n'));
    assert.ok(text.includes('phone_farm_phone_wda_not_ready_seconds{udid="udid-r1-mini",name="Rack1 Mini"} 0\n'));
    assert.ok(text.includes('phone_farm_worker_heartbeat_present 0\n'));
    assert.ok(!text.includes('phone_farm_worker_heartbeat_age_seconds '));
    assert.equal(escapeLabelValue('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
});

test('GET /metrics is the only token route and bypasses the session check; wda-log is admin-only', async (context) => {
    const { app, store } = await harness({ wdaLogs: async (udid) => (udid === 'udid-r1-mini' ? ['line 1', 'line 2'] : undefined) });
    context.after(() => app.close());
    const tokenRoutes = routeAccessReport(app).filter(({ requirement }) => requirement?.kind === 'token').map(({ method, url }) => `${method} ${url}`);
    assert.deepEqual(tokenRoutes.filter((route) => !route.startsWith('HEAD')), ['GET /metrics']);

    const admin = await seedUser(store, 'kash', 'admin');
    const va = await seedUser(store, 'va', 'operator');
    await store.createGrant({ userId: va.id, groupId: null, scopeType: 'all', scopeValue: null, level: 'operate' });
    const adminCookie = { pf_session: await sessionFor(store, admin.id) };
    const vaCookie = { pf_session: await sessionFor(store, va.id) };

    const log = await app.inject({ method: 'GET', url: '/api/devices/udid-r1-mini/wda-log?lines=50', cookies: adminCookie });
    assert.equal(log.statusCode, 200);
    assert.deepEqual(log.json(), { udid: 'udid-r1-mini', lines: ['line 1', 'line 2'] });
    assert.equal((await app.inject({ method: 'GET', url: '/api/devices/udid-r1-mini/wda-log', cookies: vaCookie })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/devices/udid-r1-mini/wda-log' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/devices/unknown/wda-log', cookies: adminCookie })).statusCode, 404);
});

test('the wda-log route answers 503 when the wda-service is down', async (context) => {
    const { app, store } = await harness({ wdaLogs: async () => { throw new Error('ENOENT .wda/wda-service.sock'); } });
    context.after(() => app.close());
    const admin = await seedUser(store, 'kash', 'admin');
    const response = await app.inject({ method: 'GET', url: '/api/devices/udid-r1-mini/wda-log', cookies: { pf_session: await sessionFor(store, admin.id) } });
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /ENOENT/);
});

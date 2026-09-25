import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';

import { allocateDevicePorts } from '../src/devices/registration.js';
import { DeviceConnectionManager } from '../src/devices/connection-manager.js';
import { localDevices } from '../src/devices/host-identity.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import { agentUrlFromEnv, HOST_LEASE_SQL, startHostLease } from '../src/hosts/lease.js';
import { queueNameForDevice } from '../src/scheduler/queue.js';
import { syncDeviceWorkers } from '../src/scheduler/worker.js';

const phone = (udid: string, hostId?: string, extra: Partial<RegisteredDevice> = {}): RegisteredDevice =>
    ({ udid, name: udid, pluginData: {}, ...(hostId ? { hostId } : {}), ...extra });

test('the worker works only the queues of phones its host owns', async () => {
    const working = new Map<string, string>();
    const subscribed: string[] = [];
    const unsubscribed: string[] = [];
    const operations = {
        async subscribe(device: RegisteredDevice) { subscribed.push(device.udid); return queueNameForDevice(device.udid); },
        async unsubscribe(queue: string) { unsubscribed.push(queue); },
    };
    const first = await syncDeviceWorkers([phone('mine', 'mini-a'), phone('theirs', 'mini-b'), phone('legacy')], working, operations, 'mini-a');
    assert.deepEqual(first.added, ['mine', 'legacy'], 'a phone with no hostId (devices.json) is local');
    assert.deepEqual(subscribed, ['mine', 'legacy']);

    // The phone moves to another Mac: this worker lets go of its queue.
    const second = await syncDeviceWorkers([phone('mine', 'mini-b'), phone('legacy')], working, operations, 'mini-a');
    assert.deepEqual(second.removed, ['mine']);
    assert.deepEqual(unsubscribed, [queueNameForDevice('mine')]);
});

test('wda-service supervises only this host\'s phones', async () => {
    const spawned: string[] = [];
    const manager = new DeviceConnectionManager({
        hostId: 'mini-a',
        loadDevices: async () => [phone('mine', 'mini-a'), phone('theirs', 'mini-b')],
        connectedUdids: async () => ['mine', 'theirs'],
        endpointReady: async () => false,
        spawnSupervisor: (device) => {
            spawned.push(device.udid);
            return { exitCode: null, killed: false, stdout: null, stderr: null, once() {}, kill() {} } as unknown as ChildProcess;
        },
        now: () => 0,
    });
    await manager.reconcile();
    assert.deepEqual(spawned, ['mine']);
    assert.deepEqual(manager.statuses().map(({ udid }) => udid), ['mine']);
});

test('registration allocates ports among this host\'s phones only', async () => {
    const devices = localDevices([
        phone('theirs', 'mini-b', { wdaLocalPort: 8100, mjpegLocalPort: 9100 }),
        phone('mine', 'mini-a', { wdaLocalPort: 8101, mjpegLocalPort: 9101 }),
    ], 'mini-a');
    // 8100 is another Mac's; here it is free (portAvailable probes the local port too).
    const ports = await allocateDevicePorts(devices);
    assert.notEqual(ports.wdaLocalPort, 8101);
});

test('the host lease upserts id, name, agent URL and version on the database clock', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const lease = startHostLease({ async query(text, values) { calls.push({ text, values }); return { rows: [] }; } }, {
        hostId: 'mini-a', hostName: 'Rack room A', agentUrl: 'http://100.64.0.2:3001', version: 'abc1234', intervalMs: 60_000,
    });
    await lease.beat();
    await lease.stop();
    assert.equal(calls[0]!.text, HOST_LEASE_SQL);
    assert.match(HOST_LEASE_SQL, /last_seen_at[\s\S]*now\(\)/);
    assert.deepEqual(calls[0]!.values, ['mini-a', 'Rack room A', 'http://100.64.0.2:3001', 'abc1234']);
});

test('a failing lease never throws into the process', async () => {
    const lease = startHostLease({ async query() { throw new Error('db down'); } }, { hostId: 'h', agentUrl: null, version: null, intervalMs: 60_000 });
    await lease.beat();
    await lease.stop();
});

test('PHONE_FARM_AGENT_URL must be a plain http(s) URL', () => {
    assert.equal(agentUrlFromEnv({}), null);
    assert.equal(agentUrlFromEnv({ PHONE_FARM_AGENT_URL: 'http://100.64.0.2:3001/' }), 'http://100.64.0.2:3001');
    assert.throws(() => agentUrlFromEnv({ PHONE_FARM_AGENT_URL: 'ftp://x' }), /http\(s\)/);
    assert.throws(() => agentUrlFromEnv({ PHONE_FARM_AGENT_URL: 'http://user:pw@x:1' }), /without credentials/);
    assert.throws(() => agentUrlFromEnv({ PHONE_FARM_AGENT_URL: 'not a url' }), /http\(s\) URL/);
});

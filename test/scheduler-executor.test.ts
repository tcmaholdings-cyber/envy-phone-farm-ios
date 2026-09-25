import assert from 'node:assert/strict';
import test from 'node:test';

import { createSharedSweep, type Device } from '../src/devices/discovery.js';
import { waitForDevice, type WaitForDeviceDependencies } from '../src/scheduler/executor.js';
import type { RegisteredDevice } from '../src/devices/registry.js';

const registered: RegisteredDevice = { udid: 'phone-a', name: 'Rack 1 · 3', pluginData: {} };
const execution = (minutes = 5) => ({ deviceUdid: 'phone-a', deadlineAt: new Date(Date.now() + minutes * 60_000) });

function dependencies(overrides: Partial<WaitForDeviceDependencies>): WaitForDeviceDependencies {
    return {
        connectedUdids: async () => ['phone-a'],
        connectedDevices: async () => [],
        endpointReady: async () => true,
        sleep: async () => {},
        pollMs: 0,
        ...overrides,
    };
}

test('waitForDevice checks presence through the shared sweep, reading lockdown details only once', async () => {
    let usbmuxReads = 0;
    let lockdownSweeps = 0;
    const present = [false, false, true];
    const udids = createSharedSweep(async () => {
        usbmuxReads++;
        return present.shift() ? ['phone-a'] : [];
    });
    const device: Device = { udid: 'phone-a', name: 'iPhone', osVersion: '17.5' };
    const found = await waitForDevice(execution(), registered, new AbortController().signal, dependencies({
        connectedUdids: () => udids.get(0),
        connectedDevices: async () => { lockdownSweeps++; return [device]; },
    }));
    assert.deepEqual(found, device);
    assert.equal(usbmuxReads, 3);
    assert.equal(lockdownSweeps, 1, 'lockdown details are read once, not on every poll');
});

test('concurrent waiters share one usbmux read per poll instead of sweeping each', async () => {
    let usbmuxReads = 0;
    const udids = createSharedSweep(async () => {
        usbmuxReads++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ['phone-a'];
    });
    const shared = dependencies({ connectedUdids: () => udids.get(5_000) });
    await Promise.all(Array.from({ length: 34 }, () => waitForDevice(execution(), registered, new AbortController().signal, shared)));
    assert.equal(usbmuxReads, 1);
});

test('a refused usbmuxd sweep is retried on the next poll, not a failure of every waiter', async () => {
    let reads = 0;
    const udids = createSharedSweep(async () => {
        reads++;
        if (reads === 1) throw new Error('connect ECONNREFUSED /var/run/usbmuxd');
        return ['phone-a'];
    });
    const shared = dependencies({ connectedUdids: () => udids.get(0) });
    const found = await Promise.all(Array.from({ length: 5 }, () => waitForDevice(execution(), registered, new AbortController().signal, shared)));
    assert.equal(found.length, 5);
    assert.ok(reads >= 2, 'the sweep is read again after the refusal');
});

test('a usbmuxd that stays down is reported as the reason when the window expires', async () => {
    let polls = 0;
    await assert.rejects(
        waitForDevice({ deviceUdid: 'phone-a', deadlineAt: new Date(Date.now() + 50) }, registered, new AbortController().signal, dependencies({
            connectedUdids: async () => { polls++; throw new Error('connect ECONNREFUSED /var/run/usbmuxd'); },
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
            pollMs: 10,
        })),
        /Execution window expired: usbmuxd is unavailable \(connect ECONNREFUSED \/var\/run\/usbmuxd\)/,
    );
    assert.ok(polls > 1, 'it kept polling instead of failing on the first refusal');
});

test('waitForDevice falls back to the registry identity when the cached sweep predates the reconnect', async () => {
    const found = await waitForDevice(execution(), registered, new AbortController().signal, dependencies({}));
    assert.deepEqual(found, { udid: 'phone-a', name: 'Rack 1 · 3' });
});

test('waitForDevice stops promptly when aborted', async () => {
    const controller = new AbortController();
    const waiting = waitForDevice(execution(), registered, controller.signal, dependencies({
        connectedUdids: async () => [],
        sleep: (milliseconds, signal) => new Promise((resolve) => {
            if (signal.aborted) return resolve();
            signal.addEventListener('abort', () => resolve(), { once: true });
        }),
        pollMs: 60_000,
    }));
    controller.abort();
    await assert.rejects(waiting, /stopped while waiting/);
});

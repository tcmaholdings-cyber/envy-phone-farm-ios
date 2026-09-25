import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { createSharedSweep, type Device } from '../src/devices/discovery.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import {
    EFFECT_COMMITTED_MARKER, isEffectCommittedLine, reportEffectCommitted,
} from '../src/scheduler/effects.js';
import {
    deleteAppiumSessionsForDevice, killGraceMs, runPluginProcess, waitForDevice, type WaitForDeviceDependencies,
} from '../src/scheduler/executor.js';

const node = { file: process.execPath, args: [] };

async function script(source: string): Promise<{ file: string; dir: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pf-executor-'));
    const file = path.join(dir, 'task.mjs');
    await writeFile(file, source);
    return { file, dir };
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try { await access(file); return; } catch { /* not yet */ }
        if (Date.now() > deadline) throw new Error(`${file} never appeared`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test('killGraceMs defaults to 15 s and honours WORKER_KILL_GRACE_SECONDS', () => {
    assert.equal(killGraceMs({}), 15_000);
    assert.equal(killGraceMs({ WORKER_KILL_GRACE_SECONDS: '3' }), 3_000);
});

test('a stopped subprocess that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const { file, dir } = await script(`
        import { writeFileSync } from 'node:fs';
        process.on('SIGTERM', () => { /* ignore */ });
        writeFileSync(process.argv[2], 'ready');
        setInterval(() => {}, 1000);
    `);
    const ready = path.join(dir, 'ready');
    const controller = new AbortController();
    const started = Date.now();
    const running = runPluginProcess({ entrypoint: file, args: [ready] }, process.env, controller.signal, async () => {}, {
        command: node, killGraceMs: 200,
    });
    await waitForFile(ready);
    controller.abort();
    const result = await running;
    assert.equal(result.stopped, true);
    assert.equal(result.error, 'Plugin process stopped by SIGKILL');
    assert.ok(Date.now() - started < 10_000);
});

test('a subprocess that honours SIGTERM exits on the first signal', async () => {
    const { file, dir } = await script(`
        import { writeFileSync } from 'node:fs';
        process.on('SIGTERM', () => { console.log('cleaning up'); process.exit(0); });
        writeFileSync(process.argv[2], 'ready');
        setInterval(() => {}, 1000);
    `);
    const ready = path.join(dir, 'ready');
    const controller = new AbortController();
    const lines: string[] = [];
    const running = runPluginProcess({ entrypoint: file, args: [ready] }, process.env, controller.signal,
        async (batch) => { lines.push(...batch); }, { command: node, killGraceMs: 10_000 });
    await waitForFile(ready);
    controller.abort();
    const result = await running;
    assert.deepEqual({ exitCode: result.exitCode, stopped: result.stopped }, { exitCode: 0, stopped: true });
    assert.deepEqual(lines, ['cleaning up']);
});

test('the effect-committed marker is reported once, as soon as it is printed, and kept in the log', async () => {
    const { file } = await script(`
        console.log('reached caption screen');
        console.log(${JSON.stringify(EFFECT_COMMITTED_MARKER)} + ' TikTok Post tap');
        console.log(${JSON.stringify(EFFECT_COMMITTED_MARKER)} + ' again');
        process.stdout.write('upload failed', () => process.exit(3));
    `);
    const reported: string[] = [];
    const lines: string[] = [];
    const result = await runPluginProcess({ entrypoint: file }, process.env, new AbortController().signal,
        async (batch) => { lines.push(...batch); }, {
            command: node,
            onEffectCommitted: async (line) => { reported.push(line); },
        });
    assert.equal(result.exitCode, 3);
    assert.deepEqual(reported, [`${EFFECT_COMMITTED_MARKER} TikTok Post tap`]);
    assert.ok(lines.includes('upload failed'), 'a final line without a newline is still logged');
    assert.ok(lines.includes(`${EFFECT_COMMITTED_MARKER} TikTok Post tap`));
});

test('reportEffectCommitted writes a line isEffectCommittedLine recognises', async () => {
    const stream = new PassThrough();
    let written = '';
    stream.on('data', (chunk) => { written += String(chunk); });
    await reportEffectCommitted('TikTok Post tap', stream);
    assert.equal(written, `${EFFECT_COMMITTED_MARKER} TikTok Post tap\n`);
    assert.equal(isEffectCommittedLine(written.trim()), true);
    assert.equal(isEffectCommittedLine('Tapped Post'), false);
});

test('deleteAppiumSessionsForDevice deletes only the sessions driving that phone', async () => {
    const requests: string[] = [];
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/appium/sessions')) {
            return Response.json({ value: [
                { id: 's1', capabilities: { udid: 'phone-a' } },
                { id: 's2', capabilities: { 'appium:udid': 'phone-a' } },
                { id: 's3', capabilities: { udid: 'phone-b' } },
            ] });
        }
        return new Response(null, { status: 200 });
    };
    const deleted = await deleteAppiumSessionsForDevice('phone-a', 'http://appium', fakeFetch);
    assert.deepEqual(deleted, ['s1', 's2']);
    assert.deepEqual(requests, [
        'GET http://appium/appium/sessions', 'DELETE http://appium/session/s1', 'DELETE http://appium/session/s2',
    ]);
});

test('deleteAppiumSessionsForDevice falls back to /sessions and tolerates an unreachable Appium', async () => {
    const fallback = async (url: string, init?: RequestInit): Promise<Response> => {
        if (url.endsWith('/appium/sessions')) return new Response('not found', { status: 404 });
        if (url.endsWith('/sessions')) return Response.json({ value: [{ id: 'old', capabilities: { udid: 'p' } }] });
        return new Response(null, { status: init?.method === 'DELETE' ? 200 : 404 });
    };
    assert.deepEqual(await deleteAppiumSessionsForDevice('p', 'http://127.0.0.1:4725', fallback), ['old']);
    const down = async (): Promise<Response> => { throw new Error('ECONNREFUSED'); };
    assert.deepEqual(await deleteAppiumSessionsForDevice('p', 'http://127.0.0.1:4725', down), []);
});

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
    await Promise.all(Array.from({ length: 10 }, () => waitForDevice(execution(), registered, new AbortController().signal, shared)));
    assert.equal(usbmuxReads, 1);
});

test('waitForDevice falls back to the registry identity when the cached sweep predates the reconnect', async () => {
    const found = await waitForDevice(execution(), registered, new AbortController().signal, dependencies({}));
    assert.deepEqual(found, { udid: 'phone-a', name: 'Rack 1 · 3' });
});

test('waitForDevice reports why it gave up, and stops promptly when aborted', async () => {
    await assert.rejects(
        waitForDevice(execution(-1), registered, new AbortController().signal, dependencies({})),
        /Execution window expired/,
    );
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

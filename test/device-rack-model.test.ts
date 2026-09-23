import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inject } from './support.js';

// registry.ts freezes its default path at first import: set it, then import.
const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-rack-model-'));
const configPath = path.join(directory, 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;
const { createApp } = await import('../src/api/app.js');
const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
const { PluginRegistry } = await import('../src/registry.js');
const { missingModels, RACK_MAX_LENGTH } = await import('../src/devices/registry.js');
const { DeviceRegistrationService } = await import('../src/devices/registration.js');
type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;

const stored = async () => JSON.parse(await readFile(configPath, 'utf8')) as Array<Record<string, unknown>>;

async function app(connected: Array<{ udid: string; name: string; osVersion: string; modelName?: string }> = []) {
    const scheduler = { async activeExecution() { return null; } } as unknown as SchedulerRepository;
    return createApp({
        plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme,
        discoverDevices: async () => connected, wdaStatuses: async () => [],
    });
}

test('rack and model are stored trimmed and capped, and an empty value clears them', async (context) => {
    await writeFile(configPath, JSON.stringify([{ name: 'Phone A', udid: 'udid-a', pluginData: {} }]));
    const server = await app();
    context.after(() => server.close());
    const saved = await inject(server, { method: 'PATCH', url: '/api/devices/udid-a', payload: { rack: '  1 ', model: ' iPhone 12 mini ' } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().rack, '1');
    assert.equal(saved.json().model, 'iPhone 12 mini');
    assert.equal((await stored())[0]!.rack, '1');
    const long = await inject(server, { method: 'PATCH', url: '/api/devices/udid-a', payload: { rack: 'x'.repeat(50) } });
    assert.equal(long.json().rack.length, RACK_MAX_LENGTH);
    const cleared = await inject(server, { method: 'PATCH', url: '/api/devices/udid-a', payload: { rack: '', model: '' } });
    assert.equal(cleared.json().rack, undefined);
    assert.equal(cleared.json().model, undefined);
    assert.ok(!('rack' in (await stored())[0]!));

    const created = await inject(server, { method: 'POST', url: '/api/devices', payload: { udid: 'udid-b', name: 'B', rack: '2', model: 'iPhone SE (2nd generation)' } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().rack, '2');
    const fragment = await inject(server, { method: 'GET', url: '/api/fragments/devices' });
    assert.match(fragment.body, /Rack 2/);
});

test('missingModels proposes discovery names only for phones without a model', () => {
    const devices = [
        { name: 'a', udid: 'a', pluginData: {} },
        { name: 'b', udid: 'b', model: 'Typed by an admin', pluginData: {} },
        { name: 'c', udid: 'c', model: '  ', pluginData: {} },
        { name: 'd', udid: 'd', pluginData: {} },
    ];
    const connected = [
        { udid: 'a', modelName: 'iPhone 12 mini' }, { udid: 'b', modelName: 'iPhone 8' },
        { udid: 'c', modelName: 'iPhone 11' }, { udid: 'd' }, { udid: 'unregistered', modelName: 'iPhone X' },
    ];
    assert.deepEqual([...missingModels(devices, connected)], [['a', 'iPhone 12 mini'], ['c', 'iPhone 11']]);
});

test('a connected phone without a model gets one from discovery, once, and a typed model is kept', async (context) => {
    await writeFile(configPath, JSON.stringify([
        { name: 'Phone A', udid: 'udid-a', pluginData: {} },
        { name: 'Phone B', udid: 'udid-b', model: 'Custom label', pluginData: {} },
        { name: 'Phone C', udid: 'udid-c', pluginData: {} },
    ]));
    const server = await app([
        { udid: 'udid-a', name: 'A', osVersion: '17.5', modelName: 'iPhone 12 mini' },
        { udid: 'udid-b', name: 'B', osVersion: '17.5', modelName: 'iPhone 8' },
    ]);
    context.after(() => server.close());
    const devices = (await inject(server, { method: 'GET', url: '/api/devices' })).json() as Array<{ udid: string; model?: string }>;
    assert.deepEqual(devices.map(({ udid, model }) => `${udid}=${model ?? ''}`), ['udid-a=iPhone 12 mini', 'udid-b=Custom label', 'udid-c=']);
    assert.deepEqual((await stored()).map(({ model }) => model ?? null), ['iPhone 12 mini', 'Custom label', null]);
    const before = (await stat(configPath)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await inject(server, { method: 'GET', url: '/api/fragments/devices' });
    assert.equal((await stat(configPath)).mtimeMs, before, 'nothing left to fill: no write');
});

test('the registration wizard keeps a rack across updates and restarts', async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'pf-registration-'));
    const candidate = { udid: 'udid-new', name: 'New', osVersion: '17.5', productType: 'iPhone13,1', modelName: 'iPhone 12 mini' };
    const options = {
        repositoryRoot: state, stateDirectory: state,
        discoverDevices: async () => [candidate], loadDevices: async () => [],
        fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    };
    const service = new DeviceRegistrationService(options);
    await service.start();
    await service.create('udid-new');
    const updated = await service.update('udid-new', { rack: '  3 ' });
    assert.equal(updated.rack, '3');
    assert.equal(updated.device.modelName, 'iPhone 12 mini', 'the model the wizard will save');
    await service.close();
    const restarted = new DeviceRegistrationService(options);
    await restarted.start();
    assert.equal((await restarted.get('udid-new'))?.rack, '3');
    await restarted.close();
});

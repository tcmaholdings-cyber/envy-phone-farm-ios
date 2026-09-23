import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// registry.ts freezes its default path at first import, so set the env before
// any src module loads and pull everything in dynamically.
test('a rack slot is stored, trimmed, rendered on the grid, and cleared by an empty value', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-rack-slot-'));
    const configPath = path.join(directory, 'devices.json');
    await writeFile(configPath, JSON.stringify([{ name: 'Phone A', udid: 'udid-a', pluginData: {} }]));
    process.env.DEVICES_CONFIG_PATH = configPath;

    const { createApp } = await import('../src/api/app.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const { PluginRegistry } = await import('../src/registry.js');
    type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;

    const scheduler = { async activeExecution() { return null; } } as unknown as SchedulerRepository;
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme });
    context.after(() => app.close());

    const saved = await inject(app, { method: 'PATCH', url: '/api/devices/udid-a', payload: { rackSlot: '  hub 2 · port 7  ' } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().rackSlot, 'hub 2 · port 7', 'surrounding whitespace is trimmed');
    assert.equal(JSON.parse(await readFile(configPath, 'utf8'))[0].rackSlot, 'hub 2 · port 7');

    // The slot has to be visible on an offline device — that is the whole point
    // of recording it, and nothing in this test is physically connected.
    const fragment = await inject(app, { method: 'GET', url: '/api/fragments/devices' });
    assert.match(fragment.body, /Slot hub 2 · port 7/);

    const cleared = await inject(app, { method: 'PATCH', url: '/api/devices/udid-a', payload: { rackSlot: '' } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().rackSlot, undefined);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8'))[0].rackSlot, undefined);
});

test('a rack slot can be set when the device is created, and is escaped when rendered', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-rack-slot-create-'));
    const configPath = path.join(directory, 'devices.json');
    await writeFile(configPath, '[]');
    process.env.DEVICES_CONFIG_PATH = configPath;

    const { createApp } = await import('../src/api/app.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const { PluginRegistry } = await import('../src/registry.js');
    type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;

    const scheduler = { async activeExecution() { return null; } } as unknown as SchedulerRepository;
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme });
    context.after(() => app.close());

    const created = await inject(app, {
        method: 'POST', url: '/api/devices',
        payload: { udid: 'udid-b', name: 'Phone B', rackSlot: '<script>A3' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().rackSlot, '<script>A3');

    const fragment = await inject(app, { method: 'GET', url: '/api/fragments/devices' });
    assert.match(fragment.body, /Slot &lt;script&gt;A3/);
    assert.doesNotMatch(fragment.body, /Slot <script>/);
});

test('an over-long rack slot is truncated rather than rejected', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-rack-slot-length-'));
    const configPath = path.join(directory, 'devices.json');
    const { saveRegisteredDevices, loadRegisteredDevices, RACK_SLOT_MAX_LENGTH } = await import('../src/devices/registry.js');

    await saveRegisteredDevices([{ name: 'Phone C', udid: 'udid-c', rackSlot: 'x'.repeat(200), pluginData: {} }], configPath);
    const [stored] = await loadRegisteredDevices(configPath);
    assert.equal(stored?.rackSlot?.length, RACK_SLOT_MAX_LENGTH);
});

import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { gridPollSeconds } from '../src/api/app.js';

test('the grid cadence opens up as the rack grows', (context) => {
    context.after(() => { delete process.env.PHONE_FARM_GRID_POLL_SECONDS; });
    delete process.env.PHONE_FARM_GRID_POLL_SECONDS;

    assert.equal(gridPollSeconds(0), 5);
    assert.equal(gridPollSeconds(10), 5, 'a small rack keeps the responsive cadence');
    assert.equal(gridPollSeconds(11), 10, 'past ten phones each poll is too many WDA round trips');
    assert.equal(gridPollSeconds(20), 10);
});

test('PHONE_FARM_GRID_POLL_SECONDS overrides the cadence in both directions', (context) => {
    context.after(() => { delete process.env.PHONE_FARM_GRID_POLL_SECONDS; });

    process.env.PHONE_FARM_GRID_POLL_SECONDS = '30';
    assert.equal(gridPollSeconds(2), 30);

    process.env.PHONE_FARM_GRID_POLL_SECONDS = '2';
    assert.equal(gridPollSeconds(20), 2, 'an operator may ask for a faster grid on a big rack');

    // Nonsense values fall back to the device-count default rather than
    // producing an hx-trigger the browser cannot parse.
    process.env.PHONE_FARM_GRID_POLL_SECONDS = 'soon';
    assert.equal(gridPollSeconds(2), 5);
    process.env.PHONE_FARM_GRID_POLL_SECONDS = '0';
    assert.equal(gridPollSeconds(2), 5);
});

test('the rendered grid fragment carries the configured cadence', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-grid-poll-'));
    const configPath = path.join(directory, 'devices.json');
    await writeFile(configPath, JSON.stringify([{ name: 'Phone A', udid: 'udid-a', pluginData: {} }]));
    process.env.DEVICES_CONFIG_PATH = configPath;
    process.env.PHONE_FARM_GRID_POLL_SECONDS = '12';
    context.after(() => { delete process.env.PHONE_FARM_GRID_POLL_SECONDS; });

    const { createApp } = await import('../src/api/app.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const { PluginRegistry } = await import('../src/registry.js');
    type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;

    const scheduler = { async activeExecution() { return null; } } as unknown as SchedulerRepository;
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme });
    context.after(() => app.close());

    const fragment = await inject(app, { method: 'GET', url: '/api/fragments/devices' });
    assert.equal(fragment.statusCode, 200);
    assert.match(fragment.body, /hx-trigger="every 12s"/);
});

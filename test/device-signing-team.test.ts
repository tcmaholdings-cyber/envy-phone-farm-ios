import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inject } from './support.js';

// registry.ts freezes its default path at first import: set it, then import.
const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-signing-team-'));
const configPath = path.join(directory, 'devices.json');
process.env.DEVICES_CONFIG_PATH = configPath;
const { createApp } = await import('../src/api/app.js');
const { PluginRegistry } = await import('../src/registry.js');
type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;

const stored = async () => JSON.parse(await readFile(configPath, 'utf8')) as Array<Record<string, unknown>>;

test('an admin sets, normalises and clears a phone\'s signing team through the device API', async (context) => {
    await writeFile(configPath, JSON.stringify([{ name: 'Phone A', udid: 'udid-a', pluginData: {} }]));
    const scheduler = { async activeExecution() { return null; } } as unknown as SchedulerRepository;
    const server = await createApp({ plugins: new PluginRegistry([]), scheduler, discoverDevices: async () => [], wdaStatuses: async () => [] });
    context.after(() => server.close());

    const saved = await inject(server, { method: 'PATCH', url: '/api/devices/udid-a', payload: { signingTeam: ' teamb00002 ' } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().signingTeam, 'TEAMB00002');
    assert.equal((await stored())[0]!.signingTeam, 'TEAMB00002');

    const bad = await inject(server, { method: 'PATCH', url: '/api/devices/udid-a', payload: { signingTeam: 'team b; rm' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /signing team/);

    const cleared = await inject(server, { method: 'PATCH', url: '/api/devices/udid-a', payload: { signingTeam: '' } });
    assert.equal(cleared.json().signingTeam, undefined);
    assert.ok(!('signingTeam' in (await stored())[0]!));

    const created = await inject(server, { method: 'POST', url: '/api/devices', payload: { udid: 'udid-b', signingTeam: 'TEAMC00003' } });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().signingTeam, 'TEAMC00003');
});

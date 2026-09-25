import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { DeviceSecretStore } from '../src/devices/device-secrets.js';
import { importDevicesToRegistry } from '../src/devices/import-to-db.js';
import { PostgresDeviceRegistry, type SqlPool } from '../src/devices/registry-pg.js';

/**
 * Opt-in: runs only with PHONE_FARM_TEST_DATABASE_URL pointing at a migrated,
 * disposable database (never production). It touches only rows of hosts named
 * `test-<random>` and deletes them afterwards. CI does not set it.
 */
const url = process.env.PHONE_FARM_TEST_DATABASE_URL;

test('real Postgres: concurrent registries on two pools never lose a write; passcodes stay out of the table', { skip: !url }, async (context) => {
    const hostA = `test-${crypto.randomBytes(4).toString('hex')}`;
    const hostB = `${hostA}-b`;
    const pools = [new Pool({ connectionString: url, max: 3 }), new Pool({ connectionString: url, max: 3 })];
    const cleanup = new Pool({ connectionString: url, max: 1 });
    context.after(async () => {
        await cleanup.query('delete from fleet.devices where host_id in ($1, $2)', [hostA, hostB]);
        await cleanup.query('delete from fleet.hosts where id in ($1, $2)', [hostA, hostB]);
        await Promise.all([...pools, cleanup].map((pool) => pool.end()));
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-real-'));
    const [a, b] = pools.map((pool, index) => new PostgresDeviceRegistry({
        pool: pool as unknown as SqlPool, hostId: index ? hostB : hostA, cacheMs: 0,
        secrets: new DeviceSecretStore(path.join(directory, `${index}.json`)),
    }));

    // Two "processes" (separate pools) insert concurrently; the advisory lock serialises them.
    await Promise.all(Array.from({ length: 8 }, (_value, index) => (index % 2 ? b! : a!).mutate((devices) => {
        devices.push({ udid: `${hostA}-u${index}`, name: `U${index}`, pluginData: {}, ...(index === 0 ? { passcode: '864209' } : {}) });
    })));
    const rows = (await cleanup.query<{ udid: string; host_id: string; wda_local_port: number; has_passcode: boolean }>(
        'select udid, host_id, wda_local_port, has_passcode from fleet.devices where host_id in ($1, $2) order by udid', [hostA, hostB],
    )).rows;
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.filter(({ host_id }) => host_id === hostA).map(({ wda_local_port }) => wda_local_port).sort(), [8100, 8101, 8102, 8103]);
    assert.deepEqual(rows.filter(({ host_id }) => host_id === hostB).map(({ wda_local_port }) => wda_local_port).sort(), [8100, 8101, 8102, 8103]);
    assert.equal(rows.find(({ udid }) => udid === `${hostA}-u0`)?.has_passcode, true);
    const leaked = await cleanup.query(`select 1 from fleet.devices where host_id = $1 and (plugin_data::text like '%864209%' or name like '%864209%')`, [hostA]);
    assert.equal(leaked.rowCount, 0);
    assert.equal((await a!.load()).find(({ udid }) => udid === `${hostA}-u0`)?.passcode, '864209');
    assert.equal((await b!.load()).find(({ udid }) => udid === `${hostA}-u0`)?.passcode, undefined);

    // The unique index backs the per-host port rule.
    await assert.rejects(a!.mutate((devices) => {
        const mine = devices.filter(({ hostId }) => hostId === hostA);
        mine[1]!.wdaLocalPort = mine[0]!.wdaLocalPort;
    }), /Port \d+ is used by both/);

    // Import is idempotent against the real table.
    const file = [{ udid: `${hostA}-imported`, name: 'Imported', wdaLocalPort: 8150, mjpegLocalPort: 9150, pluginData: {} }];
    assert.deepEqual((await importDevicesToRegistry(file, a!, hostA)).inserted, [`${hostA}-imported`]);
    assert.deepEqual((await importDevicesToRegistry(file, a!, hostA)).unchanged, [`${hostA}-imported`]);
});

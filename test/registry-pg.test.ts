import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DeviceSecretStore } from '../src/devices/device-secrets.js';
import { importDevicesToRegistry } from '../src/devices/import-to-db.js';
import { assignMissingPorts, planDeviceWrites, PostgresDeviceRegistry, rowToDevice } from '../src/devices/registry-pg.js';
import { redactDevice, type RegisteredDevice } from '../src/devices/registry.js';
import { FakeFleetDb } from './fake-fleet-db.js';

async function setup(hostId = 'mini-a') {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-pg-'));
    const secrets = new DeviceSecretStore(path.join(directory, 'device-secrets.json'));
    const db = new FakeFleetDb();
    const registry = new PostgresDeviceRegistry({ pool: db.pool(), hostId, hostName: `Mac ${hostId}`, secrets, cacheMs: 0 });
    return { db, registry, secrets, directory };
}

test('a new phone is inserted for this host, its host row created, and ports allocated per host', async () => {
    const { db, registry } = await setup();
    db.addDevice({ udid: 'other-host-phone', host_id: 'mini-b', wda_local_port: 8100, mjpeg_local_port: 9100 });
    await registry.mutate((devices) => { devices.push({ udid: 'u1', name: 'One', pluginData: {} }); });
    const row = db.devices.find(({ udid }) => udid === 'u1')!;
    assert.equal(row.host_id, 'mini-a');
    // 8100 is taken on mini-b, not here: ports are unique per host only.
    assert.equal(row.wda_local_port, 8100);
    assert.equal(row.mjpeg_local_port, 9100);
    assert.equal(db.hosts.get('mini-a')?.display_name, 'Mac mini-a');

    await registry.mutate((devices) => { devices.push({ udid: 'u2', name: 'Two', pluginData: {} }); });
    const second = db.devices.find(({ udid }) => udid === 'u2')!;
    assert.deepEqual([second.wda_local_port, second.mjpeg_local_port], [8101, 9101]);
});

test('load returns every host\'s phones, with passcodes only for this host\'s', async () => {
    const { db, registry, secrets } = await setup();
    db.addDevice({ udid: 'mine', host_id: 'mini-a', has_passcode: true });
    db.addDevice({ udid: 'theirs', host_id: 'mini-b', has_passcode: true, wda_local_port: 8100, mjpeg_local_port: 9100 });
    await secrets.write({ mine: { passcode: '123456' }, theirs: { passcode: '999999' } });
    const devices = await registry.load();
    const mine = devices.find(({ udid }) => udid === 'mine')!;
    const theirs = devices.find(({ udid }) => udid === 'theirs')!;
    assert.equal(mine.passcode, '123456');
    assert.equal(mine.hostId, 'mini-a');
    assert.equal(theirs.passcode, undefined, 'another host\'s passcode is never read from this host\'s file');
    assert.equal(theirs.passcodeSet, true);
    assert.equal(redactDevice(theirs).hasPasscode, true);
    assert.equal('passcodeSet' in redactDevice(theirs), false);
});

test('a passcode is written to the local 0600 secret file and never to Postgres', async () => {
    const { db, registry, secrets } = await setup();
    await registry.mutate((devices) => { devices.push({ udid: 'u1', name: 'One', passcode: '246810', pluginData: {} }); });
    assert.deepEqual(await secrets.read(), { u1: { passcode: '246810' } });
    assert.equal((await stat(secrets.filePath)).mode & 0o777, 0o600);
    assert.equal(db.devices[0]!.has_passcode, true);
    assert.ok(!db.allValues().some((value) => value.includes('246810')), 'the passcode reached a SQL statement');

    await registry.mutate((devices) => { delete devices[0]!.passcode; });
    assert.deepEqual(await secrets.read(), {});
    assert.equal(db.devices[0]!.has_passcode, false);
});

test('setting a passcode on another host\'s phone is refused', async () => {
    const { db, registry } = await setup();
    db.addDevice({ udid: 'theirs', host_id: 'mini-b' });
    await assert.rejects(
        registry.mutate((devices) => { devices[0]!.passcode = '1234'; }),
        (error: Error & { statusCode?: number }) => error.statusCode === 409 && /belongs to host mini-b/.test(error.message),
    );
});

test('editing another host\'s phone keeps its has_passcode marker', async () => {
    const { db, registry } = await setup();
    db.addDevice({ udid: 'theirs', host_id: 'mini-b', has_passcode: true });
    await registry.mutate((devices) => { devices[0]!.rack = '7'; });
    assert.equal(db.devices[0]!.rack, '7');
    assert.equal(db.devices[0]!.has_passcode, true);
});

test('a failed write rolls back the rows and leaves the secret file alone', async () => {
    const { db, registry, secrets } = await setup();
    db.addDevice({ udid: 'keep', host_id: 'mini-a' });
    await secrets.write({ keep: { passcode: '1111' } });
    db.failWriteAt = 2;
    await assert.rejects(registry.mutate((devices) => {
        devices.splice(0, 1);
        devices.push({ udid: 'new', name: 'New', passcode: '2222', pluginData: {} });
    }), /injected write failure/);
    assert.deepEqual(db.devices.map(({ udid }) => udid), ['keep']);
    assert.deepEqual(await secrets.read(), { keep: { passcode: '1111' } });
    assert.ok(db.statements.some(({ text }) => text === 'rollback'));
});

test('mutations serialise on the lock and see each other\'s writes', async () => {
    const { db } = await setup();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-pg-'));
    const a = new PostgresDeviceRegistry({ pool: db.pool(), hostId: 'mini-a', secrets: new DeviceSecretStore(path.join(directory, 'a.json')), cacheMs: 0 });
    const b = new PostgresDeviceRegistry({ pool: db.pool(), hostId: 'mini-a', secrets: new DeviceSecretStore(path.join(directory, 'b.json')), cacheMs: 0 });
    await Promise.all(Array.from({ length: 6 }, (_value, index) => (index % 2 ? a : b).mutate(async (devices) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        devices.push({ udid: `u${index}`, name: `U${index}`, pluginData: {} });
    })));
    assert.equal(db.devices.length, 6, 'no mutation lost another\'s insert');
    const ports = db.devices.map(({ wda_local_port }) => wda_local_port).sort();
    assert.deepEqual(ports, [8100, 8101, 8102, 8103, 8104, 8105]);
});

test('two phones on one host with the same port are refused before Postgres sees them', async () => {
    const { registry } = await setup();
    await assert.rejects(registry.mutate((devices) => {
        devices.push({ udid: 'a', name: 'A', wdaLocalPort: 8200, mjpegLocalPort: 9200, pluginData: {} });
        devices.push({ udid: 'b', name: 'B', wdaLocalPort: 8200, mjpegLocalPort: 9201, pluginData: {} });
    }), (error: Error & { statusCode?: number }) => error.statusCode === 409 && /Port 8200/.test(error.message));
});

test('an unchanged list writes nothing', async () => {
    const { db, registry } = await setup();
    db.addDevice({ udid: 'u1', host_id: 'mini-a', plugin_data: { x: { a: 1 } } });
    db.statements = [];
    await registry.mutate(() => undefined);
    assert.deepEqual(db.statements.map(({ text }) => text.split(/\s/)[0]), ['begin', 'select', 'select', 'commit']);
});

test('reads are cached briefly and every mutation invalidates the cache', async () => {
    const db = new FakeFleetDb();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-pg-'));
    let now = 0;
    const registry = new PostgresDeviceRegistry({
        pool: db.pool(), hostId: 'mini-a', secrets: new DeviceSecretStore(path.join(directory, 's.json')), cacheMs: 2_000, now: () => now,
    });
    db.addDevice({ udid: 'u1', host_id: 'mini-a' });
    await registry.load();
    db.addDevice({ udid: 'u2', host_id: 'mini-a', wda_local_port: 8101, mjpeg_local_port: 9101 });
    assert.equal((await registry.load()).length, 1, 'served from cache');
    now = 2_000;
    assert.equal((await registry.load()).length, 2, 'cache expired');
    const loaded = await registry.load();
    loaded[0]!.name = 'mutated by caller';
    assert.notEqual((await registry.load())[0]!.name, 'mutated by caller', 'callers get copies');
    await registry.mutate((devices) => { devices.pop(); });
    assert.equal((await registry.load()).length, 1, 'invalidated by the mutation');
});

test('pure helpers: row mapping, port allocation and the write plan', () => {
    const device = rowToDevice({
        udid: 'u', host_id: 'h', name: 'N', coordinate_profile: 'iphone8', wda_local_port: 8100, mjpeg_local_port: 9100,
        rack: '1', rack_slot: 'A3', model: 'iPhone 8', disabled: true, coordinates: {}, plugin_data: null, signing_team: 'TEAMA', has_passcode: false,
    }, 'h', { u: { passcode: '1234' } });
    assert.deepEqual(device, {
        name: 'N', udid: 'u', hostId: 'h', wdaLocalPort: 8100, mjpegLocalPort: 9100, pluginData: {},
        coordinateProfile: 'iphone8', rack: '1', rackSlot: 'A3', model: 'iPhone 8', disabled: true, signingTeam: 'TEAMA', passcode: '1234',
    });

    const devices: RegisteredDevice[] = [
        { udid: 'a', name: 'a', pluginData: {}, hostId: 'h1', wdaLocalPort: 8100, mjpegLocalPort: 9100 },
        { udid: 'b', name: 'b', pluginData: {}, hostId: 'h1' },
        { udid: 'c', name: 'c', pluginData: {}, hostId: 'h2' },
    ];
    assignMissingPorts(devices, (entry) => entry.hostId!);
    assert.deepEqual(devices.map(({ wdaLocalPort, mjpegLocalPort }) => [wdaLocalPort, mjpegLocalPort]), [[8100, 9100], [8101, 9101], [8100, 9100]]);

    const plan = planDeviceWrites(devices, [{ ...devices[0]!, name: 'renamed' }, devices[2]!], 'h1', {});
    assert.deepEqual(plan.deletes, ['b']);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.inserts.length, 0);
    assert.equal(plan.secrets, null);
});

test('import-to-db copies devices.json into Postgres for this host, idempotently, keeping passcodes local', async () => {
    const { db, registry, secrets } = await setup();
    db.addDevice({ udid: 'claimed', host_id: 'mini-b' });
    const file: RegisteredDevice[] = [
        { udid: 'p1', name: 'Phone 1', passcode: '135790', rack: '2', pluginData: { 'com.git-agni.tiktok': { accounts: ['a'] } } },
        { udid: 'p2', name: 'Phone 2', wdaLocalPort: 8101, mjpegLocalPort: 9101, signingTeam: 'team_b', pluginData: {} },
        { udid: 'claimed', name: 'Claimed elsewhere', pluginData: {} },
    ];

    const dry = await importDevicesToRegistry(file, registry, 'mini-a', { dryRun: true, env: {} });
    assert.deepEqual(dry.inserted, ['p1', 'p2']);
    assert.deepEqual(db.devices.map(({ udid }) => udid), ['claimed'], 'a dry run writes nothing');
    assert.deepEqual(await secrets.read(), {});

    const first = await importDevicesToRegistry(file, registry, 'mini-a', { env: {} });
    assert.deepEqual(first.inserted, ['p1', 'p2']);
    assert.deepEqual(first.skipped, [{ udid: 'claimed', reason: 'owned by host mini-b' }]);
    const p1 = db.devices.find(({ udid }) => udid === 'p1')!;
    assert.deepEqual([p1.host_id, p1.wda_local_port, p1.mjpeg_local_port, p1.rack, p1.has_passcode], ['mini-a', 8100, 9100, '2', true]);
    assert.equal(db.devices.find(({ udid }) => udid === 'p2')!.signing_team, 'TEAM_B');
    assert.deepEqual(await secrets.read(), { p1: { passcode: '135790' } });
    assert.ok(!db.allValues().some((value) => value.includes('135790')));
    assert.equal(db.devices.find(({ udid }) => udid === 'claimed')!.host_id, 'mini-b', 'another host\'s phone is not stolen');

    db.statements = [];
    const second = await importDevicesToRegistry(file, registry, 'mini-a', { env: {} });
    assert.deepEqual(second.inserted, []);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(second.unchanged, ['p1', 'p2']);
    assert.ok(!db.statements.some(({ text }) => /^(insert|update|delete)/.test(text.trim())), 'a re-run writes nothing');
});

test('import-to-db refuses two phones that both default to the same ports, naming them', async () => {
    const { db, registry } = await setup();
    const file: RegisteredDevice[] = [{ udid: 'x', name: 'X', pluginData: {} }, { udid: 'y', name: 'Y', pluginData: {} }];
    await assert.rejects(importDevicesToRegistry(file, registry, 'mini-a', { env: {} }), /Port 8100 is used by both x and y/);
    assert.equal(db.devices.length, 0);
});

test('the secret store writes through a release symlink instead of replacing it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-secrets-link-'));
    const shared = path.join(directory, 'shared-secrets.json');
    const link = path.join(directory, 'device-secrets.json');
    await symlink(shared, link);
    await new DeviceSecretStore(link).write({ u: { passcode: '1357' } });
    assert.ok((await lstat(link)).isSymbolicLink(), 'the link survives the save');
    assert.deepEqual(JSON.parse(await readFile(shared, 'utf8')), { u: { passcode: '1357' } });
    assert.equal((await stat(shared)).mode & 0o777, 0o600);
});

test('the secret store ignores junk and never echoes a malformed file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-secrets-'));
    const file = path.join(directory, 's.json');
    await writeFile(file, '{"a":{"passcode":"1234"},"b":"nope","c":{"passcode":5}}');
    assert.deepEqual(await new DeviceSecretStore(file).read(), { a: { passcode: '1234' }, c: {} });
    await writeFile(file, '{"a":{"passcode":"98765"');
    await assert.rejects(new DeviceSecretStore(file).read(), (error: Error) => !error.message.includes('98765'));
    await new DeviceSecretStore(file).write({ z: { passcode: '4444' }, y: {} });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { z: { passcode: '4444' } });
});

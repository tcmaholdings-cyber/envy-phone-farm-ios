import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isLocalDevice, localDevices, localHostId } from '../src/devices/host-identity.js';
import {
    loadRegisteredDevices, mutateRegisteredDevices, normalizeDevices, registryKind, saveRegisteredDevices, setDeviceRegistry,
    type DeviceRegistryBackend, type RegisteredDevice,
} from '../src/devices/registry.js';

test('PHONE_FARM_REGISTRY defaults to the file backend and rejects anything unknown', () => {
    assert.equal(registryKind({}), 'file');
    assert.equal(registryKind({ PHONE_FARM_REGISTRY: 'file' }), 'file');
    assert.equal(registryKind({ PHONE_FARM_REGISTRY: ' Postgres ' }), 'postgres');
    assert.throws(() => registryKind({ PHONE_FARM_REGISTRY: 'sqlite' }), /must be "file" or "postgres"/);
});

test('the public registry functions go through the configured backend', async (context) => {
    let devices: RegisteredDevice[] = [{ udid: 'u1', name: 'One', pluginData: {} }];
    const backend: DeviceRegistryBackend = {
        kind: 'postgres',
        load: async () => structuredClone(devices),
        async mutate(mutate) {
            const working = structuredClone(devices);
            const result = await mutate(working);
            devices = working;
            return result;
        },
    };
    setDeviceRegistry(backend);
    context.after(() => setDeviceRegistry(undefined));
    assert.deepEqual((await loadRegisteredDevices()).map(({ udid }) => udid), ['u1']);
    await mutateRegisteredDevices((list) => { list.push({ udid: 'u2', name: 'Two', pluginData: {} }); });
    await saveRegisteredDevices([{ udid: 'u3', name: 'Three', pluginData: {} }]);
    assert.deepEqual(devices.map(({ udid }) => udid), ['u3']);
});

test('an explicit path is always that devices.json, written 0600', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-file-'));
    const file = path.join(directory, 'devices.json');
    await writeFile(file, JSON.stringify([{ udid: 'a', name: 'A' }]));
    assert.deepEqual((await loadRegisteredDevices(file)).map(({ udid }) => udid), ['a']);
    await mutateRegisteredDevices((list) => { list[0]!.signingTeam = ' abcde12345 '; list[0]!.passcodeSet = true; }, file);
    const stored = JSON.parse(await readFile(file, 'utf8')) as RegisteredDevice[];
    assert.equal(stored[0]!.signingTeam, 'ABCDE12345');
    assert.equal('passcodeSet' in stored[0]!, false, 'the derived marker is never stored');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('normalizeDevices refuses a bad signing team or port', () => {
    assert.throws(() => normalizeDevices([{ udid: 'a', name: 'A', pluginData: {}, signingTeam: 'team b!' }]), /signing team/);
    assert.throws(() => normalizeDevices([{ udid: 'a', name: 'A', pluginData: {}, wdaLocalPort: 70_000 }]), /port number/);
    const cleared: RegisteredDevice[] = [{ udid: 'a', name: 'A', pluginData: {}, signingTeam: '  ' }];
    normalizeDevices(cleared);
    assert.equal('signingTeam' in cleared[0]!, false);
});

test('host identity: PHONE_FARM_HOST_ID wins, is validated, and a device without hostId is local', () => {
    assert.equal(localHostId({ PHONE_FARM_HOST_ID: 'mini-a' }), 'mini-a');
    assert.throws(() => localHostId({ PHONE_FARM_HOST_ID: 'bad host/../x' }), /PHONE_FARM_HOST_ID/);
    assert.match(localHostId({}), /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(isLocalDevice({}, 'mini-a'), true);
    assert.equal(isLocalDevice({ hostId: 'mini-a' }, 'mini-a'), true);
    assert.equal(isLocalDevice({ hostId: 'mini-b' }, 'mini-a'), false);
    assert.deepEqual(localDevices([{ hostId: 'mini-b' }, {}, { hostId: 'mini-a' }], 'mini-a'), [{}, { hostId: 'mini-a' }]);
});

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mutateRegisteredDevices, saveRegisteredDevices } from '../src/devices/registry.js';

// A release deploy (scripts/deploy.sh) links releases/<id>/devices.json to
// shared/devices.json. A save must replace the shared file, never the link.
test('saving through a symlinked devices.json keeps the link and updates the shared file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-link-'));
    const shared = path.join(root, 'shared', 'devices.json');
    const release = path.join(root, 'releases', 'abc123');
    await mkdir(path.dirname(shared), { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(shared, JSON.stringify([{ name: 'Phone A', udid: 'udid-a', pluginData: {} }]), { mode: 0o600 });
    const linked = path.join(release, 'devices.json');
    await symlink('../../shared/devices.json', linked);

    await mutateRegisteredDevices((devices) => { devices[0]!.rack = '2'; }, linked);

    assert.ok((await lstat(linked)).isSymbolicLink(), 'the release still links to shared state');
    assert.equal(await readlink(linked), '../../shared/devices.json');
    assert.equal(JSON.parse(await readFile(shared, 'utf8'))[0].rack, '2');
    assert.equal((await lstat(shared)).mode & 0o777, 0o600);
});

test('a dangling devices.json link is filled in at its target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-dangling-'));
    await mkdir(path.join(root, 'shared'));
    const linked = path.join(root, 'devices.json');
    await symlink('shared/devices.json', linked);

    await saveRegisteredDevices([{ name: 'Phone B', udid: 'udid-b', pluginData: {} }], linked);

    assert.ok((await lstat(linked)).isSymbolicLink());
    assert.equal(JSON.parse(await readFile(path.join(root, 'shared', 'devices.json'), 'utf8'))[0].udid, 'udid-b');
});

test('a plain devices.json path is saved as before', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pf-registry-plain-'));
    const file = path.join(root, 'devices.json');
    await saveRegisteredDevices([{ name: 'Phone C', udid: 'udid-c', pluginData: {} }], file);
    assert.ok((await lstat(file)).isFile());
});

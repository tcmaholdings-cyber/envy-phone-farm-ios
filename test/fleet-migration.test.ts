import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(new URL('../drizzle/0005_fleet_hosts_devices.sql', import.meta.url), 'utf8');

test('migration 0005 creates fleet.hosts and fleet.devices with per-host port uniqueness', () => {
    assert.match(sql, /CREATE SCHEMA "fleet"/);
    assert.match(sql, /CREATE TABLE "fleet"\."hosts"/);
    assert.match(sql, /CREATE TABLE "fleet"\."devices"/);
    for (const column of ['id', 'display_name', 'agent_url', 'last_seen_at', 'version']) assert.match(sql, new RegExp(`"${column}"`));
    for (const column of [
        'udid', 'host_id', 'name', 'coordinate_profile', 'wda_local_port', 'mjpeg_local_port', 'rack', 'rack_slot',
        'model', 'disabled', 'coordinates', 'plugin_data', 'signing_team', 'has_passcode', 'created_at', 'updated_at',
    ]) assert.match(sql, new RegExp(`"${column}"`));
    assert.match(sql, /UNIQUE INDEX "devices_host_wda_port_idx" ON "fleet"\."devices" USING btree \("host_id","wda_local_port"\)/);
    assert.match(sql, /UNIQUE INDEX "devices_host_mjpeg_port_idx" ON "fleet"\."devices" USING btree \("host_id","mjpeg_local_port"\)/);
    assert.match(sql, /FOREIGN KEY \("host_id"\) REFERENCES "fleet"\."hosts"\("id"\)/);
});

test('migration 0005 never gives passcodes a column', () => {
    // Passcodes stay in the owning host's 0600 file; only the boolean marker is shared.
    assert.doesNotMatch(sql, /"passcode"/);
});

test('migration 0005 is the sixth journal entry', async () => {
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    assert.deepEqual(journal.entries.map(({ idx }) => idx), journal.entries.map((_entry, index) => index));
    assert.equal(journal.entries[5]?.tag, '0005_fleet_hosts_devices');
});

import { parseArgs } from 'node:util';

import { closeDeviceRegistry, fileDeviceRegistry, loadRegisteredDevices, mutateRegisteredDevices, RACK_MAX_LENGTH } from './registry.js';
import { localHostId } from './host-identity.js';

/**
 * Small device-registry helpers for the shell:
 *
 *   npm run devices -- list
 *   npm run devices -- set-rack <rack> --all
 *   npm run devices -- set-rack <rack> <udid> [<udid> ...]
 *   npm run devices -- set-rack '' <udid>        (clears it)
 *   npm run devices -- import-to-db [--dry-run]  (devices.json → Postgres, for this host)
 *
 * They act on the configured registry (PHONE_FARM_REGISTRY: devices.json by
 * default, or Postgres). The web process re-reads it, so no restart is needed.
 */

const USAGE = `Usage:
  npm run devices -- list
  npm run devices -- set-rack <rack> --all
  npm run devices -- set-rack <rack> <udid> [<udid> ...]
  npm run devices -- import-to-db [--dry-run]`;

async function main(argv: string[]): Promise<number> {
    const { positionals, values } = parseArgs({
        args: argv, allowPositionals: true, options: {
            all: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        },
    });
    const [command, ...rest] = positionals;
    if (values.help || !command) { console.error(USAGE); return command ? 0 : 1; }
    if (command === 'list') {
        const devices = await loadRegisteredDevices();
        const rows = devices.map((device) => [device.name, device.udid, device.hostId ?? '', device.rack ?? '', device.rackSlot ?? '', device.model ?? '', device.signingTeam ?? '', device.disabled ? 'disabled' : '']);
        const header = ['NAME', 'UDID', 'HOST', 'RACK', 'SLOT', 'MODEL', 'TEAM', ''];
        const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]!.length)));
        for (const row of [header, ...rows]) console.log(row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd());
        return 0;
    }
    if (command === 'set-rack') {
        const [rack, ...udids] = rest;
        if (rack === undefined || (!values.all && !udids.length) || (values.all && udids.length)) {
            console.error(`set-rack needs a rack and either --all or one or more UDIDs.\n${USAGE}`);
            return 1;
        }
        if (rack.trim().length > RACK_MAX_LENGTH) { console.error(`A rack label is at most ${RACK_MAX_LENGTH} characters.`); return 1; }
        const changed = await mutateRegisteredDevices((devices) => {
            const unknown = udids.filter((udid) => !devices.some((device) => device.udid === udid));
            if (unknown.length) throw new Error(`Not registered: ${unknown.join(', ')}`);
            const targets = values.all ? devices : devices.filter((device) => udids.includes(device.udid));
            for (const device of targets) device.rack = rack;
            return targets.length;
        });
        console.error(rack.trim() ? `Rack set to "${rack.trim()}" on ${changed} device(s).` : `Rack cleared on ${changed} device(s).`);
        return 0;
    }
    if (command === 'import-to-db') {
        // Always reads devices.json (DEVICES_CONFIG_PATH) and always writes Postgres,
        // whatever PHONE_FARM_REGISTRY says: this is the step before switching it.
        const { createPostgresDeviceRegistry } = await import('./registry-pg.js');
        const { importDevicesToRegistry } = await import('./import-to-db.js');
        const hostId = localHostId();
        const source = await fileDeviceRegistry().load();
        const target = createPostgresDeviceRegistry();
        try {
            const result = await importDevicesToRegistry(source, target, hostId, { dryRun: values['dry-run'] === true });
            const verb = values['dry-run'] ? 'would import' : 'imported';
            console.error(`Host ${hostId}: ${verb} ${result.inserted.length} new, ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length} skipped.`);
            for (const { udid, reason } of result.skipped) console.error(`  skipped ${udid}: ${reason}`);
            if (!values['dry-run']) {
                console.error('Passcodes (if any) are in this host\'s device-secrets.json, not in Postgres. devices.json was left as it was.');
                console.error('Set PHONE_FARM_REGISTRY=postgres (and PHONE_FARM_HOST_ID) in .env, then restart web, worker and wda-service.');
            }
            return 0;
        } finally {
            await target.close();
        }
    }
    console.error(`Unknown command "${command}".\n${USAGE}`);
    return 1;
}

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    await closeDeviceRegistry();
}

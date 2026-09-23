import { parseArgs } from 'node:util';

import { loadRegisteredDevices, mutateRegisteredDevices, RACK_MAX_LENGTH } from './registry.js';

/**
 * Small devices.json helpers for the shell:
 *
 *   npm run devices -- list
 *   npm run devices -- set-rack <rack> --all
 *   npm run devices -- set-rack <rack> <udid> [<udid> ...]
 *   npm run devices -- set-rack '' <udid>        (clears it)
 *
 * The web process re-reads devices.json on every request, so no restart is needed.
 */

const USAGE = `Usage:
  npm run devices -- list
  npm run devices -- set-rack <rack> --all
  npm run devices -- set-rack <rack> <udid> [<udid> ...]`;

async function main(argv: string[]): Promise<number> {
    const { positionals, values } = parseArgs({
        args: argv, allowPositionals: true, options: { all: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
    const [command, ...rest] = positionals;
    if (values.help || !command) { console.error(USAGE); return command ? 0 : 1; }
    if (command === 'list') {
        const devices = await loadRegisteredDevices();
        const rows = devices.map((device) => [device.name, device.udid, device.rack ?? '', device.rackSlot ?? '', device.model ?? '', device.disabled ? 'disabled' : '']);
        const header = ['NAME', 'UDID', 'RACK', 'SLOT', 'MODEL', ''];
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
    console.error(`Unknown command "${command}".\n${USAGE}`);
    return 1;
}

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}

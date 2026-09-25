import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writePrivateFileAtomic, writeTarget } from './atomic-file.js';

/**
 * The host-local secret store used with the Postgres registry.
 *
 * Device passcodes never enter Postgres (AGENTS.md invariant 4): the shared
 * database only records `has_passcode`. The passcode itself stays in this
 * 0600, git-ignored JSON file on the Mac that owns the phone:
 *
 *     { "<udid>": { "passcode": "123456" } }
 *
 * Where: `PHONE_FARM_DEVICE_SECRETS_PATH`, else `device-secrets.json` in the
 * directory that really holds devices.json. In the release layout devices.json
 * is a link to `~/phone-farm/shared/devices.json`, so the secrets land in
 * `shared/` too and survive the next deploy instead of staying behind in an
 * old release directory.
 */
export interface DeviceSecret {
    passcode?: string;
}

export type DeviceSecrets = Record<string, DeviceSecret>;

export async function defaultDeviceSecretsPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
    if (env.PHONE_FARM_DEVICE_SECRETS_PATH?.trim()) return path.resolve(env.PHONE_FARM_DEVICE_SECRETS_PATH.trim());
    const devicesFile = await writeTarget(path.resolve(env.DEVICES_CONFIG_PATH ?? 'devices.json'));
    return path.join(path.dirname(devicesFile), 'device-secrets.json');
}

export class DeviceSecretStore {
    private resolved: Promise<string> | undefined;

    /** Without `filePath`, the location is resolved on first use (see `defaultDeviceSecretsPath`). */
    constructor(private readonly explicitPath?: string) {}

    /** Where the secrets are read from and written to. */
    filePath(): Promise<string> {
        this.resolved ??= this.explicitPath ? Promise.resolve(path.resolve(this.explicitPath)) : defaultDeviceSecretsPath();
        return this.resolved;
    }

    async read(): Promise<DeviceSecrets> {
        const file = await this.filePath();
        let raw: string;
        try {
            raw = await readFile(file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw error;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            // Never echo the file: it holds passcodes.
            throw new Error(`${file} contains invalid JSON (${error instanceof SyntaxError ? 'syntax error' : 'unreadable'})`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object keyed by UDID`);
        const secrets: DeviceSecrets = {};
        for (const [udid, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue;
            const passcode = (value as { passcode?: unknown }).passcode;
            secrets[udid] = typeof passcode === 'string' && passcode ? { passcode } : {};
        }
        return secrets;
    }

    /** Atomic replace, 0600 from the first byte. Entries with nothing in them are dropped. */
    async write(secrets: DeviceSecrets): Promise<void> {
        const compact: DeviceSecrets = {};
        for (const udid of Object.keys(secrets).sort()) {
            const passcode = secrets[udid]?.passcode;
            if (passcode) compact[udid] = { passcode };
        }
        // Through a symlink to the file it names, like devices.json.
        await writePrivateFileAtomic(await this.filePath(), `${JSON.stringify(compact, null, 2)}\n`);
    }
}

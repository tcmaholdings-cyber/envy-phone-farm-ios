import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writePrivateFileAtomic } from './atomic-file.js';

/**
 * The host-local secret store used with the Postgres registry.
 *
 * Device passcodes never enter Postgres (AGENTS.md invariant 4): the shared
 * database only records `has_passcode`. The passcode itself stays in this
 * 0600, git-ignored JSON file on the Mac that owns the phone —
 * `PHONE_FARM_DEVICE_SECRETS_PATH`, default `device-secrets.json`:
 *
 *     { "<udid>": { "passcode": "123456" } }
 */
export interface DeviceSecret {
    passcode?: string;
}

export type DeviceSecrets = Record<string, DeviceSecret>;

export function defaultDeviceSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
    return path.resolve(env.PHONE_FARM_DEVICE_SECRETS_PATH ?? 'device-secrets.json');
}

export class DeviceSecretStore {
    constructor(readonly filePath: string = defaultDeviceSecretsPath()) {}

    async read(): Promise<DeviceSecrets> {
        let raw: string;
        try {
            raw = await readFile(this.filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw error;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            // Never echo the file: it holds passcodes.
            throw new Error(`${this.filePath} contains invalid JSON (${error instanceof SyntaxError ? 'syntax error' : 'unreadable'})`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${this.filePath} must hold a JSON object keyed by UDID`);
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
        // Through a symlink to the file it names, like devices.json (release layout: shared/).
        await writePrivateFileAtomic(this.filePath, `${JSON.stringify(compact, null, 2)}\n`);
    }
}

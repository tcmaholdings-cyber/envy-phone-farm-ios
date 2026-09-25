import os from 'node:os';

/**
 * Which Mac this process runs on, for multi-host farms (docs/multi-host.md).
 *
 * `PHONE_FARM_HOST_ID` names the host; it defaults to `os.hostname()`. Every
 * process on one Mac (web, worker, wda-service, CLI) must agree on it, because
 * it decides which phones are "ours": the worker works only their queues and
 * wda-service supervises only them. Set it explicitly in `.env` — a hostname
 * can change when macOS renames a machine on a network clash.
 */
export const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function localHostId(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.PHONE_FARM_HOST_ID?.trim();
    if (configured) {
        if (!HOST_ID_PATTERN.test(configured)) {
            throw new Error('PHONE_FARM_HOST_ID must be 1-63 characters of letters, digits, ".", "_" or "-", starting with a letter or digit');
        }
        return configured;
    }
    const fallback = os.hostname().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 63);
    return fallback || 'localhost';
}

/** The display name for this host's `fleet.hosts` row (PHONE_FARM_HOST_NAME, default the id). */
export function localHostName(env: NodeJS.ProcessEnv = process.env): string {
    return env.PHONE_FARM_HOST_NAME?.trim().slice(0, 80) || localHostId(env);
}

/** A device with no `hostId` (the devices.json backend) is always local. */
export function isLocalDevice(device: { hostId?: string }, hostId: string = localHostId()): boolean {
    return !device.hostId || device.hostId === hostId;
}

export function localDevices<T extends { hostId?: string }>(devices: readonly T[], hostId: string = localHostId()): T[] {
    return devices.filter((device) => isLocalDevice(device, hostId));
}

import { mkdir, readFile, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { coordinatesForProfile, validateCoordinateOverrides, type DeviceCoordinateOverrides, type DeviceProfileName } from './coordinates.js';
import type { JsonObject } from '../types.js';

export interface RegisteredDevice {
    name: string;
    udid: string;
    coordinateProfile?: DeviceProfileName;
    wdaLocalPort?: number;
    mjpegLocalPort?: number;
    /** Device unlock passcode. Lives here (devices.json is 0600 and git-ignored), never in an API response. */
    passcode?: string;
    /** Per-device single-tap coordinate overrides (dashboard calibration). */
    coordinates?: DeviceCoordinateOverrides;
    /**
     * Where the phone physically sits — free text the operator chooses, e.g. `A3`
     * or `hub 2 · port 7`. Purely a label: nothing resolves it, it exists so that
     * "iPhone 14 is offline" maps to a slot in the rack without unplugging cables.
     */
    rackSlot?: string;
    /**
     * Which rack the phone is in — a short label such as `1`. Access grants can
     * target a whole rack (src/auth/policy.ts), so keep it consistent per rack.
     */
    rack?: string;
    /**
     * Marketing model name, e.g. `iPhone 12 mini`. Filled in automatically from
     * USB discovery the first time the phone is seen connected; grants can target it.
     */
    model?: string;
    /** When true the farm keeps the entry but stops supervising it — no WDA, no worker, no discovery polling. */
    disabled?: boolean;
    pluginData: Record<string, JsonObject>;
}

/** Devices the farm should actively supervise (everything except the disabled ones). */
export function activeDevices(devices: readonly RegisteredDevice[]): RegisteredDevice[] {
    return devices.filter((device) => !device.disabled);
}

export const PASSCODE_PATTERN = /^\d{4,}$/;

/** Long enough for "hub 2 · port 7", short enough to stay on one line in the grid. */
export const RACK_SLOT_MAX_LENGTH = 40;
/** A rack is a short label ("1", "B"), not a location description. */
export const RACK_MAX_LENGTH = 20;
export const MODEL_MAX_LENGTH = 60;

/** Trim and cap an optional label; an empty value removes the field. */
function normalizeLabel<K extends 'rackSlot' | 'rack' | 'model'>(device: RegisteredDevice, key: K, max: number): void {
    const value = device[key];
    if (value === undefined) return;
    const cleaned = String(value).trim().slice(0, max);
    if (cleaned) device[key] = cleaned;
    else delete device[key];
}

/**
 * Model names USB discovery can supply for registered phones that have none.
 * Pure: the caller persists the result (see `backfillDeviceModels`).
 */
export function missingModels(
    devices: readonly RegisteredDevice[],
    connected: ReadonlyArray<{ udid: string; modelName?: string }>,
): Map<string, string> {
    const names = new Map(connected.filter(({ modelName }) => modelName).map(({ udid, modelName }) => [udid, modelName!]));
    const updates = new Map<string, string>();
    for (const device of devices) {
        const name = names.get(device.udid);
        if (!device.model?.trim() && name) updates.set(device.udid, name);
    }
    return updates;
}

/**
 * Record the model of every connected phone that has none yet. Idempotent: a
 * phone that already has a model (including one an admin typed) is left alone.
 * Check `missingModels` against an already-loaded list first, so the steady
 * state costs no write.
 */
export async function backfillDeviceModels(
    connected: ReadonlyArray<{ udid: string; modelName?: string }>,
    registryPath = defaultRegistryPath,
): Promise<Map<string, string>> {
    return mutateRegisteredDevices((devices) => {
        const updates = missingModels(devices, connected);
        for (const device of devices) {
            const model = updates.get(device.udid);
            if (model) device.model = model;
        }
        return updates;
    }, registryPath);
}

/** A device with its passcode removed and a boolean marker in its place — safe to serialize. */
export function redactDevice<T extends { passcode?: string }>(device: T): Omit<T, 'passcode'> & { hasPasscode: boolean } {
    const { passcode, ...rest } = device;
    return { ...rest, hasPasscode: Boolean(passcode) };
}

const defaultRegistryPath = path.resolve(process.env.DEVICES_CONFIG_PATH ?? 'devices.json');

export async function loadRegisteredDevices(registryPath = defaultRegistryPath): Promise<RegisteredDevice[]> {
    let raw: string;
    try {
        raw = await readFile(registryPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    let devices: RegisteredDevice[];
    try {
        devices = JSON.parse(raw) as RegisteredDevice[];
    } catch (error) {
        throw new Error(`${registryPath} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const device of devices) {
        coordinatesForProfile(device.coordinateProfile);
        device.pluginData ??= {};
    }
    return devices;
}

export async function saveRegisteredDevices(devices: RegisteredDevice[], registryPath = defaultRegistryPath): Promise<void> {
    const unique = new Set<string>();
    for (const device of devices) {
        coordinatesForProfile(device.coordinateProfile);
        if (device.passcode !== undefined && !PASSCODE_PATTERN.test(device.passcode)) {
            throw new Error(`Device ${device.udid} passcode must contain at least four digits`);
        }
        if (device.coordinates !== undefined) {
            device.coordinates = validateCoordinateOverrides(device.coordinates, device.coordinateProfile);
            if (Object.keys(device.coordinates).length === 0) delete device.coordinates;
        }
        normalizeLabel(device, 'rackSlot', RACK_SLOT_MAX_LENGTH);
        normalizeLabel(device, 'rack', RACK_MAX_LENGTH);
        normalizeLabel(device, 'model', MODEL_MAX_LENGTH);
        if (device.disabled !== true) delete device.disabled;
        if (unique.has(device.udid)) throw new Error(`Device ${device.udid} is already registered`);
        unique.add(device.udid);
    }
    const target = await writeTarget(registryPath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporaryPath = `${target}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, target);
}

/**
 * The file an atomic save must replace. A release deploy links devices.json to
 * `shared/devices.json`; renaming over the link itself would swap it for a
 * plain file inside that release and the next deploy would lose every change,
 * so resolve the link and replace the file it points at.
 */
async function writeTarget(registryPath: string): Promise<string> {
    try {
        return await realpath(registryPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {  // a dangling link: create the file it names
        const link = await readlink(registryPath);
        return path.resolve(path.dirname(registryPath), link);
    } catch {
        return registryPath;
    }
}

// Every load-modify-save of devices.json in one process must go through here,
// or two overlapping mutations (a passcode save racing a disable toggle) each
// read the same file and the second write clobbers the first.
let registryMutation: Promise<unknown> = Promise.resolve();

export function mutateRegisteredDevices<T>(
    mutate: (devices: RegisteredDevice[]) => T | Promise<T>,
    registryPath = defaultRegistryPath,
): Promise<T> {
    const run = registryMutation.then(async () => {
        const devices = await loadRegisteredDevices(registryPath);
        const result = await mutate(devices);
        await saveRegisteredDevices(devices, registryPath);
        return result;
    });
    registryMutation = run.catch(() => undefined);
    return run;
}

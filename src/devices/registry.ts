import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writePrivateFileAtomic } from './atomic-file.js';
import { coordinatesForProfile, validateCoordinateOverrides, type DeviceCoordinateOverrides, type DeviceProfileName } from './coordinates.js';
import type { JsonObject } from '../types.js';

export interface RegisteredDevice {
    name: string;
    udid: string;
    coordinateProfile?: DeviceProfileName;
    wdaLocalPort?: number;
    mjpegLocalPort?: number;
    /**
     * Device unlock passcode. Lives in devices.json (file backend) or the host's
     * device-secrets.json (Postgres backend) — both 0600 and git-ignored — and
     * never in an API response or in Postgres.
     */
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
    /**
     * The Mac that owns the phone (PHONE_FARM_HOST_ID). Set by the Postgres
     * registry; absent in devices.json, where every phone is local.
     */
    hostId?: string;
    /**
     * Apple Team whose WDA build this phone runs. The supervisor launches
     * `WDA_XCTESTRUN_<TEAM>` (falling back to `WDA_XCTESTRUN`); absent means
     * the host default. See src/devices/wda/runner-args.ts.
     */
    signingTeam?: string;
    /**
     * Read-only marker from the Postgres registry: the owning host holds a
     * passcode for this phone. The value itself never leaves that host.
     */
    passcodeSet?: boolean;
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
/** An Apple Team ID (10 characters) or an operator alias; it becomes an env-var suffix, so letters, digits and `_` only. */
export const SIGNING_TEAM_PATTERN = /^[A-Z0-9_]{1,40}$/;

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
    registryPath?: string,
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
export function redactDevice<T extends { passcode?: string; passcodeSet?: boolean }>(
    device: T,
): Omit<T, 'passcode' | 'passcodeSet'> & { hasPasscode: boolean } {
    const { passcode, passcodeSet, ...rest } = device;
    return { ...rest, hasPasscode: Boolean(passcode) || passcodeSet === true };
}

/**
 * Validate and canonicalise a device list in place — the rules every backend
 * enforces before it writes: known coordinate profile, 4+ digit passcode,
 * valid overrides, trimmed labels, a signing-team token, sane ports, unique UDIDs.
 */
export function normalizeDevices(devices: RegisteredDevice[]): void {
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
        if (device.signingTeam !== undefined) {
            const team = String(device.signingTeam).trim().toUpperCase();
            if (!team) delete device.signingTeam;
            else if (!SIGNING_TEAM_PATTERN.test(team)) {
                throw new Error(`Device ${device.udid} signing team must be letters, digits or "_" (at most 40), e.g. an Apple Team ID`);
            } else device.signingTeam = team;
        }
        for (const key of ['wdaLocalPort', 'mjpegLocalPort'] as const) {
            const port = device[key];
            if (port !== undefined && !(Number.isSafeInteger(port) && port >= 1 && port <= 65535)) {
                throw new Error(`Device ${device.udid} ${key} must be a port number between 1 and 65535`);
            }
        }
        // Derived by the Postgres registry on read; never stored.
        delete device.passcodeSet;
        if (device.disabled !== true) delete device.disabled;
        if (unique.has(device.udid)) throw new Error(`Device ${device.udid} is already registered`);
        unique.add(device.udid);
    }
}

/**
 * Where registered phones live. `file` is devices.json on this host (the
 * default); `postgres` is `fleet.devices`, shared by every host
 * (src/devices/registry-pg.ts, docs/multi-host.md).
 */
export interface DeviceRegistryBackend {
    readonly kind: 'file' | 'postgres';
    /** Every registered phone. With Postgres that is every host's; passcodes only for this host's. */
    load(): Promise<RegisteredDevice[]>;
    /** Load → mutate → validate → persist as one atomic step. */
    mutate<T>(mutate: (devices: RegisteredDevice[]) => T | Promise<T>): Promise<T>;
    close?(): Promise<void>;
}

export type RegistryKind = DeviceRegistryBackend['kind'];

/** `PHONE_FARM_REGISTRY`: `file` (default) or `postgres`. Anything else is a configuration error, not a silent fallback. */
export function registryKind(env: NodeJS.ProcessEnv = process.env): RegistryKind {
    const value = (env.PHONE_FARM_REGISTRY ?? '').trim().toLowerCase();
    if (!value || value === 'file') return 'file';
    if (value === 'postgres') return 'postgres';
    throw new Error(`PHONE_FARM_REGISTRY must be "file" or "postgres", not "${env.PHONE_FARM_REGISTRY}"`);
}

const defaultRegistryPath = path.resolve(process.env.DEVICES_CONFIG_PATH ?? 'devices.json');

async function readDevicesFile(registryPath: string): Promise<RegisteredDevice[]> {
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

async function writeDevicesFile(devices: RegisteredDevice[], registryPath: string): Promise<void> {
    normalizeDevices(devices);
    // Through a symlink to the file it names (release layout: shared/devices.json).
    await writePrivateFileAtomic(registryPath, `${JSON.stringify(devices, null, 2)}\n`);
}

// Every load-modify-save of devices.json in one process must go through here,
// or two overlapping mutations (a passcode save racing a disable toggle) each
// read the same file and the second write clobbers the first. The Postgres
// backend replaces this with a transaction and row locks, which also hold
// across processes and hosts.
let registryMutation: Promise<unknown> = Promise.resolve();

export function fileDeviceRegistry(registryPath: string = defaultRegistryPath): DeviceRegistryBackend {
    return {
        kind: 'file',
        load: () => readDevicesFile(registryPath),
        mutate<T>(mutate: (devices: RegisteredDevice[]) => T | Promise<T>): Promise<T> {
            const run = registryMutation.then(async () => {
                const devices = await readDevicesFile(registryPath);
                const result = await mutate(devices);
                await writeDevicesFile(devices, registryPath);
                return result;
            });
            registryMutation = run.catch(() => undefined);
            return run;
        },
    };
}

let configured: Promise<DeviceRegistryBackend> | undefined;

/** The process-wide registry chosen by PHONE_FARM_REGISTRY, created on first use. */
export function deviceRegistry(): Promise<DeviceRegistryBackend> {
    if (!configured) {
        const creating = (async (): Promise<DeviceRegistryBackend> => {
            if (registryKind() === 'file') return fileDeviceRegistry();
            // Imported lazily: the file backend (and every test using it) never loads pg.
            const { createPostgresDeviceRegistry } = await import('./registry-pg.js');
            return createPostgresDeviceRegistry();
        })();
        configured = creating;
        // A failed start (bad env, no DATABASE_URL) is retried on the next call rather than cached.
        creating.catch(() => { if (configured === creating) configured = undefined; });
    }
    return configured;
}

/** Replace the process-wide registry (tests, embedders). `undefined` goes back to PHONE_FARM_REGISTRY. */
export function setDeviceRegistry(backend: DeviceRegistryBackend | undefined): void {
    configured = backend ? Promise.resolve(backend) : undefined;
}

/** Release the registry's database pool, if it opened one. Safe to call when nothing was opened. */
export async function closeDeviceRegistry(): Promise<void> {
    const current = configured;
    configured = undefined;
    if (!current) return;
    try {
        await (await current).close?.();
    } catch { /* it never opened */ }
}

const backendFor = (registryPath?: string) => (registryPath ? Promise.resolve(fileDeviceRegistry(registryPath)) : deviceRegistry());

/** Every registered device. An explicit `registryPath` always means that devices.json file. */
export async function loadRegisteredDevices(registryPath?: string): Promise<RegisteredDevice[]> {
    return (await backendFor(registryPath)).load();
}

/** Replace the whole registry with `devices`. Prefer `mutateRegisteredDevices`, which cannot lose a concurrent change. */
export async function saveRegisteredDevices(devices: RegisteredDevice[], registryPath?: string): Promise<void> {
    await (await backendFor(registryPath)).mutate((current) => {
        current.splice(0, current.length, ...devices);
    });
}

/** Load → mutate → save atomically: in-process lock for devices.json, a transaction with row locks for Postgres. */
export async function mutateRegisteredDevices<T>(
    mutate: (devices: RegisteredDevice[]) => T | Promise<T>,
    registryPath?: string,
): Promise<T> {
    return (await backendFor(registryPath)).mutate(mutate);
}

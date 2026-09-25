import { createRequire } from 'node:module';

import { modelNameForProductType } from './coordinates.js';

const require = createRequire(import.meta.url);
interface IosUtilities {
    getConnectedDevices(): Promise<string[]>;
    getDeviceName(udid: string): Promise<string>;
    getOSVersion(udid: string): Promise<string>;
    getDeviceInfo(udid: string): Promise<{ ProductType?: string; HardwareModel?: string }>;
}
const { utilities } = require('appium-ios-device') as { utilities: IosUtilities };

export interface Device {
    name: string;
    osVersion: string;
    udid: string;
    productType?: string;
    hardwareModel?: string;
    modelName?: string;
}

export async function discoverConnectedDevices(): Promise<Device[]> {
    const udids = await discoverConnectedDeviceUdids();
    return Promise.all(udids.map(async (udid) => {
        const [name, osVersion, info] = await Promise.all([
            utilities.getDeviceName(udid), utilities.getOSVersion(udid), utilities.getDeviceInfo(udid),
        ]);
        const modelName = modelNameForProductType(info.ProductType);
        return {
            name, osVersion, udid,
            ...(info.ProductType ? { productType: info.ProductType } : {}),
            ...(info.HardwareModel ? { hardwareModel: info.HardwareModel } : {}),
            ...(modelName ? { modelName } : {}),
        };
    }));
}

export async function discoverConnectedDeviceUdids(): Promise<string[]> {
    return utilities.getConnectedDevices();
}

export const DEFAULT_DISCOVERY_TTL_MS = 2_000;

function configuredTtlMs(): number {
    const configured = Number(process.env.PHONE_FARM_DISCOVERY_TTL_MS);
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_DISCOVERY_TTL_MS;
}

export interface SharedSweep<T> {
    get(maxAgeMs?: number): Promise<T>;
    forget(): void;
}

// A full sweep costs three lockdown round trips per attached phone, and the
// dashboard grid, the WDA supervisor and every /api/devices caller each used to
// run their own. At twenty phones on one hub that is sixty round trips over a
// single USB tree every couple of seconds. Callers now share one sweep:
// concurrent callers join the in-flight run, and a result younger than
// `maxAgeMs` is served from memory. Pass 0 when only the truth will do.
export function createSharedSweep<T>(run: () => Promise<T>): SharedSweep<T> {
    let cached: { at: number; value: T } | undefined;
    let inFlight: Promise<T> | undefined;
    return {
        get(maxAgeMs = configuredTtlMs()) {
            if (cached && maxAgeMs > 0 && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached.value);
            if (!inFlight) {
                const pending: Promise<T> = run()
                    .then((value) => {
                        cached = { at: Date.now(), value };
                        return value;
                    })
                    .finally(() => {
                        if (inFlight === pending) inFlight = undefined;
                    });
                inFlight = pending;
            }
            return inFlight;
        },
        forget() {
            cached = undefined;
        },
    };
}

const deviceSweep = createSharedSweep(discoverConnectedDevices);
const udidSweep = createSharedSweep(discoverConnectedDeviceUdids);

/** Connected devices from the shared sweep. `maxAgeMs` of 0 forces a fresh usbmux read. */
export function connectedDevices(maxAgeMs?: number): Promise<Device[]> {
    return deviceSweep.get(maxAgeMs);
}

/** Connected UDIDs from the shared sweep. `maxAgeMs` of 0 forces a fresh usbmux read. */
export function connectedDeviceUdids(maxAgeMs?: number): Promise<string[]> {
    return udidSweep.get(maxAgeMs);
}

/** Drop both cached sweeps — the next read goes to usbmux. */
export function forgetConnectedDevices(): void {
    deviceSweep.forget();
    udidSweep.forget();
}

import { normalizeDevices, type DeviceRegistryBackend, type RegisteredDevice } from './registry.js';
import { assertPortsUniquePerHost } from './registry-pg.js';

export interface ImportResult {
    inserted: string[];
    updated: string[];
    unchanged: string[];
    /** Phones already in Postgres under another host: left alone. */
    skipped: Array<{ udid: string; reason: string }>;
}

/**
 * Copy this host's devices.json entries into the shared Postgres registry,
 * owned by `hostId`. Idempotent: a second run changes nothing. Passcodes go to
 * the host's local secret file (the Postgres backend never writes them to the
 * database). A phone that another host already owns is skipped, not stolen.
 *
 * A phone with no explicit ports keeps the ones it effectively used before
 * (WDA_LOCAL_PORT / MJPEG_LOCAL_PORT, default 8100 / 9100), so the forwards do
 * not move under a running farm. Two such phones on one host were already
 * colliding; the import then fails with both UDIDs named and writes nothing.
 */
export async function importDevicesToRegistry(
    fileDevices: readonly RegisteredDevice[],
    target: DeviceRegistryBackend,
    hostId: string,
    { dryRun = false, env = process.env }: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ImportResult> {
    const result: ImportResult = { inserted: [], updated: [], unchanged: [], skipped: [] };
    const defaultWda = Number(env.WDA_LOCAL_PORT ?? 8100);
    const defaultMjpeg = Number(env.MJPEG_LOCAL_PORT ?? 9100);
    const stable = (device: RegisteredDevice) => JSON.stringify(Object.entries(device).filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)));
    const abortDryRun = new Error('dry run');
    try {
        await target.mutate((devices) => {
            for (const source of fileDevices) {
                const incoming: RegisteredDevice = {
                    ...structuredClone(source),
                    hostId,
                    pluginData: structuredClone(source.pluginData ?? {}),
                    wdaLocalPort: source.wdaLocalPort ?? defaultWda,
                    mjpegLocalPort: source.mjpegLocalPort ?? defaultMjpeg,
                };
                // Canonical form first (trimmed labels, upper-case team), so a re-run compares equal.
                normalizeDevices([incoming]);
                const index = devices.findIndex(({ udid }) => udid === source.udid);
                if (index < 0) {
                    devices.push(incoming);
                    result.inserted.push(source.udid);
                    continue;
                }
                const existing = devices[index]!;
                if (existing.hostId && existing.hostId !== hostId) {
                    result.skipped.push({ udid: source.udid, reason: `owned by host ${existing.hostId}` });
                    continue;
                }
                if (stable(existing) === stable(incoming)) {
                    result.unchanged.push(source.udid);
                    continue;
                }
                devices[index] = incoming;
                result.updated.push(source.udid);
            }
            if (dryRun) {
                // Run the checks the commit would (profiles, passcodes, per-host ports), then roll back.
                const preview = structuredClone(devices);
                normalizeDevices(preview);
                assertPortsUniquePerHost(preview, (device) => device.hostId ?? hostId);
                throw abortDryRun;
            }
        });
    } catch (error) {
        if (error !== abortDryRun) throw error;
    }
    return result;
}

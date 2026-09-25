import { Pool } from 'pg';

import { databaseUrl } from '../database/client.js';
import { DeviceSecretStore, type DeviceSecrets } from './device-secrets.js';
import { localHostId, localHostName } from './host-identity.js';
import { normalizeDevices, type DeviceRegistryBackend, type RegisteredDevice } from './registry.js';

/**
 * The shared device registry: `fleet.devices` in Postgres (migration 0005),
 * selected with PHONE_FARM_REGISTRY=postgres. Every host sees every phone; each
 * phone belongs to one host (`host_id`). Mutations run in one transaction under
 * an advisory lock plus `SELECT … FOR UPDATE`, which replaces the file
 * backend's in-process lock and also holds across processes and Macs.
 *
 * Passcodes never reach the database. For this host's phones they are read
 * from and written to the host's DeviceSecretStore (a 0600 file); Postgres only
 * records `has_passcode`, which the dashboard shows for other hosts' phones.
 */

/** The slice of a pg client/pool this module uses, so tests can pass a fake. */
export interface SqlClient {
    query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
export interface SqlPool extends SqlClient {
    connect(): Promise<SqlClient & { release(error?: Error | boolean): void }>;
    end(): Promise<void>;
}

export interface DeviceRow {
    udid: string;
    host_id: string;
    name: string;
    coordinate_profile: string | null;
    wda_local_port: number;
    mjpeg_local_port: number;
    rack: string | null;
    rack_slot: string | null;
    model: string | null;
    disabled: boolean;
    coordinates: Record<string, unknown> | null;
    plugin_data: Record<string, unknown> | null;
    signing_team: string | null;
    has_passcode: boolean;
}

const COLUMNS = [
    'udid', 'host_id', 'name', 'coordinate_profile', 'wda_local_port', 'mjpeg_local_port', 'rack', 'rack_slot',
    'model', 'disabled', 'coordinates', 'plugin_data', 'signing_team', 'has_passcode',
] as const;

export const SELECT_DEVICES_SQL = `select ${COLUMNS.join(', ')} from fleet.devices order by created_at, udid`;
export const INSERT_DEVICE_SQL = `insert into fleet.devices (${COLUMNS.join(', ')})
values (${COLUMNS.map((_column, index) => `$${index + 1}`).join(', ')})`;
export const UPDATE_DEVICE_SQL = `update fleet.devices set ${COLUMNS.slice(1).map((column, index) => `${column} = $${index + 2}`).join(', ')}, updated_at = now()
where udid = $1`;
export const DELETE_DEVICE_SQL = 'delete from fleet.devices where udid = $1';
/** A host row must exist before its first phone (foreign key); never overwrite what the lease maintains. */
export const ENSURE_HOST_SQL = `insert into fleet.hosts (id, display_name) values ($1, $2) on conflict (id) do nothing`;
export const REGISTRY_LOCK_SQL = `select pg_advisory_xact_lock(hashtext('phone-farm:fleet.devices'))`;

export const DEFAULT_WDA_PORT = 8100;
export const DEFAULT_MJPEG_PORT = 9100;

export function rowToDevice(row: DeviceRow, hostId: string, secrets: DeviceSecrets): RegisteredDevice {
    const device: RegisteredDevice = {
        name: row.name,
        udid: row.udid,
        hostId: row.host_id,
        wdaLocalPort: row.wda_local_port,
        mjpegLocalPort: row.mjpeg_local_port,
        pluginData: (row.plugin_data ?? {}) as RegisteredDevice['pluginData'],
    };
    if (row.coordinate_profile) device.coordinateProfile = row.coordinate_profile as RegisteredDevice['coordinateProfile'];
    if (row.rack) device.rack = row.rack;
    if (row.rack_slot) device.rackSlot = row.rack_slot;
    if (row.model) device.model = row.model;
    if (row.disabled) device.disabled = true;
    if (row.coordinates && Object.keys(row.coordinates).length) device.coordinates = row.coordinates as RegisteredDevice['coordinates'];
    if (row.signing_team) device.signingTeam = row.signing_team;
    if (row.host_id === hostId) {
        const passcode = secrets[row.udid]?.passcode;
        if (passcode) device.passcode = passcode;
    } else if (row.has_passcode) {
        device.passcodeSet = true;
    }
    return device;
}

/** Positional values for INSERT/UPDATE_DEVICE_SQL. jsonb goes as JSON text. */
export function deviceValues(device: RegisteredDevice, hostId: string, hasPasscode: boolean): unknown[] {
    return [
        device.udid, hostId, device.name, device.coordinateProfile ?? null,
        device.wdaLocalPort, device.mjpegLocalPort, device.rack ?? null, device.rackSlot ?? null, device.model ?? null,
        device.disabled === true, device.coordinates ? JSON.stringify(device.coordinates) : null,
        JSON.stringify(device.pluginData ?? {}), device.signingTeam ?? null, hasPasscode,
    ];
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode });
}

/**
 * Give every phone without ports the lowest free WDA/MJPEG pair on its host
 * (8100/9100, 8101/9101, …). Ports only have to be unique per host: two Macs
 * can each forward a phone to :8100.
 */
export function assignMissingPorts(devices: RegisteredDevice[], hostOf: (device: RegisteredDevice) => string): void {
    const used = new Map<string, Set<number>>();
    const usedOn = (host: string) => {
        let set = used.get(host);
        if (!set) used.set(host, set = new Set());
        return set;
    };
    for (const device of devices) {
        const set = usedOn(hostOf(device));
        if (device.wdaLocalPort !== undefined) set.add(device.wdaLocalPort);
        if (device.mjpegLocalPort !== undefined) set.add(device.mjpegLocalPort);
    }
    for (const device of devices) {
        if (device.wdaLocalPort !== undefined && device.mjpegLocalPort !== undefined) continue;
        const set = usedOn(hostOf(device));
        for (let offset = 0; offset < 1_000; offset += 1) {
            const wda = device.wdaLocalPort ?? DEFAULT_WDA_PORT + offset;
            const mjpeg = device.mjpegLocalPort ?? DEFAULT_MJPEG_PORT + offset;
            const wdaFree = device.wdaLocalPort !== undefined || !set.has(wda);
            const mjpegFree = device.mjpegLocalPort !== undefined || !set.has(mjpeg);
            if (wdaFree && mjpegFree) {
                device.wdaLocalPort = wda;
                device.mjpegLocalPort = mjpeg;
                set.add(wda);
                set.add(mjpeg);
                break;
            }
        }
        if (device.wdaLocalPort === undefined || device.mjpegLocalPort === undefined) {
            throw httpError(409, `No free WDA/MJPEG port pair left on host ${hostOf(device)}`);
        }
    }
}

/** Refuse two phones on one host sharing a forwarded port, before Postgres does it less legibly. */
export function assertPortsUniquePerHost(devices: readonly RegisteredDevice[], hostOf: (device: RegisteredDevice) => string): void {
    const seen = new Map<string, string>();
    for (const device of devices) {
        for (const port of [device.wdaLocalPort, device.mjpegLocalPort]) {
            if (port === undefined) continue;
            const key = `${hostOf(device)}\u0000${port}`;
            const other = seen.get(key);
            if (other && other !== device.udid) {
                throw httpError(409, `Port ${port} is used by both ${other} and ${device.udid} on host ${hostOf(device)}`);
            }
            seen.set(key, device.udid);
        }
    }
}

export interface DeviceWritePlan {
    deletes: string[];
    inserts: unknown[][];
    updates: unknown[][];
    /** Hosts that need a fleet.hosts row before the inserts (only ever this host). */
    ensureHosts: string[];
    /** The secret file's next content, or null when it does not change. */
    secrets: DeviceSecrets | null;
}

/**
 * The SQL a mutation needs: what was deleted, inserted or changed between the
 * locked snapshot and the mutated list. Pure, so the rules are testable
 * without Postgres. Passcodes only move for this host's phones.
 */
export function planDeviceWrites(
    before: readonly RegisteredDevice[],
    after: readonly RegisteredDevice[],
    hostId: string,
    currentSecrets: DeviceSecrets,
): DeviceWritePlan {
    const previous = new Map(before.map((device) => [device.udid, device]));
    const next = new Set(after.map(({ udid }) => udid));
    const hostOf = (device: RegisteredDevice) => device.hostId ?? hostId;
    const plan: DeviceWritePlan = { deletes: [], inserts: [], updates: [], ensureHosts: [], secrets: null };
    const secrets: DeviceSecrets = structuredClone(currentSecrets);
    let secretsChanged = false;
    const setSecret = (udid: string, passcode: string | undefined) => {
        if ((secrets[udid]?.passcode ?? undefined) === passcode) return;
        if (passcode) secrets[udid] = { passcode };
        else delete secrets[udid];
        secretsChanged = true;
    };

    for (const device of before) {
        if (next.has(device.udid)) continue;
        plan.deletes.push(device.udid);
        if (hostOf(device) === hostId) setSecret(device.udid, undefined);
    }
    for (const device of after) {
        const host = hostOf(device);
        const old = previous.get(device.udid);
        const local = host === hostId;
        if (!local && device.passcode !== undefined) {
            throw httpError(409, `Device ${device.udid} belongs to host ${host}; set its passcode on that host`);
        }
        if (local) setSecret(device.udid, device.passcode);
        const hasPasscode = local ? Boolean(device.passcode) : Boolean(old?.passcodeSet);
        const values = deviceValues(device, host, hasPasscode);
        if (!old) {
            if (local && !plan.ensureHosts.includes(host)) plan.ensureHosts.push(host);
            plan.inserts.push(values);
            continue;
        }
        const oldHost = hostOf(old);
        const oldValues = deviceValues(old, oldHost, oldHost === hostId ? Boolean(old.passcode) : Boolean(old.passcodeSet));
        if (JSON.stringify(values) !== JSON.stringify(oldValues)) plan.updates.push(values);
    }
    if (secretsChanged) plan.secrets = secrets;
    return plan;
}

function translateError(error: unknown): unknown {
    const failure = error as { code?: string; constraint?: string; message?: string };
    if (failure?.code === '42P01' || failure?.code === '3F000') {
        return new Error('The fleet tables are missing; run npm run db:migrate (migration 0005) before PHONE_FARM_REGISTRY=postgres');
    }
    if (failure?.code === '23505' && failure.constraint?.includes('port')) {
        return httpError(409, 'That port is already used by another phone on the same host');
    }
    if (failure?.code === '23505') return httpError(409, 'A device with this UDID is already registered');
    if (failure?.code === '23503') return httpError(409, 'The device names a host that is not in fleet.hosts');
    return error;
}

export interface PostgresDeviceRegistryOptions {
    pool: SqlPool;
    hostId?: string;
    hostName?: string;
    secrets?: DeviceSecretStore;
    /** How long a read is reused (default 2 s). Every mutation in this process invalidates it. */
    cacheMs?: number;
    now?: () => number;
}

export class PostgresDeviceRegistry implements DeviceRegistryBackend {
    readonly kind = 'postgres' as const;
    readonly hostId: string;
    private readonly hostName: string;
    private readonly pool: SqlPool;
    private readonly secrets: DeviceSecretStore;
    private readonly cacheMs: number;
    private readonly now: () => number;
    private cache?: { at: number; devices: Promise<RegisteredDevice[]> };

    constructor(options: PostgresDeviceRegistryOptions) {
        this.pool = options.pool;
        this.hostId = options.hostId ?? localHostId();
        this.hostName = options.hostName ?? localHostName();
        this.secrets = options.secrets ?? new DeviceSecretStore();
        this.cacheMs = options.cacheMs ?? 2_000;
        this.now = options.now ?? Date.now;
    }

    async load(): Promise<RegisteredDevice[]> {
        const now = this.now();
        if (!this.cache || now - this.cache.at >= this.cacheMs) {
            const devices = this.read(this.pool);
            this.cache = { at: now, devices };
            devices.catch(() => { if (this.cache?.devices === devices) this.cache = undefined; });
        }
        return structuredClone(await this.cache.devices);
    }

    private async read(client: SqlClient, lock = false, secrets?: DeviceSecrets): Promise<RegisteredDevice[]> {
        try {
            const [{ rows }, stored] = await Promise.all([
                client.query<DeviceRow>(lock ? `${SELECT_DEVICES_SQL} for update` : SELECT_DEVICES_SQL),
                secrets ? Promise.resolve(secrets) : this.secrets.read(),
            ]);
            return rows.map((row) => rowToDevice(row, this.hostId, stored));
        } catch (error) {
            throw translateError(error);
        }
    }

    async mutate<T>(mutate: (devices: RegisteredDevice[]) => T | Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        let failed: unknown;
        try {
            await client.query('begin');
            await client.query(REGISTRY_LOCK_SQL);
            const secrets = await this.secrets.read();
            const before = await this.read(client, true, secrets);
            const working = structuredClone(before);
            const result = await mutate(working);
            normalizeDevices(working);
            const hostOf = (device: RegisteredDevice) => device.hostId ?? this.hostId;
            assignMissingPorts(working, hostOf);
            assertPortsUniquePerHost(working, hostOf);
            const plan = planDeviceWrites(before, working, this.hostId, secrets);
            for (const host of plan.ensureHosts) await client.query(ENSURE_HOST_SQL, [host, host === this.hostId ? this.hostName : host]);
            for (const udid of plan.deletes) await client.query(DELETE_DEVICE_SQL, [udid]);
            for (const values of plan.updates) await client.query(UPDATE_DEVICE_SQL, values);
            for (const values of plan.inserts) await client.query(INSERT_DEVICE_SQL, values);
            // The secret file is written inside the transaction: if it cannot be
            // written, nothing is committed. A commit failing after it leaves a
            // passcode on disk for a change Postgres never saw, which the next
            // save of that phone corrects; the local file stays authoritative.
            if (plan.secrets) await this.secrets.write(plan.secrets);
            await client.query('commit');
            this.cache = undefined;
            return result;
        } catch (error) {
            failed = error;
            await client.query('rollback').catch(() => undefined);
            throw translateError(error);
        } finally {
            client.release(failed instanceof Error && !(failed as { statusCode?: number }).statusCode ? failed : undefined);
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

/** The registry for PHONE_FARM_REGISTRY=postgres: its own small pool on DATABASE_URL. */
export function createPostgresDeviceRegistry(env: NodeJS.ProcessEnv = process.env): PostgresDeviceRegistry {
    const pool = new Pool({
        connectionString: databaseUrl(),
        max: Number(env.PHONE_FARM_REGISTRY_POOL_SIZE ?? 3),
        // Idle registry connections must not keep a finished CLI or a drained worker alive.
        allowExitOnIdle: true,
    });
    pool.on('error', (error) => console.error(`Device registry pool: ${error.message}`));
    const cacheMs = Number(env.PHONE_FARM_REGISTRY_CACHE_MS);
    return new PostgresDeviceRegistry({
        pool: pool as unknown as SqlPool,
        ...(Number.isFinite(cacheMs) && cacheMs >= 0 && env.PHONE_FARM_REGISTRY_CACHE_MS !== undefined ? { cacheMs } : {}),
    });
}

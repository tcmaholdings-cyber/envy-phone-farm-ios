import {
    DELETE_DEVICE_SQL, ENSURE_HOST_SQL, INSERT_DEVICE_SQL, REGISTRY_LOCK_SQL, SELECT_DEVICES_SQL, UPDATE_DEVICE_SQL,
    type DeviceRow, type SqlPool,
} from '../src/devices/registry-pg.js';

const COLUMNS = [
    'udid', 'host_id', 'name', 'coordinate_profile', 'wda_local_port', 'mjpeg_local_port', 'rack', 'rack_slot',
    'model', 'disabled', 'coordinates', 'plugin_data', 'signing_team', 'has_passcode',
] as const;

function pgError(code: string, message: string, constraint?: string): Error {
    return Object.assign(new Error(message), { code, constraint });
}

/**
 * An in-memory stand-in for fleet.hosts / fleet.devices that understands exactly
 * the statements src/devices/registry-pg.ts sends, with the constraints of
 * migration 0005 (udid primary key, per-host unique ports, host foreign key)
 * and transaction rollback. Every statement and its values is recorded so tests
 * can assert what reached "the database" — e.g. that no passcode ever did.
 */
export class FakeFleetDb {
    hosts = new Map<string, { id: string; display_name: string }>();
    devices: DeviceRow[] = [];
    statements: Array<{ text: string; values: unknown[] }> = [];
    /** Fail the Nth write statement (1-based) inside a transaction, to test rollback. */
    failWriteAt: number | undefined;
    private writes = 0;
    private snapshot: { hosts: Map<string, { id: string; display_name: string }>; devices: DeviceRow[] } | undefined;
    private lockHeld: Promise<void> = Promise.resolve();
    ended = false;

    addHost(id: string): void {
        this.hosts.set(id, { id, display_name: id });
    }

    addDevice(row: Partial<DeviceRow> & { udid: string; host_id: string }): void {
        if (!this.hosts.has(row.host_id)) this.addHost(row.host_id);
        this.devices.push({
            name: row.udid, coordinate_profile: null, wda_local_port: 8100, mjpeg_local_port: 9100, rack: null,
            rack_slot: null, model: null, disabled: false, coordinates: null, plugin_data: {}, signing_team: null,
            has_passcode: false, ...row,
        });
    }

    private rowFrom(values: unknown[]): DeviceRow {
        const row = Object.fromEntries(COLUMNS.map((column, index) => [column, values[index]])) as Record<string, unknown>;
        for (const column of ['coordinates', 'plugin_data'] as const) {
            if (typeof row[column] === 'string') row[column] = JSON.parse(row[column] as string);
        }
        return row as unknown as DeviceRow;
    }

    private checkConstraints(): void {
        const seen = new Set<string>();
        for (const row of this.devices) {
            if (!this.hosts.has(row.host_id)) throw pgError('23503', 'fk violation', 'devices_host_id_hosts_id_fk');
            for (const [port, constraint] of [[row.wda_local_port, 'devices_host_wda_port_idx'], [row.mjpeg_local_port, 'devices_host_mjpeg_port_idx']] as const) {
                const key = `${constraint}:${row.host_id}:${port}`;
                if (seen.has(key)) throw pgError('23505', 'duplicate key', constraint);
                seen.add(key);
            }
        }
    }

    private async execute(text: string, values: unknown[] = []): Promise<{ rows: object[] }> {
        this.statements.push({ text, values });
        const normalized = text.trim();
        if (normalized === 'begin') {
            this.snapshot = { hosts: new Map(this.hosts), devices: structuredClone(this.devices) };
            this.writes = 0;
            return { rows: [] };
        }
        if (normalized === 'commit') { this.snapshot = undefined; return { rows: [] }; }
        if (normalized === 'rollback') {
            if (this.snapshot) { this.hosts = this.snapshot.hosts; this.devices = this.snapshot.devices; }
            this.snapshot = undefined;
            return { rows: [] };
        }
        if (normalized === REGISTRY_LOCK_SQL) return { rows: [] };
        if (normalized === SELECT_DEVICES_SQL || normalized === `${SELECT_DEVICES_SQL} for update`) {
            return { rows: structuredClone(this.devices) };
        }
        this.writes += 1;
        if (this.failWriteAt !== undefined && this.writes === this.failWriteAt) throw new Error('injected write failure');
        if (normalized === ENSURE_HOST_SQL) {
            const [id, name] = values as [string, string];
            if (!this.hosts.has(id)) this.hosts.set(id, { id, display_name: name });
            return { rows: [] };
        }
        if (normalized === DELETE_DEVICE_SQL) {
            this.devices = this.devices.filter(({ udid }) => udid !== values[0]);
            return { rows: [] };
        }
        if (normalized === INSERT_DEVICE_SQL) {
            const row = this.rowFrom(values);
            if (this.devices.some(({ udid }) => udid === row.udid)) throw pgError('23505', 'duplicate key', 'devices_pkey');
            this.devices.push(row);
            this.checkConstraints();
            return { rows: [] };
        }
        if (normalized === UPDATE_DEVICE_SQL) {
            const row = this.rowFrom(values);
            const index = this.devices.findIndex(({ udid }) => udid === row.udid);
            if (index >= 0) this.devices[index] = row;
            this.checkConstraints();
            return { rows: [] };
        }
        throw new Error(`FakeFleetDb does not understand: ${normalized.slice(0, 80)}`);
    }

    pool(): SqlPool {
        return {
            query: async (text: string, values?: unknown[]) => this.execute(text, values) as never,
            connect: async () => {
                // One connection at a time holds the "advisory lock" for its whole transaction.
                let release!: () => void;
                const previous = this.lockHeld;
                this.lockHeld = new Promise<void>((resolve) => { release = resolve; });
                await previous;
                return {
                    query: async (text: string, values?: unknown[]) => this.execute(text, values) as never,
                    release: () => release(),
                };
            },
            end: async () => { this.ended = true; },
        };
    }

    /** Every value any statement ever carried, flattened to strings. */
    allValues(): string[] {
        return this.statements.flatMap(({ values }) => values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))));
    }
}

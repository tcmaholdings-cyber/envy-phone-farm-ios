import os from 'node:os';

/** The slice of `pg.Pool` the heartbeat needs, so tests can pass a fake. */
export interface Queryable {
    query<Row extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface WorkerHeartbeat {
    /** Write one beat now. */
    beat(): Promise<void>;
    /** Stop beating; the row is left to go stale so an outage stays visible. */
    stop(): Promise<void>;
}

export interface WorkerHeartbeatOptions {
    intervalMs?: number;
    host?: string;
    pid?: number;
    startedAt?: Date;
}

/**
 * Upserts this host's row in `scheduler.worker_heartbeats` every ~15 s with
 * the pid, start time and number of device queues the worker is subscribed
 * to. The timestamp is the database's `now()`, so readers compare it against
 * the same clock and host clock skew cannot fake freshness.
 */
export function startWorkerHeartbeat(
    pool: Queryable,
    queues: () => number,
    options: WorkerHeartbeatOptions = {},
): WorkerHeartbeat {
    const host = options.host ?? os.hostname();
    const pid = options.pid ?? process.pid;
    const startedAt = options.startedAt ?? new Date();
    return startPeriodicBeat('Worker heartbeat', options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, async () => {
        await pool.query(
            `insert into scheduler.worker_heartbeats (host, pid, started_at, beat_at, queues)
             values ($1, $2, $3, now(), $4)
             on conflict (host) do update
             set pid = excluded.pid, started_at = excluded.started_at, beat_at = excluded.beat_at, queues = excluded.queues`,
            [host, pid, startedAt, queues()],
        );
    });
}

/**
 * Run `write` now and every `intervalMs` (unref'd), never throwing: a failure
 * is logged once per distinct message. Shared by the worker heartbeat and the
 * host lease (src/hosts/lease.ts).
 */
export function startPeriodicBeat(label: string, intervalMs: number, write: () => Promise<void>): WorkerHeartbeat {
    let lastError = '';
    let inFlight: Promise<void> = Promise.resolve();
    const beat = async (): Promise<void> => {
        try {
            await write();
            lastError = '';
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message !== lastError) console.error(`${label} failed: ${message}`);
            lastError = message;
        }
    };
    const tick = () => { inFlight = beat(); };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return {
        beat: () => { tick(); return inFlight; },
        async stop() {
            clearInterval(timer);
            await inFlight;
        },
    };
}

export interface WorkerHeartbeatRow {
    host: string;
    pid: number;
    startedAt: Date;
    queues: number;
    ageSeconds: number;
}

/** Every host's heartbeat, freshest first, with its age by the database clock. */
export async function readWorkerHeartbeats(pool: Queryable): Promise<WorkerHeartbeatRow[]> {
    const result = await pool.query<{ host: string; pid: number; started_at: Date; queues: number; age_seconds: string | number }>(
        `select host, pid, started_at, queues, extract(epoch from (now() - beat_at)) as age_seconds
         from scheduler.worker_heartbeats order by beat_at desc`,
    );
    return result.rows.map((row) => ({
        host: row.host,
        pid: row.pid,
        startedAt: row.started_at,
        queues: row.queues,
        ageSeconds: Math.max(0, Number(row.age_seconds)),
    }));
}

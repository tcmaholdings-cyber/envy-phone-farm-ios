import { Pool } from 'pg';

import { requestWdaService } from '../devices/wda-service-client.js';
import { readWorkerHeartbeats, type Queryable, type WorkerHeartbeatRow } from './heartbeat.js';

export interface QueueStat {
    queue: string;
    /** created/retry jobs whose start time has come. */
    queued: number;
    /** created/retry jobs scheduled for later. */
    deferred: number;
    active: number;
    /** Seconds since the oldest `queued` job became runnable; null when none. */
    oldestQueuedSeconds: number | null;
}

/**
 * Everything /health/ready and /metrics ask outside the web process. Each call
 * throws when its dependency is unhealthy. Kept behind an interface so the
 * routes are testable without Postgres, Appium or the wda-service socket.
 */
export interface ObservabilityProbes {
    database(): Promise<void>;
    appium(): Promise<void>;
    wdaService(): Promise<void>;
    workerHeartbeats(): Promise<WorkerHeartbeatRow[]>;
    queueStats(): Promise<QueueStat[]>;
    executionsLastHour(): Promise<Record<string, number>>;
    close(): Promise<void>;
}

export const QUEUE_STATS_SQL = `
select name,
       count(*) filter (where state in ('created', 'retry') and start_after <= now())::int as queued,
       count(*) filter (where state in ('created', 'retry') and start_after > now())::int as deferred,
       count(*) filter (where state = 'active')::int as active,
       extract(epoch from (now() - min(start_after) filter (where state in ('created', 'retry') and start_after <= now()))) as oldest
from pgboss.job
where state in ('created', 'retry', 'active')
group by name
order by name`;

export const EXECUTIONS_LAST_HOUR_SQL = `
select status::text as status, count(*)::int as count
from scheduler.executions
where updated_at > now() - interval '1 hour'
group by status`;

export async function queueStats(pool: Queryable): Promise<QueueStat[]> {
    const result = await pool.query<{ name: string; queued: number; deferred: number; active: number; oldest: string | number | null }>(QUEUE_STATS_SQL);
    return result.rows.map((row) => ({
        queue: row.name,
        queued: Number(row.queued),
        deferred: Number(row.deferred),
        active: Number(row.active),
        oldestQueuedSeconds: row.oldest === null ? null : Math.max(0, Number(row.oldest)),
    }));
}

export async function executionsLastHour(pool: Queryable): Promise<Record<string, number>> {
    const result = await pool.query<{ status: string; count: number }>(EXECUTIONS_LAST_HOUR_SQL);
    return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
}

export function appiumStatusUrl(env: NodeJS.ProcessEnv = process.env): string {
    return `http://${env.APPIUM_HOST ?? '127.0.0.1'}:${Number(env.APPIUM_PORT ?? 4725)}/status`;
}

/**
 * The production probes. The database pool is separate from the scheduler's,
 * tiny (2 connections) and opened on first use, so an app embedded without
 * DATABASE_URL still starts and simply reports the database as failing.
 */
export function createDefaultProbes(): ObservabilityProbes {
    let pool: Pool | undefined;
    const db = (): Pool => {
        if (!pool) {
            const connectionString = process.env.DATABASE_URL;
            if (!connectionString) throw new Error('DATABASE_URL is not set');
            pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 2_000 });
            pool.on('error', () => { /* an idle client dropped; the next probe reconnects */ });
        }
        return pool;
    };
    return {
        async database() { await db().query('select 1'); },
        async appium() {
            const response = await fetch(appiumStatusUrl(), { signal: AbortSignal.timeout(2_000) });
            if (!response.ok) throw new Error(`Appium answered ${response.status}`);
        },
        async wdaService() {
            const response = await requestWdaService('/health', { timeoutMs: 1_500 });
            if (response.statusCode !== 200) throw new Error(`wda-service answered ${response.statusCode}`);
        },
        workerHeartbeats: () => readWorkerHeartbeats(db()),
        queueStats: () => queueStats(db()),
        executionsLastHour: () => executionsLastHour(db()),
        async close() {
            const current = pool;
            pool = undefined;
            await current?.end();
        },
    };
}

export interface ReadinessCheck {
    ok: boolean;
    /** A short, fixed reason — never an error message, which could carry paths or hostnames. */
    reason?: 'unreachable' | 'timeout' | 'no heartbeat' | 'stale';
    ageSeconds?: number;
}

export interface ReadinessReport {
    ok: boolean;
    checks: {
        database: ReadinessCheck;
        appium: ReadinessCheck;
        wdaService: ReadinessCheck;
        worker: ReadinessCheck;
    };
}

export const DEFAULT_WORKER_STALE_SECONDS = 60;

export function workerStaleSeconds(env: NodeJS.ProcessEnv = process.env): number {
    const value = Number(env.PHONE_FARM_WORKER_STALE_SECONDS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_WORKER_STALE_SECONDS;
}

class ProbeTimeout extends Error {}

export function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ProbeTimeout('probe timed out')), milliseconds);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Runs every readiness probe in parallel, each bounded by `timeoutMs`.
 * `onFailure` receives the real error for the server log; the report itself
 * only carries fixed reasons, because /health/ready is anonymous.
 */
export async function checkReadiness(
    probes: ObservabilityProbes,
    options: { timeoutMs?: number; staleSeconds?: number; onFailure?: (check: string, error: unknown) => void } = {},
): Promise<ReadinessReport> {
    const timeoutMs = options.timeoutMs ?? 3_000;
    const staleSeconds = options.staleSeconds ?? workerStaleSeconds();
    const run = async (name: string, probe: () => Promise<void>): Promise<ReadinessCheck> => {
        try {
            await withTimeout(probe(), timeoutMs);
            return { ok: true };
        } catch (error) {
            options.onFailure?.(name, error);
            return { ok: false, reason: error instanceof ProbeTimeout ? 'timeout' : 'unreachable' };
        }
    };
    const worker = async (): Promise<ReadinessCheck> => {
        try {
            const [freshest] = await withTimeout(probes.workerHeartbeats(), timeoutMs);
            if (!freshest) return { ok: false, reason: 'no heartbeat' };
            const ageSeconds = Math.round(freshest.ageSeconds);
            return ageSeconds <= staleSeconds ? { ok: true, ageSeconds } : { ok: false, reason: 'stale', ageSeconds };
        } catch (error) {
            options.onFailure?.('worker', error);
            return { ok: false, reason: error instanceof ProbeTimeout ? 'timeout' : 'unreachable' };
        }
    };
    const [database, appium, wdaService, workerCheck] = await Promise.all([
        run('database', () => probes.database()),
        run('appium', () => probes.appium()),
        run('wdaService', () => probes.wdaService()),
        worker(),
    ]);
    const checks = { database, appium, wdaService, worker: workerCheck };
    return { ok: Object.values(checks).every((check) => check.ok), checks };
}

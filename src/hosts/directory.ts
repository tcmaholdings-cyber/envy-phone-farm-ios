import { Pool } from 'pg';

import { databaseUrl } from '../database/client.js';
import type { Queryable } from '../observability/heartbeat.js';

/** One row of fleet.hosts, as the dashboard needs it. */
export interface HostRecord {
    id: string;
    displayName: string;
    /** Where this host's /agent/* listener is reached; null when it has none. */
    agentUrl: string | null;
    /** Seconds since the host's lease was last refreshed (database clock); null if never. */
    ageSeconds: number | null;
}

/** How other hosts are found. Kept behind an interface so the dashboard is testable without Postgres. */
export interface HostDirectory {
    list(): Promise<HostRecord[]>;
    close?(): Promise<void>;
}

export const LIST_HOSTS_SQL = `select id, display_name, agent_url, extract(epoch from (now() - last_seen_at)) as age_seconds
from fleet.hosts order by id`;

export async function readHosts(pool: Queryable): Promise<HostRecord[]> {
    const result = await pool.query<{ id: string; display_name: string; agent_url: string | null; age_seconds: string | number | null }>(LIST_HOSTS_SQL);
    return result.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        agentUrl: row.agent_url,
        ageSeconds: row.age_seconds === null ? null : Math.max(0, Number(row.age_seconds)),
    }));
}

/** A fixed directory (tests, or a farm that prefers configuration to the lease table). */
export function staticHostDirectory(hosts: readonly HostRecord[]): HostDirectory {
    return { list: async () => hosts.map((host) => ({ ...host })) };
}

/**
 * fleet.hosts through a one-connection pool opened on first use, with reads
 * reused for `cacheMs` (default 5 s): every remote thumbnail needs its host's
 * agent URL, and that changes only when an operator reconfigures a host.
 */
export function postgresHostDirectory({ cacheMs = 5_000, now = Date.now }: { cacheMs?: number; now?: () => number } = {}): HostDirectory {
    let pool: Pool | undefined;
    let cache: { at: number; hosts: Promise<HostRecord[]> } | undefined;
    return {
        async list() {
            const at = now();
            if (!cache || at - cache.at >= cacheMs) {
                pool ??= new Pool({ connectionString: databaseUrl(), max: 1, allowExitOnIdle: true });
                const hosts = readHosts(pool);
                cache = { at, hosts };
                hosts.catch(() => { if (cache?.hosts === hosts) cache = undefined; });
            }
            return (await cache.hosts).map((host) => ({ ...host }));
        },
        async close() {
            await pool?.end().catch(() => undefined);
            pool = undefined;
        },
    };
}

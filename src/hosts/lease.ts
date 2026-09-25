import { readFileSync } from 'node:fs';
import path from 'node:path';

import { localHostId, localHostName } from '../devices/host-identity.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, startPeriodicBeat, type Queryable, type WorkerHeartbeat } from '../observability/heartbeat.js';

/**
 * The host lease: this Mac's row in `fleet.hosts`, refreshed every ~15 s by
 * its worker and its wda-service while PHONE_FARM_REGISTRY=postgres. Other
 * hosts' dashboards read it to find this host's agent URL and to tell a host
 * that stopped (stale `last_seen_at`) from one with phones offline. The
 * timestamp is the database's `now()`, so host clock skew cannot fake it.
 */
export const HOST_LEASE_SQL = `insert into fleet.hosts (id, display_name, agent_url, last_seen_at, version)
values ($1, $2, $3, now(), $4)
on conflict (id) do update
set display_name = excluded.display_name, agent_url = excluded.agent_url,
    last_seen_at = excluded.last_seen_at, version = excluded.version`;

/**
 * PHONE_FARM_AGENT_URL, validated: where another host's dashboard reaches this
 * host's /agent/* listener (e.g. `http://100.101.74.35:3001`, a Tailscale IP).
 * Unset means other hosts cannot view or drive this host's phones.
 */
export function agentUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = env.PHONE_FARM_AGENT_URL?.trim();
    if (!raw) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('PHONE_FARM_AGENT_URL must be an http(s) URL such as http://100.64.0.2:3001');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('PHONE_FARM_AGENT_URL must be a plain http(s) URL without credentials, query or fragment');
    }
    return url.toString().replace(/\/+$/, '');
}

/** The deployed release sha (RELEASED, written by deploy tooling), else the package version. */
export function hostVersion(env: NodeJS.ProcessEnv = process.env): string | null {
    try {
        const release = JSON.parse(readFileSync(path.resolve(env.PHONE_FARM_RELEASE_FILE ?? 'RELEASED'), 'utf8')) as { sha?: unknown };
        if (typeof release.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(release.sha)) return release.sha.slice(0, 12);
    } catch { /* no release marker */ }
    try {
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
        return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
        return null;
    }
}

export interface HostLeaseOptions {
    hostId?: string;
    hostName?: string;
    agentUrl?: string | null;
    version?: string | null;
    intervalMs?: number;
}

export function startHostLease(pool: Queryable, options: HostLeaseOptions = {}): WorkerHeartbeat {
    const values = [
        options.hostId ?? localHostId(),
        options.hostName ?? localHostName(),
        options.agentUrl === undefined ? agentUrlFromEnv() : options.agentUrl,
        options.version === undefined ? hostVersion() : options.version,
    ];
    return startPeriodicBeat('Host lease', options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS, async () => {
        await pool.query(HOST_LEASE_SQL, values);
    });
}

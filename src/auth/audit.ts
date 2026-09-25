import { and, desc, eq, isNull, lt, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';

import type { DatabaseConnection } from '../database/client.js';
import { authAuditLog } from '../database/schema.js';

/**
 * The audit log (auth.audit_log, append-only in the database; see
 * drizzle/0006_tenants.sql). One row per state-changing HTTP request, written
 * after the response, plus a row per account event (sign-in, sign-out,
 * password and Team changes). Rows carry who, from where, which route
 * pattern, which phone or ids, and the outcome — never a request body, a
 * password, a token or typed text.
 */

export interface AuditRecord {
    tenantId: string | null;
    actorUserId: string | null;
    actorRole: string | null;
    ip: string | null;
    method: string | null;
    /** The route pattern (`/api/devices/:udid/remote/action`), never the raw URL. */
    route: string | null;
    /** `http` for a request row, or the account event (`login.failure`, `grant.created`, …). */
    event: string;
    targetUdid: string | null;
    targetIds: string[] | null;
    status: number | null;
    requestId: string | null;
    detail: string | null;
}

export interface AuditEntry extends AuditRecord {
    id: number;
    at: Date;
}

export interface AuditQuery {
    /** undefined: every tenant (platform staff); null: platform-level rows only; an id: that tenant. */
    tenantId?: string | null;
    /** Keyset pagination: rows with a smaller id than this. */
    before?: number;
    limit: number;
}

export interface AuditLog {
    record(entry: AuditRecord): Promise<void>;
    /** Newest first. */
    list(query: AuditQuery): Promise<AuditEntry[]>;
}

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
/** The database refuses to delete younger rows (the append-only trigger), so a shorter setting is raised to this. */
export const MIN_AUDIT_RETENTION_DAYS = 30;

/** PHONE_FARM_AUDIT_RETENTION_DAYS: default 365, at least 30; 0 keeps rows forever (returns null). */
export function auditRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
    const raw = env.PHONE_FARM_AUDIT_RETENTION_DAYS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_AUDIT_RETENTION_DAYS;
    const days = Number(raw);
    if (!Number.isSafeInteger(days) || days < 0) return DEFAULT_AUDIT_RETENTION_DAYS;
    if (days === 0) return null;
    return Math.max(MIN_AUDIT_RETENTION_DAYS, days);
}

/** Delete rows older than the retention window. Returns how many went; a missing table (older schema) is 0. */
export async function pruneAuditLog(pool: Pool, days = auditRetentionDays()): Promise<number> {
    if (days === null) return 0;
    const present = await pool.query<{ present: string | null }>(`select to_regclass('auth.audit_log')::text as present`);
    if (!present.rows[0]?.present) return 0;
    const result = await pool.query(`delete from auth.audit_log where at < now() - make_interval(days => $1)`, [days]);
    return result.rowCount ?? 0;
}

const MAX_TEXT = 500;
const clip = (value: string | null | undefined, max = MAX_TEXT) => (value ? value.slice(0, max) : null);

/** Normalise a record before it is stored: bounded strings, at most 20 short ids. */
export function cleanAuditRecord(entry: AuditRecord): AuditRecord {
    return {
        ...entry,
        actorRole: clip(entry.actorRole, 32), ip: clip(entry.ip, 64), method: clip(entry.method, 16), route: clip(entry.route, 200),
        event: entry.event.slice(0, 64), targetUdid: clip(entry.targetUdid, 128), requestId: clip(entry.requestId, 64), detail: clip(entry.detail),
        targetIds: entry.targetIds?.length ? entry.targetIds.slice(0, 20).map((id) => id.slice(0, 128)) : null,
    };
}

export class PgAuditLog implements AuditLog {
    constructor(private readonly connection: DatabaseConnection) {}

    async record(entry: AuditRecord): Promise<void> {
        await this.connection.db.insert(authAuditLog).values(cleanAuditRecord(entry));
    }

    async list(query: AuditQuery): Promise<AuditEntry[]> {
        const conditions: SQL[] = [];
        if (query.tenantId === null) conditions.push(isNull(authAuditLog.tenantId));
        else if (query.tenantId !== undefined) {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.tenantId)) return [];
            conditions.push(eq(authAuditLog.tenantId, query.tenantId));
        }
        if (query.before !== undefined) conditions.push(lt(authAuditLog.id, query.before));
        return this.connection.db.select().from(authAuditLog).where(conditions.length ? and(...conditions) : undefined)
            .orderBy(desc(authAuditLog.id)).limit(query.limit);
    }
}

/** In memory, for tests and deployments without the built-in accounts. */
export class MemoryAuditLog implements AuditLog {
    readonly entries: AuditEntry[] = [];
    private next = 1;

    async record(entry: AuditRecord): Promise<void> {
        this.entries.push({ ...cleanAuditRecord(entry), id: this.next++, at: new Date() });
    }

    async list(query: AuditQuery): Promise<AuditEntry[]> {
        return this.entries
            .filter((entry) => query.tenantId === undefined || entry.tenantId === query.tenantId)
            .filter((entry) => query.before === undefined || entry.id < query.before)
            .sort((a, b) => b.id - a.id)
            .slice(0, query.limit);
    }
}

export const AUDIT_CSV_COLUMNS = [
    'id', 'at', 'tenantId', 'actorUserId', 'actorRole', 'ip', 'method', 'route', 'event', 'targetUdid', 'targetIds', 'status', 'requestId', 'detail',
] as const;

/**
 * One CSV cell: quoted when needed, and a leading = + - @ (or tab/CR) is
 * neutralised with an apostrophe so a spreadsheet never runs it as a formula.
 */
export function csvCell(value: unknown): string {
    let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString()
        : Array.isArray(value) ? value.join(' ') : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function auditCsv(entries: readonly AuditEntry[]): string {
    const lines = [AUDIT_CSV_COLUMNS.join(',')];
    for (const entry of entries) lines.push(AUDIT_CSV_COLUMNS.map((column) => csvCell(entry[column])).join(','));
    return `${lines.join('\r\n')}\r\n`;
}

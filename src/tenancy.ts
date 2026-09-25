/**
 * Tenancy constants shared by the scheduler, the accounts and the dashboard.
 *
 * Every schedule, execution, asset, user (except platform staff), group and
 * phone belongs to one tenant. A deployment that predates tenants runs entirely
 * inside the default tenant that migration 0006 creates, so nothing changes for
 * it until a platform user adds a second tenant (docs/tenants.md).
 */

/** The tenant migration 0006 creates and assigns every pre-existing row to. A fixed id, so SQL defaults can name it. */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TENANT_SLUG = 'beloura';

export const TENANT_STATUSES = ['active', 'suspended'] as const;
export type TenantStatus = typeof TENANT_STATUSES[number];

/** Per-tenant limits, stored as jsonb on auth.tenants. A missing key means the deployment default. */
export interface TenantQuotas {
    maxPhones?: number;
    maxUploadBytes?: number;
    maxUsers?: number;
}

export const QUOTA_KEYS = ['maxPhones', 'maxUploadBytes', 'maxUsers'] as const;

/** Total bytes of stored uploads a tenant may hold when its quotas do not say (5 GiB). */
export const DEFAULT_TENANT_UPLOAD_BYTES = 5 * 1024 ** 3;
/** One uploaded file, when PHONE_FARM_MAX_UPLOAD_BYTES does not say (200 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 ** 2;

/** The per-file upload cap: PHONE_FARM_MAX_UPLOAD_BYTES, else 200 MiB. */
export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number(env.PHONE_FARM_MAX_UPLOAD_BYTES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

/** A tenant's stored-upload budget in bytes. */
export function tenantUploadBudget(quotas: TenantQuotas | null | undefined): number {
    const value = quotas?.maxUploadBytes;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_TENANT_UPLOAD_BYTES;
}

/**
 * Clean a quotas object from untrusted input: only known keys, non-negative
 * safe integers; `null` or '' removes a key (back to the default).
 * @throws Error with a message safe to show when a value is not a whole number.
 */
export function parseQuotas(input: unknown, base: TenantQuotas = {}): TenantQuotas {
    if (input === undefined) return { ...base };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Quotas must be an object');
    const out: TenantQuotas = { ...base };
    for (const key of QUOTA_KEYS) {
        if (!(key in input)) continue;
        const raw = (input as Record<string, unknown>)[key];
        if (raw === null || raw === '') { delete out[key]; continue; }
        const value = typeof raw === 'string' ? Number(raw) : raw;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a whole number of 0 or more`);
        out[key] = value;
    }
    return out;
}

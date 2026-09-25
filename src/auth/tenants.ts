import {
    DEFAULT_TENANT_ID, parseQuotas, TENANT_STATUSES, type TenantQuotas, type TenantStatus,
} from '../tenancy.js';
import type { AuditEvent } from './accounts.js';
import { AccountError } from './accounts.js';
import { AuthConflictError } from './store.js';

/**
 * Tenants (paying organisations) and which tenant owns each phone. Only
 * platform staff reach any of this; the route table enforces that, and the
 * service assumes it. Storage is a `TenantStore`; `PgTenantStore`
 * (src/auth/pg-store.ts) is the real one, in schema `auth`.
 */

export interface TenantRecord {
    id: string;
    slug: string;
    name: string;
    status: TenantStatus;
    quotas: TenantQuotas;
    createdAt: Date;
}

export type TenantPatch = Partial<Pick<TenantRecord, 'name' | 'status' | 'quotas'>>;

export interface TenantStore {
    listTenants(): Promise<TenantRecord[]>;
    tenantById(id: string): Promise<TenantRecord | null>;
    tenantBySlug(slug: string): Promise<TenantRecord | null>;
    /** @throws AuthConflictError when the slug is taken. */
    createTenant(input: { slug: string; name: string; quotas: TenantQuotas }): Promise<TenantRecord>;
    updateTenant(id: string, patch: TenantPatch): Promise<TenantRecord | null>;
    /** Explicit phone owners, UDID → tenant id. A phone without an entry belongs to the default tenant. */
    deviceAssignments(): Promise<Map<string, string>>;
    /** Idempotent upsert. */
    assignDevice(udid: string, tenantId: string): Promise<void>;
    countUsers(tenantId: string): Promise<number>;
}

/** Which tenant owns each phone. */
export interface DeviceTenants {
    tenantOf(udid: string): string;
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NAME_MAX = 80;

/** Phones with no explicit owner belong to the default tenant: a pre-tenancy farm keeps every phone. */
export function deviceTenantsFrom(assignments: ReadonlyMap<string, string>): DeviceTenants {
    return { tenantOf: (udid) => assignments.get(udid) ?? DEFAULT_TENANT_ID };
}

/** One tenant for everything: auth off, or a provider without tenants. */
export const SINGLE_TENANT: DeviceTenants = Object.freeze({ tenantOf: () => DEFAULT_TENANT_ID });

function cleanName(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
}

function quotasOrError(input: unknown, base?: TenantQuotas): TenantQuotas {
    try {
        return parseQuotas(input, base);
    } catch (error) {
        throw new AccountError(400, error instanceof Error ? error.message : String(error));
    }
}

export class TenantService {
    audit: (event: AuditEvent) => void;

    constructor(readonly store: TenantStore, audit?: (event: AuditEvent) => void) {
        this.audit = audit ?? (() => {});
    }

    list(): Promise<TenantRecord[]> { return this.store.listTenants(); }

    async required(id: unknown): Promise<TenantRecord> {
        const tenant = typeof id === 'string' && id ? await this.store.tenantById(id) : null;
        if (!tenant) throw new AccountError(404, 'Organisation not found');
        return tenant;
    }

    async deviceTenants(): Promise<DeviceTenants> {
        return deviceTenantsFrom(await this.store.deviceAssignments());
    }

    async create(actor: { id: string; username: string } | null, input: { slug?: unknown; name?: unknown; quotas?: unknown }): Promise<TenantRecord> {
        const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase() : '';
        if (!SLUG_PATTERN.test(slug)) throw new AccountError(400, 'The short name is 2–40 characters: lowercase letters, digits and dashes, starting with a letter or digit');
        const name = cleanName(input.name) || slug;
        const quotas = quotasOrError(input.quotas);
        try {
            const tenant = await this.store.createTenant({ slug, name, quotas });
            this.audit({ event: 'tenant.created', actor: actor?.username ?? 'cli', actorId: actor?.id, tenantId: tenant.id, target: slug });
            return tenant;
        } catch (error) {
            if (error instanceof AuthConflictError) throw new AccountError(409, 'An organisation with that short name already exists');
            throw error;
        }
    }

    async update(actor: { id: string; username: string } | null, id: string, input: { name?: unknown; status?: unknown; quotas?: unknown }): Promise<TenantRecord> {
        const tenant = await this.required(id);
        const patch: TenantPatch = {};
        if (input.name !== undefined) {
            patch.name = cleanName(input.name);
            if (!patch.name) throw new AccountError(400, 'A name is required');
        }
        if (input.status !== undefined) {
            if (!(TENANT_STATUSES as readonly unknown[]).includes(input.status)) throw new AccountError(400, 'Status must be active or suspended');
            patch.status = input.status as TenantStatus;
            // The default tenant is the farm operator's own; suspending it would lock the farm out of itself.
            if (patch.status === 'suspended' && tenant.id === DEFAULT_TENANT_ID) throw new AccountError(409, 'The default organisation cannot be suspended');
        }
        if (input.quotas !== undefined) patch.quotas = quotasOrError(input.quotas, tenant.quotas);
        const updated = await this.store.updateTenant(tenant.id, patch);
        if (!updated) throw new AccountError(404, 'Organisation not found');
        const changes = Object.entries(patch).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
        this.audit({ event: 'tenant.updated', actor: actor?.username ?? 'cli', actorId: actor?.id, tenantId: tenant.id, target: tenant.slug, detail: changes });
        return updated;
    }

    /**
     * Give `udid` to `tenantId`. `registeredUdids` is the farm's phone list,
     * for the tenant's maxPhones quota (the phone being moved does not count).
     */
    async assignDevice(actor: { id: string; username: string } | null, udid: string, tenantId: unknown, registeredUdids: readonly string[]): Promise<{ tenant: TenantRecord; previousTenantId: string }> {
        const tenant = await this.required(tenantId);
        const owners = await this.deviceTenants();
        const previousTenantId = owners.tenantOf(udid);
        if (previousTenantId === tenant.id) return { tenant, previousTenantId };
        const limit = tenant.quotas.maxPhones;
        if (typeof limit === 'number') {
            const held = registeredUdids.filter((other) => other !== udid && owners.tenantOf(other) === tenant.id).length;
            if (held >= limit) throw new AccountError(409, `${tenant.name} already has its limit of ${limit} ${limit === 1 ? 'phone' : 'phones'}`);
        }
        await this.store.assignDevice(udid, tenant.id);
        this.audit({
            event: 'tenant.device_assigned', actor: actor?.username ?? 'cli', actorId: actor?.id, tenantId: tenant.id,
            target: udid, detail: `from=${previousTenantId}`,
        });
        return { tenant, previousTenantId };
    }
}

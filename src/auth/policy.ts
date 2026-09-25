/**
 * Access policy — pure functions, no I/O.
 *
 * Three roles (docs/tenants.md):
 * - `platform` — Beloura staff. Every tenant, every phone, farm setup. No tenant of their own.
 * - `admin`    — one tenant's administrator: every phone of that tenant, and its
 *                users, groups and grants. Nothing of any other tenant.
 * - `operator` — within one tenant, only the phones granted to them.
 *
 * Tenancy comes first: a resource (phone, schedule, execution, asset, user,
 * group) of another tenant does not exist for anyone but platform staff, and
 * the dashboard answers 404 for it. Within the tenant, an operator reaches a
 * phone only through a grant: to the user, or to a group the user belongs to.
 * A grant matches a phone by scope (every phone, a rack, a model, or one UDID)
 * and carries a level; the effective level is the highest level of every grant
 * that matches. `view` shows the phone; `operate` also drives it.
 */

export const ACCESS_LEVELS = ['view', 'operate'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];

export const SCOPE_TYPES = ['all', 'rack', 'model', 'device'] as const;
export type ScopeType = typeof SCOPE_TYPES[number];

export const USER_ROLES = ['platform', 'admin', 'operator'] as const;
export type UserRole = typeof USER_ROLES[number];
/** The roles a tenant's own users can hold. */
export const TENANT_ROLES = ['admin', 'operator'] as const;

export interface PolicyUser {
    id: string;
    role: UserRole;
    /** The user's tenant; null or absent for platform staff. */
    tenantId?: string | null;
    disabled?: boolean;
}

export interface PolicyGrant {
    userId?: string | null;
    groupId?: string | null;
    scopeType: ScopeType;
    scopeValue?: string | null;
    level: AccessLevel;
}

export interface PolicyDevice {
    udid: string;
    rack?: string | null;
    model?: string | null;
    /** The phone's tenant. Unknown means no tenant user can reach it (platform still can). */
    tenantId?: string | null;
}

const RANK: Record<AccessLevel, number> = { view: 1, operate: 2 };

export function isAccessLevel(value: unknown): value is AccessLevel {
    return typeof value === 'string' && (ACCESS_LEVELS as readonly string[]).includes(value);
}

export function isScopeType(value: unknown): value is ScopeType {
    return typeof value === 'string' && (SCOPE_TYPES as readonly string[]).includes(value);
}

export function isUserRole(value: unknown): value is UserRole {
    return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** True when `level` is at least `required`. No level never satisfies anything. */
export function levelSatisfies(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
    return Boolean(level) && RANK[level!] >= RANK[required];
}

export function maxLevel(a: AccessLevel | null, b: AccessLevel | null): AccessLevel | null {
    if (!a) return b;
    if (!b) return a;
    return RANK[a] >= RANK[b] ? a : b;
}

/** Racks and models are labels people type; compare them trimmed and case-insensitively. */
function label(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase();
}

export function grantMatchesDevice(grant: PolicyGrant, device: PolicyDevice): boolean {
    switch (grant.scopeType) {
        case 'all': return true;
        case 'rack': return Boolean(label(device.rack)) && label(device.rack) === label(grant.scopeValue);
        case 'model': return Boolean(label(device.model)) && label(device.model) === label(grant.scopeValue);
        case 'device': return Boolean(grant.scopeValue) && grant.scopeValue === device.udid;
        default: return false;
    }
}

/** A grant belongs to the user directly, or to one of the user's groups. */
export function grantAppliesToUser(grant: PolicyGrant, userId: string, groupIds: readonly string[]): boolean {
    if (grant.userId) return grant.userId === userId;
    if (grant.groupId) return groupIds.includes(grant.groupId);
    return false;
}

function active(user: PolicyUser | null | undefined): user is PolicyUser {
    return Boolean(user && !user.disabled);
}

/** Beloura staff: every tenant. */
export function isPlatform(user: PolicyUser | null | undefined): boolean {
    return active(user) && user.role === 'platform';
}

/** A tenant's administrator (never true without a tenant). */
export function isTenantAdmin(user: PolicyUser | null | undefined): boolean {
    return active(user) && user.role === 'admin' && Boolean(user.tenantId);
}

/**
 * True when `user` may know that a resource of `tenantId` exists at all:
 * platform staff always, anyone else only for their own tenant. An unknown
 * tenant (null/undefined) is visible to platform staff only.
 */
export function canSeeTenant(user: PolicyUser | null | undefined, tenantId: string | null | undefined): boolean {
    if (!active(user)) return false;
    if (user.role === 'platform') return true;
    return Boolean(user.tenantId) && Boolean(tenantId) && user.tenantId === tenantId;
}

/** Managing users, groups and grants of `tenantId`: platform staff, or that tenant's admin. */
export function canManageTeam(user: PolicyUser | null | undefined, tenantId: string | null | undefined): boolean {
    return isPlatform(user) || (isTenantAdmin(user) && canSeeTenant(user, tenantId));
}

/** The roles `actor` may give to someone: platform staff any, a tenant admin only tenant roles. */
export function assignableRoles(actor: PolicyUser | null | undefined): readonly UserRole[] {
    if (isPlatform(actor)) return USER_ROLES;
    if (isTenantAdmin(actor)) return TENANT_ROLES;
    return [];
}

/**
 * What `user` may do with `device`: `operate`, `view`, or null for nothing.
 * `groupIds` are the groups the user belongs to; `grants` may contain grants
 * for anybody — only the ones that apply to this user count.
 */
export function effectiveLevel(
    user: PolicyUser | null | undefined,
    groupIds: readonly string[],
    grants: readonly PolicyGrant[],
    device: PolicyDevice,
): AccessLevel | null {
    if (!active(user)) return null;
    if (user.role === 'platform') return 'operate';
    if (!canSeeTenant(user, device.tenantId)) return null;
    if (user.role === 'admin') return 'operate';
    if (user.role !== 'operator') return null;
    let best: AccessLevel | null = null;
    for (const grant of grants) {
        if (!isAccessLevel(grant.level)) continue;
        if (!grantAppliesToUser(grant, user.id, groupIds) || !grantMatchesDevice(grant, device)) continue;
        best = maxLevel(best, grant.level);
        if (best === 'operate') break;
    }
    return best;
}

/** True when some grant of the user carries `operate` (uploads are not tied to one phone). */
export function hasAnyOperateGrant(user: PolicyUser | null | undefined, groupIds: readonly string[], grants: readonly PolicyGrant[]): boolean {
    if (!active(user)) return false;
    if (user.role === 'platform' || isTenantAdmin(user)) return true;
    if (user.role !== 'operator' || !user.tenantId) return false;
    return grants.some((grant) => grant.level === 'operate' && grantAppliesToUser(grant, user.id, groupIds));
}

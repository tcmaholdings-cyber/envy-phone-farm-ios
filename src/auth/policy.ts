/**
 * Device access policy — pure functions, no I/O.
 *
 * An admin can do everything. An operator can see and act on a phone only
 * through a grant: to the user, or to a group the user belongs to. A grant
 * matches a phone by scope (every phone, a rack, a model, or one UDID) and
 * carries a level; the effective level is the highest level of every grant that
 * matches. `view` shows the phone; `operate` also drives it.
 */

export const ACCESS_LEVELS = ['view', 'operate'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];

export const SCOPE_TYPES = ['all', 'rack', 'model', 'device'] as const;
export type ScopeType = typeof SCOPE_TYPES[number];

export const USER_ROLES = ['admin', 'operator'] as const;
export type UserRole = typeof USER_ROLES[number];

export interface PolicyUser {
    id: string;
    role: UserRole;
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

export function isAdmin(user: PolicyUser | null | undefined): boolean {
    return Boolean(user && !user.disabled && user.role === 'admin');
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
    if (!user || user.disabled) return null;
    if (user.role === 'admin') return 'operate';
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
    if (!user || user.disabled) return false;
    if (user.role === 'admin') return true;
    return grants.some((grant) => grant.level === 'operate' && grantAppliesToUser(grant, user.id, groupIds));
}

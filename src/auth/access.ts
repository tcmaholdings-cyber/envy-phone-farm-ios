import type { AuthenticatedUser } from '../plugin.js';
import {
    canSeeTenant, effectiveLevel, hasAnyOperateGrant, isTenantAdmin, type AccessLevel, type PolicyDevice, type PolicyUser,
} from './policy.js';

/**
 * What the current request may touch. Built once per request from the
 * authenticated user; every route and list filter asks this, never the raw user.
 */
export interface RequestAccess {
    user: AuthenticatedUser | null;
    /** Everything, in every tenant: auth off, platform staff, or a provider without scoped access. */
    platform: boolean;
    /** The caller's tenant; null when `platform` (no tenant of their own). */
    tenantId: string | null;
    /** Administers `tenantId`: its users, groups, grants and audit log. */
    tenantAdmin: boolean;
    levelFor(device: PolicyDevice): AccessLevel | null;
    anyOperate: boolean;
    /** True when a resource of `tenantId` exists for this caller; otherwise it is a 404. */
    canSeeTenant(tenantId: string | null | undefined): boolean;
}

/** Auth is off: the loopback-only dashboard of old, with no users. */
export const FULL_ACCESS: RequestAccess = Object.freeze({
    user: null, platform: true, tenantId: null, tenantAdmin: false,
    levelFor: () => 'operate' as const, anyOperate: true, canSeeTenant: () => true,
});

export const NO_ACCESS: RequestAccess = Object.freeze({
    user: null, platform: false, tenantId: null, tenantAdmin: false,
    levelFor: () => null, anyOperate: false, canSeeTenant: () => false,
});

export function requestAccessFor(user: AuthenticatedUser | null | undefined): RequestAccess {
    if (!user) return NO_ACCESS;
    const access = user.access;
    // A provider that does not describe scoped access keeps all-or-nothing
    // semantics, and so does one that says `admin` without naming a tenant.
    if (!access || access.role === 'platform' || (access.role === 'admin' && !access.tenantId)) {
        return { ...FULL_ACCESS, user };
    }
    const subject: PolicyUser = { id: user.id, role: access.role, tenantId: access.tenantId ?? null };
    return {
        user,
        platform: false,
        tenantId: subject.tenantId ?? null,
        tenantAdmin: isTenantAdmin(subject),
        levelFor: (device) => effectiveLevel(subject, access.groupIds, access.grants, device),
        anyOperate: hasAnyOperateGrant(subject, access.groupIds, access.grants),
        canSeeTenant: (tenantId) => canSeeTenant(subject, tenantId),
    };
}

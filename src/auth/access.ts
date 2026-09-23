import type { AuthenticatedUser } from '../plugin.js';
import { effectiveLevel, hasAnyOperateGrant, type AccessLevel, type PolicyDevice, type PolicyUser } from './policy.js';

/**
 * What the current request may touch. Built once per request from the
 * authenticated user; every route and list filter asks this, never the raw user.
 */
export interface RequestAccess {
    user: AuthenticatedUser | null;
    /** Everything allowed: auth off, an admin, or a provider without scoped access. */
    admin: boolean;
    levelFor(device: PolicyDevice): AccessLevel | null;
    anyOperate: boolean;
}

/** Auth is off: the loopback-only dashboard of old, with no users. */
export const FULL_ACCESS: RequestAccess = Object.freeze({
    user: null, admin: true, levelFor: () => 'operate' as const, anyOperate: true,
});

export const NO_ACCESS: RequestAccess = Object.freeze({
    user: null, admin: false, levelFor: () => null, anyOperate: false,
});

export function requestAccessFor(user: AuthenticatedUser | null | undefined): RequestAccess {
    if (!user) return NO_ACCESS;
    const access = user.access;
    // A provider that does not describe scoped access keeps all-or-nothing semantics.
    if (!access || access.role === 'admin') return { user, admin: true, levelFor: () => 'operate', anyOperate: true };
    const subject: PolicyUser = { id: user.id, role: access.role };
    return {
        user,
        admin: false,
        levelFor: (device) => effectiveLevel(subject, access.groupIds, access.grants, device),
        anyOperate: hasAnyOperateGrant(subject, access.groupIds, access.grants),
    };
}

import type { AccessLevel, ScopeType, UserRole } from './policy.js';

/** Persistence for the built-in accounts. `PgAuthStore` is the real one (schema `auth`). */

export interface UserRecord {
    id: string;
    username: string;
    /** Null only for platform staff. */
    tenantId: string | null;
    displayName: string;
    role: UserRole;
    passwordHash: string;
    mustChangePassword: boolean;
    disabled: boolean;
    createdAt: Date;
    updatedAt: Date;
    lastLoginAt: Date | null;
}

export type NewUser = Pick<UserRecord, 'username' | 'tenantId' | 'displayName' | 'role' | 'passwordHash' | 'mustChangePassword'>;
export type UserPatch = Partial<Pick<UserRecord, 'displayName' | 'role' | 'passwordHash' | 'mustChangePassword' | 'disabled' | 'lastLoginAt'>>;

export interface GroupRecord {
    id: string;
    tenantId: string;
    name: string;
    description: string;
    createdAt: Date;
}

export interface MembershipRecord {
    groupId: string;
    userId: string;
}

export interface GrantRecord {
    id: string;
    userId: string | null;
    groupId: string | null;
    scopeType: ScopeType;
    scopeValue: string | null;
    level: AccessLevel;
    createdAt: Date;
}

export type NewGrant = Omit<GrantRecord, 'id' | 'createdAt'>;

export interface SessionRecord {
    id: string;
    /** SHA-256 of the cookie token. The raw token is never stored. */
    tokenHash: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
    lastSeenAt: Date;
    ip: string | null;
    userAgent: string | null;
}

export type NewSession = Omit<SessionRecord, 'id'>;

/** A unique constraint was violated (duplicate username, group name, membership). */
export class AuthConflictError extends Error {}

/**
 * Which accounts a listing covers: `undefined` every account, `null` platform
 * staff only, a tenant id that tenant only. Listings are filtered in the store,
 * so another tenant's rows never reach the service.
 */
export type TenantFilter = string | null | undefined;

export interface AuthStore {
    listUsers(tenantId?: TenantFilter): Promise<UserRecord[]>;
    userById(id: string): Promise<UserRecord | null>;
    userByUsername(username: string): Promise<UserRecord | null>;
    /** @throws AuthConflictError when the username is taken. */
    createUser(input: NewUser): Promise<UserRecord>;
    updateUser(id: string, patch: UserPatch): Promise<UserRecord | null>;
    deleteUser(id: string): Promise<boolean>;

    listGroups(tenantId?: TenantFilter): Promise<GroupRecord[]>;
    groupById(id: string): Promise<GroupRecord | null>;
    /** @throws AuthConflictError when the name is taken in that tenant. */
    createGroup(input: { tenantId: string; name: string; description: string }): Promise<GroupRecord>;
    updateGroup(id: string, patch: Partial<Pick<GroupRecord, 'name' | 'description'>>): Promise<GroupRecord | null>;
    deleteGroup(id: string): Promise<boolean>;
    /** With a tenant: memberships of that tenant's groups. */
    listMemberships(tenantId?: TenantFilter): Promise<MembershipRecord[]>;
    groupIdsForUser(userId: string): Promise<string[]>;
    /** Idempotent: adding an existing member is not an error. */
    addMember(groupId: string, userId: string): Promise<void>;
    removeMember(groupId: string, userId: string): Promise<boolean>;

    /** With a tenant: grants whose user or group belongs to that tenant. */
    listGrants(tenantId?: TenantFilter): Promise<GrantRecord[]>;
    grantsForSubjects(userId: string, groupIds: readonly string[]): Promise<GrantRecord[]>;
    createGrant(input: NewGrant): Promise<GrantRecord>;
    deleteGrant(id: string): Promise<GrantRecord | null>;

    createSession(input: NewSession): Promise<SessionRecord>;
    sessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
    touchSession(id: string, lastSeenAt: Date): Promise<void>;
    deleteSession(id: string): Promise<void>;
    /** Revoke every session of a user, optionally keeping one (the caller's). */
    deleteUserSessions(userId: string, exceptSessionId?: string): Promise<void>;
    deleteExpiredSessions(now: Date): Promise<number>;

    close?(): Promise<void>;
}

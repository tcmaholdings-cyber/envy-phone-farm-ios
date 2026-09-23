import crypto from 'node:crypto';

import type { UserAccess } from '../plugin.js';
import { generatePassword, hashPassword, passwordProblem, verifyAgainstDummy, verifyPassword } from './password.js';
import { isAccessLevel, isScopeType, isUserRole, type AccessLevel, type ScopeType, type UserRole } from './policy.js';
import type { AuthStore, GrantRecord, GroupRecord, MembershipRecord, SessionRecord, UserRecord } from './store.js';
import { AuthConflictError } from './store.js';
import { LoginThrottle } from './throttle.js';

/**
 * The built-in accounts: sign-in, sessions, password changes, and the
 * admin-only user / group / grant management behind the Team panel and the
 * `npm run users` CLI. Storage is an `AuthStore`; this module holds the rules.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 12 * 60 * 60_000;
export const DEFAULT_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
/** last_seen_at is written at most this often, not on every request. */
const TOUCH_INTERVAL_MS = 60_000;

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const DISPLAY_NAME_MAX = 80;
const GROUP_NAME_MAX = 60;
const GROUP_DESCRIPTION_MAX = 200;
const SCOPE_VALUE_MAX = 100;

/** A refusal with an HTTP status and a message that is safe to show. */
export class AccountError extends Error {
    constructor(readonly statusCode: number, message: string) { super(message); }
}

export interface AuditEvent {
    event: string;
    actor?: string;
    target?: string;
    ip?: string;
    detail?: string;
}

export interface Actor {
    id: string;
    username: string;
}

export type PublicUser = Omit<UserRecord, 'passwordHash'>;

export interface TeamSnapshot {
    users: PublicUser[];
    groups: GroupRecord[];
    memberships: MembershipRecord[];
    grants: GrantRecord[];
}

export interface ResolvedSession {
    session: SessionRecord;
    user: UserRecord;
    access: UserAccess;
}

export type LoginResult =
    | { ok: true; token: string; user: UserRecord; session: SessionRecord }
    | { ok: false; reason: 'invalid' | 'throttled'; retryAfterMs?: number };

export interface AccountServiceOptions {
    store: AuthStore;
    now?: () => Date;
    idleTimeoutMs?: number;
    absoluteTimeoutMs?: number;
    throttle?: LoginThrottle;
    audit?: (event: AuditEvent) => void;
}

export function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export function publicUser(user: UserRecord): PublicUser {
    const { passwordHash: _hidden, ...rest } = user;
    return rest;
}

export function normalizeUsername(value: unknown): string {
    if (typeof value !== 'string') throw new AccountError(400, 'A username is required');
    const username = value.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username)) {
        throw new AccountError(400, 'Usernames are 2–32 characters: letters, digits, dot, dash or underscore, starting with a letter or digit');
    }
    return username;
}

function cleanText(value: unknown, max: number): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function defaultAudit(event: AuditEvent): void {
    console.info(JSON.stringify({ audit: event }));
}

export class AccountService {
    readonly store: AuthStore;
    readonly idleTimeoutMs: number;
    readonly absoluteTimeoutMs: number;
    private readonly now: () => Date;
    private readonly throttle: LoginThrottle;
    audit: (event: AuditEvent) => void;

    constructor(options: AccountServiceOptions) {
        this.store = options.store;
        this.now = options.now ?? (() => new Date());
        this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS;
        this.throttle = options.throttle ?? new LoginThrottle({ now: () => this.now().getTime() });
        this.audit = options.audit ?? defaultAudit;
    }

    // ---------- sign-in and sessions ----------

    async login(username: unknown, password: unknown, meta: { ip: string; userAgent?: string }): Promise<LoginResult> {
        // No format validation here: a malformed name is simply not found,
        // with the same timing and message as a wrong password.
        const name = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 64) : '';
        const secret = typeof password === 'string' ? password.slice(0, 1024) : '';
        const wait = this.throttle.retryAfterMs(name, meta.ip);
        if (wait > 0) {
            this.audit({ event: 'login.throttled', target: name, ip: meta.ip });
            return { ok: false, reason: 'throttled', retryAfterMs: wait };
        }
        const user = name && secret ? await this.store.userByUsername(name) : null;
        const matches = user ? await verifyPassword(secret, user.passwordHash) : await verifyAgainstDummy(secret);
        if (!user || !matches || user.disabled) {
            this.throttle.recordFailure(name, meta.ip);
            const reason = !user ? 'unknown user' : !matches ? 'wrong password' : 'account disabled';
            this.audit({ event: 'login.failure', target: name, ip: meta.ip, detail: reason });
            return { ok: false, reason: 'invalid' };
        }
        this.throttle.recordSuccess(name);
        const now = this.now();
        const token = crypto.randomBytes(32).toString('base64url');
        const session = await this.store.createSession({
            tokenHash: hashToken(token), userId: user.id, createdAt: now,
            expiresAt: new Date(now.getTime() + this.absoluteTimeoutMs), lastSeenAt: now,
            ip: meta.ip || null, userAgent: meta.userAgent?.slice(0, 256) ?? null,
        });
        await this.store.updateUser(user.id, { lastLoginAt: now });
        await this.store.deleteExpiredSessions(now).catch(() => 0);
        this.audit({ event: 'login.success', actor: user.username, ip: meta.ip });
        return { ok: true, token, user, session };
    }

    /** The live session behind a cookie token, or null (expired, idle, revoked, user disabled). */
    async resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
        if (!token || token.length > 256) return null;
        const session = await this.store.sessionByTokenHash(hashToken(token));
        if (!session) return null;
        const now = this.now();
        const idle = now.getTime() - session.lastSeenAt.getTime();
        if (now >= session.expiresAt || idle > this.idleTimeoutMs) {
            await this.store.deleteSession(session.id);
            return null;
        }
        const user = await this.store.userById(session.userId);
        if (!user || user.disabled) {
            await this.store.deleteSession(session.id);
            return null;
        }
        if (idle > TOUCH_INTERVAL_MS) {
            await this.store.touchSession(session.id, now);
            session.lastSeenAt = now;
        }
        return { session, user, access: await this.accessFor(user) };
    }

    async accessFor(user: UserRecord): Promise<UserAccess> {
        if (user.role === 'admin') return { role: 'admin', groupIds: [], grants: [] };
        const groupIds = await this.store.groupIdsForUser(user.id);
        const grants = await this.store.grantsForSubjects(user.id, groupIds);
        return { role: user.role, groupIds, grants };
    }

    async logout(token: string | undefined, ip?: string): Promise<void> {
        if (!token || token.length > 256) return;
        const session = await this.store.sessionByTokenHash(hashToken(token));
        if (!session) return;
        await this.store.deleteSession(session.id);
        const user = await this.store.userById(session.userId);
        this.audit({ event: 'logout', actor: user?.username ?? session.userId, ...(ip ? { ip } : {}) });
    }

    /** Change one's own password; every other session of the user is revoked. */
    async changePassword(userId: string, keepSessionId: string, current: unknown, next: unknown): Promise<void> {
        const user = await this.store.userById(userId);
        if (!user || user.disabled) throw new AccountError(401, 'Sign in again');
        if (typeof current !== 'string' || !(await verifyPassword(current, user.passwordHash))) {
            throw new AccountError(400, 'Your current password is not correct.');
        }
        const problem = passwordProblem(next, user.username);
        if (problem) throw new AccountError(400, problem);
        if (next === current) throw new AccountError(400, 'Choose a new password, not the current one.');
        await this.store.updateUser(user.id, { passwordHash: await hashPassword(next as string), mustChangePassword: false });
        await this.store.deleteUserSessions(user.id, keepSessionId);
        this.audit({ event: 'password.changed', actor: user.username });
    }

    // ---------- administration ----------

    async team(): Promise<TeamSnapshot> {
        const [users, groups, memberships, grants] = await Promise.all([
            this.store.listUsers(), this.store.listGroups(), this.store.listMemberships(), this.store.listGrants(),
        ]);
        return { users: users.map(publicUser), groups, memberships, grants };
    }

    private async requiredUser(id: string): Promise<UserRecord> {
        const user = await this.store.userById(id);
        if (!user) throw new AccountError(404, 'User not found');
        return user;
    }

    private async requiredGroup(id: string): Promise<GroupRecord> {
        const group = await this.store.groupById(id);
        if (!group) throw new AccountError(404, 'Group not found');
        return group;
    }

    /** Refuse a change that would leave no active admin. `target` is the admin about to lose it. */
    private async assertAnotherActiveAdmin(target: UserRecord): Promise<void> {
        if (target.role !== 'admin' || target.disabled) return;
        const others = (await this.store.listUsers()).filter((user) => user.role === 'admin' && !user.disabled && user.id !== target.id);
        if (!others.length) throw new AccountError(409, 'This is the last active admin. Add or enable another admin first.');
    }

    async createUser(
        actor: Actor | null,
        input: { username: unknown; displayName?: unknown; role?: unknown; groupIds?: unknown },
    ): Promise<{ user: PublicUser; temporaryPassword: string }> {
        const username = normalizeUsername(input.username);
        const role: UserRole = input.role === undefined ? 'operator' : isUserRole(input.role) ? input.role
            : (() => { throw new AccountError(400, 'Role must be admin or operator'); })();
        const displayName = cleanText(input.displayName, DISPLAY_NAME_MAX) || username;
        const groupIds = Array.isArray(input.groupIds) ? [...new Set(input.groupIds.filter((id): id is string => typeof id === 'string'))] : [];
        for (const groupId of groupIds) await this.requiredGroup(groupId);
        const temporaryPassword = generatePassword();
        let user: UserRecord;
        try {
            user = await this.store.createUser({
                username, displayName, role, passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true,
            });
        } catch (error) {
            if (error instanceof AuthConflictError) throw new AccountError(409, 'That username is already taken');
            throw error;
        }
        for (const groupId of groupIds) await this.store.addMember(groupId, user.id);
        this.audit({ event: 'user.created', actor: actor?.username ?? 'cli', target: username, detail: `role=${role}` });
        return { user: publicUser(user), temporaryPassword };
    }

    async resetPassword(actor: Actor | null, userId: string): Promise<{ user: PublicUser; temporaryPassword: string }> {
        const user = await this.requiredUser(userId);
        const temporaryPassword = generatePassword();
        const updated = await this.store.updateUser(user.id, {
            passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true,
        });
        await this.store.deleteUserSessions(user.id);
        this.audit({ event: 'user.password_reset', actor: actor?.username ?? 'cli', target: user.username });
        return { user: publicUser(updated ?? user), temporaryPassword };
    }

    async updateUser(actor: Actor, userId: string, input: { displayName?: unknown; role?: unknown; disabled?: unknown }): Promise<PublicUser> {
        const user = await this.requiredUser(userId);
        const patch: { displayName?: string; role?: UserRole; disabled?: boolean } = {};
        if (input.displayName !== undefined) {
            patch.displayName = cleanText(input.displayName, DISPLAY_NAME_MAX);
            if (!patch.displayName) throw new AccountError(400, 'A display name is required');
        }
        if (input.role !== undefined) {
            if (!isUserRole(input.role)) throw new AccountError(400, 'Role must be admin or operator');
            patch.role = input.role;
        }
        if (input.disabled !== undefined) {
            if (typeof input.disabled !== 'boolean') throw new AccountError(400, 'disabled must be true or false');
            patch.disabled = input.disabled;
        }
        if (patch.disabled === true && user.id === actor.id) throw new AccountError(409, 'You cannot disable your own account');
        if ((patch.role && patch.role !== 'admin') || patch.disabled === true) await this.assertAnotherActiveAdmin(user);
        const updated = await this.store.updateUser(user.id, patch);
        if (!updated) throw new AccountError(404, 'User not found');
        if (patch.disabled === true) await this.store.deleteUserSessions(user.id);
        const changes = Object.entries(patch).map(([key, value]) => `${key}=${key === 'displayName' ? JSON.stringify(value) : String(value)}`).join(' ');
        this.audit({ event: 'user.updated', actor: actor.username, target: user.username, detail: changes });
        return publicUser(updated);
    }

    async deleteUser(actor: Actor, userId: string): Promise<void> {
        const user = await this.requiredUser(userId);
        if (user.id === actor.id) throw new AccountError(409, 'You cannot delete your own account');
        await this.assertAnotherActiveAdmin(user);
        await this.store.deleteUser(user.id);
        this.audit({ event: 'user.deleted', actor: actor.username, target: user.username });
    }

    async createGroup(actor: Actor, input: { name?: unknown; description?: unknown }): Promise<GroupRecord> {
        const name = cleanText(input.name, GROUP_NAME_MAX);
        if (!name) throw new AccountError(400, 'A group name is required');
        try {
            const group = await this.store.createGroup({ name, description: cleanText(input.description, GROUP_DESCRIPTION_MAX) });
            this.audit({ event: 'group.created', actor: actor.username, target: name });
            return group;
        } catch (error) {
            if (error instanceof AuthConflictError) throw new AccountError(409, 'A group with that name already exists');
            throw error;
        }
    }

    async updateGroup(actor: Actor, groupId: string, input: { name?: unknown; description?: unknown }): Promise<GroupRecord> {
        const group = await this.requiredGroup(groupId);
        const patch: { name?: string; description?: string } = {};
        if (input.name !== undefined) {
            patch.name = cleanText(input.name, GROUP_NAME_MAX);
            if (!patch.name) throw new AccountError(400, 'A group name is required');
        }
        if (input.description !== undefined) patch.description = cleanText(input.description, GROUP_DESCRIPTION_MAX);
        try {
            const updated = await this.store.updateGroup(group.id, patch);
            if (!updated) throw new AccountError(404, 'Group not found');
            this.audit({ event: 'group.updated', actor: actor.username, target: group.name, ...(patch.name ? { detail: `name=${JSON.stringify(patch.name)}` } : {}) });
            return updated;
        } catch (error) {
            if (error instanceof AuthConflictError) throw new AccountError(409, 'A group with that name already exists');
            throw error;
        }
    }

    async deleteGroup(actor: Actor, groupId: string): Promise<void> {
        const group = await this.requiredGroup(groupId);
        await this.store.deleteGroup(group.id);
        this.audit({ event: 'group.deleted', actor: actor.username, target: group.name });
    }

    async addMember(actor: Actor, groupId: string, userId: unknown): Promise<void> {
        const group = await this.requiredGroup(groupId);
        if (typeof userId !== 'string') throw new AccountError(400, 'Choose a person to add');
        const user = await this.requiredUser(userId);
        await this.store.addMember(group.id, user.id);
        this.audit({ event: 'group.member_added', actor: actor.username, target: group.name, detail: `user=${user.username}` });
    }

    async removeMember(actor: Actor, groupId: string, userId: string): Promise<void> {
        const group = await this.requiredGroup(groupId);
        const user = await this.requiredUser(userId);
        if (!(await this.store.removeMember(group.id, user.id))) throw new AccountError(404, 'That person is not in this group');
        this.audit({ event: 'group.member_removed', actor: actor.username, target: group.name, detail: `user=${user.username}` });
    }

    /**
     * Add a grant. A grant for the same subject and scope replaces the old one,
     * so changing View to Operate is one step.
     */
    async createGrant(actor: Actor, input: {
        subjectType?: unknown; subjectId?: unknown; scopeType?: unknown; scopeValue?: unknown; level?: unknown;
    }): Promise<GrantRecord> {
        if (input.subjectType !== 'user' && input.subjectType !== 'group') throw new AccountError(400, 'Grant access to a user or a group');
        if (typeof input.subjectId !== 'string') throw new AccountError(400, 'Choose who gets access');
        if (!isScopeType(input.scopeType)) throw new AccountError(400, 'Scope must be all, rack, model or device');
        if (!isAccessLevel(input.level)) throw new AccountError(400, 'Level must be view or operate');
        const scopeType: ScopeType = input.scopeType;
        const level: AccessLevel = input.level;
        let scopeValue: string | null = null;
        if (scopeType !== 'all') {
            scopeValue = typeof input.scopeValue === 'string' ? input.scopeValue.trim().slice(0, SCOPE_VALUE_MAX) : '';
            if (!scopeValue) throw new AccountError(400, `Choose which ${scopeType} this grant covers`);
        }
        const subjectName = input.subjectType === 'user'
            ? (await this.requiredUser(input.subjectId)).username
            : (await this.requiredGroup(input.subjectId)).name;
        const userId = input.subjectType === 'user' ? input.subjectId : null;
        const groupId = input.subjectType === 'group' ? input.subjectId : null;
        const same = (await this.store.listGrants()).filter((grant) => grant.userId === userId && grant.groupId === groupId
            && grant.scopeType === scopeType && (grant.scopeValue ?? '').toLowerCase() === (scopeValue ?? '').toLowerCase());
        for (const grant of same) await this.store.deleteGrant(grant.id);
        const grant = await this.store.createGrant({ userId, groupId, scopeType, scopeValue, level });
        this.audit({
            event: same.length ? 'grant.replaced' : 'grant.created', actor: actor.username,
            target: `${input.subjectType}:${subjectName}`, detail: `${scopeType}${scopeValue ? `=${JSON.stringify(scopeValue)}` : ''} level=${level}`,
        });
        return grant;
    }

    async deleteGrant(actor: Actor, grantId: string): Promise<void> {
        const grant = await this.store.deleteGrant(grantId);
        if (!grant) throw new AccountError(404, 'Grant not found');
        this.audit({
            event: 'grant.deleted', actor: actor.username,
            target: grant.userId ? `user:${grant.userId}` : `group:${grant.groupId}`,
            detail: `${grant.scopeType}${grant.scopeValue ? `=${JSON.stringify(grant.scopeValue)}` : ''} level=${grant.level}`,
        });
    }
}

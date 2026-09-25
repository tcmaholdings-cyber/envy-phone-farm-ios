import crypto from 'node:crypto';

import type { UserAccess } from '../plugin.js';
import { DEFAULT_TENANT_ID } from '../tenancy.js';
import { generatePassword, hashPassword, passwordProblem, verifyAgainstDummy, verifyPassword } from './password.js';
import {
    assignableRoles, canManageTeam, isAccessLevel, isScopeType, isUserRole, type AccessLevel, type PolicyUser, type ScopeType, type UserRole,
} from './policy.js';
import type { AuthStore, GrantRecord, GroupRecord, MembershipRecord, SessionRecord, UserRecord } from './store.js';
import { AuthConflictError } from './store.js';
import { LoginThrottle, type LoginThrottleStore } from './throttle.js';
import type { TenantStore } from './tenants.js';

/**
 * The built-in accounts: sign-in, sessions, password changes, and the user /
 * group / grant management behind the Team panel and the `npm run users` CLI.
 * Storage is an `AuthStore`; this module holds the rules.
 *
 * Every management call is confined to what the actor may manage: a tenant
 * admin their own tenant, platform staff any tenant (and platform accounts).
 * A user, group or grant outside that is "not found" (404), never "forbidden".
 * The actor's role and tenant are read from the store on every call, not
 * trusted from the caller.
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
    /** The acting user's username ('cli' for the command line). */
    actor?: string;
    actorId?: string;
    actorRole?: string;
    /** The tenant the event concerns; null/absent for platform-level events. */
    tenantId?: string | null;
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
    /** Tenants, for suspension and the maxUsers quota. Without one, every tenant user is in the default tenant. */
    tenants?: TenantStore;
    now?: () => Date;
    idleTimeoutMs?: number;
    absoluteTimeoutMs?: number;
    throttle?: LoginThrottleStore;
    audit?: (event: AuditEvent) => void;
}

/** Who a management call acts for: a tenant admin, platform staff, or the CLI. */
interface ResolvedActor {
    id: string | null;
    username: string;
    policy: PolicyUser;
}

const CLI_ACTOR: ResolvedActor = { id: null, username: 'cli', policy: { id: 'cli', role: 'platform', tenantId: null } };

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
    readonly tenants: TenantStore | undefined;
    readonly idleTimeoutMs: number;
    readonly absoluteTimeoutMs: number;
    private readonly now: () => Date;
    private readonly throttle: LoginThrottleStore;
    audit: (event: AuditEvent) => void;
    /** The tenant that owns a phone, for one-phone grants. The dashboard sets it; the default is single-tenant. */
    tenantOfDevice: (udid: string) => Promise<string> = async () => DEFAULT_TENANT_ID;

    constructor(options: AccountServiceOptions) {
        this.store = options.store;
        this.tenants = options.tenants;
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
        const wait = await this.throttle.retryAfterMs(name, meta.ip);
        if (wait > 0) {
            this.audit({ event: 'login.throttled', target: name, ip: meta.ip });
            return { ok: false, reason: 'throttled', retryAfterMs: wait };
        }
        const user = name && secret ? await this.store.userByUsername(name) : null;
        const matches = user ? await verifyPassword(secret, user.passwordHash) : await verifyAgainstDummy(secret);
        const suspended = Boolean(user && matches && !user.disabled && await this.tenantSuspended(user));
        if (!user || !matches || user.disabled || suspended) {
            await this.throttle.recordFailure(name, meta.ip);
            const reason = !user ? 'unknown user' : !matches ? 'wrong password' : user.disabled ? 'account disabled' : 'organisation suspended';
            this.audit({ event: 'login.failure', target: name, ip: meta.ip, detail: reason, ...(user ? { tenantId: user.tenantId } : {}) });
            return { ok: false, reason: 'invalid' };
        }
        await this.throttle.recordSuccess(name);
        const now = this.now();
        const token = crypto.randomBytes(32).toString('base64url');
        const session = await this.store.createSession({
            tokenHash: hashToken(token), userId: user.id, createdAt: now,
            expiresAt: new Date(now.getTime() + this.absoluteTimeoutMs), lastSeenAt: now,
            ip: meta.ip || null, userAgent: meta.userAgent?.slice(0, 256) ?? null,
        });
        await this.store.updateUser(user.id, { lastLoginAt: now });
        await this.store.deleteExpiredSessions(now).catch(() => 0);
        this.audit({ event: 'login.success', actor: user.username, actorId: user.id, actorRole: user.role, tenantId: user.tenantId, ip: meta.ip });
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
        if (!user || user.disabled || await this.tenantSuspended(user)) {
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
        if (user.role === 'platform') return { role: 'platform', tenantId: null, groupIds: [], grants: [] };
        // A tenant user without a tenant (the database forbids it) reaches nothing.
        const tenantId = user.tenantId ?? '';
        if (user.role === 'admin') return { role: 'admin', tenantId, groupIds: [], grants: [] };
        const groupIds = await this.store.groupIdsForUser(user.id);
        const grants = await this.store.grantsForSubjects(user.id, groupIds);
        return { role: user.role, tenantId, groupIds, grants };
    }

    /** A suspended (or vanished) tenant's users cannot sign in, and their live sessions end. */
    private async tenantSuspended(user: UserRecord): Promise<boolean> {
        if (!user.tenantId || !this.tenants) return false;
        const tenant = await this.tenants.tenantById(user.tenantId);
        return !tenant || tenant.status !== 'active';
    }

    async logout(token: string | undefined, ip?: string): Promise<void> {
        if (!token || token.length > 256) return;
        const session = await this.store.sessionByTokenHash(hashToken(token));
        if (!session) return;
        await this.store.deleteSession(session.id);
        const user = await this.store.userById(session.userId);
        this.audit({
            event: 'logout', actor: user?.username ?? session.userId, actorId: session.userId,
            ...(user ? { actorRole: user.role, tenantId: user.tenantId } : {}), ...(ip ? { ip } : {}),
        });
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
        this.audit({ event: 'password.changed', actor: user.username, actorId: user.id, actorRole: user.role, tenantId: user.tenantId });
    }

    // ---------- administration ----------

    /** The actor as the store knows them now; a vanished or disabled actor manages nothing. */
    private async resolveActor(actor: Actor | null): Promise<ResolvedActor> {
        if (!actor) return CLI_ACTOR;
        const user = await this.store.userById(actor.id);
        if (!user || user.disabled) throw new AccountError(401, 'Sign in again');
        return { id: user.id, username: user.username, policy: { id: user.id, role: user.role, tenantId: user.tenantId, disabled: user.disabled } };
    }

    private event(actor: ResolvedActor, tenantId: string | null, event: Omit<AuditEvent, 'actor' | 'actorId' | 'actorRole' | 'tenantId'>): void {
        this.audit({
            ...event, actor: actor.username, ...(actor.id ? { actorId: actor.id } : {}),
            actorRole: actor.id ? actor.policy.role : 'cli', tenantId,
        });
    }

    /**
     * The tenant a call is confined to. A tenant admin always gets their own
     * (whatever they asked for); platform staff and the CLI get the tenant they
     * named, or the default one.
     */
    async scopeTenant(actor: Actor | null, requested?: unknown): Promise<string> {
        return this.scopeFor(await this.resolveActor(actor), requested);
    }

    private async scopeFor(actor: ResolvedActor, requested?: unknown): Promise<string> {
        const own = actor.policy.role === 'platform' ? null : actor.policy.tenantId ?? null;
        const tenantId = own ?? (typeof requested === 'string' && requested ? requested : DEFAULT_TENANT_ID);
        if (!canManageTeam(actor.policy, tenantId)) throw new AccountError(403, 'Admin access required');
        if (this.tenants && !own && !(await this.tenants.tenantById(tenantId))) throw new AccountError(404, 'Organisation not found');
        return tenantId;
    }

    /** True when `actor` may manage `user`: its tenant's admin, or platform staff (who also manage platform accounts). */
    private manages(actor: ResolvedActor, user: Pick<UserRecord, 'tenantId' | 'role'>): boolean {
        if (actor.policy.role === 'platform') return true;
        return user.role !== 'platform' && canManageTeam(actor.policy, user.tenantId);
    }

    /**
     * The Team snapshot: one tenant's users, groups, memberships and grants.
     * `tenantId: null` (platform staff only) lists the platform accounts instead.
     */
    async team(actor: Actor | null = null, tenantId?: string | null): Promise<TeamSnapshot> {
        const who = await this.resolveActor(actor);
        if (tenantId === null && who.policy.role === 'platform') {
            const users = await this.store.listUsers(null);
            return { users: users.map(publicUser), groups: [], memberships: [], grants: [] };
        }
        const scope = await this.scopeFor(who, tenantId);
        const [users, groups, memberships, grants] = await Promise.all([
            this.store.listUsers(scope), this.store.listGroups(scope), this.store.listMemberships(scope), this.store.listGrants(scope),
        ]);
        return { users: users.map(publicUser), groups, memberships, grants };
    }

    private async requiredUser(actor: ResolvedActor, id: string): Promise<UserRecord> {
        const user = await this.store.userById(id);
        if (!user || !this.manages(actor, user)) throw new AccountError(404, 'User not found');
        return user;
    }

    private async requiredGroup(actor: ResolvedActor, id: string): Promise<GroupRecord> {
        const group = await this.store.groupById(id);
        if (!group || !canManageTeam(actor.policy, group.tenantId)) throw new AccountError(404, 'Group not found');
        return group;
    }

    /**
     * Refuse a change that would leave no active administrator: no platform
     * account for a platform target, no admin in the tenant for a tenant admin.
     * `target` is the one about to lose it.
     */
    private async assertAnotherActiveAdmin(target: UserRecord): Promise<void> {
        if ((target.role !== 'admin' && target.role !== 'platform') || target.disabled) return;
        const peers = await this.store.listUsers(target.role === 'platform' ? null : target.tenantId);
        const others = peers.filter((user) => user.role === target.role && !user.disabled && user.id !== target.id);
        if (!others.length) {
            throw new AccountError(409, target.role === 'platform'
                ? 'This is the last active platform account. Add or enable another first.'
                : 'This is the last active admin. Add or enable another admin first.');
        }
    }

    async createUser(
        actor: Actor | null,
        input: { username: unknown; displayName?: unknown; role?: unknown; groupIds?: unknown; tenantId?: unknown },
    ): Promise<{ user: PublicUser; temporaryPassword: string }> {
        const who = await this.resolveActor(actor);
        const username = normalizeUsername(input.username);
        const role: UserRole = input.role === undefined ? 'operator' : isUserRole(input.role) ? input.role
            : (() => { throw new AccountError(400, 'Role must be platform, admin or operator'); })();
        if (!assignableRoles(who.policy).includes(role)) {
            throw new AccountError(403, role === 'platform' ? 'Only platform staff can create platform accounts' : 'Admin access required');
        }
        const tenantId = role === 'platform' ? null : await this.scopeFor(who, input.tenantId);
        const displayName = cleanText(input.displayName, DISPLAY_NAME_MAX) || username;
        const groupIds = Array.isArray(input.groupIds) ? [...new Set(input.groupIds.filter((id): id is string => typeof id === 'string'))] : [];
        for (const groupId of groupIds) {
            const group = await this.requiredGroup(who, groupId);
            if (group.tenantId !== tenantId) throw new AccountError(404, 'Group not found');
        }
        if (tenantId && this.tenants) {
            const limit = (await this.tenants.tenantById(tenantId))?.quotas.maxUsers;
            if (typeof limit === 'number' && await this.tenants.countUsers(tenantId) >= limit) {
                throw new AccountError(409, `This organisation has reached its limit of ${limit} ${limit === 1 ? 'person' : 'people'}`);
            }
        }
        const temporaryPassword = generatePassword();
        let user: UserRecord;
        try {
            user = await this.store.createUser({
                username, tenantId, displayName, role, passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true,
            });
        } catch (error) {
            if (error instanceof AuthConflictError) throw new AccountError(409, 'That username is already taken');
            throw error;
        }
        for (const groupId of groupIds) await this.store.addMember(groupId, user.id);
        this.event(who, tenantId, { event: 'user.created', target: username, detail: `role=${role}` });
        return { user: publicUser(user), temporaryPassword };
    }

    async resetPassword(actor: Actor | null, userId: string): Promise<{ user: PublicUser; temporaryPassword: string }> {
        const who = await this.resolveActor(actor);
        const user = await this.requiredUser(who, userId);
        const temporaryPassword = generatePassword();
        const updated = await this.store.updateUser(user.id, {
            passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true,
        });
        await this.store.deleteUserSessions(user.id);
        this.event(who, user.tenantId, { event: 'user.password_reset', target: user.username });
        return { user: publicUser(updated ?? user), temporaryPassword };
    }

    async updateUser(actor: Actor, userId: string, input: { displayName?: unknown; role?: unknown; disabled?: unknown }): Promise<PublicUser> {
        const who = await this.resolveActor(actor);
        const user = await this.requiredUser(who, userId);
        const patch: { displayName?: string; role?: UserRole; disabled?: boolean } = {};
        if (input.displayName !== undefined) {
            patch.displayName = cleanText(input.displayName, DISPLAY_NAME_MAX);
            if (!patch.displayName) throw new AccountError(400, 'A display name is required');
        }
        if (input.role !== undefined) {
            if (!isUserRole(input.role)) throw new AccountError(400, 'Role must be platform, admin or operator');
            if (!assignableRoles(who.policy).includes(input.role)) throw new AccountError(403, 'Admin access required');
            // A platform account has no tenant and a tenant account has one: moving between them is a new account.
            if ((input.role === 'platform') !== (user.role === 'platform')) {
                throw new AccountError(400, 'Platform and organisation accounts cannot be converted into each other; create a new account instead');
            }
            patch.role = input.role;
        }
        if (input.disabled !== undefined) {
            if (typeof input.disabled !== 'boolean') throw new AccountError(400, 'disabled must be true or false');
            patch.disabled = input.disabled;
        }
        if (patch.disabled === true && user.id === who.id) throw new AccountError(409, 'You cannot disable your own account');
        if ((patch.role && patch.role !== user.role) || patch.disabled === true) await this.assertAnotherActiveAdmin(user);
        const updated = await this.store.updateUser(user.id, patch);
        if (!updated) throw new AccountError(404, 'User not found');
        if (patch.disabled === true) await this.store.deleteUserSessions(user.id);
        const changes = Object.entries(patch).map(([key, value]) => `${key}=${key === 'displayName' ? JSON.stringify(value) : String(value)}`).join(' ');
        this.event(who, user.tenantId, { event: 'user.updated', target: user.username, detail: changes });
        return publicUser(updated);
    }

    async deleteUser(actor: Actor, userId: string): Promise<void> {
        const who = await this.resolveActor(actor);
        const user = await this.requiredUser(who, userId);
        if (user.id === who.id) throw new AccountError(409, 'You cannot delete your own account');
        await this.assertAnotherActiveAdmin(user);
        await this.store.deleteUser(user.id);
        this.event(who, user.tenantId, { event: 'user.deleted', target: user.username });
    }

    async createGroup(actor: Actor, input: { name?: unknown; description?: unknown; tenantId?: unknown }): Promise<GroupRecord> {
        const who = await this.resolveActor(actor);
        const tenantId = await this.scopeFor(who, input.tenantId);
        const name = cleanText(input.name, GROUP_NAME_MAX);
        if (!name) throw new AccountError(400, 'A group name is required');
        try {
            const group = await this.store.createGroup({ tenantId, name, description: cleanText(input.description, GROUP_DESCRIPTION_MAX) });
            this.event(who, tenantId, { event: 'group.created', target: name });
            return group;
        } catch (error) {
            if (error instanceof AuthConflictError) throw new AccountError(409, 'A group with that name already exists');
            throw error;
        }
    }

    async updateGroup(actor: Actor, groupId: string, input: { name?: unknown; description?: unknown }): Promise<GroupRecord> {
        const who = await this.resolveActor(actor);
        const group = await this.requiredGroup(who, groupId);
        const patch: { name?: string; description?: string } = {};
        if (input.name !== undefined) {
            patch.name = cleanText(input.name, GROUP_NAME_MAX);
            if (!patch.name) throw new AccountError(400, 'A group name is required');
        }
        if (input.description !== undefined) patch.description = cleanText(input.description, GROUP_DESCRIPTION_MAX);
        try {
            const updated = await this.store.updateGroup(group.id, patch);
            if (!updated) throw new AccountError(404, 'Group not found');
            this.event(who, group.tenantId, { event: 'group.updated', target: group.name, ...(patch.name ? { detail: `name=${JSON.stringify(patch.name)}` } : {}) });
            return updated;
        } catch (error) {
            if (error instanceof AuthConflictError) throw new AccountError(409, 'A group with that name already exists');
            throw error;
        }
    }

    async deleteGroup(actor: Actor, groupId: string): Promise<void> {
        const who = await this.resolveActor(actor);
        const group = await this.requiredGroup(who, groupId);
        await this.store.deleteGroup(group.id);
        this.event(who, group.tenantId, { event: 'group.deleted', target: group.name });
    }

    /** A member of a group must belong to the group's tenant; anyone else is "not found". */
    private async memberOf(who: ResolvedActor, group: GroupRecord, userId: unknown): Promise<UserRecord> {
        if (typeof userId !== 'string') throw new AccountError(400, 'Choose a person to add');
        const user = await this.requiredUser(who, userId);
        if (user.tenantId !== group.tenantId) throw new AccountError(404, 'User not found');
        return user;
    }

    async addMember(actor: Actor, groupId: string, userId: unknown): Promise<void> {
        const who = await this.resolveActor(actor);
        const group = await this.requiredGroup(who, groupId);
        const user = await this.memberOf(who, group, userId);
        await this.store.addMember(group.id, user.id);
        this.event(who, group.tenantId, { event: 'group.member_added', target: group.name, detail: `user=${user.username}` });
    }

    async removeMember(actor: Actor, groupId: string, userId: string): Promise<void> {
        const who = await this.resolveActor(actor);
        const group = await this.requiredGroup(who, groupId);
        const user = await this.memberOf(who, group, userId);
        if (!(await this.store.removeMember(group.id, user.id))) throw new AccountError(404, 'That person is not in this group');
        this.event(who, group.tenantId, { event: 'group.member_removed', target: group.name, detail: `user=${user.username}` });
    }

    /**
     * Add a grant. A grant for the same subject and scope replaces the old one,
     * so changing View to Operate is one step. The subject must be within the
     * actor's reach, and a one-phone grant must name a phone of the subject's tenant.
     */
    async createGrant(actor: Actor, input: {
        subjectType?: unknown; subjectId?: unknown; scopeType?: unknown; scopeValue?: unknown; level?: unknown;
    }): Promise<GrantRecord> {
        const who = await this.resolveActor(actor);
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
        const subject = input.subjectType === 'user'
            ? await this.requiredUser(who, input.subjectId).then((user) => ({ name: user.username, tenantId: user.tenantId }))
            : await this.requiredGroup(who, input.subjectId).then((group) => ({ name: group.name, tenantId: group.tenantId }));
        if (!subject.tenantId) throw new AccountError(400, 'Platform accounts reach every phone already');
        if (scopeType === 'device' && await this.tenantOfDevice(scopeValue!) !== subject.tenantId) throw new AccountError(404, 'Phone not found');
        const userId = input.subjectType === 'user' ? input.subjectId : null;
        const groupId = input.subjectType === 'group' ? input.subjectId : null;
        const same = (await this.store.listGrants(subject.tenantId)).filter((grant) => grant.userId === userId && grant.groupId === groupId
            && grant.scopeType === scopeType && (grant.scopeValue ?? '').toLowerCase() === (scopeValue ?? '').toLowerCase());
        for (const grant of same) await this.store.deleteGrant(grant.id);
        const grant = await this.store.createGrant({ userId, groupId, scopeType, scopeValue, level });
        this.event(who, subject.tenantId, {
            event: same.length ? 'grant.replaced' : 'grant.created',
            target: `${input.subjectType}:${subject.name}`, detail: `${scopeType}${scopeValue ? `=${JSON.stringify(scopeValue)}` : ''} level=${level}`,
        });
        return grant;
    }

    async deleteGrant(actor: Actor, grantId: string): Promise<void> {
        const who = await this.resolveActor(actor);
        // Looked up within the actor's tenant, so another tenant's grant is simply not there.
        const scope = who.policy.role === 'platform' ? undefined : who.policy.tenantId ?? '';
        const grant = (await this.store.listGrants(scope)).find(({ id }) => id === grantId);
        if (!grant) throw new AccountError(404, 'Grant not found');
        const subject = grant.userId ? await this.store.userById(grant.userId) : await this.store.groupById(grant.groupId ?? '');
        const tenantId = subject?.tenantId ?? null;
        if (!canManageTeam(who.policy, tenantId)) throw new AccountError(404, 'Grant not found');
        await this.store.deleteGrant(grant.id);
        this.event(who, tenantId, {
            event: 'grant.deleted',
            target: grant.userId ? `user:${grant.userId}` : `group:${grant.groupId}`,
            detail: `${grant.scopeType}${grant.scopeValue ? `=${JSON.stringify(grant.scopeValue)}` : ''} level=${grant.level}`,
        });
    }
}

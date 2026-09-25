import crypto from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
    AuthStore, GrantRecord, GroupRecord, MembershipRecord, NewGrant, NewSession, NewUser, SessionRecord, TenantFilter, UserPatch, UserRecord,
} from '../src/auth/store.js';
import { AuthConflictError } from '../src/auth/store.js';
import type { TenantPatch, TenantRecord, TenantStore } from '../src/auth/tenants.js';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG, type TenantQuotas } from '../src/tenancy.js';

export { DEFAULT_TENANT_ID };

const byTenant = (tenantId: TenantFilter) => (row: { tenantId: string | null }) => tenantId === undefined || row.tenantId === tenantId;

/** An in-memory AuthStore with the same contract as PgAuthStore (unique names, cascades). */
export class MemoryAuthStore implements AuthStore {
    users: UserRecord[] = [];
    groups: GroupRecord[] = [];
    memberships: MembershipRecord[] = [];
    grants: GrantRecord[] = [];
    sessions: SessionRecord[] = [];

    async listUsers(tenantId?: TenantFilter) { return this.users.filter(byTenant(tenantId)).sort((a, b) => a.username.localeCompare(b.username)); }
    async userById(id: string) { return this.users.find((user) => user.id === id) ?? null; }
    async userByUsername(username: string) { return this.users.find((user) => user.username === username) ?? null; }
    async createUser(input: NewUser) {
        if (this.users.some((user) => user.username === input.username)) throw new AuthConflictError('taken');
        const now = new Date();
        const user: UserRecord = { ...input, id: crypto.randomUUID(), disabled: false, createdAt: now, updatedAt: now, lastLoginAt: null };
        this.users.push(user);
        return user;
    }
    async updateUser(id: string, patch: UserPatch) {
        const user = this.users.find((entry) => entry.id === id);
        if (!user) return null;
        Object.assign(user, patch, { updatedAt: new Date() });
        return user;
    }
    async deleteUser(id: string) {
        const before = this.users.length;
        this.users = this.users.filter((user) => user.id !== id);
        this.memberships = this.memberships.filter((membership) => membership.userId !== id);
        this.grants = this.grants.filter((grant) => grant.userId !== id);
        this.sessions = this.sessions.filter((session) => session.userId !== id);
        return this.users.length < before;
    }
    async listGroups(tenantId?: TenantFilter) { return this.groups.filter(byTenant(tenantId)); }
    async groupById(id: string) { return this.groups.find((group) => group.id === id) ?? null; }
    async createGroup(input: { tenantId: string; name: string; description: string }) {
        if (this.groups.some((group) => group.name === input.name && group.tenantId === input.tenantId)) throw new AuthConflictError('taken');
        const group: GroupRecord = { ...input, id: crypto.randomUUID(), createdAt: new Date() };
        this.groups.push(group);
        return group;
    }
    async updateGroup(id: string, patch: Partial<Pick<GroupRecord, 'name' | 'description'>>) {
        const tenantId = this.groups.find((entry) => entry.id === id)?.tenantId;
        if (patch.name && this.groups.some((group) => group.name === patch.name && group.id !== id && group.tenantId === tenantId)) throw new AuthConflictError('taken');
        const group = this.groups.find((entry) => entry.id === id);
        if (!group) return null;
        Object.assign(group, patch);
        return group;
    }
    async deleteGroup(id: string) {
        const before = this.groups.length;
        this.groups = this.groups.filter((group) => group.id !== id);
        this.memberships = this.memberships.filter((membership) => membership.groupId !== id);
        this.grants = this.grants.filter((grant) => grant.groupId !== id);
        return this.groups.length < before;
    }
    async listMemberships(tenantId?: TenantFilter) {
        const groups = new Set(this.groups.filter(byTenant(tenantId)).map(({ id }) => id));
        return this.memberships.filter(({ groupId }) => groups.has(groupId));
    }
    async groupIdsForUser(userId: string) { return this.memberships.filter((entry) => entry.userId === userId).map(({ groupId }) => groupId); }
    async addMember(groupId: string, userId: string) {
        if (!this.memberships.some((entry) => entry.groupId === groupId && entry.userId === userId)) this.memberships.push({ groupId, userId });
    }
    async removeMember(groupId: string, userId: string) {
        const before = this.memberships.length;
        this.memberships = this.memberships.filter((entry) => !(entry.groupId === groupId && entry.userId === userId));
        return this.memberships.length < before;
    }
    async listGrants(tenantId?: TenantFilter) {
        if (tenantId === undefined) return [...this.grants];
        const users = new Set(this.users.filter(byTenant(tenantId)).map(({ id }) => id));
        const groups = new Set(this.groups.filter(byTenant(tenantId)).map(({ id }) => id));
        return this.grants.filter((grant) => (grant.userId && users.has(grant.userId)) || (grant.groupId && groups.has(grant.groupId)));
    }
    async grantsForSubjects(userId: string, groupIds: readonly string[]) {
        return this.grants.filter((grant) => grant.userId === userId || (grant.groupId !== null && groupIds.includes(grant.groupId)));
    }
    async createGrant(input: NewGrant) {
        const grant: GrantRecord = { ...input, id: crypto.randomUUID(), createdAt: new Date() };
        this.grants.push(grant);
        return grant;
    }
    async deleteGrant(id: string) {
        const grant = this.grants.find((entry) => entry.id === id) ?? null;
        this.grants = this.grants.filter((entry) => entry.id !== id);
        return grant;
    }
    async createSession(input: NewSession) {
        const session: SessionRecord = { ...input, id: crypto.randomUUID() };
        this.sessions.push(session);
        return session;
    }
    async sessionByTokenHash(tokenHash: string) { return this.sessions.find((session) => session.tokenHash === tokenHash) ?? null; }
    async touchSession(id: string, lastSeenAt: Date) {
        const session = this.sessions.find((entry) => entry.id === id);
        if (session) session.lastSeenAt = lastSeenAt;
    }
    async deleteSession(id: string) { this.sessions = this.sessions.filter((session) => session.id !== id); }
    async deleteUserSessions(userId: string, exceptSessionId?: string) {
        this.sessions = this.sessions.filter((session) => session.userId !== userId || session.id === exceptSessionId);
    }
    async deleteExpiredSessions(now: Date) {
        const before = this.sessions.length;
        this.sessions = this.sessions.filter((session) => session.expiresAt > now);
        return before - this.sessions.length;
    }
}

/** An in-memory TenantStore; starts with the default tenant, like migration 0006. */
export class MemoryTenantStore implements TenantStore {
    tenants: TenantRecord[] = [{ id: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG, name: 'Beloura', status: 'active', quotas: {}, createdAt: new Date(0) }];
    assignments = new Map<string, string>();
    constructor(private readonly users?: MemoryAuthStore) {}
    async listTenants() { return [...this.tenants].sort((a, b) => a.name.localeCompare(b.name)); }
    async tenantById(id: string) { return this.tenants.find((tenant) => tenant.id === id) ?? null; }
    async tenantBySlug(slug: string) { return this.tenants.find((tenant) => tenant.slug === slug) ?? null; }
    async createTenant(input: { slug: string; name: string; quotas: TenantQuotas }) {
        if (this.tenants.some((tenant) => tenant.slug === input.slug)) throw new AuthConflictError('taken');
        const tenant: TenantRecord = { ...input, id: crypto.randomUUID(), status: 'active', createdAt: new Date() };
        this.tenants.push(tenant);
        return tenant;
    }
    async updateTenant(id: string, patch: TenantPatch) {
        const tenant = this.tenants.find((entry) => entry.id === id);
        if (!tenant) return null;
        Object.assign(tenant, patch);
        return tenant;
    }
    async deviceAssignments() { return new Map(this.assignments); }
    async assignDevice(udid: string, tenantId: string) { this.assignments.set(udid, tenantId); }
    async countUsers(tenantId: string) { return (this.users?.users ?? []).filter((user) => user.tenantId === tenantId).length; }
}

/** A controllable clock for session-expiry tests. */
export function testClock(start = Date.UTC(2026, 8, 23, 12)) {
    let now = start;
    return { now: () => new Date(now), advance(ms: number) { now += ms; } };
}

/**
 * Write a devices.json and point DEVICES_CONFIG_PATH at it. Call before the
 * first dynamic import of any src module: registry.ts freezes the path on load.
 */
export async function useDevicesFile(devices: unknown[]): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-auth-'));
    const configPath = path.join(directory, 'devices.json');
    await writeFile(configPath, JSON.stringify(devices));
    process.env.DEVICES_CONFIG_PATH = configPath;
    return configPath;
}

/** The `pf_session` value from a response's Set-Cookie header. */
export function sessionCookie(response: { headers: Record<string, unknown> }): { value: string; raw: string } | null {
    const header = response.headers['set-cookie'];
    const all = (Array.isArray(header) ? header : header ? [header] : []) as string[];
    const raw = all.find((value) => value.startsWith('pf_session='));
    if (!raw) return null;
    return { value: decodeURIComponent(raw.slice('pf_session='.length).split(';')[0] ?? ''), raw };
}

export interface FakeSchedule { id: string; deviceUdid: string; tenantId?: string; status: string; pluginId: string; taskType: string; taskVersion: number; payload: Record<string, unknown>; timing: unknown; nextRunAt: Date | null; runWindowMinutes: number; createdAt: Date }
export interface FakeExecution { id: string; deviceUdid: string; tenantId?: string; status: string; pluginId: string; taskType: string; taskVersion: number; payload: Record<string, unknown>; scheduledFor: Date; error: string | null; createdAt: Date }

/**
 * A SchedulerRepository stand-in holding rows in memory; records the calls a
 * test cares about. Rows without a tenantId are the default tenant's, and the
 * tenant filters behave like the real repository's.
 */
export function fakeScheduler(schedules: FakeSchedule[] = [], executions: FakeExecution[] = [], tenantOfDevice: (udid: string) => Promise<string> = async () => DEFAULT_TENANT_ID) {
    const calls: string[] = [];
    for (const row of [...schedules, ...executions]) row.tenantId ??= DEFAULT_TENANT_ID;
    const assets: Array<{ id: string; tenantId: string; scheduleId: string | null; size: number; uploadedBy: string | null; relativePath: string }> = [];
    const filter = async <T extends { deviceUdid: string; tenantId?: string }>(rows: T[], udid?: string | readonly string[], tenantId?: string | null) => {
        let out = Array.isArray(udid) ? rows.filter((row) => udid.includes(row.deviceUdid))
            : typeof udid === 'string' && udid ? rows.filter((row) => row.deviceUdid === udid) : rows;
        if (typeof udid === 'string' && udid && tenantId === undefined) {
            const owner = await tenantOfDevice(udid);
            out = out.filter((row) => row.tenantId === owner);
        }
        return typeof tenantId === 'string' ? out.filter((row) => row.tenantId === tenantId) : out;
    };
    const scheduler = {
        calls, schedules, executions, assets,
        uploadBudget: 5 * 1024 ** 3,
        async listSchedules(_limit: number, udid?: string | readonly string[], tenantId?: string | null) { return filter(schedules, udid, tenantId); },
        async listExecutions(_limit: number, udid?: string | readonly string[], tenantId?: string | null) { return filter(executions, udid, tenantId); },
        async schedule(id: string, tenantId?: string) { return schedules.find((row) => row.id === id && (tenantId === undefined || row.tenantId === tenantId)) ?? null; },
        async execution(id: string, tenantId?: string) {
            const row = executions.find((entry) => entry.id === id && (tenantId === undefined || entry.tenantId === tenantId));
            return row ? { ...row, logs: [] } : null;
        },
        async activeExecution() { return null; },
        async tenantForDevice(udid: string) { return tenantOfDevice(udid); },
        async uploadUsage(tenantId: string) {
            return { usedBytes: assets.filter((asset) => asset.tenantId === tenantId).reduce((total, asset) => total + asset.size, 0), budgetBytes: scheduler.uploadBudget };
        },
        async createTask(input: { deviceUdid: string; task: { pluginId: string; taskType: string; taskVersion: number; payload: Record<string, unknown> }; timing: unknown }, _data?: unknown, _now?: Date, assetIds: string[] = []) {
            calls.push(`create:${input.deviceUdid}`);
            const tenantId = await tenantOfDevice(input.deviceUdid);
            const attachable = assetIds.every((id) => assets.some((asset) => asset.id === id && asset.tenantId === tenantId && !asset.scheduleId));
            if (!attachable) throw Object.assign(new Error('Asset not found'), { statusCode: 404 });
            const row: FakeSchedule = {
                id: crypto.randomUUID(), deviceUdid: input.deviceUdid, tenantId, status: 'active', ...input.task, timing: input.timing,
                nextRunAt: null, runWindowMinutes: 30, createdAt: new Date(),
            };
            for (const asset of assets) if (assetIds.includes(asset.id)) asset.scheduleId = row.id;
            schedules.push(row);
            return row;
        },
        async setScheduleStatus(id: string, status: string) {
            calls.push(`status:${id}:${status}`);
            const row = schedules.find((entry) => entry.id === id);
            if (row) row.status = status;
            return row ?? null;
        },
        async requestStop(id: string) { calls.push(`stop:${id}`); return executions.some((row) => row.id === id) ? 'queued' : 'not-found'; },
        async retryExecution(id: string) { calls.push(`retry:${id}`); return executions.find((row) => row.id === id) ?? null; },
        async registerAssets(files: Array<{ relativePath: string; size: number }>, owner: { tenantId?: string | null; deviceUdid?: string; uploadedBy?: string | null } = {}) {
            const tenantId = owner.tenantId ?? (owner.deviceUdid ? await tenantOfDevice(owner.deviceUdid) : DEFAULT_TENANT_ID);
            const used = (await scheduler.uploadUsage(tenantId)).usedBytes;
            if (used + files.reduce((total, file) => total + file.size, 0) > scheduler.uploadBudget) {
                throw Object.assign(new Error('Uploads for this organisation are over quota'), { statusCode: 413, name: 'UploadQuotaError' });
            }
            return files.map((file) => {
                const asset = { id: crypto.randomUUID(), tenantId, scheduleId: null, size: file.size, uploadedBy: owner.uploadedBy ?? null, relativePath: file.relativePath };
                assets.push(asset);
                return { id: asset.id, name: file.relativePath, mimeType: 'application/octet-stream' };
            });
        },
        async deleteAssets(ids: string[], tenantId?: string) {
            if (tenantId !== undefined && !ids.every((id) => assets.some((asset) => asset.id === id && asset.tenantId === tenantId))) return false;
            calls.push('delete-assets');
            for (const id of ids) {
                const index = assets.findIndex((asset) => asset.id === id);
                if (index >= 0) assets.splice(index, 1);
            }
            return true;
        },
        async updateSchedule(id: string) { calls.push(`update:${id}`); return schedules.find((row) => row.id === id) ?? null; },
    };
    return scheduler;
}

/** A RemoteControl stand-in: a 1×1 PNG screen, and a log of the actions it was asked to perform. */
export function fakeRemote() {
    const actions: string[] = [];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    return {
        actions,
        async getScreenInfo() { return { screenSize: { width: 375, height: 667 }, scale: 2 }; },
        async getScreenshot() { return png; },
        async getMjpegStream() { return new Response('stream', { headers: { 'content-type': 'multipart/x-mixed-replace; boundary=x' } }); },
        async performAction(udid: string, action: { type: string }) { actions.push(`${udid}:${action.type}`); },
        async isLocked() { return false; },
    };
}

export const TEST_DEVICES = [
    { name: 'Rack1 Mini', udid: 'udid-r1-mini', rack: '1', rackSlot: 'A1', model: 'iPhone 12 mini', pluginData: {} },
    { name: 'Rack1 SE', udid: 'udid-r1-se', rack: '1', model: 'iPhone SE (2nd generation)', pluginData: {} },
    { name: 'Rack2 Mini', udid: 'udid-r2-mini', rack: '2', model: 'iPhone 12 mini', pluginData: {} },
    { name: 'Loose <b>phone</b>', udid: 'udid-loose', pluginData: {} },
];

/**
 * A dashboard with the built-in accounts over a MemoryAuthStore, the TikTok
 * plugin, the Envy theme and fake scheduler/remote/discovery. Call
 * `useDevicesFile` first.
 */
export async function createAuthApp(options: {
    clock?: ReturnType<typeof testClock>; schedules?: FakeSchedule[]; executions?: FakeExecution[];
    extra?: Partial<import('../src/api/app.js').CreateAppOptions>;
} = {}) {
    const { createApp } = await import('../src/api/app.js');
    const { AccountService } = await import('../src/auth/accounts.js');
    const { createBuiltinAuthProvider } = await import('../src/auth/builtin.js');
    const { LoginThrottle } = await import('../src/auth/throttle.js');
    const { TenantService } = await import('../src/auth/tenants.js');
    const { MemoryAuditLog } = await import('../src/auth/audit.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const { PluginRegistry } = await import('../src/registry.js');
    const { createTikTokPlugin } = await import('../src/tiktok-plugin.js');
    const store = new MemoryAuthStore();
    const tenantStore = new MemoryTenantStore(store);
    const clock = options.clock ?? testClock();
    const audit: Array<import('../src/auth/accounts.js').AuditEvent> = [];
    const accounts = new AccountService({
        store, tenants: tenantStore, now: clock.now,
        throttle: new LoginThrottle({ now: () => clock.now().getTime() }),
    });
    const tenants = new TenantService(tenantStore);
    const auditLog = new MemoryAuditLog();
    const provider = createBuiltinAuthProvider(accounts, undefined, { tenants, auditLog });
    const scheduler = fakeScheduler(options.schedules, options.executions, async (udid) => tenantStore.assignments.get(udid) ?? DEFAULT_TENANT_ID);
    const remote = fakeRemote();
    const registrations = {
        async start() {}, async close() {}, async candidates() { return []; },
        async create() { throw new Error('unused'); }, async get() { return undefined; },
        async update() { throw new Error('unused'); }, async run() { throw new Error('unused'); }, async cancel() {},
    };
    const app = await createApp({
        plugins: new PluginRegistry([createTikTokPlugin()]),
        scheduler: scheduler as never, authProvider: provider, dashboardTheme: defaultDashboardTheme,
        registrations: registrations as never, remote: remote as never,
        discoverDevices: async () => [], wdaStatuses: async () => [],
        ...options.extra,
    });
    // Record events for the test while still passing them on to the dashboard's audit log.
    const forward = accounts.audit;
    accounts.audit = (event) => { audit.push(event); forward(event); };
    tenants.audit = (event) => { audit.push(event); forward(event); };
    return { app, store, tenantStore, tenants, accounts, provider, scheduler, remote, clock, audit, auditLog };
}

/** A live session for `userId` without going through the sign-in form: returns the cookie value. */
export async function sessionFor(store: MemoryAuthStore, userId: string, now = new Date(Date.UTC(2026, 8, 23, 12))): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createSession({
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId, createdAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000), lastSeenAt: now, ip: '127.0.0.1', userAgent: 'test',
    });
    return token;
}

/**
 * A user row with a placeholder hash (these tests never sign in with a password).
 * Tenant users land in `tenantId` (the default tenant unless given); platform staff in none.
 */
export async function seedUser(store: MemoryAuthStore, username: string, role: 'platform' | 'admin' | 'operator', displayName = username, tenantId: string = DEFAULT_TENANT_ID) {
    return store.createUser({
        username, role, displayName, passwordHash: 'scrypt$1$1$1$x$y', mustChangePassword: false, tenantId: role === 'platform' ? null : tenantId,
    });
}

import crypto from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
    AuthStore, GrantRecord, GroupRecord, MembershipRecord, NewGrant, NewSession, NewUser, SessionRecord, UserPatch, UserRecord,
} from '../src/auth/store.js';
import { AuthConflictError } from '../src/auth/store.js';

/** An in-memory AuthStore with the same contract as PgAuthStore (unique names, cascades). */
export class MemoryAuthStore implements AuthStore {
    users: UserRecord[] = [];
    groups: GroupRecord[] = [];
    memberships: MembershipRecord[] = [];
    grants: GrantRecord[] = [];
    sessions: SessionRecord[] = [];

    async listUsers() { return [...this.users].sort((a, b) => a.username.localeCompare(b.username)); }
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
    async listGroups() { return [...this.groups]; }
    async groupById(id: string) { return this.groups.find((group) => group.id === id) ?? null; }
    async createGroup(input: { name: string; description: string }) {
        if (this.groups.some((group) => group.name === input.name)) throw new AuthConflictError('taken');
        const group: GroupRecord = { ...input, id: crypto.randomUUID(), createdAt: new Date() };
        this.groups.push(group);
        return group;
    }
    async updateGroup(id: string, patch: Partial<Pick<GroupRecord, 'name' | 'description'>>) {
        if (patch.name && this.groups.some((group) => group.name === patch.name && group.id !== id)) throw new AuthConflictError('taken');
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
    async listMemberships() { return [...this.memberships]; }
    async groupIdsForUser(userId: string) { return this.memberships.filter((entry) => entry.userId === userId).map(({ groupId }) => groupId); }
    async addMember(groupId: string, userId: string) {
        if (!this.memberships.some((entry) => entry.groupId === groupId && entry.userId === userId)) this.memberships.push({ groupId, userId });
    }
    async removeMember(groupId: string, userId: string) {
        const before = this.memberships.length;
        this.memberships = this.memberships.filter((entry) => !(entry.groupId === groupId && entry.userId === userId));
        return this.memberships.length < before;
    }
    async listGrants() { return [...this.grants]; }
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

export interface FakeSchedule { id: string; deviceUdid: string; status: string; pluginId: string; taskType: string; taskVersion: number; payload: Record<string, unknown>; timing: unknown; nextRunAt: Date | null; runWindowMinutes: number; createdAt: Date }
export interface FakeExecution { id: string; deviceUdid: string; status: string; pluginId: string; taskType: string; taskVersion: number; payload: Record<string, unknown>; scheduledFor: Date; error: string | null; createdAt: Date }

/** A SchedulerRepository stand-in holding rows in memory; records the calls a test cares about. */
export function fakeScheduler(schedules: FakeSchedule[] = [], executions: FakeExecution[] = []) {
    const calls: string[] = [];
    const byUdid = <T extends { deviceUdid: string }>(rows: T[], udid?: string | readonly string[]) =>
        Array.isArray(udid) ? rows.filter((row) => udid.includes(row.deviceUdid))
            : typeof udid === 'string' && udid ? rows.filter((row) => row.deviceUdid === udid) : rows;
    const scheduler = {
        calls, schedules, executions,
        async listSchedules(_limit: number, udid?: string | readonly string[]) { return byUdid(schedules, udid); },
        async listExecutions(_limit: number, udid?: string | readonly string[]) { return byUdid(executions, udid); },
        async schedule(id: string) { return schedules.find((row) => row.id === id) ?? null; },
        async execution(id: string) { const row = executions.find((entry) => entry.id === id); return row ? { ...row, logs: [] } : null; },
        async activeExecution() { return null; },
        async createTask(input: { deviceUdid: string; task: { pluginId: string; taskType: string; taskVersion: number; payload: Record<string, unknown> }; timing: unknown }) {
            calls.push(`create:${input.deviceUdid}`);
            const row: FakeSchedule = {
                id: crypto.randomUUID(), deviceUdid: input.deviceUdid, status: 'active', ...input.task, timing: input.timing,
                nextRunAt: null, runWindowMinutes: 30, createdAt: new Date(),
            };
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
        async registerAssets(files: Array<{ relativePath: string }>) { return files.map((file) => ({ id: crypto.randomUUID(), ...file })); },
        async deleteAssets() { calls.push('delete-assets'); },
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
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const { PluginRegistry } = await import('../src/registry.js');
    const { createTikTokPlugin } = await import('../src/tiktok-plugin.js');
    const store = new MemoryAuthStore();
    const clock = options.clock ?? testClock();
    const audit: Array<{ event: string; actor?: string; target?: string; ip?: string; detail?: string }> = [];
    const accounts = new AccountService({
        store, now: clock.now,
        throttle: new LoginThrottle({ now: () => clock.now().getTime() }),
    });
    const provider = createBuiltinAuthProvider(accounts);
    const scheduler = fakeScheduler(options.schedules, options.executions);
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
    accounts.audit = (event) => audit.push(event);
    return { app, store, accounts, provider, scheduler, remote, clock, audit };
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

/** A user row with a placeholder hash (these tests never sign in with a password). */
export async function seedUser(store: MemoryAuthStore, username: string, role: 'admin' | 'operator', displayName = username) {
    return store.createUser({ username, role, displayName, passwordHash: 'scrypt$1$1$1$x$y', mustChangePassword: false });
}

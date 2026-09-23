import { and, asc, eq, inArray, lt, ne, or } from 'drizzle-orm';

import type { DatabaseConnection } from '../database/client.js';
import { authGrants, authGroupMembers, authGroups, authSessions, authUsers } from '../database/schema.js';
import {
    AuthConflictError, type AuthStore, type GrantRecord, type GroupRecord, type MembershipRecord, type NewGrant,
    type NewSession, type NewUser, type SessionRecord, type UserPatch, type UserRecord,
} from './store.js';

function isUniqueViolation(error: unknown): boolean {
    const candidate = error as { code?: string; cause?: { code?: string } };
    return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

async function conflictAware<T>(message: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (isUniqueViolation(error)) throw new AuthConflictError(message);
        throw error;
    }
}

/** The built-in accounts in Postgres schema `auth` (drizzle/0002_builtin_auth.sql). */
export class PgAuthStore implements AuthStore {
    constructor(private readonly connection: DatabaseConnection) {}

    private get db() { return this.connection.db; }

    async listUsers(): Promise<UserRecord[]> {
        return this.db.select().from(authUsers).orderBy(asc(authUsers.username));
    }

    async userById(id: string): Promise<UserRecord | null> {
        const [row] = await this.db.select().from(authUsers).where(eq(authUsers.id, id)).limit(1);
        return row ?? null;
    }

    async userByUsername(username: string): Promise<UserRecord | null> {
        const [row] = await this.db.select().from(authUsers).where(eq(authUsers.username, username)).limit(1);
        return row ?? null;
    }

    async createUser(input: NewUser): Promise<UserRecord> {
        return conflictAware('That username is already taken', async () => {
            const [row] = await this.db.insert(authUsers).values(input).returning();
            return row!;
        });
    }

    async updateUser(id: string, patch: UserPatch): Promise<UserRecord | null> {
        const [row] = await this.db.update(authUsers).set({ ...patch, updatedAt: new Date() })
            .where(eq(authUsers.id, id)).returning();
        return row ?? null;
    }

    async deleteUser(id: string): Promise<boolean> {
        return (await this.db.delete(authUsers).where(eq(authUsers.id, id)).returning({ id: authUsers.id })).length > 0;
    }

    async listGroups(): Promise<GroupRecord[]> {
        return this.db.select().from(authGroups).orderBy(asc(authGroups.name));
    }

    async groupById(id: string): Promise<GroupRecord | null> {
        const [row] = await this.db.select().from(authGroups).where(eq(authGroups.id, id)).limit(1);
        return row ?? null;
    }

    async createGroup(input: { name: string; description: string }): Promise<GroupRecord> {
        return conflictAware('A group with that name already exists', async () => {
            const [row] = await this.db.insert(authGroups).values(input).returning();
            return row!;
        });
    }

    async updateGroup(id: string, patch: Partial<Pick<GroupRecord, 'name' | 'description'>>): Promise<GroupRecord | null> {
        return conflictAware('A group with that name already exists', async () => {
            const [row] = await this.db.update(authGroups).set(patch).where(eq(authGroups.id, id)).returning();
            return row ?? null;
        });
    }

    async deleteGroup(id: string): Promise<boolean> {
        return (await this.db.delete(authGroups).where(eq(authGroups.id, id)).returning({ id: authGroups.id })).length > 0;
    }

    async listMemberships(): Promise<MembershipRecord[]> {
        return this.db.select({ groupId: authGroupMembers.groupId, userId: authGroupMembers.userId }).from(authGroupMembers);
    }

    async groupIdsForUser(userId: string): Promise<string[]> {
        const rows = await this.db.select({ groupId: authGroupMembers.groupId }).from(authGroupMembers)
            .where(eq(authGroupMembers.userId, userId));
        return rows.map(({ groupId }) => groupId);
    }

    async addMember(groupId: string, userId: string): Promise<void> {
        await this.db.insert(authGroupMembers).values({ groupId, userId }).onConflictDoNothing();
    }

    async removeMember(groupId: string, userId: string): Promise<boolean> {
        const rows = await this.db.delete(authGroupMembers)
            .where(and(eq(authGroupMembers.groupId, groupId), eq(authGroupMembers.userId, userId)))
            .returning({ userId: authGroupMembers.userId });
        return rows.length > 0;
    }

    async listGrants(): Promise<GrantRecord[]> {
        return this.db.select().from(authGrants).orderBy(asc(authGrants.createdAt));
    }

    async grantsForSubjects(userId: string, groupIds: readonly string[]): Promise<GrantRecord[]> {
        const subject = groupIds.length
            ? or(eq(authGrants.userId, userId), inArray(authGrants.groupId, [...groupIds]))
            : eq(authGrants.userId, userId);
        return this.db.select().from(authGrants).where(subject);
    }

    async createGrant(input: NewGrant): Promise<GrantRecord> {
        const [row] = await this.db.insert(authGrants).values(input).returning();
        return row!;
    }

    async deleteGrant(id: string): Promise<GrantRecord | null> {
        const [row] = await this.db.delete(authGrants).where(eq(authGrants.id, id)).returning();
        return row ?? null;
    }

    async createSession(input: NewSession): Promise<SessionRecord> {
        const [row] = await this.db.insert(authSessions).values(input).returning();
        return row!;
    }

    async sessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
        const [row] = await this.db.select().from(authSessions).where(eq(authSessions.tokenHash, tokenHash)).limit(1);
        return row ?? null;
    }

    async touchSession(id: string, lastSeenAt: Date): Promise<void> {
        await this.db.update(authSessions).set({ lastSeenAt }).where(eq(authSessions.id, id));
    }

    async deleteSession(id: string): Promise<void> {
        await this.db.delete(authSessions).where(eq(authSessions.id, id));
    }

    async deleteUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
        await this.db.delete(authSessions).where(exceptSessionId
            ? and(eq(authSessions.userId, userId), ne(authSessions.id, exceptSessionId))
            : eq(authSessions.userId, userId));
    }

    async deleteExpiredSessions(now: Date): Promise<number> {
        return (await this.db.delete(authSessions).where(lt(authSessions.expiresAt, now)).returning({ id: authSessions.id })).length;
    }

    async close(): Promise<void> {
        await this.connection.close();
    }
}

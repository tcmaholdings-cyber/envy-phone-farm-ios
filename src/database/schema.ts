import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { JsonObject, ScheduleTiming } from '../types.js';

export const schedulerSchema = pgSchema('scheduler');
export const scheduleStatus = schedulerSchema.enum('schedule_status', ['active', 'paused', 'completed', 'cancelled']);
export const executionStatus = schedulerSchema.enum('execution_status', [
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'stopped',
]);

const taskColumns = {
    pluginId: text('plugin_id').notNull(),
    taskType: text('task_type').notNull(),
    taskVersion: integer('task_version').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
};

export const schedules = schedulerSchema.table('schedules', {
    id: uuid('id').primaryKey().defaultRandom(), deviceUdid: text('device_udid').notNull(), ...taskColumns,
    timing: jsonb('timing').$type<ScheduleTiming>().notNull(),
    status: scheduleStatus('status').notNull().default('active'),
    runWindowMinutes: integer('run_window_minutes').notNull().default(30),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('schedules_due_idx').on(table.status, table.nextRunAt),
    index('schedules_device_idx').on(table.deviceUdid, table.createdAt),
    index('schedules_plugin_idx').on(table.pluginId, table.taskType, table.taskVersion),
]);

export const executions = schedulerSchema.table('executions', {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    deviceUdid: text('device_udid').notNull(), ...taskColumns,
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: executionStatus('status').notNull().default('queued'), queueJobId: text('queue_job_id'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }), exitCode: integer('exit_code'),
    error: text('error'), stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true, mode: 'date' }),
    // Set once the task reports its irreversible side effect (e.g. the TikTok
    // Post tap). An execution with this set is never re-run: not by a pg-boss
    // retry, not by the dashboard Retry button, not after a worker restart.
    effectCommittedAt: timestamp('effect_committed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('executions_schedule_occurrence_idx').on(table.scheduleId, table.scheduledFor),
    index('executions_device_status_idx').on(table.deviceUdid, table.status),
    index('executions_plugin_idx').on(table.pluginId, table.taskType, table.taskVersion),
]);

export const executionAttempts = schedulerSchema.table('execution_attempts', {
    executionId: uuid('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }), exitCode: integer('exit_code'), error: text('error'),
}, (table) => [primaryKey({ columns: [table.executionId, table.attempt] })]);

export const executionLogs = schedulerSchema.table('execution_logs', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    executionId: uuid('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(), line: text('line').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('execution_logs_execution_idx').on(table.executionId, table.id)]);

export const assets = schedulerSchema.table('assets', {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull().unique(), originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(), size: bigint('size', { mode: 'number' }).notNull(), sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('assets_schedule_idx').on(table.scheduleId), index('assets_execution_idx').on(table.executionId)]);

// One row per host running a worker, refreshed every ~15 s
// (src/observability/heartbeat.ts). /health/ready and /metrics read its age:
// a worker that hangs or dies stops refreshing it.
export const workerHeartbeats = schedulerSchema.table('worker_heartbeats', {
    host: text('host').primaryKey(),
    pid: integer('pid').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    beatAt: timestamp('beat_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    queues: integer('queues').notNull().default(0),
});

// ---------- built-in accounts (PHONE_FARM_AUTH_PLUGIN=builtin) ----------
// Only password hashes and session-token hashes are stored; never a raw
// password or cookie token.
export const authSchema = pgSchema('auth');
export const authUserRole = authSchema.enum('user_role', ['admin', 'operator']);
export const authGrantScope = authSchema.enum('grant_scope', ['all', 'rack', 'model', 'device']);
export const authGrantLevel = authSchema.enum('grant_level', ['view', 'operate']);

export const authUsers = authSchema.table('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull().unique(),
    displayName: text('display_name').notNull(),
    role: authUserRole('role').notNull().default('operator'),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    disabled: boolean('disabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
}, (table) => [check('users_username_lowercase', sql`${table.username} = lower(${table.username})`)]);

export const authGroups = authSchema.table('groups', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const authGroupMembers = authSchema.table('group_members', {
    groupId: uuid('group_id').notNull().references(() => authGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.groupId, table.userId] }), index('group_members_user_idx').on(table.userId)]);

export const authGrants = authSchema.table('grants', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => authGroups.id, { onDelete: 'cascade' }),
    scopeType: authGrantScope('scope_type').notNull(),
    scopeValue: text('scope_value'),
    level: authGrantLevel('level').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    check('grants_one_subject', sql`(${table.userId} is null) <> (${table.groupId} is null)`),
    check('grants_scope_value', sql`(${table.scopeType} = 'all') = (${table.scopeValue} is null)`),
    index('grants_user_idx').on(table.userId),
    index('grants_group_idx').on(table.groupId),
]);

export const authSessions = authSchema.table('sessions', {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
}, (table) => [index('sessions_user_idx').on(table.userId), index('sessions_expires_idx').on(table.expiresAt)]);

export type ScheduleRow = typeof schedules.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;

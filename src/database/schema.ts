import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { DEFAULT_TENANT_ID, type TenantQuotas } from '../tenancy.js';
import type { JsonObject, ScheduleTiming } from '../types.js';

export const schedulerSchema = pgSchema('scheduler');
export const scheduleStatus = schedulerSchema.enum('schedule_status', ['active', 'paused', 'completed', 'cancelled']);
export const executionStatus = schedulerSchema.enum('execution_status', [
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'stopped',
]);

/**
 * The owning tenant (migration 0006). The default is the pre-tenancy tenant so a
 * previous release, which never names one, keeps working after the migration;
 * this release always sets it explicitly.
 */
const tenantColumn = () => uuid('tenant_id').notNull().default(sql.raw(`'${DEFAULT_TENANT_ID}'::uuid`))
    .references(() => authTenants.id, { onDelete: 'restrict' });

const taskColumns = {
    pluginId: text('plugin_id').notNull(),
    taskType: text('task_type').notNull(),
    taskVersion: integer('task_version').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
};

export const schedules = schedulerSchema.table('schedules', {
    id: uuid('id').primaryKey().defaultRandom(), deviceUdid: text('device_udid').notNull(), ...taskColumns,
    tenantId: tenantColumn(),
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
    index('schedules_tenant_idx').on(table.tenantId, table.createdAt),
]);

export const executions = schedulerSchema.table('executions', {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    deviceUdid: text('device_udid').notNull(), ...taskColumns,
    tenantId: tenantColumn(),
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
    index('executions_tenant_idx').on(table.tenantId, table.createdAt),
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
    tenantId: tenantColumn(),
    // Who uploaded it; null for uploads that predate tenants or whose uploader was deleted.
    uploadedBy: uuid('uploaded_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('assets_schedule_idx').on(table.scheduleId), index('assets_execution_idx').on(table.executionId),
    index('assets_tenant_idx').on(table.tenantId),
]);

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

// ---------- fleet: hosts and their phones (PHONE_FARM_REGISTRY=postgres) ----------
// Several Macs share one database; each owns the phones on its USB tree.
// Device passcodes are NOT stored here: they stay in a 0600 file on the owning
// host (src/devices/device-secrets.ts); `has_passcode` is only the marker the
// dashboard shows.
export const fleetSchema = pgSchema('fleet');

export const fleetHosts = fleetSchema.table('hosts', {
    // PHONE_FARM_HOST_ID, default os.hostname()
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    // Where another host's dashboard reaches this host's /agent/* routes (Tailscale), e.g. http://100.64.0.2:3001
    agentUrl: text('agent_url'),
    // Refreshed every ~15 s by the host's worker and wda-service (src/hosts/lease.ts).
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    version: text('version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const fleetDevices = fleetSchema.table('devices', {
    udid: text('udid').primaryKey(),
    hostId: text('host_id').notNull().references(() => fleetHosts.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    coordinateProfile: text('coordinate_profile'),
    wdaLocalPort: integer('wda_local_port').notNull(),
    mjpegLocalPort: integer('mjpeg_local_port').notNull(),
    rack: text('rack'),
    rackSlot: text('rack_slot'),
    model: text('model'),
    disabled: boolean('disabled').notNull().default(false),
    coordinates: jsonb('coordinates').$type<Record<string, unknown>>(),
    pluginData: jsonb('plugin_data').$type<Record<string, JsonObject>>().notNull().default({}),
    // Apple Team whose WDA build this phone runs (WDA_XCTESTRUN_<TEAM>); null means the host default.
    signingTeam: text('signing_team'),
    hasPasscode: boolean('has_passcode').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('devices_host_wda_port_idx').on(table.hostId, table.wdaLocalPort),
    uniqueIndex('devices_host_mjpeg_port_idx').on(table.hostId, table.mjpegLocalPort),
    check('devices_wda_port_range', sql`${table.wdaLocalPort} between 1 and 65535`),
    check('devices_mjpeg_port_range', sql`${table.mjpegLocalPort} between 1 and 65535`),
]);

// ---------- built-in accounts (PHONE_FARM_AUTH_PLUGIN=builtin) ----------
// Only password hashes and session-token hashes are stored; never a raw
// password or cookie token.
export const authSchema = pgSchema('auth');
// platform: Beloura staff, every tenant (tenant_id null). admin: one tenant's
// users, groups and phones. operator: granted phones within one tenant.
export const authUserRole = authSchema.enum('user_role', ['platform', 'admin', 'operator']);
export const authTenantStatus = authSchema.enum('tenant_status', ['active', 'suspended']);
export const authGrantScope = authSchema.enum('grant_scope', ['all', 'rack', 'model', 'device']);
export const authGrantLevel = authSchema.enum('grant_level', ['view', 'operate']);

// A paying organisation (migration 0006). Suspended: its users cannot sign in
// and its schedules are not queued.
export const authTenants = authSchema.table('tenants', {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: authTenantStatus('status').notNull().default('active'),
    quotas: jsonb('quotas').$type<TenantQuotas>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [check('tenants_slug_format', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,39}$'`)]);

export const authUsers = authSchema.table('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull().unique(),
    // Null only for platform staff (users_tenant_matches_role).
    tenantId: uuid('tenant_id').default(sql.raw(`'${DEFAULT_TENANT_ID}'::uuid`)).references(() => authTenants.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    role: authUserRole('role').notNull().default('operator'),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    disabled: boolean('disabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
    check('users_username_lowercase', sql`${table.username} = lower(${table.username})`),
    check('users_tenant_matches_role', sql`(${table.role} = 'platform') = (${table.tenantId} is null)`),
    index('users_tenant_idx').on(table.tenantId),
]);

export const authGroups = authSchema.table('groups', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('groups_tenant_name_idx').on(table.tenantId, table.name)]);

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

// Which tenant a phone belongs to, keyed by UDID so it works with whichever
// device registry backend is in use. A phone with no row belongs to the default
// tenant; that is how a pre-tenancy farm keeps every phone.
export const authTenantDevices = authSchema.table('tenant_devices', {
    udid: text('udid').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => authTenants.id, { onDelete: 'restrict' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('tenant_devices_tenant_idx').on(table.tenantId)]);

// Append-only: a trigger refuses UPDATE and TRUNCATE, and DELETE of anything
// younger than 30 days (retention pruning only). No request bodies, no secrets.
export const authAuditLog = authSchema.table('audit_log', {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    tenantId: uuid('tenant_id'),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role'),
    ip: text('ip'),
    method: text('method'),
    route: text('route'),
    event: text('event').notNull().default('http'),
    targetUdid: text('target_udid'),
    targetIds: jsonb('target_ids').$type<string[]>(),
    status: integer('status'),
    requestId: text('request_id'),
    detail: text('detail'),
}, (table) => [
    index('audit_log_tenant_idx').on(table.tenantId, table.id),
    index('audit_log_at_idx').on(table.at),
]);

// Failed sign-ins per username and per client IP, shared by every web replica
// and surviving restarts (src/auth/throttle.ts).
export const authLoginThrottle = authSchema.table('login_throttle', {
    key: text('key').primaryKey(),
    failures: integer('failures').notNull(),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }).notNull(),
}, (table) => [index('login_throttle_last_failure_idx').on(table.lastFailureAt)]);

export type FleetDeviceRow = typeof fleetDevices.$inferSelect;
export type FleetHostRow = typeof fleetHosts.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;

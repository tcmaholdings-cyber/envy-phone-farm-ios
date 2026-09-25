import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { DatabaseConnection } from '../database/client.js';
import {
    assets, executionAttempts, executionLogs, executions, schedules,
    type ExecutionRow, type ScheduleRow,
} from '../database/schema.js';
import type { TaskDefinition } from '../plugin.js';
import type { PluginRegistry } from '../registry.js';
import type { CreateTaskInput, JsonObject, ScheduleTiming, StoredAsset, TaskEnvelope } from '../types.js';
import { EFFECT_COMMITTED_REFUSAL } from './effects.js';
import { ensureDeviceQueue, queueNameForDevice } from './queue.js';
import { initialRunAt, latestDueOccurrence } from './recurrence.js';
import { DEFAULT_MIN_SCHEDULE_GAP_MINUTES, estimatedTaskWindow, validateTaskInput, windowsTooClose } from './validation.js';

export interface ExecutionDetail extends ExecutionRow { logs: string[] }

/** Thrown by setScheduleStatus for a disallowed status change (e.g. resuming a completed schedule). */
export class ScheduleTransitionError extends Error {}

/**
 * Schedule status state machine. A completed or cancelled schedule can only be
 * cancelled — never resumed, which would recompute nextRunAt and re-fire a
 * one-shot (a duplicate public post).
 */
export function scheduleTransitionAllowed(from: string, to: 'active' | 'paused' | 'cancelled'): boolean {
    if (from === to) return true;
    const allowed: Record<string, Array<typeof to>> = {
        active: ['paused', 'cancelled'],
        paused: ['active', 'cancelled'],
        completed: ['cancelled'],
        cancelled: [],
    };
    return (allowed[from] ?? []).includes(to);
}

/** pg-boss refuses an expiry above 24 h. */
export const MAX_JOB_EXPIRY_SECONDS = 24 * 60 * 60;
const JOB_EXPIRY_MARGIN_SECONDS = 600;
const MIN_JOB_EXPIRY_SECONDS = 900;

/**
 * How long pg-boss lets one job run before it expires it (and, if retries are
 * left, hands it to another worker while the first is still going). The
 * executor may spend the whole run window waiting for the phone before the
 * task even starts, so the expiry covers window + task duration + a margin.
 */
export function jobExpirySeconds(runWindowMinutes: number, estimatedDurationMs: number): number {
    const window = Math.max(0, runWindowMinutes) * 60;
    const duration = Math.ceil(Math.max(0, estimatedDurationMs) / 1000);
    return Math.min(MAX_JOB_EXPIRY_SECONDS, Math.max(MIN_JOB_EXPIRY_SECONDS, window + duration + JOB_EXPIRY_MARGIN_SECONDS));
}

type DueOccurrence = NonNullable<ReturnType<typeof latestDueOccurrence>>;

/** A schedules row as materializeDue reads it (raw SQL, snake_case). */
export interface DueScheduleRow {
    id: string; device_udid: string; plugin_id: string; task_type: string; task_version: number;
    payload: JsonObject; timing: ScheduleTiming; run_window_minutes: number; next_run_at: Date;
}

export type MaterializationPlan =
    | { kind: 'enqueue'; occurrence: DueOccurrence; definition: TaskDefinition; expireInSeconds: number }
    | { kind: 'skip'; occurrence: DueOccurrence; error: string };

/**
 * What to do with one due schedule. A task the registry cannot resolve (its
 * version was uninstalled, its plugin removed) is recorded as a skipped
 * execution and the schedule moves on — it must not throw, which used to roll
 * back the whole batch and block every other schedule every 5 s.
 */
export function planMaterialization(plugins: PluginRegistry, row: DueScheduleRow, now: Date): MaterializationPlan | null {
    const occurrence = latestDueOccurrence(row.timing, new Date(row.next_run_at), now);
    if (!occurrence) return null;
    const task: TaskEnvelope = { pluginId: row.plugin_id, taskType: row.task_type, taskVersion: row.task_version, payload: row.payload };
    try {
        const definition = plugins.task(task);
        return {
            kind: 'enqueue', occurrence, definition,
            expireInSeconds: jobExpirySeconds(row.run_window_minutes, definition.estimateDurationMs(task.payload)),
        };
    } catch (error) {
        return { kind: 'skip', occurrence, error: `Skipped: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** Why startAttempt did or did not start an attempt. */
export type StartAttemptResult =
    | { status: 'started'; execution: ExecutionRow; attempt: number }
    | { status: 'effect-committed'; execution: ExecutionRow }
    | { status: 'not-runnable' };

type Transaction = Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0];

/** The root cause's message only — drizzle wraps it in "Failed query … params: …". */
export function errorSummary(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    return error.cause instanceof Error ? error.cause.message : error.message;
}

function taskEnvelope(row: Pick<ScheduleRow, 'pluginId' | 'taskType' | 'taskVersion' | 'payload'>): TaskEnvelope {
    return { pluginId: row.pluginId, taskType: row.taskType, taskVersion: row.taskVersion, payload: row.payload };
}

export class SchedulerRepository {
    constructor(
        readonly connection: DatabaseConnection,
        readonly boss: PgBoss,
        readonly plugins: PluginRegistry,
    ) {}

    async createTask(
        input: CreateTaskInput,
        devicePluginData: JsonObject = {},
        now = new Date(),
        assetIds: string[] = [],
    ): Promise<ScheduleRow> {
        const validated = validateTaskInput(this.plugins, input, devicePluginData, now);
        const nextRunAt = initialRunAt(validated.timing, now);
        await this.assertNoScheduleConflict(validated.deviceUdid, validated.task, nextRunAt);
        await ensureDeviceQueue(this.boss, validated.deviceUdid);
        const [schedule] = await this.connection.db.insert(schedules).values({
            deviceUdid: validated.deviceUdid,
            pluginId: validated.task.pluginId,
            taskType: validated.task.taskType,
            taskVersion: validated.task.taskVersion,
            payload: validated.task.payload,
            timing: validated.timing,
            runWindowMinutes: validated.runWindowMinutes ?? Number(process.env.SCHEDULER_RUN_WINDOW_MINUTES ?? 30),
            nextRunAt,
        }).returning();
        if (!schedule) throw new Error('Unable to create schedule');
        await this.attachAssets(schedule.id, assetIds);
        if (schedule.nextRunAt && schedule.nextRunAt <= now) await this.materializeDue(now, schedule.id);
        return schedule;
    }

    private async assertNoScheduleConflict(deviceUdid: string, task: TaskEnvelope, start: Date, excludeId?: string): Promise<void> {
        const gap = Number(process.env.SCHEDULER_MIN_TASK_GAP_MINUTES ?? DEFAULT_MIN_SCHEDULE_GAP_MINUTES);
        if (gap <= 0) return;
        const candidate = estimatedTaskWindow(this.plugins, task, start);
        const others = await this.connection.db.select().from(schedules).where(and(
            eq(schedules.deviceUdid, deviceUdid), eq(schedules.status, 'active'),
        ));
        for (const other of others) {
            if (other.id === excludeId || !other.nextRunAt) continue;
            const otherWindow = estimatedTaskWindow(this.plugins, taskEnvelope(other), other.nextRunAt);
            if (windowsTooClose(candidate, otherWindow, gap)) {
                throw new Error(`This schedule is within ${gap} minutes of another schedule on this device`);
            }
        }
    }

    async registerAssets(files: Array<{
        relativePath: string; originalName: string; mimeType: string; size: number; sha256: string;
    }>): Promise<Array<{ id: string; name: string; mimeType: string }>> {
        if (!files.length) return [];
        const rows = await this.connection.db.insert(assets).values(files).returning();
        return rows.map((asset) => ({ id: asset.id, name: asset.originalName, mimeType: asset.mimeType }));
    }

    async attachAssets(scheduleId: string, assetIds: string[]): Promise<void> {
        if (assetIds.length) await this.connection.db.update(assets).set({ scheduleId }).where(inArray(assets.id, assetIds));
    }

    async deleteAssets(assetIds: string[]): Promise<void> { await this.purgeAssetIds(assetIds); }

    /** Newest first. `deviceUdid` narrows to one phone, or to a set of phones (an operator's). */
    async listSchedules(limit = 100, deviceUdid?: string | readonly string[]): Promise<ScheduleRow[]> {
        const query = this.connection.db.select().from(schedules);
        if (Array.isArray(deviceUdid)) {
            if (!deviceUdid.length) return [];
            return query.where(inArray(schedules.deviceUdid, [...deviceUdid])).orderBy(desc(schedules.createdAt)).limit(limit);
        }
        return typeof deviceUdid === 'string' && deviceUdid
            ? query.where(eq(schedules.deviceUdid, deviceUdid)).orderBy(desc(schedules.createdAt)).limit(limit)
            : query.orderBy(desc(schedules.createdAt)).limit(limit);
    }

    async schedule(id: string): Promise<ScheduleRow | null> {
        const [row] = await this.connection.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
        return row ?? null;
    }

    /** Newest first. `deviceUdid` narrows to one phone, or to a set of phones (an operator's). */
    async listExecutions(limit = 100, deviceUdid?: string | readonly string[]): Promise<ExecutionRow[]> {
        const query = this.connection.db.select().from(executions);
        if (Array.isArray(deviceUdid)) {
            if (!deviceUdid.length) return [];
            return query.where(inArray(executions.deviceUdid, [...deviceUdid])).orderBy(desc(executions.createdAt)).limit(limit);
        }
        return typeof deviceUdid === 'string' && deviceUdid
            ? query.where(eq(executions.deviceUdid, deviceUdid)).orderBy(desc(executions.createdAt)).limit(limit)
            : query.orderBy(desc(executions.createdAt)).limit(limit);
    }

    async execution(id: string): Promise<ExecutionDetail | null> {
        const [row] = await this.connection.db.select().from(executions).where(eq(executions.id, id)).limit(1);
        if (!row) return null;
        const logs = await this.connection.db.select({ line: executionLogs.line }).from(executionLogs)
            .where(eq(executionLogs.executionId, id)).orderBy(executionLogs.id);
        return { ...row, logs: logs.map(({ line }) => line) };
    }

    async executionAssets(execution: ExecutionRow): Promise<StoredAsset[]> {
        const rows = await this.connection.db.select().from(assets).where(or(
            eq(assets.executionId, execution.id),
            ...(execution.scheduleId ? [eq(assets.scheduleId, execution.scheduleId)] : []),
        ));
        const root = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
        return rows.map((asset) => ({
            id: asset.id, path: path.resolve(root, asset.relativePath), name: asset.originalName,
            mimeType: asset.mimeType, size: asset.size, sha256: asset.sha256,
        }));
    }

    async activeExecution(deviceUdid: string): Promise<ExecutionRow | null> {
        const [row] = await this.connection.db.select().from(executions).where(and(
            eq(executions.deviceUdid, deviceUdid), inArray(executions.status, ['queued', 'running']),
        )).orderBy(desc(executions.createdAt)).limit(1);
        return row ?? null;
    }

    async updateSchedule(
        id: string,
        changes: { timing?: ScheduleTiming; task?: TaskEnvelope; runWindowMinutes?: number },
        devicePluginData: JsonObject = {},
        now = new Date(),
    ): Promise<ScheduleRow | null> {
        const [current] = await this.connection.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
        if (!current || current.status === 'cancelled' || current.status === 'completed') return null;
        const input = validateTaskInput(this.plugins, {
            deviceUdid: current.deviceUdid,
            task: changes.task ?? taskEnvelope(current),
            timing: changes.timing ?? current.timing,
            runWindowMinutes: changes.runWindowMinutes ?? current.runWindowMinutes,
        }, devicePluginData, now);
        const nextRunAt = changes.timing ? initialRunAt(input.timing, now) : current.nextRunAt;
        if (nextRunAt) await this.assertNoScheduleConflict(input.deviceUdid, input.task, nextRunAt, id);
        const [updated] = await this.connection.db.update(schedules).set({
            pluginId: input.task.pluginId, taskType: input.task.taskType, taskVersion: input.task.taskVersion,
            payload: input.task.payload, timing: input.timing, runWindowMinutes: input.runWindowMinutes,
            nextRunAt, updatedAt: now,
        }).where(eq(schedules.id, id)).returning();
        return updated ?? null;
    }

    async setScheduleStatus(id: string, status: 'active' | 'paused' | 'cancelled', now = new Date()): Promise<ScheduleRow | null> {
        const [current] = await this.connection.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
        if (!current) return null;
        if (!scheduleTransitionAllowed(current.status, status)) {
            throw new ScheduleTransitionError(`Cannot change a ${current.status} schedule to ${status}`);
        }
        const [updated] = await this.connection.db.update(schedules).set({
            status, nextRunAt: status === 'active' ? initialRunAt(current.timing, now) : current.nextRunAt, updatedAt: now,
        }).where(eq(schedules.id, id)).returning();
        if (status === 'cancelled') {
            const queued = await this.connection.db.select().from(executions).where(and(
                eq(executions.scheduleId, id), eq(executions.status, 'queued'),
            ));
            for (const execution of queued) {
                if (execution.queueJobId) await this.boss.cancel(queueNameForDevice(execution.deviceUdid), execution.queueJobId);
            }
            await this.connection.db.update(executions).set({ status: 'cancelled', finishedAt: now, updatedAt: now })
                .where(and(eq(executions.scheduleId, id), eq(executions.status, 'queued')));
            await this.purgeScheduleAssetsIfIdle(id);
        }
        return updated ?? null;
    }

    async materializeDue(now = new Date(), onlyScheduleId?: string): Promise<number> {
        let count = 0;
        await this.connection.db.transaction(async (tx) => {
            const conditions = onlyScheduleId
                ? sql`status = 'active' and next_run_at <= ${now} and id = ${onlyScheduleId}::uuid`
                : sql`status = 'active' and next_run_at <= ${now}`;
            const result = await tx.execute(sql`select id, device_udid, plugin_id, task_type, task_version, payload,
                timing, run_window_minutes, next_run_at from scheduler.schedules where ${conditions}
                order by next_run_at for update skip locked limit 100`);
            for (const row of result.rows as unknown as DueScheduleRow[]) {
                // One savepoint per schedule: a row that fails (a queue error, a
                // bad payload) rolls back alone and the rest of the batch still
                // gets queued. It stays due, so it is retried on the next tick.
                try {
                    if (await tx.transaction((savepoint) => this.materializeRow(savepoint, row, now))) count++;
                } catch (error) {
                    // Not the error object: drizzle's message embeds the query
                    // params, which carry the task payload (account, caption).
                    console.error(`Could not queue schedule ${row.id}: ${errorSummary(error)}`);
                }
            }
        });
        return count;
    }

    /** Queue (or record as skipped) one due schedule inside `tx`. True when a job was queued. */
    protected async materializeRow(tx: Transaction, row: DueScheduleRow, now: Date): Promise<boolean> {
        const plan = planMaterialization(this.plugins, row, now);
        if (!plan) return false;
        const { occurrence } = plan;
        const occurrenceColumns = {
            scheduleId: row.id, deviceUdid: row.device_udid,
            pluginId: row.plugin_id, taskType: row.task_type, taskVersion: row.task_version, payload: row.payload,
            scheduledFor: occurrence.scheduledFor,
            deadlineAt: new Date(occurrence.scheduledFor.getTime() + row.run_window_minutes * 60_000),
        };
        const [execution] = await tx.insert(executions).values(plan.kind === 'skip'
            ? { ...occurrenceColumns, status: 'skipped' as const, error: plan.error, finishedAt: now }
            : occurrenceColumns).onConflictDoNothing().returning();
        // Advance even when skipping, so an uninstalled task version is not
        // re-evaluated every 5 s; a recurring schedule records one skip per occurrence.
        await tx.update(schedules).set({
            nextRunAt: occurrence.nextRunAt, status: occurrence.nextRunAt ? 'active' : 'completed', updatedAt: now,
        }).where(eq(schedules.id, row.id));
        if (!execution || plan.kind === 'skip') return false;
        const policy = plan.definition.retryPolicy(row.payload);
        // A pgboss schema restored without its queues would otherwise leave the
        // schedule due forever; creating the queue is idempotent.
        const queue = await ensureDeviceQueue(this.boss, row.device_udid);
        const queueJobId = await this.boss.send(queue, { executionId: execution.id }, {
            db: fromDrizzle(tx, sql), retryLimit: policy.retryLimit,
            retryDelay: policy.retryDelaySeconds, retryBackoff: policy.retryBackoff,
            expireInSeconds: plan.expireInSeconds,
        });
        if (!queueJobId) throw new Error('Queue rejected an execution job');
        await tx.update(executions).set({ queueJobId }).where(eq(executions.id, execution.id));
        return true;
    }

    /**
     * Claim an execution for a new attempt. Refuses an execution that already
     * committed its side effect (whatever re-delivered it: a pg-boss retry, an
     * expired job, a restart). The attempt number continues from the recorded
     * attempts, so a re-queued execution does not overwrite attempt 1.
     */
    async startAttempt(id: string, now = new Date()): Promise<StartAttemptResult> {
        const [row] = await this.connection.db.update(executions).set({
            status: 'running', startedAt: now, updatedAt: now, error: null,
        }).where(and(
            eq(executions.id, id), inArray(executions.status, ['queued', 'running']), isNull(executions.effectCommittedAt),
        )).returning();
        if (!row) {
            const [current] = await this.connection.db.select().from(executions).where(eq(executions.id, id)).limit(1);
            if (current?.effectCommittedAt && ['queued', 'running'].includes(current.status)) {
                return { status: 'effect-committed', execution: current };
            }
            return { status: 'not-runnable' };
        }
        const [previous] = await this.connection.db.select({ latest: sql<number>`coalesce(max(${executionAttempts.attempt}), 0)::int` })
            .from(executionAttempts).where(eq(executionAttempts.executionId, id));
        const attempt = Number(previous?.latest ?? 0) + 1;
        await this.connection.db.insert(executionAttempts).values({ executionId: id, attempt }).onConflictDoNothing();
        return { status: 'started', execution: row, attempt };
    }

    /** Record that the execution's irreversible side effect happened (first call wins). */
    async markEffectCommitted(id: string, now = new Date()): Promise<void> {
        await this.connection.db.update(executions).set({ effectCommittedAt: now, updatedAt: now })
            .where(and(eq(executions.id, id), isNull(executions.effectCommittedAt)));
    }

    async appendLogs(id: string, attempt: number, lines: string[]): Promise<void> {
        if (lines.length) await this.connection.db.insert(executionLogs).values(lines.map((line) => ({ executionId: id, attempt, line })));
    }

    async finishAttempt(id: string, attempt: number, exitCode: number | null, error?: string): Promise<void> {
        await this.connection.db.update(executionAttempts).set({ finishedAt: new Date(), exitCode, error })
            .where(and(eq(executionAttempts.executionId, id), eq(executionAttempts.attempt, attempt)));
    }

    async finishExecution(id: string, status: 'succeeded' | 'failed' | 'cancelled' | 'stopped', exitCode: number | null, error?: string): Promise<void> {
        await this.connection.db.update(executions).set({
            status, exitCode, error, finishedAt: new Date(), updatedAt: new Date(),
        }).where(eq(executions.id, id));
        // Keep the media for retryable outcomes — the dashboard Retry button
        // accepts failed/stopped and would otherwise hit "asset is missing".
        // failed/stopped media is reclaimed by cleanup() once it ages out.
        if (status === 'succeeded' || status === 'cancelled') await this.purgeTerminalAssets(id);
    }

    /** Back to queued for a pg-boss retry. False (and nothing changes) once the side effect is committed. */
    async resetForRetry(id: string, error: string): Promise<boolean> {
        const rows = await this.connection.db.update(executions).set({ status: 'queued', error, updatedAt: new Date() })
            .where(and(eq(executions.id, id), isNull(executions.effectCommittedAt))).returning({ id: executions.id });
        return rows.length > 0;
    }

    /**
     * A worker shutdown interrupted this execution before its task started, so
     * nothing happened on the phone: queue it again (a fresh job, same
     * execution) for the next worker. The old job completes normally. False when
     * it cannot be re-queued (no longer running, effect committed, window over,
     * plugin gone) — the caller then records it as stopped.
     */
    async requeueAfterShutdown(id: string, message: string, now = new Date()): Promise<boolean> {
        const [current] = await this.connection.db.select().from(executions).where(eq(executions.id, id)).limit(1);
        if (!current || current.status !== 'running' || current.effectCommittedAt || current.deadlineAt <= now) return false;
        let definition: TaskDefinition;
        try {
            definition = this.plugins.task(taskEnvelope(current));
        } catch {
            return false;
        }
        const policy = definition.retryPolicy(current.payload);
        const remainingMinutes = Math.ceil((current.deadlineAt.getTime() - now.getTime()) / 60_000);
        let requeued = false;
        await this.connection.db.transaction(async (tx) => {
            const [row] = await tx.update(executions).set({ status: 'queued', error: message, updatedAt: now }).where(and(
                eq(executions.id, id), eq(executions.status, 'running'), isNull(executions.effectCommittedAt),
            )).returning();
            if (!row) return;
            const jobId = await this.boss.send(queueNameForDevice(row.deviceUdid), { executionId: row.id }, {
                db: fromDrizzle(tx, sql), retryLimit: policy.retryLimit,
                retryDelay: policy.retryDelaySeconds, retryBackoff: policy.retryBackoff,
                expireInSeconds: jobExpirySeconds(remainingMinutes, definition.estimateDurationMs(row.payload)),
            });
            if (!jobId) throw new Error('Queue rejected the re-queued execution');
            await tx.update(executions).set({ queueJobId: jobId }).where(eq(executions.id, row.id));
            requeued = true;
        });
        return requeued;
    }

    async stopRequested(id: string): Promise<boolean> {
        const [row] = await this.connection.db.select({ requested: executions.stopRequestedAt }).from(executions)
            .where(eq(executions.id, id)).limit(1);
        return Boolean(row?.requested);
    }

    async requestStop(id: string): Promise<'queued' | 'running' | 'not-found' | 'unsupported'> {
        const [execution] = await this.connection.db.select().from(executions).where(eq(executions.id, id)).limit(1);
        if (!execution) return 'not-found';
        if (execution.status === 'queued') {
            if (execution.queueJobId) await this.boss.cancel(queueNameForDevice(execution.deviceUdid), execution.queueJobId);
            await this.finishExecution(id, 'cancelled', null, 'Cancelled before execution');
            return 'queued';
        }
        if (execution.status !== 'running') return 'unsupported';
        // If the plugin was uninstalled, still let the operator request a stop —
        // a running execution nobody can inspect is exactly what needs stopping.
        let supportsStop = true;
        try {
            supportsStop = this.plugins.task(taskEnvelope(execution)).supportsStop(execution.payload);
        } catch { /* plugin unavailable */ }
        if (!supportsStop) return 'unsupported';
        await this.connection.db.update(executions).set({ stopRequestedAt: new Date(), updatedAt: new Date() })
            .where(eq(executions.id, id));
        return 'running';
    }

    async retryExecution(id: string, now = new Date()): Promise<ExecutionRow | null> {
        const [source] = await this.connection.db.select().from(executions).where(eq(executions.id, id)).limit(1);
        if (!source || !['failed', 'stopped'].includes(source.status)) return null;
        // Retrying a post that was already submitted would publish it twice.
        if (source.effectCommittedAt) return null;
        await ensureDeviceQueue(this.boss, source.deviceUdid);
        const definition = this.plugins.task(taskEnvelope(source));
        const policy = definition.retryPolicy(source.payload);
        const runWindowMinutes = Number(process.env.SCHEDULER_RUN_WINDOW_MINUTES ?? 30);
        let created: ExecutionRow | undefined;
        await this.connection.db.transaction(async (tx) => {
            [created] = await tx.insert(executions).values({
                scheduleId: source.scheduleId, deviceUdid: source.deviceUdid,
                pluginId: source.pluginId, taskType: source.taskType, taskVersion: source.taskVersion, payload: source.payload,
                scheduledFor: now, deadlineAt: new Date(now.getTime() + runWindowMinutes * 60_000),
            }).returning();
            if (!created) throw new Error('Unable to create retry execution');
            const jobId = await this.boss.send(queueNameForDevice(source.deviceUdid), { executionId: created.id }, {
                db: fromDrizzle(tx, sql), retryLimit: policy.retryLimit,
                retryDelay: policy.retryDelaySeconds, retryBackoff: policy.retryBackoff,
                // Match materializeDue: the job may wait out the whole run window
                // for the phone before the task runs, so both count toward expiry.
                expireInSeconds: jobExpirySeconds(runWindowMinutes, definition.estimateDurationMs(source.payload)),
            });
            if (!jobId) throw new Error('Unable to enqueue retry execution');
            await tx.update(executions).set({ queueJobId: jobId }).where(eq(executions.id, created.id));
            created = { ...created, queueJobId: jobId };
        });
        return created ?? null;
    }

    async reconcileQueueStates(): Promise<number> {
        const pending = await this.connection.db.select().from(executions).where(inArray(executions.status, ['queued', 'running']));
        let changed = 0;
        for (const execution of pending) {
            if (!execution.queueJobId) continue;
            const queue = queueNameForDevice(execution.deviceUdid);
            const [job] = await this.boss.findJobs(queue, { id: execution.queueJobId });
            if (execution.effectCommittedAt && (job?.state === 'retry' || job?.state === 'created')) {
                // Something would deliver it again (an expired job, an
                // interrupted attempt): cancel that instead of posting twice.
                await this.boss.cancel(queue, execution.queueJobId);
                await this.finishExecution(execution.id, 'failed', null, EFFECT_COMMITTED_REFUSAL); changed++;
            } else if (job?.state === 'retry' && execution.status === 'running') {
                await this.resetForRetry(execution.id, 'Worker attempt interrupted; waiting for retry'); changed++;
            } else if (job && (job.state === 'failed' || job.state === 'cancelled')) {
                await this.finishExecution(execution.id, job.state === 'cancelled' ? 'cancelled' : 'failed', null, `Queue job ${job.state}`); changed++;
            }
        }
        return changed;
    }

    async cleanup(historyDays = Number(process.env.SCHEDULER_HISTORY_DAYS ?? 30)): Promise<number> {
        const cutoff = new Date(Date.now() - historyDays * 86_400_000);
        const expired = await this.connection.db.select().from(executions).where(and(
            lt(executions.finishedAt, cutoff), inArray(executions.status, ['succeeded', 'failed', 'cancelled', 'skipped', 'stopped']),
        ));
        for (const execution of expired) await this.purgeTerminalAssets(execution.id);
        const removed = await this.connection.db.delete(executions).where(and(
            lt(executions.finishedAt, cutoff), inArray(executions.status, ['succeeded', 'failed', 'cancelled', 'skipped', 'stopped']),
        )).returning({ id: executions.id });
        return removed.length;
    }

    /** Media uploaded via POST /api/assets but never attached to a schedule (abandoned post form). */
    async sweepOrphanedAssets(olderThanHours = Number(process.env.SCHEDULER_ORPHAN_ASSET_HOURS)): Promise<number> {
        // A destructive job — an empty/NaN env must not collapse the window to 0.
        const hours = Number.isFinite(olderThanHours) && olderThanHours >= 1 ? olderThanHours : 24;
        const cutoff = new Date(Date.now() - hours * 3_600_000);
        const rows = await this.connection.db.select({ id: assets.id }).from(assets).where(and(
            isNull(assets.scheduleId), isNull(assets.executionId), lt(assets.createdAt, cutoff),
        ));
        await this.purgeAssetIds(rows.map(({ id }) => id));
        return rows.length;
    }

    private async purgeTerminalAssets(executionId: string): Promise<void> {
        const [execution] = await this.connection.db.select().from(executions).where(eq(executions.id, executionId)).limit(1);
        if (!execution) return;
        if (execution.scheduleId) {
            const [schedule] = await this.connection.db.select().from(schedules).where(eq(schedules.id, execution.scheduleId)).limit(1);
            if (schedule && ['daily', 'weekly'].includes(schedule.timing.kind) && schedule.status !== 'cancelled') return;
        }
        const rows = await this.connection.db.select({ id: assets.id }).from(assets).where(or(
            eq(assets.executionId, executionId),
            ...(execution.scheduleId ? [eq(assets.scheduleId, execution.scheduleId)] : []),
        ));
        await this.purgeAssetIds(rows.map(({ id }) => id));
    }

    private async purgeScheduleAssetsIfIdle(scheduleId: string): Promise<void> {
        const [running] = await this.connection.db.select({ id: executions.id }).from(executions).where(and(
            eq(executions.scheduleId, scheduleId), eq(executions.status, 'running'),
        )).limit(1);
        if (running) return;
        const rows = await this.connection.db.select({ id: assets.id }).from(assets).where(eq(assets.scheduleId, scheduleId));
        await this.purgeAssetIds(rows.map(({ id }) => id));
    }

    private async purgeAssetIds(ids: string[]): Promise<void> {
        if (!ids.length) return;
        const rows = await this.connection.db.select().from(assets).where(inArray(assets.id, ids));
        const root = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
        for (const asset of rows) {
            const file = path.resolve(root, asset.relativePath);
            if (file.startsWith(`${root}${path.sep}`)) await rm(file, { force: true });
        }
        await this.connection.db.delete(assets).where(inArray(assets.id, ids));
    }
}

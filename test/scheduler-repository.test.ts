import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgBoss } from 'pg-boss';

import type { DatabaseConnection } from '../src/database/client.js';
import type { ExecutionRow } from '../src/database/schema.js';
import { PluginRegistry } from '../src/registry.js';
import {
    jobExpirySeconds, MAX_JOB_EXPIRY_SECONDS, planMaterialization, SchedulerRepository, type DueScheduleRow,
} from '../src/scheduler/repository.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';

const plugins = new PluginRegistry([createTikTokPlugin()]);
const now = new Date('2026-09-25T12:00:00Z');

function dueRow(overrides: Partial<DueScheduleRow> = {}): DueScheduleRow {
    return {
        id: 'schedule-1', device_udid: 'udid-1', plugin_id: 'com.git-agni.tiktok', task_type: 'doomscroll', task_version: 1,
        payload: { durationMinutes: 60, personality: 'casual', likeEnabled: false, saveEnabled: false },
        timing: { kind: 'once', runAt: '2026-09-25T11:59:00Z' }, run_window_minutes: 30,
        next_run_at: new Date('2026-09-25T11:59:00Z'),
        ...overrides,
    };
}

test('job expiry covers the run window, the task duration and a margin', () => {
    // 30-minute window + 60-minute doomscroll + 10-minute margin.
    assert.equal(jobExpirySeconds(30, 60 * 60_000), (30 + 60 + 10) * 60);
    // The old formula (duration + 600) would have expired this job while it
    // was still waiting out its window for the phone.
    assert.ok(jobExpirySeconds(30, 60_000) > 30 * 60 + 60);
    assert.equal(jobExpirySeconds(0, 0), 900, 'never below 15 minutes');
    assert.equal(jobExpirySeconds(1440, 180 * 60_000), MAX_JOB_EXPIRY_SECONDS, 'clamped to what pg-boss accepts');
});

test('planMaterialization enqueues an installed task with a window-aware expiry', () => {
    const plan = planMaterialization(plugins, dueRow(), now);
    assert.equal(plan?.kind, 'enqueue');
    assert.equal(plan?.kind === 'enqueue' && plan.expireInSeconds, jobExpirySeconds(30, 60 * 60_000));
    assert.equal(plan?.occurrence.nextRunAt, null);
});

test('planMaterialization skips (instead of throwing) a task version that is not installed', () => {
    const plan = planMaterialization(plugins, dueRow({ task_version: 9 }), now);
    assert.equal(plan?.kind, 'skip');
    assert.match(plan?.kind === 'skip' ? plan.error : '', /com\.git-agni\.tiktok\/doomscroll@9 is unavailable/);
    // The occurrence is still computed, so the schedule is advanced past it.
    assert.deepEqual(plan?.occurrence, { scheduledFor: new Date('2026-09-25T11:59:00Z'), nextRunAt: null });
});

test('planMaterialization returns null for a schedule that is not due yet', () => {
    assert.equal(planMaterialization(plugins, dueRow({ next_run_at: new Date('2026-09-25T13:00:00Z') }), now), null);
});

/** A transaction fake that behaves like drizzle's: a failing nested transaction (savepoint) rethrows. */
function fakeConnection(rows: DueScheduleRow[]) {
    const savepoints: string[] = [];
    const tx = {
        execute: async () => ({ rows }),
        transaction: async <T>(work: (savepoint: unknown) => Promise<T>) => {
            savepoints.push('savepoint');
            return work(tx);
        },
    };
    const connection = { db: { transaction: async <T>(work: (outer: unknown) => Promise<T>) => work(tx) } };
    return { connection: connection as unknown as DatabaseConnection, savepoints };
}

class IsolationProbe extends SchedulerRepository {
    readonly handled: string[] = [];
    protected override async materializeRow(_tx: unknown, row: DueScheduleRow): Promise<boolean> {
        if (row.id === 'bad') throw new Error('queue rejected an execution job');
        this.handled.push(row.id);
        return true;
    }
}

test('materializeDue isolates each schedule: one failing row does not block the batch', async () => {
    const { connection, savepoints } = fakeConnection([dueRow({ id: 'first' }), dueRow({ id: 'bad' }), dueRow({ id: 'last' })]);
    const repository = new IsolationProbe(connection, {} as PgBoss, plugins);
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
        assert.equal(await repository.materializeDue(now), 2);
    } finally {
        console.error = originalError;
    }
    assert.deepEqual(repository.handled, ['first', 'last']);
    assert.equal(savepoints.length, 3, 'each row runs in its own savepoint');
    assert.equal(logged.length, 1);
});

function selectReturning(row: Partial<ExecutionRow>) {
    const chain = { from: () => chain, where: () => chain, limit: async () => [row] };
    return chain;
}

test('retryExecution refuses an execution whose side effect was committed', async () => {
    let enqueued = false;
    const connection = { db: { select: () => selectReturning({ id: 'x', status: 'failed', effectCommittedAt: new Date() }) } };
    const boss = { getQueue: async () => { enqueued = true; }, send: async () => { enqueued = true; } };
    const repository = new SchedulerRepository(connection as unknown as DatabaseConnection, boss as unknown as PgBoss, plugins);
    assert.equal(await repository.retryExecution('x'), null);
    assert.equal(enqueued, false);
});

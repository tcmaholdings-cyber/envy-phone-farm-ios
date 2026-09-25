import assert from 'node:assert/strict';
import test from 'node:test';

import type { JobWithMetadata } from 'pg-boss';

import type { ExecutionRow } from '../src/database/schema.js';
import type { RegisteredDevice } from '../src/devices/registry.js';
import { PluginRegistry } from '../src/registry.js';
import { EFFECT_COMMITTED_REFUSAL } from '../src/scheduler/effects.js';
import type { AutomationOutcome } from '../src/scheduler/executor.js';
import { queueNameForDevice, type ExecutionJob } from '../src/scheduler/queue.js';
import type { SchedulerRepository, StartAttemptResult } from '../src/scheduler/repository.js';
import {
    createExecutionHandler, drainSeconds, ExecutionTracker, syncDeviceWorkers, type ExecuteFunction,
} from '../src/scheduler/worker.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';

const plugins = new PluginRegistry([createTikTokPlugin()]);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function executionRow(overrides: Partial<ExecutionRow> = {}): ExecutionRow {
    const now = new Date();
    return {
        id: 'exec-1', scheduleId: null, deviceUdid: 'udid-1',
        pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1,
        payload: { durationMinutes: 5, personality: 'casual', likeEnabled: false, saveEnabled: false },
        scheduledFor: now, deadlineAt: new Date(now.getTime() + 30 * 60_000),
        status: 'running', queueJobId: 'job-1', startedAt: now, finishedAt: null, exitCode: null,
        error: null, stopRequestedAt: null, effectCommittedAt: null, createdAt: now, updatedAt: now,
        ...overrides,
    };
}

const postPayload = {
    media: [{ assetId: 'a', name: 'a.mp4', mimeType: 'video/mp4' }], destination: 'publish', account: '@me',
};

interface Call { method: string; args: unknown[] }

function fakeRepository(options: { claim?: StartAttemptResult; requeue?: boolean; reset?: boolean } = {}) {
    const calls: Call[] = [];
    const record = (method: string) => async (...args: unknown[]) => {
        calls.push({ method, args });
        if (method === 'startAttempt') return options.claim ?? { status: 'started', execution: executionRow(), attempt: 1 };
        if (method === 'requeueAfterShutdown') return options.requeue ?? true;
        if (method === 'resetForRetry') return options.reset ?? true;
        return undefined;
    };
    const repository = {
        startAttempt: record('startAttempt'),
        finishAttempt: record('finishAttempt'),
        finishExecution: record('finishExecution'),
        resetForRetry: record('resetForRetry'),
        requeueAfterShutdown: record('requeueAfterShutdown'),
    } as unknown as SchedulerRepository;
    const finished = () => calls.filter(({ method }) => method === 'finishExecution').map(({ args }) => args);
    const called = (method: string) => calls.some((call) => call.method === method);
    return { repository, calls, finished, called };
}

function job(retryCount = 0): JobWithMetadata<ExecutionJob> {
    return { id: 'job-1', data: { executionId: 'exec-1' }, retryCount, signal: new AbortController().signal } as unknown as JobWithMetadata<ExecutionJob>;
}

function outcome(overrides: Partial<AutomationOutcome>): ExecuteFunction {
    return async () => ({ exitCode: 1, stopped: false, started: true, effectCommitted: false, shutdown: false, error: 'boom', ...overrides });
}

test('drainSeconds defaults to 120 and honours WORKER_DRAIN_SECONDS', () => {
    assert.equal(drainSeconds({}), 120);
    assert.equal(drainSeconds({ WORKER_DRAIN_SECONDS: '45' }), 45);
    assert.equal(drainSeconds({ WORKER_DRAIN_SECONDS: 'junk' }), 120);
    assert.equal(drainSeconds({ WORKER_DRAIN_SECONDS: '' }), 120);
});

test('drain signals shutdown, waits for running work, and forces what outlives the deadline', async () => {
    const tracker = new ExecutionTracker();
    const events: string[] = [];
    // Finishes on its own once asked to stop (a stoppable task).
    const cooperative = tracker.track(async ({ shutdown }) => {
        await new Promise<void>((resolve) => shutdown.addEventListener('abort', () => resolve(), { once: true }));
        events.push('cooperative stopped');
    });
    // Ignores shutdown; only `force` ends it (a post that is mid-upload).
    const stubborn = tracker.track(async ({ force }) => {
        await new Promise<void>((resolve) => force.addEventListener('abort', () => resolve(), { once: true }));
        events.push('stubborn forced');
    });
    assert.equal(tracker.size, 2);
    const abandoned = await tracker.drain({ drainMs: 50, killGraceMs: 10, settleMs: 50 });
    await Promise.all([cooperative, stubborn]);
    assert.equal(abandoned, 0);
    assert.deepEqual(events, ['cooperative stopped', 'stubborn forced']);
    assert.equal(tracker.size, 0);
});

test('drain returns early when work finishes inside the window and reports work that never stops', async () => {
    const quick = new ExecutionTracker();
    void quick.track(() => delay(20));
    const started = Date.now();
    assert.equal(await quick.drain({ drainMs: 5_000, killGraceMs: 0 }), 0);
    assert.ok(Date.now() - started < 1_000, 'did not wait out the whole drain window');

    const hung = new ExecutionTracker();
    void hung.track(() => new Promise(() => {}));
    assert.equal(await hung.drain({ drainMs: 10, killGraceMs: 0, settleMs: 10 }), 1);
});

test('work that starts after draining began sees the shutdown signal already fired', async () => {
    const tracker = new ExecutionTracker();
    const draining = tracker.drain({ drainMs: 100, killGraceMs: 0, settleMs: 0 });
    let sawShutdown = false;
    await tracker.track(async ({ shutdown }) => { sawShutdown = shutdown.aborted; });
    await draining;
    assert.equal(sawShutdown, true);
});

test('a task interrupted by shutdown before it started is re-queued, not failed', async () => {
    const { repository, finished, called } = fakeRepository();
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(),
        outcome({ started: false, stopped: true, shutdown: true, exitCode: null, error: 'Execution stopped while waiting for the device' }));
    await handler(job());
    assert.equal(called('requeueAfterShutdown'), true);
    assert.deepEqual(finished(), []);
});

test('a shutdown-interrupted task that cannot be re-queued is recorded as stopped', async () => {
    const { repository, finished } = fakeRepository({ requeue: false });
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(),
        outcome({ started: false, stopped: true, shutdown: true, exitCode: null }));
    await handler(job());
    assert.equal(finished()[0]?.[1], 'stopped');
});

test('a started stoppable task stopped by shutdown goes through its retry policy', async () => {
    const { repository, called } = fakeRepository();
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(),
        outcome({ started: true, stopped: true, shutdown: true, exitCode: 0, error: undefined }));
    await assert.rejects(handler(job(0)), /Worker shut down during the task/);
    assert.equal(called('resetForRetry'), true);
});

test('a task whose side effect was committed is never retried, even with retries left', async () => {
    const { repository, finished, called } = fakeRepository();
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(),
        outcome({ started: true, effectCommitted: true, error: 'Plugin process exited with 1' }));
    await handler(job(0));
    assert.equal(called('resetForRetry'), false, 'doomscroll allows 2 retries, but the effect is committed');
    const [[, status, , message]] = finished() as [[string, string, number | null, string]];
    assert.equal(status, 'failed');
    assert.match(message, new RegExp(EFFECT_COMMITTED_REFUSAL.slice(0, 30)));
});

test('an ordinary failure with retries left is reset and re-thrown for pg-boss', async () => {
    const { repository, called } = fakeRepository();
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(), outcome({}));
    await assert.rejects(handler(job(0)), /boom/);
    assert.equal(called('resetForRetry'), true);
});

test('a failure is final when resetForRetry refuses (effect committed in the database)', async () => {
    const { repository, finished } = fakeRepository({ reset: false });
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(), outcome({}));
    await handler(job(0));
    assert.equal(finished()[0]?.[1], 'failed');
});

test('a post (retryLimit 0) that fails is not retried', async () => {
    const post = executionRow({ taskType: 'post', payload: postPayload });
    const { repository, finished, called } = fakeRepository({ claim: { status: 'started', execution: post, attempt: 1 } });
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(), outcome({}));
    await handler(job(0));
    assert.equal(called('resetForRetry'), false);
    assert.equal(finished()[0]?.[1], 'failed');
});

test('a re-delivered execution whose effect is committed is refused at claim time', async () => {
    let executed = false;
    const committed = executionRow({ effectCommittedAt: new Date() });
    const { repository, finished } = fakeRepository({ claim: { status: 'effect-committed', execution: committed } });
    const handler = createExecutionHandler(repository, plugins, new ExecutionTracker(), async () => {
        executed = true;
        return { exitCode: 0, stopped: false, started: true, effectCommitted: false, shutdown: false };
    });
    await handler(job(1));
    assert.equal(executed, false);
    assert.deepEqual(finished()[0]?.slice(1), ['failed', null, EFFECT_COMMITTED_REFUSAL]);
});

test('an operator stop is recorded as stopped and success as succeeded', async () => {
    const stopped = fakeRepository();
    await createExecutionHandler(stopped.repository, plugins, new ExecutionTracker(),
        outcome({ stopped: true, exitCode: 0, error: undefined }))(job());
    assert.equal(stopped.finished()[0]?.[1], 'stopped');

    const succeeded = fakeRepository();
    await createExecutionHandler(succeeded.repository, plugins, new ExecutionTracker(),
        outcome({ exitCode: 0, error: undefined }))(job());
    assert.equal(succeeded.finished()[0]?.[1], 'succeeded');
});

test('the handler stays tracked until the outcome is recorded', async () => {
    const tracker = new ExecutionTracker();
    const { repository } = fakeRepository();
    let release: () => void = () => {};
    const handler = createExecutionHandler(repository, plugins, tracker, async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { exitCode: 0, stopped: false, started: true, effectCommitted: false, shutdown: false };
    });
    const running = handler(job());
    await delay(5);
    assert.equal(tracker.size, 1);
    release();
    await running;
    assert.equal(tracker.size, 0);
});

function device(udid: string, overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
    return { udid, name: `phone ${udid}`, pluginData: {}, ...overrides };
}

test('syncDeviceWorkers keeps going past a device that fails, and retries it next pass', async () => {
    const working = new Map<string, string>();
    let failB = true;
    const operations = {
        async subscribe(target: RegisteredDevice) {
            if (target.udid === 'b' && failB) throw new Error('queue create failed');
            return queueNameForDevice(target.udid);
        },
        async unsubscribe() {},
    };
    const first = await syncDeviceWorkers([device('a'), device('b'), device('c')], working, operations);
    assert.deepEqual(first.added, ['a', 'c']);
    assert.deepEqual(first.failed, ['b']);
    failB = false;
    const second = await syncDeviceWorkers([device('a'), device('b'), device('c')], working, operations);
    assert.deepEqual(second.added, ['b']);
    assert.equal(working.size, 3);
});

test('syncDeviceWorkers stops working queues of removed and disabled devices', async () => {
    const working = new Map<string, string>([
        [queueNameForDevice('a'), 'a'], [queueNameForDevice('b'), 'b'], [queueNameForDevice('c'), 'c'],
    ]);
    const unsubscribed: string[] = [];
    const result = await syncDeviceWorkers([device('a'), device('b', { disabled: true })], working, {
        async subscribe(target) { return queueNameForDevice(target.udid); },
        async unsubscribe(queue) { unsubscribed.push(queue); },
    });
    assert.deepEqual(result.removed.sort(), ['b', 'c']);
    assert.deepEqual(unsubscribed.sort(), [queueNameForDevice('b'), queueNameForDevice('c')].sort());
    assert.deepEqual([...working.values()], ['a']);
});

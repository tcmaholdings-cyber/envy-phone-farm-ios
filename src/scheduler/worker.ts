import type { JobWithMetadata } from 'pg-boss';

import { pruneAuditLog } from '../auth/audit.js';
import { assertDatabaseReady, createDatabaseConnection } from '../database/client.js';
import { activeDevices, loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { configuredPluginModules, loadPlugins } from '../loader.js';
import { PluginRegistry } from '../registry.js';
import { EFFECT_COMMITTED_REFUSAL } from './effects.js';
import { executeAutomation, killGraceMs, type AutomationOutcome, type ExecutionSignals } from './executor.js';
import { createQueue, ensureDeviceQueue, queueNameForDevice, type ExecutionJob } from './queue.js';
import { SchedulerRepository } from './repository.js';
import { createTikTokPlugin } from '../tiktok-plugin.js';
import { startWorkerHeartbeat } from '../observability/heartbeat.js';
import { localDevices, localHostId } from '../devices/host-identity.js';
import { closeDeviceRegistry, registryKind } from '../devices/registry.js';
import { startHostLease } from '../hosts/lease.js';

export interface WorkerRuntime { close(): Promise<void> }

export const DEFAULT_DRAIN_SECONDS = 120;

/** How long a stopping worker waits for running tasks (WORKER_DRAIN_SECONDS, default 120). */
export function drainSeconds(env: NodeJS.ProcessEnv = process.env): number {
    const seconds = Number(env.WORKER_DRAIN_SECONDS);
    return env.WORKER_DRAIN_SECONDS !== undefined && env.WORKER_DRAIN_SECONDS !== '' && Number.isFinite(seconds) && seconds >= 0
        ? seconds : DEFAULT_DRAIN_SECONDS;
}

interface TrackedExecution {
    shutdown: AbortController;
    force: AbortController;
    done: Promise<unknown>;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds).unref());

/**
 * The executions this worker is running, so shutdown can drain them instead of
 * killing them mid-task (a killed post used to be marked failed even when it
 * had published, and retrying it posted twice).
 */
export class ExecutionTracker {
    private readonly running = new Set<TrackedExecution>();
    private drainingSince: number | undefined;

    get size(): number { return this.running.size; }
    get draining(): boolean { return this.drainingSince !== undefined; }

    /** Run `work` with shutdown/force signals. Work that starts after draining began sees `shutdown` already fired. */
    track<T>(work: (signals: Required<ExecutionSignals>) => Promise<T>): Promise<T> {
        const entry: TrackedExecution = { shutdown: new AbortController(), force: new AbortController(), done: Promise.resolve() };
        if (this.draining) entry.shutdown.abort();
        const promise = work({ shutdown: entry.shutdown.signal, force: entry.force.signal });
        entry.done = promise.catch(() => undefined).finally(() => this.running.delete(entry));
        this.running.add(entry);
        return promise;
    }

    /**
     * Signal shutdown to every execution, wait up to `drainMs` for them to
     * finish, then force the rest (their subprocesses get SIGTERM, then SIGKILL
     * after `killGraceMs`) and wait for that to land. Resolves with the number
     * of executions that never finished.
     */
    async drain({ drainMs, killGraceMs: grace, settleMs = 5_000 }: { drainMs: number; killGraceMs: number; settleMs?: number }): Promise<number> {
        this.drainingSince ??= Date.now();
        for (const entry of this.running) entry.shutdown.abort();
        await this.settle(drainMs);
        if (!this.running.size) return 0;
        console.warn(`Worker drain deadline passed with ${this.running.size} execution(s) still running; stopping them`);
        for (const entry of this.running) entry.force.abort();
        await this.settle(grace + settleMs);
        return this.running.size;
    }

    /** Wait until nothing is running (including work tracked meanwhile) or `timeoutMs` passes. */
    private async settle(timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.running.size && Date.now() < deadline) {
            await Promise.race([
                Promise.all([...this.running].map((entry) => entry.done)),
                sleep(deadline - Date.now()),
            ]);
        }
    }
}

type HandlerRepository = Pick<SchedulerRepository,
    'startAttempt' | 'finishAttempt' | 'finishExecution' | 'resetForRetry' | 'requeueAfterShutdown'>;

export type ExecuteFunction = (
    repository: SchedulerRepository, plugins: PluginRegistry, execution: Parameters<typeof executeAutomation>[2],
    attempt: number, signal: AbortSignal, signals: ExecutionSignals,
) => Promise<AutomationOutcome>;

/** The pg-boss handler for one execution job. Throwing asks pg-boss to retry the job. */
export function createExecutionHandler(
    repository: HandlerRepository,
    plugins: PluginRegistry,
    tracker: ExecutionTracker,
    execute: ExecuteFunction = executeAutomation,
): (job: JobWithMetadata<ExecutionJob>) => Promise<void> {
    return async (job) => {
        const claim = await repository.startAttempt(job.data.executionId);
        if (claim.status === 'effect-committed') {
            await repository.finishExecution(claim.execution.id, 'failed', null, EFFECT_COMMITTED_REFUSAL);
            return;
        }
        if (claim.status !== 'started') return;
        const { execution, attempt } = claim;
        // Tracked until the outcome is recorded, so a draining worker does not
        // close the database under a finishing execution.
        await tracker.track(async (signals) => {
            const result = await execute(repository as SchedulerRepository, plugins, execution, attempt, job.signal, signals);
            await settleOutcome(repository, plugins, job, execution, attempt, result);
        });
    };
}

async function settleOutcome(
    repository: HandlerRepository,
    plugins: PluginRegistry,
    job: JobWithMetadata<ExecutionJob>,
    execution: Parameters<typeof executeAutomation>[2],
    attempt: number,
    result: AutomationOutcome,
): Promise<void> {
    await repository.finishAttempt(execution.id, attempt, result.exitCode, result.error);
    if (!result.stopped && !result.error && result.exitCode === 0) {
        await repository.finishExecution(execution.id, 'succeeded', 0);
        return;
    }
    if (result.shutdown && !result.started) {
        const message = 'Worker restarted before the task started; queued again';
        if (await repository.requeueAfterShutdown(execution.id, message)) return;
        await repository.finishExecution(execution.id, 'stopped', result.exitCode, 'Worker shut down before the task started');
        return;
    }
    if (result.stopped && !result.shutdown) {
        await repository.finishExecution(execution.id, 'stopped', result.exitCode, result.error);
        return;
    }
    const message = result.shutdown
        ? `Worker shut down during the task${result.error ? `: ${result.error}` : ''}`
        : result.error ?? 'Automation failed';
    if (result.effectCommitted) {
        await repository.finishExecution(execution.id, 'failed', result.exitCode, `${message}. ${EFFECT_COMMITTED_REFUSAL}`);
        return;
    }
    let retryLimit = 0;
    try {
        retryLimit = plugins.task({
            pluginId: execution.pluginId, taskType: execution.taskType,
            taskVersion: execution.taskVersion, payload: execution.payload,
        }).retryPolicy(execution.payload).retryLimit;
    } catch { /* plugin uninstalled mid-run: nothing to retry with */ }
    if (job.retryCount < retryLimit && Date.now() < execution.deadlineAt.getTime()
        && await repository.resetForRetry(execution.id, message)) {
        throw new Error(message);
    }
    await repository.finishExecution(execution.id, result.shutdown ? 'stopped' : 'failed', result.exitCode, message);
}

export interface DeviceWorkerOperations {
    /** Subscribe to the device's queue; resolves with the queue name. */
    subscribe(device: RegisteredDevice): Promise<string>;
    unsubscribe(queue: string): Promise<void>;
}

/**
 * Bring the set of subscribed queues in line with the active devices: one
 * device failing to subscribe must not skip the others, and a device that was
 * removed or disabled stops being worked (a job already running on it finishes).
 * Only phones this host owns are worked: with the shared Postgres registry a
 * second Mac's worker would otherwise compete for — and fail — jobs for phones
 * on another USB tree. A phone moved to another host stops being worked here.
 * `working` maps queue name → UDID and is updated in place.
 */
export async function syncDeviceWorkers(
    devices: readonly RegisteredDevice[],
    working: Map<string, string>,
    operations: DeviceWorkerOperations,
    hostId: string = localHostId(),
): Promise<{ added: string[]; removed: string[]; failed: string[] }> {
    const active = activeDevices(localDevices(devices, hostId));
    const wanted = new Set(active.map(({ udid }) => queueNameForDevice(udid)));
    const added: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];
    for (const [queue, udid] of [...working]) {
        if (wanted.has(queue)) continue;
        try {
            await operations.unsubscribe(queue);
            working.delete(queue);
            removed.push(udid);
        } catch (error) {
            failed.push(udid);
            console.error(`Could not stop the worker for ${udid}:`, error);
        }
    }
    for (const device of active) {
        if (working.has(queueNameForDevice(device.udid))) continue;
        try {
            const queue = await operations.subscribe(device);
            working.set(queue, device.udid);
            added.push(device.udid);
        } catch (error) {
            failed.push(device.udid);
            console.error(`Could not start the worker for ${device.name} (${device.udid}):`, error);
        }
    }
    return { added, removed, failed };
}

export async function startWorker(plugins: PluginRegistry): Promise<WorkerRuntime> {
    const connection = createDatabaseConnection();
    await assertDatabaseReady(connection);
    const boss = createQueue();
    await boss.start();
    const repository = new SchedulerRepository(connection, boss, plugins);
    const tracker = new ExecutionTracker();
    const handle = createExecutionHandler(repository, plugins, tracker);
    const workingQueues = new Map<string, string>();
    // Fails fast on a malformed PHONE_FARM_HOST_ID, before any queue is worked.
    const hostId = localHostId();
    const operations: DeviceWorkerOperations = {
        async subscribe(device) {
            const queue = await ensureDeviceQueue(boss, device.udid);
            await boss.work<ExecutionJob>(queue, { includeMetadata: true }, async ([job]) => {
                if (job) await handle(job as JobWithMetadata<ExecutionJob>);
            });
            console.log(`Worker listening on ${queue} for ${device.name}`);
            return queue;
        },
        async unsubscribe(queue) {
            // wait: false — stop fetching now; a job already running here finishes on its own.
            await boss.offWork(queue, { wait: false });
            console.log(`Worker stopped listening on ${queue}`);
        },
    };
    let syncing: Promise<unknown> = Promise.resolve();
    const registerDeviceWorkers = () => {
        // Serialised, and a failed pass must not poison the chain for the next one.
        syncing = syncing.catch(() => undefined).then(async () => {
            if (!tracker.draining) await syncDeviceWorkers(await loadRegisteredDevices(), workingQueues, operations, hostId);
        });
        return syncing;
    };

    await registerDeviceWorkers();
    await repository.reconcileQueueStates();
    await repository.materializeDue();
    const materializeTimer = setInterval(() => void repository.materializeDue().catch(console.error), 5_000);
    const deviceTimer = setInterval(() => void registerDeviceWorkers().catch(console.error), 30_000);
    const cleanupTimer = setInterval(() => {
        void repository.cleanup().catch(console.error);
        void repository.sweepOrphanedAssets().catch(console.error);
        // Audit rows past PHONE_FARM_AUDIT_RETENTION_DAYS (default 365; the database keeps at least 30).
        void pruneAuditLog(connection.pool).catch(console.error);
    }, 60 * 60_000);
    const reconcileTimer = setInterval(() => void repository.reconcileQueueStates().catch(console.error), 60_000);
    const heartbeat = startWorkerHeartbeat(connection.pool, () => workingQueues.size, { host: hostId });
    // With the shared registry, keep this host's fleet.hosts row fresh (its lease).
    const lease = registryKind() === 'postgres' ? startHostLease(connection.pool, { hostId }) : null;
    let closing: Promise<void> | undefined;
    return {
        close() {
            closing ??= (async () => {
                clearInterval(materializeTimer);
                clearInterval(deviceTimer);
                clearInterval(cleanupTimer);
                clearInterval(reconcileTimer);
                const drainMs = drainSeconds() * 1000;
                const grace = killGraceMs();
                // Mark draining before unsubscribing: a job fetched in the gap
                // starts with its shutdown signal already fired and is re-queued.
                const draining = tracker.drain({ drainMs, killGraceMs: grace });
                await Promise.allSettled([...workingQueues.keys()].map((queue) => boss.offWork(queue, { wait: false })));
                console.log(`Scheduler worker draining ${tracker.size} execution(s) for up to ${drainMs / 1000}s`);
                const abandoned = await draining;
                if (abandoned) console.error(`${abandoned} execution(s) did not stop in time`);
                // The heartbeat runs through the drain: a draining worker is alive.
                await heartbeat.stop();
                await lease?.stop();
                await boss.stop({ graceful: true, timeout: 10_000 });
                await connection.close();
                await closeDeviceRegistry();
            })();
            return closing;
        },
    };
}

async function main(): Promise<void> {
    const plugins = new PluginRegistry([
        createTikTokPlugin({ bundleId: process.env.TIKTOK_BUNDLE_ID }),
        ...await loadPlugins(configuredPluginModules()),
    ]);
    const runtime = await startWorker(plugins);
    const shutdown = async (signal: string) => {
        console.log(`Scheduler worker stopping after ${signal}`);
        try {
            await runtime.close();
            console.log('Scheduler worker stopped');
        } catch (error) {
            console.error('Scheduler worker shutdown failed:', error);
            process.exitCode = 1;
        }
        // Leftover timers or sockets must not keep a drained worker alive until
        // launchd's ExitTimeOut SIGKILLs it.
        process.exit();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => void shutdown(signal));
    }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();

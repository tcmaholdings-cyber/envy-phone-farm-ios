import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import type { DeviceAutomation, PluginProcessSpecification, TaskExecutionContext } from '../plugin.js';
import { connectedDevices, connectedDeviceUdids, type Device } from '../devices/discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { passcodeForDevice } from '../devices/secrets.js';
import { WdaRemoteControl } from '../devices/wda-remote.js';
import type { ExecutionRow } from '../database/schema.js';
import type { PluginRegistry } from '../registry.js';
import type { DeviceIdentity, TaskExecutionResult } from '../types.js';
import { isEffectCommittedLine } from './effects.js';
import type { SchedulerRepository } from './repository.js';

/** What the worker needs to know beyond the task's own result. */
export interface AutomationOutcome extends TaskExecutionResult {
    /** The task's execute() was entered: the phone may have been touched. */
    started: boolean;
    /** The task reported an irreversible side effect; it must never be re-run. */
    effectCommitted: boolean;
    /** The worker's shutdown signal fired before this returned. */
    shutdown: boolean;
}

export interface ExecutionSignals {
    /**
     * Fired when the worker begins draining. A task still waiting for its phone
     * gives up at once; a running task stops only if it `supportsStop`, otherwise
     * it is left to finish until `force` fires.
     */
    shutdown?: AbortSignal;
    /** Fired when the drain deadline passes: stop every task, stoppable or not. */
    force?: AbortSignal;
}

export const DEFAULT_KILL_GRACE_MS = 15_000;

/** How long a task subprocess gets between SIGTERM and SIGKILL (WORKER_KILL_GRACE_SECONDS, default 15). */
export function killGraceMs(env: NodeJS.ProcessEnv = process.env): number {
    const seconds = Number(env.WORKER_KILL_GRACE_SECONDS);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_KILL_GRACE_MS;
}

async function endpointReady(url: string): Promise<boolean> {
    try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
        return false;
    }
}

function appiumBaseUrl(): string {
    return `http://${process.env.APPIUM_HOST ?? '127.0.0.1'}:${Number(process.env.APPIUM_PORT ?? 4725)}`;
}

export interface WaitForDeviceDependencies {
    /** Connected UDIDs. Must be the shared, cached usbmux sweep — never a per-caller lockdown sweep. */
    connectedUdids(): Promise<string[]>;
    /** Connected devices with lockdown details, from the shared cache; read once, when the phone is present. */
    connectedDevices(): Promise<Device[]>;
    endpointReady(url: string): Promise<boolean>;
    sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
    pollMs: number;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, milliseconds);
        signal.addEventListener('abort', done, { once: true });
    });
}

// The presence check used to call discoverConnectedDevices() — three lockdown
// round trips to *every* attached phone — once per waiting job every 5 s. After
// a hub brownout at 100 phones that is O(n²) USB traffic on the tree that just
// failed. Presence now comes from the process-wide shared usbmux sweep (no
// lockdown at all, and concurrent waiters share one read); lockdown details are
// read once, from the shared cached sweep, when the phone is actually there.
export const defaultWaitForDeviceDependencies: WaitForDeviceDependencies = {
    connectedUdids: () => connectedDeviceUdids(5_000),
    connectedDevices: () => connectedDevices(30_000),
    endpointReady,
    sleep: abortableSleep,
    pollMs: 5_000,
};

export async function waitForDevice(
    execution: Pick<ExecutionRow, 'deviceUdid' | 'deadlineAt'>,
    registered: RegisteredDevice,
    signal: AbortSignal,
    dependencies: WaitForDeviceDependencies = defaultWaitForDeviceDependencies,
): Promise<DeviceIdentity> {
    const wdaPort = registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100);
    let lastProblem = 'device is offline';
    while (Date.now() <= execution.deadlineAt.getTime()) {
        if (signal.aborted) throw new Error('Execution stopped while waiting for the device');
        const present = (await dependencies.connectedUdids()).includes(execution.deviceUdid);
        if (!present) lastProblem = 'device is offline';
        else if (!await dependencies.endpointReady(`http://127.0.0.1:${wdaPort}/status`)) lastProblem = `WDA is unavailable on port ${wdaPort}`;
        else if (!await dependencies.endpointReady(`${appiumBaseUrl()}/status`)) lastProblem = `Appium is unavailable at ${appiumBaseUrl()}`;
        else {
            const discovered = (await dependencies.connectedDevices().catch(() => [] as Device[]))
                .find(({ udid }) => udid === execution.deviceUdid);
            // A cached sweep older than the reconnect will not list the phone yet;
            // the registry identity is enough to run on, and costs no USB traffic.
            return discovered ?? { udid: registered.udid, name: registered.name };
        }
        await dependencies.sleep(dependencies.pollMs, signal);
    }
    if (signal.aborted) throw new Error('Execution stopped while waiting for the device');
    throw new Error(`Execution window expired: ${lastProblem}`);
}

function deviceAutomation(registered: RegisteredDevice, passcode: string | undefined): DeviceAutomation {
    const udid = registered.udid;
    const remote = new WdaRemoteControl({
        deviceUdid: udid,
        wdaUrl: `http://127.0.0.1:${registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`,
        passcode,
    });
    const appRequest = async (pathname: string, bundleId: string): Promise<void> => {
        await remote.request(pathname, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bundleId }),
        });
    };
    return {
        activateApp: (bundleId) => appRequest('/wda/apps/launch', bundleId),
        terminateApp: (bundleId) => appRequest('/wda/apps/terminate', bundleId),
        pause: (milliseconds, signal) => new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason);
            const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, milliseconds);
            signal?.addEventListener('abort', onAbort, { once: true });
        }),
        screenshot: () => remote.getScreenshot(udid),
        tap: (x, y) => remote.performAction(udid, { type: 'tap', x, y }),
        swipe: (startX, startY, endX, endY, durationMs) => remote.performAction(udid, {
            type: 'swipe', startX, startY, endX, endY, durationMs,
        }),
    };
}

export interface PluginProcessOptions {
    /** Called (at most once) as soon as the process prints EFFECT_COMMITTED_MARKER; awaited before returning. */
    onEffectCommitted?(line: string): Promise<void>;
    /** SIGTERM → SIGKILL escalation delay after a stop. */
    killGraceMs?: number;
    /** Interpreter and leading arguments; the entrypoint and its args follow. */
    command?: { file: string; args: string[] };
}

const defaultCommand = () => ({
    file: process.execPath,
    args: ['--env-file-if-exists=.env', '--env-file-if-exists=.env.devices', '--import', 'tsx'],
});

export async function runPluginProcess(
    specification: PluginProcessSpecification,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onLines: (lines: string[]) => Promise<void>,
    options: PluginProcessOptions = {},
): Promise<TaskExecutionResult> {
    const command = options.command ?? defaultCommand();
    const grace = options.killGraceMs ?? killGraceMs();
    const child = spawn(command.file, [...command.args, specification.entrypoint, ...(specification.args ?? [])], {
        cwd: process.cwd(), env: { ...environment, ...specification.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending: string[] = [];
    let effectReport: Promise<void> | undefined;
    const partial = { stdout: '', stderr: '' };
    const append = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
        const text = partial[stream] + chunk.toString();
        const parts = text.split(/\r?\n/);
        partial[stream] = parts.pop() ?? '';
        const lines = parts.filter(Boolean);
        // Checked on arrival, not on the 3 s flush: the process may be killed
        // (or the worker may stop) before the next flush.
        const marker = lines.find(isEffectCommittedLine);
        if (marker && !effectReport && options.onEffectCommitted) {
            effectReport = options.onEffectCommitted(marker).catch((error) => console.error('Recording committed effect failed:', error));
        }
        pending.push(...lines);
    };
    child.stdout.on('data', append('stdout'));
    child.stderr.on('data', append('stderr'));
    const flush = async () => {
        if (!pending.length) return;
        const lines = pending;
        pending = [];
        await onLines(lines);
    };
    const timer = setInterval(() => void flush().catch(console.error), 3_000);
    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    const running = () => child.exitCode === null && child.signalCode === null;
    const stop = () => {
        stopped = true;
        if (!running()) return;
        child.kill('SIGTERM');
        // A task that ignores SIGTERM (or hangs in its cleanup) must not keep the
        // phone — or a draining worker — waiting forever.
        killTimer ??= setTimeout(() => { if (running()) child.kill('SIGKILL'); }, grace);
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        const result = await new Promise<TaskExecutionResult>((resolve) => {
            child.once('error', (error) => resolve({ exitCode: null, stopped, error: error.message }));
            child.once('exit', (exitCode, childSignal) => resolve({
                exitCode,
                stopped,
                ...(exitCode === 0 ? {} : {
                    error: childSignal ? `Plugin process stopped by ${childSignal}` : `Plugin process exited with ${exitCode}`,
                }),
            }));
        });
        // Let the pipes drain so the last lines (and a late marker) are seen, but
        // do not wait on a grandchild that inherited them and outlived the task.
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
        for (const stream of ['stdout', 'stderr'] as const) {
            if (partial[stream]) append(stream)('\n');
        }
        await effectReport;
        await flush();
        return result;
    } finally {
        clearInterval(timer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', stop);
    }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Delete every Appium session driving `udid`. A task subprocess that was killed
 * (SIGKILL after a stop, a crash) never reaches its own `deleteSession()`, and
 * the orphaned session would hold the phone until Appium's newCommandTimeout.
 * Only task subprocesses open Appium sessions and the per-device queue runs one
 * task at a time, so any session for this phone after its task ended is stale.
 */
export async function deleteAppiumSessionsForDevice(
    udid: string,
    baseUrl = appiumBaseUrl(),
    fetchImpl: FetchLike = fetch,
): Promise<string[]> {
    const signal = () => AbortSignal.timeout(5_000);
    let sessions: Array<{ id?: string; capabilities?: Record<string, unknown> }> = [];
    for (const listPath of ['/appium/sessions', '/sessions']) {
        const response = await fetchImpl(`${baseUrl}${listPath}`, { signal: signal() }).catch(() => undefined);
        if (!response?.ok) continue;
        const body = await response.json().catch(() => ({})) as { value?: unknown };
        if (Array.isArray(body.value)) { sessions = body.value; break; }
    }
    const deleted: string[] = [];
    for (const session of sessions) {
        const caps = session.capabilities ?? {};
        if (!session.id || (caps.udid !== udid && caps['appium:udid'] !== udid)) continue;
        const response = await fetchImpl(`${baseUrl}/session/${encodeURIComponent(session.id)}`, { method: 'DELETE', signal: signal() })
            .catch(() => undefined);
        if (response?.ok) deleted.push(session.id);
    }
    return deleted;
}

export async function executeAutomation(
    repository: SchedulerRepository,
    plugins: PluginRegistry,
    execution: ExecutionRow,
    attempt: number,
    signal: AbortSignal,
    signals: ExecutionSignals = {},
): Promise<AutomationOutcome> {
    const { shutdown, force } = signals;
    let started = false;
    let effectCommitted = Boolean(execution.effectCommittedAt);
    const outcome = (result: TaskExecutionResult): AutomationOutcome => ({
        ...result, started, effectCommitted, shutdown: Boolean(shutdown?.aborted),
    });
    const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === execution.deviceUdid);
    if (!registered) return outcome({ exitCode: null, stopped: false, error: 'Device is not registered' });
    if (Date.now() > execution.deadlineAt.getTime()) {
        return outcome({ exitCode: null, stopped: false, error: 'Execution window expired before the worker claimed the task' });
    }
    const controller = new AbortController();
    const listeners: Array<() => void> = [];
    const forward = (source: AbortSignal | undefined, reason: () => unknown) => {
        if (!source) return;
        const abort = () => controller.abort(reason());
        if (source.aborted) abort();
        source.addEventListener('abort', abort, { once: true });
        listeners.push(() => source.removeEventListener('abort', abort));
    };
    forward(signal, () => signal.reason);
    forward(force, () => new Error('Worker shutdown: drain deadline passed'));
    // While the task is only waiting for its phone nothing has happened yet, so
    // a shutdown abandons the wait at once and the worker re-queues it.
    const waitController = new AbortController();
    const abortWait = () => waitController.abort();
    controller.signal.addEventListener('abort', abortWait, { once: true });
    shutdown?.addEventListener('abort', abortWait, { once: true });
    if (shutdown?.aborted || controller.signal.aborted) abortWait();
    const stopPoll = setInterval(() => void repository.stopRequested(execution.id).then((requested) => {
        if (requested) controller.abort(new Error('Stop requested'));
    }).catch(console.error), 1_000);
    const cleanup = () => {
        clearInterval(stopPoll);
        for (const remove of listeners) remove();
        controller.signal.removeEventListener('abort', abortWait);
        shutdown?.removeEventListener('abort', abortWait);
    };
    let device: DeviceIdentity;
    try {
        device = await waitForDevice(execution, registered, waitController.signal);
    } catch (error) {
        cleanup();
        return outcome({ exitCode: null, stopped: waitController.signal.aborted, error: error instanceof Error ? error.message : String(error) });
    }
    if (shutdown?.aborted || controller.signal.aborted) {
        cleanup();
        return outcome({ exitCode: null, stopped: true, error: 'Execution stopped before the task started' });
    }
    const workspaceDirectory = await mkdtemp(`${os.tmpdir()}/phone-farm-${execution.id}-`);
    const task = { pluginId: execution.pluginId, taskType: execution.taskType, taskVersion: execution.taskVersion, payload: execution.payload };
    let launchedProcess = false;
    try {
        const definition = plugins.task(task);
        // A stoppable task (doomscroll) stops as soon as the worker drains; a
        // task that cannot be stopped safely (a post) is given the drain window
        // to finish, and is only stopped by `force`.
        let stoppable = true;
        try { stoppable = definition.supportsStop(execution.payload); } catch { /* treat as stoppable */ }
        if (stoppable) forward(shutdown, () => new Error('Worker shutdown'));
        const commitEffect = async (description: string) => {
            if (effectCommitted) return;
            effectCommitted = true;
            await repository.markEffectCommitted(execution.id);
            await repository.appendLogs(execution.id, attempt, [`Side effect committed: ${description}`]);
        };
        const passcode = await passcodeForDevice(device.udid);
        const environment: NodeJS.ProcessEnv = {
            ...process.env,
            IOS_UDID: device.udid,
            WDA_URL: `http://127.0.0.1:${registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`,
            ...(passcode ? { IOS_PASSCODE: passcode } : {}),
        };
        const context: TaskExecutionContext = {
            executionId: execution.id,
            attempt,
            workspaceDirectory,
            device,
            devicePluginData: registered.pluginData[execution.pluginId] ?? {},
            automation: deviceAutomation(registered, passcode),
            assets: await repository.executionAssets(execution),
            signal: controller.signal,
            log: (line) => repository.appendLogs(execution.id, attempt, [line]),
            runProcess: (specification) => {
                launchedProcess = true;
                return runPluginProcess(
                    specification, environment, controller.signal,
                    (lines) => repository.appendLogs(execution.id, attempt, lines),
                    { onEffectCommitted: (line) => commitEffect(line) },
                );
            },
            commitEffect,
        };
        started = true;
        const result = await definition.execute(context, execution.payload);
        return outcome({ ...result, stopped: result.stopped || controller.signal.aborted });
    } catch (error) {
        return outcome({ exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) });
    } finally {
        cleanup();
        if (launchedProcess) {
            // Always, even after a clean exit: a SIGKILLed subprocess never
            // deleted its session, and a stale one blocks the next task.
            const deleted = await deleteAppiumSessionsForDevice(execution.deviceUdid).catch(() => [] as string[]);
            if (deleted.length) {
                await repository.appendLogs(execution.id, attempt, [`Deleted ${deleted.length} orphaned Appium session(s)`]).catch(console.error);
            }
        }
        await rm(workspaceDirectory, { recursive: true, force: true });
    }
}

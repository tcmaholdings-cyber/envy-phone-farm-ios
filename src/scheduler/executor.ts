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
import type { SchedulerRepository } from './repository.js';
import { createStartGate, taskStartConcurrency, taskStartWarmupMs } from './start-gate.js';

/** One gate per worker process: every phone's task starts through it. */
const taskStartGate = createStartGate(taskStartConcurrency());

async function endpointReady(url: string): Promise<boolean> {
    try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
        return false;
    }
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
// round trips to *every* attached phone — once per waiting job every 5 s. With
// 34 jobs waiting on 35 phones that is thousands of usbmuxd connections at
// once, which overflows usbmuxd's accept backlog: every client on the host then
// gets ECONNREFUSED on /var/run/usbmuxd. Presence now comes from the
// process-wide shared usbmux sweep (no lockdown at all, and concurrent waiters
// share one read); lockdown details are read once, from the shared cached
// sweep, when the phone is actually there.
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
    const appiumHost = process.env.APPIUM_HOST ?? '127.0.0.1';
    const appiumPort = Number(process.env.APPIUM_PORT ?? 4725);
    let lastProblem = 'device is offline';
    while (Date.now() <= execution.deadlineAt.getTime()) {
        if (signal.aborted) throw new Error('Execution stopped while waiting for the device');
        // A refused usbmuxd connection is transient, and one failed shared sweep
        // is seen by every waiter at the same moment. Poll again, like an offline
        // phone, instead of failing the whole batch on one refusal.
        let present = false;
        let sweepError: string | undefined;
        try {
            present = (await dependencies.connectedUdids()).includes(execution.deviceUdid);
        } catch (error) {
            sweepError = error instanceof Error ? error.message : String(error);
        }
        if (sweepError) lastProblem = `usbmuxd is unavailable (${sweepError})`;
        else if (!present) lastProblem = 'device is offline';
        else if (!await dependencies.endpointReady(`http://127.0.0.1:${wdaPort}/status`)) lastProblem = `WDA is unavailable on port ${wdaPort}`;
        else if (!await dependencies.endpointReady(`http://${appiumHost}:${appiumPort}/status`)) lastProblem = `Appium is unavailable on port ${appiumPort}`;
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

async function runPluginProcess(
    specification: PluginProcessSpecification,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onLines: (lines: string[]) => Promise<void>,
): Promise<TaskExecutionResult> {
    const child = spawn(process.execPath, [
        '--env-file-if-exists=.env', '--env-file-if-exists=.env.devices', '--import', 'tsx',
        specification.entrypoint, ...(specification.args ?? []),
    ], { cwd: process.cwd(), env: { ...environment, ...specification.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending: string[] = [];
    const append = (chunk: Buffer | string) => { pending.push(...chunk.toString().split(/\r?\n/).filter(Boolean)); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const flush = async () => {
        if (!pending.length) return;
        const lines = pending;
        pending = [];
        await onLines(lines);
    };
    const timer = setInterval(() => void flush().catch(console.error), 3_000);
    let stopped = false;
    const stop = () => {
        stopped = true;
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
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
        await flush();
        return result;
    } finally {
        clearInterval(timer);
        signal.removeEventListener('abort', stop);
    }
}

export async function executeAutomation(
    repository: SchedulerRepository,
    plugins: PluginRegistry,
    execution: ExecutionRow,
    attempt: number,
    signal: AbortSignal,
): Promise<TaskExecutionResult> {
    const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === execution.deviceUdid);
    if (!registered) return { exitCode: null, stopped: false, error: 'Device is not registered' };
    if (Date.now() > execution.deadlineAt.getTime()) {
        return { exitCode: null, stopped: false, error: 'Execution window expired before the worker claimed the task' };
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    const stopPoll = setInterval(() => void repository.stopRequested(execution.id).then((requested) => {
        if (requested) controller.abort(new Error('Stop requested'));
    }).catch(console.error), 1_000);
    let device: DeviceIdentity;
    try {
        device = await waitForDevice(execution, registered, controller.signal);
    } catch (error) {
        clearInterval(stopPoll);
        signal.removeEventListener('abort', forwardAbort);
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    }
    const workspaceDirectory = await mkdtemp(`${os.tmpdir()}/phone-farm-${execution.id}-`);
    const task = { pluginId: execution.pluginId, taskType: execution.taskType, taskVersion: execution.taskVersion, payload: execution.payload };
    try {
        const definition = plugins.task(task);
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
            runProcess: async (specification) => {
                if (taskStartGate.wouldWait()) {
                    await repository.appendLogs(execution.id, attempt, ['Waiting for a start slot (PHONE_FARM_TASK_START_CONCURRENCY)']);
                }
                const release = await taskStartGate.acquire(controller.signal);
                const warmup = setTimeout(release, taskStartWarmupMs());
                try {
                    return await runPluginProcess(specification, environment, controller.signal, (lines) => repository.appendLogs(execution.id, attempt, lines));
                } finally {
                    clearTimeout(warmup);
                    release();
                }
            },
        };
        return await definition.execute(context, execution.payload);
    } catch (error) {
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    } finally {
        clearInterval(stopPoll);
        signal.removeEventListener('abort', forwardAbort);
        await rm(workspaceDirectory, { recursive: true, force: true });
    }
}

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { connectedDeviceUdids } from './discovery.js';
import { localDevices, localHostId } from './host-identity.js';
import { activeDevices, loadRegisteredDevices, type RegisteredDevice } from './registry.js';
import { LineSplitter, redactSecret, WdaLogStore } from './wda-log.js';

export type DeviceConnectionPhase = 'disconnected' | 'connecting' | 'unlock-required' | 'ready' | 'error';
export type AppiumConnectionPhase = 'ready' | 'unavailable';

export interface DeviceConnectionStatus {
    udid: string;
    physical: 'connected' | 'disconnected';
    wda: DeviceConnectionPhase;
    appium: AppiumConnectionPhase;
    managed: boolean;
    message: string;
    retryCount: number;
    updatedAt: string;
    /** Times WDA on this phone entered `error` (each one is followed by a relaunch). Monotonic for the service's life. */
    restarts?: number;
    /** Since when WDA has not been `ready`; absent while it is ready. */
    notReadySince?: string;
    /** Since when the phone has been off USB; absent while it is attached. */
    disconnectedSince?: string;
}

export interface DeviceConnections {
    start(): Promise<void>;
    close(): Promise<void>;
    status(udid: string): DeviceConnectionStatus | undefined;
    statuses(): DeviceConnectionStatus[];
    reconnect(udid: string): Promise<DeviceConnectionStatus | undefined>;
    /** The phone's most recent supervisor/xcodebuild output lines, oldest first. */
    logs?(udid: string, limit?: number): string[] | undefined | Promise<string[] | undefined>;
}

interface SupervisorMessage {
    state: DeviceConnectionPhase;
    message: string;
}

interface RuntimeState {
    device: RegisteredDevice;
    status: DeviceConnectionStatus;
    child?: ChildProcess;
    retryAt: number;
    /** The signing team the running supervisor was launched with. */
    spawnedTeam?: string;
}

interface ManagerOptions {
    loadDevices?: () => Promise<RegisteredDevice[]>;
    /** This Mac's PHONE_FARM_HOST_ID; phones another host owns are never supervised here. */
    hostId?: string;
    connectedUdids?: () => Promise<string[]>;
    spawnSupervisor?: (device: RegisteredDevice) => ChildProcess;
    endpointReady?: (url: string) => Promise<boolean>;
    pollIntervalMs?: number;
    now?: () => number;
    /** Where supervisor output goes; defaults to memory only (wda-service passes a file-backed store). */
    logs?: WdaLogStore;
}

const supervisorPrefix = '[wda-state] ';

export function parseSupervisorMessage(line: string): SupervisorMessage | undefined {
    const marker = line.indexOf(supervisorPrefix);
    if (marker < 0) return;
    try {
        const value = JSON.parse(line.slice(marker + supervisorPrefix.length)) as Partial<SupervisorMessage>;
        if (!['disconnected', 'connecting', 'unlock-required', 'ready', 'error'].includes(value.state ?? '')) return;
        if (typeof value.message !== 'string') return;
        return value as SupervisorMessage;
    } catch {
        return;
    }
}

async function defaultEndpointReady(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * The environment one phone's WDA supervisor (wda/start.ts) runs with: its
 * UDID, its forwarded ports and its signing team, which picks the prebuilt
 * WDA (`WDA_XCTESTRUN_<TEAM>`, see wda/runner-args.ts). The team is always
 * set, empty for the host default, so an inherited value never leaks in.
 */
export function supervisorEnvironment(device: RegisteredDevice, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
        ...env,
        IOS_UDID: device.udid,
        WDA_LOCAL_PORT: String(device.wdaLocalPort ?? Number(env.WDA_LOCAL_PORT ?? 8100)),
        MJPEG_LOCAL_PORT: String(device.mjpegLocalPort ?? Number(env.MJPEG_LOCAL_PORT ?? 9100)),
        WDA_SIGNING_TEAM: device.signingTeam ?? '',
    };
}

function defaultSpawnSupervisor(device: RegisteredDevice): ChildProcess {
    const script = fileURLToPath(new URL('./wda/start.ts', import.meta.url));
    // --env-file-if-exists does not override values already in the environment,
    // so the per-phone ones below win over .env.
    return spawn(process.execPath, ['--env-file-if-exists=.env', '--env-file-if-exists=.env.devices', '--import', 'tsx', script], {
        cwd: process.cwd(),
        env: supervisorEnvironment(device),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

export class DeviceConnectionManager implements DeviceConnections {
    private readonly loadDevices: () => Promise<RegisteredDevice[]>;
    private readonly connectedUdids: () => Promise<string[]>;
    private readonly spawnSupervisor: (device: RegisteredDevice) => ChildProcess;
    private readonly endpointReady: (url: string) => Promise<boolean>;
    private readonly pollIntervalMs: number;
    private readonly now: () => number;
    private readonly hostId: string;
    private readonly logStore: WdaLogStore;
    private readonly runtimes = new Map<string, RuntimeState>();
    private timer?: NodeJS.Timeout;
    private running = false;
    private closing = false;
    private appium: AppiumConnectionPhase = 'unavailable';

    constructor(options: ManagerOptions = {}) {
        this.loadDevices = options.loadDevices ?? loadRegisteredDevices;
        this.connectedUdids = options.connectedUdids ?? connectedDeviceUdids;
        this.spawnSupervisor = options.spawnSupervisor ?? defaultSpawnSupervisor;
        this.endpointReady = options.endpointReady ?? defaultEndpointReady;
        this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
        this.now = options.now ?? Date.now;
        this.hostId = options.hostId ?? localHostId();
        this.logStore = options.logs ?? new WdaLogStore();
    }

    logs(udid: string, limit?: number): string[] | undefined {
        if (!this.runtimes.has(udid)) return;
        return this.logStore.tail(udid, limit) ?? [];
    }

    async start(): Promise<void> {
        if (this.timer) return;
        await this.reconcile();
        let lastReconcileError = '';
        this.timer = setInterval(() => void this.reconcile().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message === lastReconcileError) return;
            lastReconcileError = message;
            console.error(error);
        }), this.pollIntervalMs);
    }

    status(udid: string): DeviceConnectionStatus | undefined {
        const value = this.runtimes.get(udid)?.status;
        return value ? { ...value } : undefined;
    }

    statuses(): DeviceConnectionStatus[] {
        return Array.from(this.runtimes.values(), ({ status }) => ({ ...status }));
    }

    async reconcile(): Promise<void> {
        if (this.running || this.closing) return;
        this.running = true;
        try {
            const [allDevices, connected, appiumReady] = await Promise.all([
                this.loadDevices(),
                this.connectedUdids(),
                this.endpointReady(`http://${process.env.APPIUM_HOST ?? '127.0.0.1'}:${Number(process.env.APPIUM_PORT ?? 4725)}/status`),
            ]);
            this.appium = appiumReady ? 'ready' : 'unavailable';
            // Disabled devices are supervised exactly like unregistered ones:
            // their WDA child is stopped and their runtime forgotten. So are
            // phones another Mac owns (shared Postgres registry): not our USB tree.
            const devices = activeDevices(localDevices(allDevices, this.hostId));
            const registered = new Set(devices.map(({ udid }) => udid));
            for (const [udid, runtime] of this.runtimes) {
                if (!registered.has(udid)) {
                    await this.stopChild(runtime);
                    this.runtimes.delete(udid);
                    this.logStore.forget(udid);
                }
            }
            const attached = new Set(connected);
            await Promise.all(devices.map(async (device) => {
                const runtime = this.runtimes.get(device.udid) ?? this.createRuntime(device);
                runtime.device = device;
                // A new signing team means a different WDA build: relaunch with it.
                if (runtime.child && runtime.spawnedTeam !== (device.signingTeam ?? '')) {
                    await this.stopChild(runtime);
                    runtime.retryAt = 0;
                }
                this.setPhysical(runtime, attached.has(device.udid) ? 'connected' : 'disconnected');
                if (!runtime.child && this.now() >= runtime.retryAt) this.startChild(runtime);
                const wdaPort = device.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100);
                const ready = attached.has(device.udid)
                    && await this.endpointReady(`http://127.0.0.1:${wdaPort}/status`);
                if (ready) this.update(runtime, 'ready', 'WDA is ready');
                else if (!attached.has(device.udid)) this.update(runtime, 'disconnected', 'Reconnect the USB cable');
                else if (runtime.status.wda === 'ready' || runtime.status.wda === 'disconnected') {
                    this.update(runtime, 'connecting', 'Starting WDA');
                }
            }));
        } finally {
            this.running = false;
        }
    }

    async reconnect(udid: string): Promise<DeviceConnectionStatus | undefined> {
        const runtime = this.runtimes.get(udid);
        if (!runtime) return;
        await this.stopChild(runtime);
        runtime.status.retryCount = 0;
        runtime.retryAt = 0;
        this.update(runtime, runtime.status.physical === 'connected' ? 'connecting' : 'disconnected',
            runtime.status.physical === 'connected' ? 'Restarting WDA' : 'Reconnect the USB cable');
        this.startChild(runtime);
        return this.status(udid);
    }

    async close(): Promise<void> {
        this.closing = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        await Promise.all(Array.from(this.runtimes.values(), (runtime) => this.stopChild(runtime)));
        await this.logStore.flush();
    }

    private createRuntime(device: RegisteredDevice): RuntimeState {
        const now = new Date(this.now()).toISOString();
        const runtime: RuntimeState = {
            device,
            retryAt: 0,
            status: {
                udid: device.udid,
                physical: 'disconnected',
                wda: 'disconnected',
                appium: this.appium,
                managed: true,
                message: 'Checking USB connection',
                retryCount: 0,
                updatedAt: now,
                restarts: 0,
                notReadySince: now,
                disconnectedSince: now,
            },
        };
        this.runtimes.set(device.udid, runtime);
        return runtime;
    }

    private update(runtime: RuntimeState, wda: DeviceConnectionPhase, message: string): void {
        if (runtime.status.wda === wda && runtime.status.message === message
            && runtime.status.appium === this.appium) return;
        const now = new Date(this.now()).toISOString();
        const previous = runtime.status;
        runtime.status = {
            ...previous,
            wda,
            appium: this.appium,
            message,
            updatedAt: now,
            restarts: (previous.restarts ?? 0) + (wda === 'error' && previous.wda !== 'error' ? 1 : 0),
            notReadySince: wda === 'ready' ? undefined : previous.notReadySince ?? now,
        };
        if (wda !== previous.wda) this.logStore.append(runtime.device.udid, `[wda-service] ${previous.wda} -> ${wda}: ${message}`);
    }

    private setPhysical(runtime: RuntimeState, physical: DeviceConnectionStatus['physical']): void {
        runtime.status.physical = physical;
        runtime.status.disconnectedSince = physical === 'connected'
            ? undefined
            : runtime.status.disconnectedSince ?? new Date(this.now()).toISOString();
    }

    private startChild(runtime: RuntimeState): void {
        if (runtime.child || this.closing) return;
        try {
            const child = this.spawnSupervisor(runtime.device);
            runtime.spawnedTeam = runtime.device.signingTeam ?? '';
            runtime.child = child;
            this.update(runtime, runtime.status.physical === 'connected' ? 'connecting' : 'disconnected',
                runtime.status.physical === 'connected' ? 'Starting WDA' : 'Waiting for the USB cable');
            // One splitter per stream: stdout and stderr interleave at chunk
            // boundaries, so a shared buffer would glue half-lines together.
            const streams = [child.stdout, child.stderr].map((stream) => {
                const splitter = new LineSplitter();
                stream?.on('data', (chunk: Buffer | string) => this.consumeLines(runtime, splitter.push(chunk)));
                return splitter;
            });
            child.once('error', (error) => this.update(runtime, 'error', error.message));
            child.once('exit', (code, signal) => {
                for (const splitter of streams) this.consumeLines(runtime, splitter.flush());
                if (runtime.child !== child) return;
                runtime.child = undefined;
                if (this.closing) return;
                runtime.status.retryCount += 1;
                const seconds = [2, 5, 10, 30][Math.min(runtime.status.retryCount - 1, 3)]!;
                runtime.retryAt = this.now() + seconds * 1_000;
                this.update(runtime, runtime.status.physical === 'connected' ? 'error' : 'disconnected',
                    runtime.status.physical === 'connected'
                        ? `WDA supervisor exited ${signal ? `after ${signal}` : `with code ${code ?? 'unknown'}`}; retrying in ${seconds}s`
                        : 'Reconnect the USB cable');
            });
        } catch (error) {
            runtime.status.retryCount += 1;
            runtime.retryAt = this.now() + 2_000;
            this.update(runtime, 'error', error instanceof Error ? error.message : String(error));
        }
    }

    private consumeLines(runtime: RuntimeState, lines: string[]): void {
        for (const line of lines) {
            if (line.trim()) this.logStore.append(runtime.device.udid, redactSecret(line, runtime.device.passcode));
            const state = parseSupervisorMessage(line);
            if (!state) continue;
            if (state.state === 'error') runtime.status.retryCount += 1;
            if (state.state === 'ready') runtime.status.retryCount = 0;
            this.update(runtime, state.state, state.message);
        }
    }

    private async stopChild(runtime: RuntimeState): Promise<void> {
        const child = runtime.child;
        runtime.child = undefined;
        if (!child || child.exitCode !== null || child.killed) return;
        child.kill('SIGTERM');
        await Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            new Promise<void>((resolve) => { setTimeout(resolve, 5_000).unref(); }),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
    }
}

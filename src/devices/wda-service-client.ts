import http from 'node:http';

import { loadRegisteredDevices, type RegisteredDevice } from './registry.js';
import { localDevices } from './host-identity.js';
import type {
    DeviceConnections,
    DeviceConnectionStatus,
} from './connection-manager.js';
import {
    wdaServiceSocketPath,
    type WdaServiceDevicesResponse,
    type WdaServiceErrorResponse,
    type WdaServiceLogsResponse,
} from './wda-service-protocol.js';

export interface ServiceResponse {
    statusCode: number;
    body: string;
}

export type WdaServiceRequester = (
    pathname: string,
    options?: { socketPath?: string; method?: 'GET' | 'POST'; timeoutMs?: number },
) => Promise<ServiceResponse>;

interface WdaServiceClientOptions {
    socketPath?: string;
    loadDevices?: () => Promise<RegisteredDevice[]>;
    pollIntervalMs?: number;
    requestTimeoutMs?: number;
    requestService?: WdaServiceRequester;
}

export function requestWdaService(
    pathname: string,
    options: { socketPath?: string; method?: 'GET' | 'POST'; timeoutMs?: number } = {},
): Promise<ServiceResponse> {
    return new Promise((resolve, reject) => {
        const request = http.request({
            socketPath: options.socketPath ?? wdaServiceSocketPath(),
            path: pathname,
            method: options.method ?? 'GET',
        }, (response) => {
            response.setEncoding('utf8');
            let body = '';
            response.on('data', (chunk: string) => { body += chunk; });
            response.once('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
        });
        request.setTimeout(options.timeoutMs ?? 2_000, () => {
            request.destroy(new Error('WDA service request timed out'));
        });
        // .on, not .once: a second socket error (e.g. EINVAL on an over-long path)
        // would otherwise be unhandled and crash the process.
        request.on('error', reject);
        request.end();
    });
}

function parseJson<T>(response: ServiceResponse): T {
    let value: unknown;
    try {
        value = JSON.parse(response.body);
    } catch {
        throw new Error(`WDA service returned invalid JSON with status ${response.statusCode}`);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        const message = (value as Partial<WdaServiceErrorResponse>).error;
        throw new Error(message ?? `WDA service returned status ${response.statusCode}`);
    }
    return value as T;
}

export class WdaServiceClient implements DeviceConnections {
    private readonly socketPath: string;
    private readonly loadDevices: () => Promise<RegisteredDevice[]>;
    private readonly pollIntervalMs: number;
    private readonly requestTimeoutMs: number;
    private readonly requestService: WdaServiceRequester;
    private readonly values = new Map<string, DeviceConnectionStatus>();
    private timer?: NodeJS.Timeout;
    private refreshing = false;
    private closing = false;

    constructor(options: WdaServiceClientOptions = {}) {
        this.socketPath = options.socketPath ?? wdaServiceSocketPath();
        this.loadDevices = options.loadDevices ?? (async () => localDevices(await loadRegisteredDevices()));
        this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
        this.requestService = options.requestService ?? requestWdaService;
    }

    async start(): Promise<void> {
        if (this.timer) return;
        this.closing = false;
        await this.refresh();
        this.timer = setInterval(() => void this.refresh().catch(console.error), this.pollIntervalMs);
    }

    async close(): Promise<void> {
        this.closing = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    status(udid: string): DeviceConnectionStatus | undefined {
        const value = this.values.get(udid);
        return value ? { ...value } : undefined;
    }

    statuses(): DeviceConnectionStatus[] {
        return Array.from(this.values.values(), (value) => ({ ...value }));
    }

    async reconnect(udid: string): Promise<DeviceConnectionStatus | undefined> {
        const response = await this.requestService(`/devices/${encodeURIComponent(udid)}/reconnect`, {
            socketPath: this.socketPath,
            method: 'POST',
            timeoutMs: 7_000,
        });
        if (response.statusCode === 404) return;
        const status = parseJson<DeviceConnectionStatus>(response);
        this.values.set(status.udid, status);
        return { ...status };
    }

    async logs(udid: string, limit = 200): Promise<string[] | undefined> {
        const response = await this.requestService(`/devices/${encodeURIComponent(udid)}/logs?lines=${limit}`, {
            socketPath: this.socketPath,
            timeoutMs: this.requestTimeoutMs,
        });
        if (response.statusCode === 404) return;
        return parseJson<WdaServiceLogsResponse>(response).lines;
    }

    async refresh(): Promise<void> {
        if (this.refreshing || this.closing) return;
        this.refreshing = true;
        try {
            const response = await this.requestService('/devices', {
                socketPath: this.socketPath,
                timeoutMs: this.requestTimeoutMs,
            });
            const body = parseJson<WdaServiceDevicesResponse>(response);
            this.values.clear();
            for (const status of body.devices) this.values.set(status.udid, status);
        } catch (error) {
            const now = new Date().toISOString();
            const message = `WDA service is unavailable: ${error instanceof Error ? error.message : String(error)}`;
            const devices = await this.loadDevices();
            const registered = new Set(devices.map(({ udid }) => udid));
            for (const udid of this.values.keys()) {
                if (!registered.has(udid)) this.values.delete(udid);
            }
            for (const device of devices) {
                const previous = this.values.get(device.udid);
                this.values.set(device.udid, {
                    udid: device.udid,
                    physical: previous?.physical ?? 'disconnected',
                    wda: 'error',
                    appium: 'unavailable',
                    managed: false,
                    message,
                    retryCount: previous?.retryCount ?? 0,
                    updatedAt: now,
                    restarts: previous?.restarts ?? 0,
                    notReadySince: previous?.notReadySince ?? now,
                    disconnectedSince: previous?.disconnectedSince,
                });
            }
        } finally {
            this.refreshing = false;
        }
    }
}

import type { HostDirectory, HostRecord } from '../hosts/directory.js';
import { RemoteDeviceError, type RemoteAction, type RemoteControl, type ScreenInfo } from '../devices/wda-remote.js';
import { agentToken } from './token.js';

/**
 * The dashboard side of the host agent: reach a phone that another Mac owns
 * through that Mac's /agent/* routes (src/agent/routes.ts), at the agent URL
 * its lease publishes in fleet.hosts, with the shared PHONE_FARM_AGENT_TOKEN.
 */

/** A failed agent call. A RemoteDeviceError, so the grid shows the phone as "not ready" rather than faulting. */
export class AgentRequestError extends RemoteDeviceError {
    constructor(message: string, readonly statusCode: number) {
        super(message);
    }
}

export interface AgentRequestInit {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    /** Deadline for the response headers (and body, for non-streams). Omit for a stream. */
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface AgentClientOptions {
    hosts: HostDirectory;
    /** Defaults to PHONE_FARM_AGENT_TOKEN, read per call so a test or reload can change it. */
    token?: () => string | undefined;
    fetch?: typeof fetch;
}

export class AgentClient {
    private readonly hosts: HostDirectory;
    private readonly token: () => string | undefined;
    private readonly fetchImpl: typeof fetch;

    constructor(options: AgentClientOptions) {
        this.hosts = options.hosts;
        this.token = options.token ?? (() => agentToken());
        this.fetchImpl = options.fetch ?? fetch;
    }

    listHosts(): Promise<HostRecord[]> {
        return this.hosts.list();
    }

    private async agentUrl(hostId: string): Promise<string> {
        const host = (await this.hosts.list()).find(({ id }) => id === hostId);
        if (!host) throw new AgentRequestError(`Host ${hostId} is not in fleet.hosts; start its worker or wda-service`, 502);
        if (!host.agentUrl) throw new AgentRequestError(`Host ${hostId} publishes no agent URL; set PHONE_FARM_AGENT_URL there`, 502);
        return host.agentUrl.replace(/\/+$/, '');
    }

    /** One authenticated request to a host's agent. Never follows redirects, so the token cannot be sent elsewhere. */
    async request(hostId: string, pathAndQuery: string, init: AgentRequestInit = {}): Promise<Response> {
        const token = this.token();
        if (!token) throw new AgentRequestError('PHONE_FARM_AGENT_TOKEN is not set on this host, so it cannot reach other hosts\' phones', 502);
        const base = await this.agentUrl(hostId);
        const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
        try {
            return await this.fetchImpl(`${base}${pathAndQuery}`, {
                method: init.method ?? 'GET',
                headers: { ...init.headers, authorization: `Bearer ${token}` },
                ...(init.body !== undefined ? { body: init.body } : {}),
                ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
                redirect: 'error',
            });
        } catch (error) {
            const reason = (error as Error)?.name === 'TimeoutError' ? 'timed out' : 'did not answer';
            throw new AgentRequestError(`Host ${hostId} ${reason}`, reason === 'timed out' ? 504 : 502);
        }
    }
}

const devicePath = (udid: string, rest: string) => `/agent/devices/${encodeURIComponent(udid)}${rest}`;

async function failure(hostId: string, response: Response): Promise<AgentRequestError> {
    let message = `Host ${hostId} answered ${response.status}`;
    try {
        const body = await response.json() as { error?: unknown };
        if (typeof body.error === 'string') message = body.error;
    } catch { /* not JSON */ }
    // Upstream 4xx (e.g. 409 automation running) keep their meaning; anything else is a bad gateway.
    return new AgentRequestError(message, response.status >= 400 && response.status < 500 ? response.status : 502);
}

/**
 * The RemoteControl the dashboard uses: this host's phones go to `local`
 * (WDA on 127.0.0.1); a phone another host owns goes through that host's
 * agent. `ownerOf` answers the owning host id, or undefined for a local phone.
 */
export class FleetRemoteControl implements RemoteControl {
    constructor(
        private readonly local: RemoteControl,
        private readonly agent: AgentClient,
        private readonly ownerOf: (udid: string) => Promise<string | undefined>,
    ) {}

    forget(udid: string): void {
        this.local.forget?.(udid);
    }

    private async remoteJson<T>(hostId: string, udid: string, rest: string, init: AgentRequestInit): Promise<T> {
        const response = await this.agent.request(hostId, devicePath(udid, rest), init);
        if (!response.ok) throw await failure(hostId, response);
        return await response.json() as T;
    }

    async getScreenInfo(udid: string): Promise<ScreenInfo> {
        const host = await this.ownerOf(udid);
        if (!host) return this.local.getScreenInfo(udid);
        return (await this.remoteJson<{ screen: ScreenInfo }>(host, udid, '/remote/info', { timeoutMs: 5_000 })).screen;
    }

    async getScreenshot(udid: string, options?: { timeoutMs?: number }): Promise<Buffer> {
        const host = await this.ownerOf(udid);
        if (!host) return this.local.getScreenshot(udid, options);
        const response = await this.agent.request(host, devicePath(udid, '/remote/screenshot'), { timeoutMs: (options?.timeoutMs ?? 10_000) + 2_000 });
        if (!response.ok) throw await failure(host, response);
        return Buffer.from(await response.arrayBuffer());
    }

    async getMjpegStream(udid: string, signal?: AbortSignal): Promise<Response> {
        const host = await this.ownerOf(udid);
        if (!host) return this.local.getMjpegStream(udid, signal);
        const response = await this.agent.request(host, devicePath(udid, '/remote/stream'), { ...(signal ? { signal } : {}) });
        if (!response.ok) throw await failure(host, response);
        return response;
    }

    async performAction(udid: string, action: RemoteAction): Promise<void> {
        const host = await this.ownerOf(udid);
        if (!host) return this.local.performAction(udid, action);
        await this.remoteJson(host, udid, '/remote/action', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action), timeoutMs: 15_000,
        });
    }

    async isLocked(udid: string): Promise<boolean> {
        const host = await this.ownerOf(udid);
        if (!host) return this.local.isLocked(udid);
        return (await this.remoteJson<{ locked: boolean }>(host, udid, '/remote/locked', { timeoutMs: 5_000 })).locked === true;
    }
}

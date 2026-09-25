import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import net from 'node:net';

import { AGENT_TOKEN_MIN_LENGTH, agentToken } from './token.js';

/**
 * The host agent's own listener. The dashboard stays on loopback (AGENTS.md
 * invariant 3; `assertSafeBind` is unchanged). When PHONE_FARM_AGENT_BIND is set
 * (e.g. `100.101.74.35:3001`, this Mac's Tailscale address), a second listener
 * opens there that forwards ONLY /agent/* requests into the same app — those
 * routes demand the shared bearer token — and answers 404 to everything else,
 * so the dashboard itself is never exposed through it.
 */

export interface AgentBind {
    host: string;
    port: number;
}

const WILDCARDS = new Set(['0.0.0.0', '::', '[::]', '*', '::0', '0:0:0:0:0:0:0:0']);

/** Parse `host:port` / `[v6]:port` and refuse anything that would listen on every interface. */
export function parseAgentBind(value: string): AgentBind {
    const trimmed = value.trim();
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed) ?? /^([^:]+):(\d+)$/.exec(trimmed);
    if (!match) throw new Error('PHONE_FARM_AGENT_BIND must be <ip>:<port>, e.g. 100.101.74.35:3001 (your Tailscale address)');
    const host = match[1]!;
    const port = Number(match[2]);
    if (WILDCARDS.has(host) || WILDCARDS.has(`[${host}]`)) {
        throw new Error('PHONE_FARM_AGENT_BIND refuses to listen on every interface; bind the Tailscale IP only');
    }
    if (!net.isIP(host) && host !== 'localhost') throw new Error('PHONE_FARM_AGENT_BIND must name an IP address (your Tailscale address), not a hostname');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PHONE_FARM_AGENT_BIND port must be between 1 and 65535');
    return { host, port };
}

/** Refuse to open the agent listener without a strong token, or on a wildcard address. */
export function assertSafeAgentBind(value: string, env: NodeJS.ProcessEnv = process.env): AgentBind {
    const bind = parseAgentBind(value);
    const token = agentToken(env);
    if (!token || token.length < AGENT_TOKEN_MIN_LENGTH) {
        throw new Error(`PHONE_FARM_AGENT_BIND needs PHONE_FARM_AGENT_TOKEN of at least ${AGENT_TOKEN_MIN_LENGTH} characters (openssl rand -hex 32)`);
    }
    return bind;
}

/**
 * Whether a raw request target may reach the app through the agent listener:
 * under /agent/ and with nothing a router or proxy could normalise into
 * another path (dot segments, encoded slashes or dots, backslashes, `//`).
 */
export function isAgentRequestPath(rawUrl: string | undefined): boolean {
    if (!rawUrl) return false;
    const pathname = rawUrl.split('?')[0] ?? '';
    if (!pathname.startsWith('/agent/')) return false;
    if (/%2e|%2f|%5c/i.test(pathname) || pathname.includes('\\') || pathname.includes('//')) return false;
    return !pathname.split('/').some((segment) => segment === '.' || segment === '..');
}

/** Open the agent listener on `bind`, routing allowed requests into `app` (which must already be ready). */
export async function startAgentListener(app: FastifyInstance, bind: AgentBind): Promise<{ address: AgentBind; close(): Promise<void> }> {
    const server = http.createServer((request, response) => {
        if (!isAgentRequestPath(request.url)) {
            response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}');
            return;
        }
        app.routing(request, response);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bind.port, bind.host, () => { server.off('error', reject); resolve(); });
    });
    const address = server.address() as net.AddressInfo;
    return {
        address: { host: address.address, port: address.port },
        close: () => new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        }),
    };
}

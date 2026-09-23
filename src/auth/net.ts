import net from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * Who is on the other end of a request, for a dashboard that is usually
 * published through a Cloudflare tunnel: cloudflared runs on the same Mac and
 * connects to 127.0.0.1, so every tunnelled request arrives from loopback and
 * the real client is only named by Cloudflare's headers. Those headers are
 * trusted ONLY when the TCP peer is loopback — anyone else could forge them.
 */

export function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) return false;
    const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (plain === '::1') return true;
    return net.isIPv4(plain) && plain.startsWith('127.');
}

function header(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

function peerAddress(request: FastifyRequest): string | undefined {
    return request.socket?.remoteAddress ?? request.raw.socket?.remoteAddress;
}

/** The client's IP: `CF-Connecting-IP` when the peer is loopback and the header is a valid IP, else the peer. */
export function clientIp(request: FastifyRequest): string {
    const peer = peerAddress(request) ?? '';
    if (isLoopbackAddress(peer)) {
        const forwarded = header(request, 'cf-connecting-ip')?.trim();
        if (forwarded && net.isIP(forwarded)) return forwarded;
    }
    return peer;
}

/**
 * True when the browser reached us over HTTPS: a TLS socket, or — from a
 * loopback proxy only — `X-Forwarded-Proto: https` or Cloudflare's
 * `CF-Visitor: {"scheme":"https"}`. Decides the cookie's Secure flag, so plain
 * http://127.0.0.1 keeps working for local use.
 */
export function isHttpsRequest(request: FastifyRequest): boolean {
    if ((request.raw.socket as { encrypted?: boolean } | undefined)?.encrypted) return true;
    if (!isLoopbackAddress(peerAddress(request))) return false;
    const proto = header(request, 'x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    if (proto === 'https') return true;
    const visitor = header(request, 'cf-visitor');
    if (visitor) {
        try {
            return (JSON.parse(visitor) as { scheme?: unknown }).scheme === 'https';
        } catch { /* malformed header */ }
    }
    return false;
}

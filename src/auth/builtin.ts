import type { FastifyReply, FastifyRequest } from 'fastify';

import { createDatabaseConnection } from '../database/client.js';
import type { AuthenticatedUser, AuthProvider } from '../plugin.js';
import { AccountService, type ResolvedSession } from './accounts.js';
import { isHttpsRequest } from './net.js';
import { PgAuthStore } from './pg-store.js';

/**
 * The built-in auth provider (`PHONE_FARM_AUTH_PLUGIN=builtin`): accounts in
 * Postgres, a server-side session behind an HttpOnly cookie, and per-device
 * access through `UserAccess`. The login, password and Team pages are
 * registered by the dashboard (src/auth/routes.ts) so they share its theme.
 */

export const SESSION_COOKIE = 'pf_session';
export const LOGIN_PATH = '/login';
export const LOGOUT_PATH = '/logout';
export const PASSWORD_PATH = '/account/password';

/** Reachable without a session: the sign-in page and only what it needs to render. */
const PUBLIC_PATHS = new Set([LOGIN_PATH, LOGOUT_PATH, '/health', '/assets/styles.css', '/assets/brand-logo']);

export function isBuiltinPublicPath(path: string): boolean {
    return PUBLIC_PATHS.has(path) || /^\/assets\/fonts\/[^/]+$/.test(path);
}

export interface BuiltinAuthProvider extends AuthProvider {
    readonly accounts: AccountService;
    /** The resolved session for this request, when `authenticate` found one. */
    sessionOf(request: FastifyRequest): ResolvedSession | undefined;
}

export function isBuiltinAuthProvider(provider: AuthProvider | null | undefined): provider is BuiltinAuthProvider {
    return Boolean(provider && provider.id === 'builtin' && 'accounts' in provider);
}

export function sessionCookieOptions(request: FastifyRequest, maxAgeSeconds?: number) {
    return {
        path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isHttpsRequest(request),
        ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
    };
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string, maxAgeSeconds: number): void {
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(request, maxAgeSeconds));
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(request));
}

export function authenticatedUserFrom(resolved: ResolvedSession): AuthenticatedUser {
    return {
        id: resolved.user.id,
        roles: [resolved.user.role],
        displayName: resolved.user.displayName,
        mustChangePassword: resolved.user.mustChangePassword,
        access: resolved.access,
    };
}

export function createBuiltinAuthProvider(accounts: AccountService, onClose?: () => Promise<void>): BuiltinAuthProvider {
    const sessions = new WeakMap<FastifyRequest, ResolvedSession>();
    return {
        id: 'builtin',
        accounts,
        loginPath: LOGIN_PATH,
        logoutPath: LOGOUT_PATH,
        logoutMethod: 'POST',
        passwordChangePath: PASSWORD_PATH,
        registerRoutes() { /* the dashboard registers the pages; see src/auth/routes.ts */ },
        isPublicPath: isBuiltinPublicPath,
        sessionOf: (request) => sessions.get(request),
        async authenticate(request, reply) {
            const token = request.cookies?.[SESSION_COOKIE];
            if (!token) return null;
            const resolved = await accounts.resolveSession(token);
            if (!resolved) {
                clearSessionCookie(request, reply);
                return null;
            }
            sessions.set(request, resolved);
            return authenticatedUserFrom(resolved);
        },
        async close() { await onClose?.(); },
    };
}

/** `PHONE_FARM_AUTH_PLUGIN=builtin`: a provider over the `auth` schema of DATABASE_URL. */
export async function createBuiltinAuthProviderFromEnv(): Promise<BuiltinAuthProvider> {
    const connection = createDatabaseConnection();
    try {
        const result = await connection.pool.query<{ present: string | null }>(`select to_regclass('auth.users')::text as present`);
        if (!result.rows[0]?.present) throw new Error('Built-in auth tables are missing; run npm run db:migrate');
    } catch (error) {
        await connection.close();
        throw error;
    }
    const idle = Number(process.env.PHONE_FARM_SESSION_IDLE_HOURS);
    const absolute = Number(process.env.PHONE_FARM_SESSION_MAX_DAYS);
    const accounts = new AccountService({
        store: new PgAuthStore(connection),
        ...(Number.isFinite(idle) && idle > 0 ? { idleTimeoutMs: idle * 60 * 60_000 } : {}),
        ...(Number.isFinite(absolute) && absolute > 0 ? { absoluteTimeoutMs: absolute * 24 * 60 * 60_000 } : {}),
    });
    return createBuiltinAuthProvider(accounts, () => connection.close());
}

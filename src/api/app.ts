import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';

import { FULL_ACCESS, requestAccessFor, type RequestAccess } from '../auth/access.js';
import { isBuiltinAuthProvider } from '../auth/builtin.js';
import { levelSatisfies, type AccessLevel } from '../auth/policy.js';
import { SINGLE_TENANT, type DeviceTenants } from '../auth/tenants.js';
import { buildRouteRequirements, routeKey, type RouteRequirement } from '../auth/route-access.js';
import { registerBuiltinAuthRoutes, safeNextPath, type ShellOptions } from '../auth/routes.js';
import { connectedDevices, type Device } from '../devices/discovery.js';
import {
    backfillDeviceModels, loadRegisteredDevices, missingModels, mutateRegisteredDevices, saveRegisteredDevices, redactDevice,
    PASSCODE_PATTERN, type RegisteredDevice,
} from '../devices/registry.js';
import { createScreenshotCache } from '../devices/screenshot-cache.js';
import { createThumbnailCache, thumbnailWidth } from '../devices/thumbnail.js';
import {
    CALIBRATABLE_POINTS, POINT_LABELS, coordinatesForProfile, resolveDeviceCoordinates, validateCoordinateOverrides,
} from '../devices/coordinates.js';
import { RegistryWdaRemoteControl } from '../devices/registry-remote.js';
import type {
    DeviceRegistrationManager, RegistrationAction, RegistrationUpdate,
} from '../devices/registration.js';
import { RemoteDeviceError, type RemoteAction, type RemoteControl } from '../devices/wda-remote.js';
import { requestWdaService } from '../devices/wda-service-client.js';
import type { DeviceConnectionStatus } from '../devices/connection-manager.js';
import { escapeHtml } from '../html.js';
import { brandHtml, brandingFromEnv, footerHtml, logoContentType, type Branding } from '../branding.js';
import type { AuthenticatedUser, AuthProvider, PluginNavLink } from '../plugin.js';
import type { PluginRegistry } from '../registry.js';
import type { CreateTaskInput, JsonObject, ScheduleTiming } from '../types.js';
import { DEFAULT_TENANT_ID, maxUploadBytes } from '../tenancy.js';
import { ScheduleTransitionError, UploadQuotaError, type SchedulerRepository } from '../scheduler/repository.js';
import { PROMETHEUS_CONTENT_TYPE, renderMetrics } from '../observability/metrics.js';
import { checkReadiness, createDefaultProbes, type ObservabilityProbes } from '../observability/probes.js';
import { AgentClient, AgentRequestError, FleetRemoteControl } from '../agent/client.js';
import { agentToken, bearerToken, tokenMatches } from '../agent/token.js';
import { isLocalDevice, localDevices, localHostId } from '../devices/host-identity.js';
import { postgresHostDirectory, type HostDirectory } from '../hosts/directory.js';

export interface CreateAppOptions {
    plugins: PluginRegistry;
    scheduler: SchedulerRepository;
    authProvider?: AuthProvider | null;
    dashboardTheme?: DashboardTheme;
    registrations?: DeviceRegistrationManager;
    logger?: boolean;
    /** Test seams: default to the registry-backed WDA client, usbmux discovery and the wda-service supervisor. */
    remote?: RemoteControl;
    discoverDevices?: () => Promise<Device[]>;
    wdaStatuses?: () => Promise<DeviceConnectionStatus[]>;
    /** Dependency probes for /health/ready and /metrics; defaults to Postgres, Appium and the wda-service socket. */
    observability?: ObservabilityProbes;
    /** A phone's recent supervisor output; defaults to the wda-service socket. Undefined means unknown phone. */
    wdaLogs?: (udid: string, limit: number) => Promise<string[] | undefined>;
    /** Multi-host: this Mac's id (default PHONE_FARM_HOST_ID / hostname). Phones with another hostId are reached through their host's agent. */
    hostId?: string;
    /** Multi-host: where other hosts' agents are (default fleet.hosts in Postgres, opened on first use). */
    hosts?: HostDirectory;
    /** Multi-host test seam: the fetch used to call other hosts' agents. */
    agentFetch?: typeof fetch;
}

/** What GET /agent/status answers: this host's phones with their USB and WDA state. */
export interface AgentStatusResponse {
    hostId: string;
    devices: Array<{ udid: string; connected: Device | null; status: DeviceConnectionStatus | null }>;
}

export interface DashboardTheme {
    rootDirectory: string;
    renderDevice?(template: string, device: RegisteredDevice): string;
}

interface LoadedDashboardTheme {
    /** Content hashes of the versioned assets, for pages built in code (sign-in, Team). */
    versions: Record<string, string>;
    teamScript: string;
    indexHtml: string;
    deviceHtml: string;
    tasksHtml: string;
    styles: string;
    deviceScript: string;
    tasksScript: string;
    registerDeviceHtml: string;
    registerDeviceScript: string;
    gridScript: string;
    htmx: string;
    fonts: Map<string, Buffer>;
}

/**
 * The self-hosted dashboard fonts (static/dashboard/fonts, SIL OFL). The font
 * route serves only these names, so a request can never reach another file.
 */
export const DASHBOARD_FONTS = [
    'oswald-latin-variable.woff2', 'poppins-latin-400.woff2', 'poppins-latin-500.woff2', 'poppins-latin-600.woff2',
] as const;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Thrown inside route bodies / registry mutations; mapped to its status by setErrorHandler. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode });
}

function csrfBlocked(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({
        error: 'Cross-origin write blocked. Send an Authorization: Bearer token for API clients, '
            + 'or add the origin to PHONE_FARM_TRUSTED_ORIGINS.',
    });
}


// Brand name, credit, logo and footer come from the environment (src/branding.ts)
// so a licensee can white-label the dashboard without forking.
function page(title: string, body: string, authNav: string, navLinks: readonly PluginNavLink[], branding: Branding, footer: string): string {
    const extra = navLinks.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('');
    // A minimal copy of the dashboard tokens (static/dashboard/styles.css :root),
    // system fonts only, so un-themed pages and errors match the dark dashboard.
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(branding.title)}</title><style>
:root{color-scheme:dark;--bg:#0a0a0c;--bg-2:#101014;--panel:#141419;--line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.16);--ink:#f6f6f8;--muted:#a9a9b4;--pink-2:#ff5fae;--pink-deep:#d6166f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Helvetica Neue",sans-serif}
nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 20px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--bg-2)}
nav form{display:inline}nav .nav-user{color:var(--muted);font-size:12px}nav a{color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;text-decoration:none}nav a:hover{color:var(--ink)}nav .home{margin-right:auto;color:var(--ink);letter-spacing:.18em}
main{max-width:1100px;margin:24px auto;padding:0 20px}h1{font-size:28px;letter-spacing:.01em;text-transform:uppercase;margin:0 0 12px}h2{font-size:15px;letter-spacing:.06em;text-transform:uppercase}
.card{margin:14px 0;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
button,.button{display:inline-flex;align-items:center;min-height:36px;padding:0 16px;border:0;border-radius:999px;background:var(--pink-deep);color:#fff;font:600 12px system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;cursor:pointer}
.button.secondary{border:1px solid var(--line-strong);background:transparent;color:var(--ink)}a{color:var(--pink-2)}
input,select,textarea{min-height:36px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:10px;background:var(--bg-2);color:var(--ink);font:inherit}
:focus-visible{outline:2px solid var(--pink-2);outline-offset:2px}footer{max-width:1100px;margin:24px auto;padding:16px 20px;color:var(--muted);font-size:12px}footer a{color:var(--muted)}</style></head>
<body><nav><a class="home" href="/">${escapeHtml(branding.name)}</a><a href="/">Devices</a><a href="/tasks">Tasks</a><a href="/docs">API</a>${extra}${authNav}</nav><main>${body}</main><footer>${footer}</footer></body></html>`;
}

/**
 * How often the device grid re-polls itself. Each poll pulls a still from every
 * connected phone, so at two phones 5s is free and at twenty it is twenty WDA
 * round trips over one shared USB tree. The cadence opens up as the rack grows;
 * `PHONE_FARM_GRID_POLL_SECONDS` overrides it either way.
 */
export function gridPollSeconds(activeDeviceCount: number): number {
    const configured = Number(process.env.PHONE_FARM_GRID_POLL_SECONDS);
    if (Number.isFinite(configured) && configured >= 1) return Math.round(configured);
    return activeDeviceCount > 10 ? 10 : 5;
}

export const DEFAULT_GRID_SCREENSHOT_TIMEOUT_MS = 3_000;

/**
 * The WDA deadline for a grid still. A phone that cannot answer in a few seconds
 * is shown as unavailable rather than holding a browser connection for the full
 * 10s client default. `PHONE_FARM_GRID_SCREENSHOT_TIMEOUT_MS` overrides it.
 */
export function gridScreenshotTimeoutMs(): number {
    const configured = Number(process.env.PHONE_FARM_GRID_SCREENSHOT_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 100 ? Math.round(configured) : DEFAULT_GRID_SCREENSHOT_TIMEOUT_MS;
}

/** The supervisor's per-device WDA state, read once per grid poll. */
async function supervisorLogs(udid: string, limit: number): Promise<string[] | undefined> {
    const response = await requestWdaService(`/devices/${encodeURIComponent(udid)}/logs?lines=${limit}`, { timeoutMs: 1_500 });
    if (response.statusCode === 404) return;
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`WDA service returned ${response.statusCode}`);
    const lines = (JSON.parse(response.body) as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) throw new Error('WDA service returned no log lines');
    return lines.map(String);
}

async function supervisorStatuses(): Promise<DeviceConnectionStatus[]> {
    const response = await requestWdaService('/devices', { timeoutMs: 1_500 });
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`WDA service returned ${response.statusCode}`);
    const devices = (JSON.parse(response.body) as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) throw new Error('WDA service returned no device list');
    return devices as DeviceConnectionStatus[];
}

/**
 * The grid card's phone-frame proportions from the device's coordinate profile,
 * as an inline custom property. Numbers only; an unknown profile falls back to
 * the stylesheet default rather than breaking the whole grid.
 */
function screenRatioStyle(profile: string | undefined): string {
    try {
        const { width, height } = coordinatesForProfile(profile).screenSize;
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return ` style="--screen-ar: ${Math.round(width)} / ${Math.round(height)}"`;
        }
    } catch { /* unknown profile */ }
    return '';
}

/** A stable, id-safe token for a device, so htmx can match its elements across swaps. */
function deviceKey(udid: string): string {
    return crypto.createHash('sha1').update(udid).digest('hex').slice(0, 12);
}

/** htmx preserves the preview <img> by this id across the grid poll. */
function previewId(udid: string): string {
    return `preview-${deviceKey(udid)}`;
}

function ageText(at: number | undefined): string {
    if (!at) return '';
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return `updated ${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `updated ${minutes}m ago` : `updated ${Math.round(minutes / 60)}h ago`;
}

export interface RegisteredRoute {
    method: string;
    url: string;
}

export interface RouteAccessEntry extends RegisteredRoute {
    requirement: RouteRequirement | undefined;
}

const appRoutes = new WeakMap<FastifyInstance, { routes: RegisteredRoute[]; requirements: Map<string, RouteRequirement> }>();

/**
 * Every route the app registered, with the requirement the authorization hook
 * applies to it. `requirement: undefined` means admin-only by default —
 * test/auth-route-coverage.test.ts insists there are none.
 */
export function routeAccessReport(app: FastifyInstance): RouteAccessEntry[] {
    const entry = appRoutes.get(app);
    if (!entry) return [];
    return entry.routes.map((route) => ({ ...route, requirement: entry.requirements.get(routeKey(route.method, route.url)) }));
}

/** Browser page navigations get redirects and HTML; API and asset requests get JSON. */
function wantsPage(request: FastifyRequest): boolean {
    const pathname = request.url.split('?')[0] ?? '';
    if (!['GET', 'HEAD'].includes(request.method) || pathname.startsWith('/api/') || pathname.startsWith('/assets/')) return false;
    const accept = request.headers.accept ?? '';
    return !request.headers['hx-request'] && (accept === '' || accept.includes('text/html') || accept.includes('*/*'));
}


export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
    const app = Fastify({ logger: options.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
    const routes: RegisteredRoute[] = [];
    const requirements = buildRouteRequirements(options.plugins.list());
    appRoutes.set(app, { routes, requirements });
    app.addHook('onRoute', (route) => {
        for (const method of [route.method].flat()) routes.push({ method: String(method), url: route.url ?? route.path });
    });
    await app.register(formbody);
    await app.register(cookie);
    // One uploaded file: PHONE_FARM_MAX_UPLOAD_BYTES, default 200 MiB. A bigger
    // file fails the request with 413; each tenant also has a total budget.
    await app.register(multipart, { limits: { fileSize: maxUploadBytes(), files: 20 } });

    // Server-rendered HTML must never be cached — a stale page + fresh assets
    // (or vice versa) breaks the dashboard after a deploy.
    app.addHook('onSend', async (_request, reply) => {
        const type = reply.getHeader('content-type');
        if (typeof type === 'string' && type.includes('text/html') && !reply.hasHeader('cache-control')) {
            reply.header('cache-control', 'no-cache');
        }
    });

    // CSRF guard — runs for every deployment, auth or not. The default loopback
    // dashboard is otherwise open to form-encoded POSTs from any page the
    // operator has open in the same browser (tap the phone, stop executions,
    // launch tasks). A Bearer token means a real API client, not a browser form.
    app.addHook('onRequest', async (request, reply) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
        if (request.headers.authorization?.startsWith('Bearer ')) return;
        const origin = request.headers.origin;
        if (!origin) return csrfBlocked(reply);
        const configured = [process.env.PUBLIC_ORIGIN, ...(process.env.PHONE_FARM_TRUSTED_ORIGINS ?? '').split(',')]
            .map((value) => value?.trim().replace(/\/+$/, '')).filter((value): value is string => Boolean(value));
        if (configured.length) {
            if (!configured.includes(origin.replace(/\/+$/, ''))) return csrfBlocked(reply);
            return;
        }
        // Nothing configured: same-origin only, compared by host (ignoring
        // scheme) so a TLS-terminating proxy that doesn't forward
        // x-forwarded-proto still passes. URL normalises default ports, so
        // compare the Origin's host against the request Host under both schemes.
        // Set PHONE_FARM_TRUSTED_ORIGINS if the proxy also rewrites Host.
        let originHost: string;
        try { originHost = new URL(origin).host; } catch { return csrfBlocked(reply); }
        const hostMatches = ['http', 'https'].some((scheme) => {
            try { return new URL(`${scheme}://${request.headers.host}`).host === originHost; } catch { return false; }
        });
        if (!hostMatches) return csrfBlocked(reply);
    });

    // Authentication (who) runs on every request; authorization (what) runs in
    // the preHandler below, once the route and body are known. With no provider
    // the dashboard is the loopback-only, everything-allowed tool it always was.
    const provider = options.authProvider ?? null;
    const requestUsers = new WeakMap<FastifyRequest, AuthenticatedUser>();
    const accessOf = (request: FastifyRequest): RequestAccess => (provider ? requestAccessFor(requestUsers.get(request)) : FULL_ACCESS);
    const pathOf = (request: FastifyRequest) => request.url.split('?')[0] ?? request.url;
    if (provider) {
        await provider.registerRoutes(app);
        app.addHook('onRequest', async (request, reply) => {
            const pathname = pathOf(request);
            if (provider.isPublicPath(pathname)) return;
            // Machine endpoints that authenticate themselves (a bearer token, not a session).
            if (requirements.get(routeKey(request.method, request.routeOptions.url ?? ''))?.kind === 'token') return;
            const user = await provider.authenticate(request, reply);
            if (reply.sent) return reply;
            if (!user) {
                if (provider.loginPath && request.headers['hx-request']) {
                    return reply.code(401).header('hx-redirect', provider.loginPath).send({ error: 'Authentication required' });
                }
                if (provider.loginPath && wantsPage(request)) {
                    const next = safeNextPath(request.url);
                    return reply.redirect(next === '/' ? provider.loginPath : `${provider.loginPath}?next=${encodeURIComponent(next)}`);
                }
                return reply.code(401).send({ error: 'Authentication required' });
            }
            requestUsers.set(request, user);
            const changePath = provider.passwordChangePath;
            if (user.mustChangePassword && changePath) {
                const allowed = pathname === changePath || pathname === provider.logoutPath
                    || pathname === '/api/me' || pathname.startsWith('/assets/');
                if (!allowed) {
                    if (wantsPage(request)) return reply.redirect(changePath);
                    return reply.code(403).send({ error: 'Change your password before continuing' });
                }
            }
        });
    }

    // Authorization, centrally: every route is looked up in the requirement
    // table (src/auth/route-access.ts). Admins, and users of a provider without
    // scoped access, pass straight through; operators are checked against the
    // phone the route touches. Unknown and ungranted phones are both a 404.
    const deny = (request: FastifyRequest, reply: FastifyReply, statusCode: 403 | 404, message: string) => {
        if (!pathOf(request).startsWith('/api/') && request.method === 'GET') {
            const title = statusCode === 404 ? 'Not found' : 'Not allowed';
            return reply.code(statusCode).type('text/html').send(renderPage(title, `<section class="card"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p><p><a class="button" href="/">Back to devices</a></p></section>`, request));
        }
        return reply.code(statusCode).send({ error: message });
    };
    // Which tenant owns each phone (src/auth/tenants.ts): the built-in accounts
    // keep it in auth.tenant_devices; without them one tenant owns everything.
    const tenantService = isBuiltinAuthProvider(provider) ? provider.tenants : undefined;
    const deviceTenants = async (): Promise<DeviceTenants> => (tenantService ? tenantService.deviceTenants() : SINGLE_TENANT);
    /** Registered phones, each labelled with the tenant that owns it. */
    const loadOwnedDevices = async () => {
        const [devices, owners] = await Promise.all([loadRegisteredDevices(), deviceTenants()]);
        return devices.map((device) => ({ ...device, tenantId: owners.tenantOf(device.udid) }));
    };
    const authorizeDevice = async (
        request: FastifyRequest, reply: FastifyReply, access: RequestAccess, udid: unknown, level: AccessLevel, notFound = 'Device not found',
    ) => {
        const device = typeof udid === 'string' && udid ? (await loadOwnedDevices()).find((entry) => entry.udid === udid) : undefined;
        const granted = device ? access.levelFor(device) : null;
        if (!granted) return deny(request, reply, 404, notFound);
        if (!levelSatisfies(granted, level)) return deny(request, reply, 403, 'You have view-only access to this phone');
        return undefined;
    };
    if (provider) {
        app.addHook('preHandler', async (request, reply) => {
            const url = request.routeOptions.url;
            if (!url || provider.isPublicPath(pathOf(request))) return;
            const access = accessOf(request);
            if (access.platform) return;
            const requirement = requirements.get(routeKey(request.method, url));
            const params = (request.params ?? {}) as Record<string, string | undefined>;
            const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
            switch (requirement?.kind) {
                case 'public':
                case 'signed-in':
                case 'token':
                    return;
                case 'tenant-admin':
                    return access.tenantAdmin ? undefined : deny(request, reply, 403, 'Admin access required');
                case 'any-operate':
                    return access.anyOperate ? undefined : deny(request, reply, 403, 'You need operate access to at least one phone');
                case 'device':
                    return authorizeDevice(request, reply, access, params.udid, requirement.level);
                case 'device-settings': {
                    // Calibration saves touch points through the device PATCH; that
                    // alone is an operator action. Everything else is device setup.
                    const keys = Object.keys(body);
                    if (keys.length && keys.every((key) => key === 'coordinates')) {
                        return authorizeDevice(request, reply, access, params.udid, 'operate');
                    }
                    const refused = await authorizeDevice(request, reply, access, params.udid, 'view');
                    return refused ?? deny(request, reply, 403, 'Only platform staff can change device settings');
                }
                case 'schedule-create':
                    return authorizeDevice(request, reply, access, body.deviceUdid, 'operate');
                case 'schedule': {
                    // Fetched within the caller's tenant: another tenant's schedule is not found.
                    const schedule = params.id ? await options.scheduler.schedule(params.id, access.tenantId ?? '') : null;
                    if (!schedule || !access.canSeeTenant(schedule.tenantId)) return deny(request, reply, 404, 'Schedule not found');
                    return authorizeDevice(request, reply, access, schedule.deviceUdid, requirement.level, 'Schedule not found');
                }
                case 'execution': {
                    const execution = params.id ? await options.scheduler.execution(params.id, access.tenantId ?? '') : null;
                    if (!execution || !access.canSeeTenant(execution.tenantId)) return deny(request, reply, 404, 'Execution not found');
                    return authorizeDevice(request, reply, access, execution.deviceUdid, requirement.level, 'Execution not found');
                }
                default:
                    // 'platform', and any route nobody declared: platform staff only.
                    return deny(request, reply, 403, 'Platform access required');
            }
        });
    }

    const discover = options.discoverDevices ?? connectedDevices;
    const wdaStatuses = options.wdaStatuses ?? supervisorStatuses;

    // Multi-host (docs/multi-host.md). A phone whose hostId is another Mac is
    // reached through that Mac's /agent/* routes; everything else is local.
    const hostId = options.hostId ?? localHostId();
    const hostDirectory = options.hosts ?? postgresHostDirectory();
    if (!options.hosts) app.addHook('onClose', async () => hostDirectory.close?.());
    const agent = new AgentClient({ hosts: hostDirectory, ...(options.agentFetch ? { fetch: options.agentFetch } : {}) });
    /** The host that owns a registered phone when that is not this Mac; undefined for a local or unknown phone. */
    const ownerOf = async (udid: string): Promise<string | undefined> => {
        const device = (await loadRegisteredDevices()).find((entry) => entry.udid === udid);
        return device && !isLocalDevice(device, hostId) ? device.hostId : undefined;
    };
    const localRemote: RemoteControl = options.remote ?? new RegistryWdaRemoteControl();
    const remote: RemoteControl = new FleetRemoteControl(localRemote, agent, ownerOf);
    /** Relay an agent response: status, the caching/state headers, and the body (streamed). */
    const relay = (reply: FastifyReply, upstream: Response) => {
        reply.code(upstream.status);
        for (const header of ['content-type', 'etag', 'cache-control', 'x-device-state']) {
            const value = upstream.headers.get(header);
            if (value) reply.header(header, value);
        }
        if (!upstream.body || upstream.status === 304) return reply.send();
        return reply.send(Readable.from(upstream.body as AsyncIterable<Uint8Array>));
    };
    const agentFailure = (reply: FastifyReply, error: unknown) => {
        if (!(error instanceof AgentRequestError)) throw error;
        return reply.code(error.statusCode).header('cache-control', 'no-store').send({ error: error.message });
    };
    /** Each other host's phones with their USB/WDA state, fetched once per host and reused for 2 s. */
    const remoteStatusCache = new Map<string, { at: number; value: Promise<AgentStatusResponse | null> }>();
    const remoteHostStatus = (owner: string): Promise<AgentStatusResponse | null> => {
        const cached = remoteStatusCache.get(owner);
        if (cached && Date.now() - cached.at < 2_000) return cached.value;
        const value = (async () => {
            try {
                const response = await agent.request(owner, '/agent/status', { timeoutMs: 1_500 });
                return response.ok ? await response.json() as AgentStatusResponse : null;
            } catch {
                return null;
            }
        })();
        remoteStatusCache.set(owner, { at: Date.now(), value });
        return value;
    };
    const remoteFleet = async (devices: readonly RegisteredDevice[]) => {
        const owners = [...new Set(devices.filter((device) => !isLocalDevice(device, hostId)).map((device) => device.hostId!))];
        const state = new Map<string, { connected: Device | null; status: DeviceConnectionStatus | null }>();
        const unreachable = new Set<string>();
        await Promise.all(owners.map(async (owner) => {
            const status = await remoteHostStatus(owner);
            if (!status) { unreachable.add(owner); return; }
            for (const entry of status.devices) state.set(entry.udid, { connected: entry.connected, status: entry.status });
        }));
        return { state, unreachable };
    };
    /** Host id → display name, only fetched when some phone lives on another host. */
    const hostNames = async (devices: readonly RegisteredDevice[]): Promise<Map<string, string>> => {
        if (!devices.some((device) => device.hostId)) return new Map();
        try {
            return new Map((await hostDirectory.list()).map((host) => [host.id, host.displayName]));
        } catch {
            return new Map();
        }
    };
    const registeredWithStatus = async () => {
        const [registered, connected] = await Promise.all([loadRegisteredDevices(), discover()]);
        // A phone seen on USB without a stored model gets the one discovery reports,
        // once; model grants depend on it. Steady state: no write. Only this
        // host's USB tree is visible here, so only its phones are considered.
        const missing = missingModels(localDevices(registered, hostId), connected);
        if (missing.size) {
            try {
                await backfillDeviceModels(connected.filter(({ udid }) => missing.has(udid)));
                for (const device of registered) device.model ??= missing.get(device.udid);
            } catch (error) {
                console.warn(`could not record device models (${errorMessage(error)})`);
            }
        }
        const online = new Map(connected.map((device) => [device.udid, device]));
        const [fleet, names] = await Promise.all([remoteFleet(registered), hostNames(registered)]);
        return registered.map((device) => {
            const local = isLocalDevice(device, hostId);
            const remoteEntry = local ? undefined : fleet.state.get(device.udid);
            return {
                ...redactDevice(device),
                connected: device.disabled ? null : local ? online.get(device.udid) ?? null : remoteEntry?.connected ?? null,
                ...(device.hostId ? { hostName: names.get(device.hostId) ?? device.hostId } : {}),
                ...(local ? {} : {
                    remoteStatus: remoteEntry?.status ?? null,
                    hostReachable: !fleet.unreachable.has(device.hostId!),
                }),
            };
        });
    };
    const screenshots = createScreenshotCache(remote);
    const thumbnails = createThumbnailCache();
    const forgetDevice = (udid: string) => {
        remote.forget?.(udid);
        screenshots.forget(udid);
        thumbnails.forget(udid);
    };
    const teamEnabled = isBuiltinAuthProvider(provider);
    /** The signed-in part of the navigation: Team (admins), the user's name, Log out. */
    const authNav = (request: FastifyRequest | null, current?: string): string => {
        const user = request ? requestUsers.get(request) : undefined;
        if (!provider || !request || !user) return '';
        const parts: string[] = [];
        const access = accessOf(request);
        if (teamEnabled && (access.platform || access.tenantAdmin)) {
            parts.push(`<a class="nav-link" href="/team"${current === '/team' ? ' aria-current="page"' : ''}>Team</a>`);
        }
        if (user.displayName) parts.push(`<span class="nav-user">${escapeHtml(user.displayName)}</span>`);
        const logoutPath = provider.logoutPath;
        if (logoutPath) {
            parts.push(provider.logoutMethod === 'POST'
                ? `<form class="nav-logout" method="post" action="${escapeHtml(logoutPath)}"><button class="button secondary app-logout" type="submit">Log out</button></form>`
                : `<a class="button secondary app-logout" href="${escapeHtml(logoutPath)}">Log out</a>`);
        }
        return parts.join('');
    };
    const navLinks: PluginNavLink[] = options.plugins.list()
        .flatMap((plugin) => plugin.navLinks ?? [])
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const pluginNavHtml = navLinks
        .map((link) => `<a class="nav-link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
        .join('');
    const assetHash = (body: string | Buffer) => crypto.createHash('sha1').update(body).digest('base64url').slice(0, 10);

    const branding = brandingFromEnv();
    const footer = footerHtml(branding);
    let logo: { body: Buffer; contentType: string; hash: string } | null = null;
    if (branding.logoPath) {
        const contentType = logoContentType(branding.logoPath);
        if (!contentType) {
            console.warn(`PHONE_FARM_BRAND_LOGO: unsupported file type for ${branding.logoPath} (use .png, .svg, .jpg or .webp); logo not shown`);
        } else {
            try {
                const body = await readFile(branding.logoPath);
                logo = { body, contentType, hash: assetHash(body) };
            } catch (error) {
                console.warn(`PHONE_FARM_BRAND_LOGO: cannot read ${branding.logoPath} (${errorMessage(error)}); logo not shown`);
            }
        }
    }
    const brand = brandHtml(branding, logo ? `/assets/brand-logo?v=${logo.hash}` : null);
    const renderPage = (title: string, body: string, request?: FastifyRequest) =>
        page(title, body, authNav(request ?? null), navLinks, branding, footer);

    let themed: LoadedDashboardTheme | null = null;
    if (options.dashboardTheme) {
        const root = options.dashboardTheme.rootDirectory;
        const require = createRequire(import.meta.url);
        const [indexHtml, deviceHtml, tasksHtml, registerDeviceHtml, rawStyles, deviceScript, tasksScript, registerDeviceScript, gridScript, htmx, teamScript] = await Promise.all([
            readFile(path.join(root, 'templates/index.html'), 'utf8'),
            readFile(path.join(root, 'templates/device.html'), 'utf8'),
            readFile(path.join(root, 'templates/tasks.html'), 'utf8'),
            readFile(path.join(root, 'templates/register-device.html'), 'utf8'),
            readFile(path.join(root, 'styles.css'), 'utf8'),
            readFile(path.join(root, 'assets/device.js'), 'utf8'),
            readFile(path.join(root, 'assets/tasks.js'), 'utf8'),
            readFile(path.join(root, 'assets/register-device.js'), 'utf8'),
            readFile(path.join(root, 'assets/grid.js'), 'utf8'),
            readFile(require.resolve('htmx.org/dist/htmx.min.js'), 'utf8'),
            // The Team panel script ships with the package; a custom theme may override it.
            readFile(path.join(root, 'assets/team.js'), 'utf8')
                .catch(() => readFile(new URL('../../static/dashboard/assets/team.js', import.meta.url), 'utf8'))
                .catch(() => ''),
        ]);
        const fonts = new Map<string, Buffer>();
        for (const name of DASHBOARD_FONTS) {
            try {
                fonts.set(name, await readFile(path.join(root, 'fonts', name)));
            } catch (error) {
                // A theme without the font files still renders with the metric-matched fallbacks.
                console.warn(`dashboard font ${name} not found (${errorMessage(error)}); using fallback fonts`);
            }
        }
        const fontVersions = Object.fromEntries([...fonts].map(([name, body]) => [`fonts/${name}`, assetHash(body)]));
        // Version the stylesheet's own font URLs too, so they are the same
        // immutable URLs the templates preload (one download, cached forever).
        let styles = rawStyles;
        for (const [name, v] of Object.entries(fontVersions)) styles = styles.replaceAll(`/assets/${name})`, `/assets/${name}?v=${v})`);
        // Content-hash every asset URL in the templates so a changed file gets a
        // fresh URL that no browser or CDN can serve stale.
        const versions: Record<string, string> = {
            'styles.css': assetHash(styles), 'device.js': assetHash(deviceScript),
            'tasks.js': assetHash(tasksScript), 'register-device.js': assetHash(registerDeviceScript),
            'grid.js': assetHash(gridScript), 'htmx.min.js': assetHash(htmx), 'team.js': assetHash(teamScript),
            ...fontVersions,
        };
        const finalize = (html: string) => {
            // __AUTH_NAV__ stays: it names the signed-in user, so it is filled per request.
            let out = html.replaceAll('__PLUGIN_NAV__', pluginNavHtml)
                .replaceAll('__BRAND__', brand).replaceAll('__BRAND_TITLE__', escapeHtml(branding.title))
                .replaceAll('__FOOTER__', footer);
            for (const [name, v] of Object.entries(versions)) out = out.replaceAll(`/assets/${name}`, `/assets/${name}?v=${v}`);
            return out;
        };
        themed = {
            versions, teamScript,
            indexHtml: finalize(indexHtml), deviceHtml: finalize(deviceHtml),
            tasksHtml: finalize(tasksHtml), registerDeviceHtml: finalize(registerDeviceHtml),
            styles, deviceScript, tasksScript, registerDeviceScript, gridScript, htmx, fonts,
        };
    }

    /**
     * Fill a themed template for this request: the signed-in navigation, and
     * body markers the stylesheet uses to hide controls the user cannot use
     * (the server still refuses them — this is presentation only).
     */
    const personalize = (html: string, request: FastifyRequest, deviceLevel?: AccessLevel | null): string => {
        const access = accessOf(request);
        let out = html.replaceAll('__AUTH_NAV__', authNav(request));
        const markers = [
            // Platform staff see everything; a tenant admin or operator does not get farm-setup controls.
            ...(access.platform ? [] : [access.tenantAdmin ? 'data-role="admin"' : 'data-role="operator"']),
            ...(deviceLevel === 'view' ? ['data-device-access="view"'] : []),
        ];
        if (markers.length) out = out.replace('<body ', `<body ${markers.join(' ')} `);
        return out;
    };

    /** A page built in code (sign-in, password, Team) in the dashboard's own shell. */
    const renderShell = (request: FastifyRequest | null, shell: ShellOptions): string => {
        const main = `<main class="shell ${escapeHtml(shell.mainClass ?? '')}">${shell.main}</main>`;
        if (!themed) return page(shell.title, shell.main, authNav(request), shell.bare ? [] : navLinks, branding, footer);
        const v = themed.versions;
        const access = request ? accessOf(request) : FULL_ACCESS;
        const nav = shell.bare ? '' : `<nav class="topbar-nav" aria-label="Main"><a class="nav-link" href="/">Devices</a><a class="nav-link" href="/tasks">Tasks</a>${access.platform ? '<a class="nav-link" href="/devices/register">Register</a>' : ''}${pluginNavHtml}${authNav(request, shell.current)}</nav>`;
        const scripts = (shell.scripts ?? []).map((name) => `<script type="module" src="/assets/${escapeHtml(name)}?v=${escapeHtml(v[name] ?? '')}"></script>`).join('');
        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(shell.title)} · ${escapeHtml(branding.title)}</title>
    <link rel="preload" href="/assets/fonts/oswald-latin-variable.woff2?v=${v['fonts/oswald-latin-variable.woff2'] ?? ''}" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="/assets/fonts/poppins-latin-400.woff2?v=${v['fonts/poppins-latin-400.woff2'] ?? ''}" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/assets/styles.css?v=${v['styles.css']}">
</head>
<body class="${escapeHtml(shell.bodyClass ?? '')}">
    <header class="topbar"><div class="topbar-inner">${brand}${nav}</div></header>
    ${main}
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
    ${scripts}
    <footer class="app-footer">${footer}</footer>
</body>
</html>`;
    };

    const renderActivity = async (deviceUdid: string, message?: string, canOperate = true): Promise<string> => {
        // Only the runs of the tenant that owns the phone now: a phone moved from
        // another tenant must not show that tenant's captions and logs.
        const owner = (await deviceTenants()).tenantOf(deviceUdid);
        const executions = (await options.scheduler.listExecutions(25, deviceUdid))
            .filter((execution) => (execution.tenantId ?? DEFAULT_TENANT_ID) === owner);
        const execution = executions.find(({ status }) => status === 'running') ?? executions[0];
        const errorBanner = message
            ? `<div class="banner err run-error" role="alert"><strong>Could not start the automation</strong><p>${escapeHtml(message)}</p></div>` : '';
        if (!execution) return `<section id="device-activity" class="run-panel"><div class="run-heading"><span class="status idle"><span class="dot"></span>idle</span><span class="run-meta">No automation has run on this device yet.</span></div>${errorBanner}<pre role="log" aria-live="polite">Waiting for output…</pre></section>`;
        const detail = await options.scheduler.execution(execution.id);
        // A plugin (or task version) can be uninstalled while old executions
        // still reference it — degrade instead of throwing out of the fragment.
        let definition: { summarize(payload: JsonObject): string; supportsStop(payload: JsonObject): boolean } | undefined;
        try {
            definition = options.plugins.task({
                pluginId: execution.pluginId, taskType: execution.taskType,
                taskVersion: execution.taskVersion, payload: execution.payload,
            });
        } catch { /* plugin unavailable */ }
        const summary = definition
            ? definition.summarize(execution.payload)
            : `${execution.pluginId}/${execution.taskType}@${execution.taskVersion} (plugin not installed)`;
        const canStop = canOperate && execution.status === 'queued' || (execution.status === 'running' && (definition?.supportsStop(execution.payload) ?? true));
        const stop = canStop
            ? `<form hx-post="/api/executions/${execution.id}/stop" hx-target="#device-activity" hx-swap="outerHTML"><button class="button secondary" type="submit">Stop</button></form>` : '';
        return `<section id="device-activity" class="run-panel" hx-get="/api/devices/${encodeURIComponent(deviceUdid)}/fragments/activity" hx-trigger="every 1s" hx-swap="outerHTML"><div class="run-heading"><span class="status ${escapeHtml(execution.status)}"><span class="dot"></span>${escapeHtml(execution.status)}</span><span class="run-meta">${escapeHtml(summary)} · <time datetime="${escapeHtml(execution.scheduledFor.toISOString())}" data-local-time>${escapeHtml(execution.scheduledFor.toISOString().slice(0, 16).replace('T', ' '))} UTC</time></span></div>${errorBanner}${stop}<pre role="log" aria-live="polite">${detail?.logs.length ? detail.logs.map(escapeHtml).join('\n') : escapeHtml(execution.error ?? 'Waiting for worker output…')}</pre></section>`;
    };

    // Liveness, anonymous: the process answers, plus the deployed commit. Plugin
    // versions moved to the signed-in GET /api/plugins; anonymous callers get
    // nothing to fingerprint.
    app.get('/health', async () => {
        const body: { ok: true; release?: string } = { ok: true };
        // Deploy tooling writes a RELEASED file (sha, subject, deployedAt) into the
        // working directory; surface the sha so "what's live" is answerable over HTTP.
        try {
            const release = JSON.parse(await readFile(path.resolve(process.env.PHONE_FARM_RELEASE_FILE ?? 'RELEASED'), 'utf8')) as { sha?: unknown };
            if (typeof release.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(release.sha)) body.release = release.sha;
        } catch { /* no release marker — fine */ }
        return body;
    });
    const probes = options.observability ?? createDefaultProbes();
    if (!options.observability) app.addHook('onClose', async () => probes.close());
    // Readiness, anonymous: 200 only when Postgres, Appium, the wda-service
    // socket and a fresh worker heartbeat all check out; 503 otherwise. The body
    // names each check with a fixed reason; real errors go to the server log.
    app.get('/health/ready', async (request, reply) => {
        const report = await checkReadiness(probes, {
            onFailure: (check, error) => request.log.warn({ check, error: errorMessage(error) }, 'readiness check failed'),
        });
        return reply.code(report.ok ? 200 : 503).header('cache-control', 'no-store').send(report);
    });
    // Prometheus scrape. Off (404) unless PHONE_FARM_METRICS_TOKEN is set; then
    // it needs `Authorization: Bearer <token>`. A failing source is reported as
    // phone_farm_metrics_source_up{source=…} 0 rather than failing the scrape.
    app.get('/metrics', async (request, reply) => {
        const expected = process.env.PHONE_FARM_METRICS_TOKEN;
        if (!expected) return reply.code(404).send({ error: 'Not found' });
        const header = request.headers.authorization;
        const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
        if (!tokenMatches(presented, expected)) {
            return reply.code(401).header('www-authenticate', 'Bearer realm="metrics"').send({ error: 'Authentication required' });
        }
        const settle = async <T>(source: string, work: () => Promise<T>): Promise<T | null> => {
            try {
                return await work();
            } catch (error) {
                request.log.warn({ source, error: errorMessage(error) }, 'metrics source failed');
                return null;
            }
        };
        const [devices, usb, wda, queues, executions, heartbeats] = await Promise.all([
            settle('registry', () => loadRegisteredDevices()),
            settle('usb', async () => new Set((await discover()).map(({ udid }) => udid))),
            settle('wda_service', () => wdaStatuses()),
            settle('queues', () => probes.queueStats()),
            settle('executions', () => probes.executionsLastHour()),
            settle('heartbeats', () => probes.workerHeartbeats()),
        ]);
        const body = renderMetrics({
            // Per-host scrape: only the phones on this Mac's USB tree.
            now: Date.now(), uptimeSeconds: process.uptime(), devices: localDevices(devices ?? [], hostId), usbUdids: usb, wda,
            queues, executionsLastHour: executions, heartbeats,
        });
        return reply.type(PROMETHEUS_CONTENT_TYPE).header('cache-control', 'no-store').send(body);
    });
    app.get('/api/plugins', async () => options.plugins.list().map((plugin) => ({
        id: plugin.id, version: plugin.version, displayName: plugin.displayName,
        tasks: plugin.tasks.map(({ type, version, displayName }) => ({ type, version, displayName })),
    })));
    /**
     * Platform staff see every tenant; `?tenant=<id>` narrows a list to one.
     * Anyone else is always confined to their own tenant, whatever they ask for.
     */
    const tenantFilter = (request: FastifyRequest): string | undefined => {
        const access = accessOf(request);
        if (!access.platform) return access.tenantId ?? '';
        const requested = (request.query as { tenant?: unknown } | undefined)?.tenant;
        return typeof requested === 'string' && requested ? requested : undefined;
    };
    /** Registered phones this request may see, each with its tenant and the caller's level on it. */
    const visibleDevices = async (request: FastifyRequest) => {
        const access = accessOf(request);
        const tenant = tenantFilter(request);
        const [devices, owners] = await Promise.all([registeredWithStatus(), deviceTenants()]);
        return devices.flatMap((device) => {
            const owned = { ...device, tenantId: owners.tenantOf(device.udid) };
            if (tenant !== undefined && owned.tenantId !== tenant) return [];
            const level = access.levelFor(owned);
            return level ? [{ ...owned, access: level }] : [];
        });
    };
    /** Phones whose schedules and runs this request may list: UDID → level. Null means every phone. */
    const listableUdids = async (request: FastifyRequest, only?: string): Promise<Map<string, AccessLevel> | null> => {
        const access = accessOf(request);
        if (access.platform) return null;
        const visible = new Map<string, AccessLevel>();
        for (const device of await loadOwnedDevices()) {
            const level = access.levelFor(device);
            if (level && (!only || device.udid === only)) visible.set(device.udid, level);
        }
        return visible;
    };
    app.get('/api/devices', async (request) => visibleDevices(request));
    app.get('/api/devices/discovered', async () => connectedDevices());
    app.get('/api/device-registrations/candidates', async (_request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return { devices: await options.registrations.candidates() };
    });
    app.post<{ Body: { udid?: string } }>('/api/device-registrations', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        if (!request.body.udid?.trim()) return reply.code(400).send({ error: 'Device UDID is required' });
        return reply.code(201).send(await options.registrations.create(request.body.udid.trim()));
    });
    app.get<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return await options.registrations.get(request.params.id)
            ?? reply.code(404).send({ error: 'Registration draft not found' });
    });
    app.patch<{ Params: { id: string }; Body: RegistrationUpdate }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        return options.registrations.update(request.params.id, request.body);
    });
    app.post<{ Params: { id: string; action: RegistrationAction }; Body: { authorizeTeamRegistration?: boolean } }>(
        '/api/device-registrations/:id/actions/:action', async (request, reply) => {
            if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
            if (!['refresh', 'prepare', 'verify', 'finalize'].includes(request.params.action)) {
                return reply.code(404).send({ error: 'Unknown registration action' });
            }
            return options.registrations.run(request.params.id, request.params.action, {
                authorizeTeamRegistration: request.body?.authorizeTeamRegistration === true,
            });
        },
    );
    app.delete<{ Params: { id: string } }>('/api/device-registrations/:id', async (request, reply) => {
        if (!options.registrations) return reply.code(503).send({ error: 'Device registration is not configured' });
        await options.registrations.cancel(request.params.id);
        return reply.code(204).send();
    });
    app.post<{ Body: { name?: string; udid?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinateProfile?: string; rackSlot?: string; rack?: string; model?: string; signingTeam?: string; pluginData?: Record<string, JsonObject> } }>(
        '/api/devices', async (request, reply) => {
            const { name, udid, wdaLocalPort, mjpegLocalPort, passcode, coordinateProfile, rackSlot, rack, model, signingTeam, pluginData } = request.body;
            if (!udid) return reply.code(400).send({ error: 'A device UDID is required' });
            if (passcode !== undefined && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
            }
            const created = await mutateRegisteredDevices((devices) => {
                if (devices.some((device) => device.udid === udid)) throw httpError(409, 'A device with this UDID is already registered');
                // Explicit whitelist — never mass-assign arbitrary body keys into devices.json.
                const device: RegisteredDevice = {
                    name: name ?? udid, udid, pluginData: pluginData ?? {},
                    ...(wdaLocalPort !== undefined ? { wdaLocalPort } : {}),
                    ...(mjpegLocalPort !== undefined ? { mjpegLocalPort } : {}),
                    ...(coordinateProfile !== undefined ? { coordinateProfile: coordinateProfile as RegisteredDevice['coordinateProfile'] } : {}),
                    ...(rackSlot !== undefined ? { rackSlot } : {}),
                    ...(rack !== undefined ? { rack: String(rack) } : {}),
                    ...(model !== undefined ? { model: String(model) } : {}),
                    ...(signingTeam !== undefined ? { signingTeam: String(signingTeam) } : {}),
                    ...(passcode !== undefined ? { passcode } : {}),
                };
                devices.push(device);
                return device;
            });
            return reply.code(201).send(redactDevice(created));
        },
    );
    app.patch<{ Params: { udid: string }; Body: { name?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinates?: unknown; disabled?: boolean; coordinateProfile?: string; rackSlot?: string; rack?: string; model?: string; signingTeam?: string; pluginData?: Record<string, JsonObject> } }>(
        '/api/devices/:udid', async (request, reply) => {
            const { passcode, coordinates, name, wdaLocalPort, mjpegLocalPort, disabled, coordinateProfile, rackSlot, rack, model, signingTeam, pluginData } = request.body;
            if (passcode !== undefined && passcode !== '' && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
            }
            // A passcode lives only on the Mac that owns the phone (never in Postgres).
            if (passcode !== undefined) {
                const owner = await ownerOf(request.params.udid);
                if (owner) return reply.code(409).send({ error: `This phone is on host ${owner}; set its passcode from that host's dashboard` });
            }
            if (disabled === true && await options.scheduler.activeExecution(request.params.udid)) {
                return reply.code(409).send({ error: 'Stop the running automation before disconnecting this device' });
            }
            const updated = await mutateRegisteredDevices((devices) => {
                const device = devices.find((entry) => entry.udid === request.params.udid);
                if (!device) throw httpError(404, 'Device not found');
                if (name !== undefined) device.name = name;
                if (wdaLocalPort !== undefined) device.wdaLocalPort = wdaLocalPort;
                if (mjpegLocalPort !== undefined) device.mjpegLocalPort = mjpegLocalPort;
                if (coordinateProfile !== undefined) device.coordinateProfile = coordinateProfile as RegisteredDevice['coordinateProfile'];
                // rackSlot: a value sets it, '' clears it (saveRegisteredDevices trims and drops empties)
                if (rackSlot !== undefined) device.rackSlot = rackSlot;
                // rack / model: same rule — a value sets it, '' clears it
                if (rack !== undefined) device.rack = String(rack);
                if (model !== undefined) device.model = String(model);
                // signingTeam: a value sets it (upper-cased), '' goes back to the host default
                if (signingTeam !== undefined) device.signingTeam = String(signingTeam);
                if (pluginData !== undefined) device.pluginData = pluginData;
                if (disabled === true) device.disabled = true;
                else if (disabled === false) delete device.disabled;
                // passcode: a value sets it, '' clears it, omitting it leaves it
                if (passcode === '') delete device.passcode;
                else if (passcode !== undefined) device.passcode = passcode;
                // coordinates: the object replaces the whole override map; {} clears it
                if (coordinates !== undefined) {
                    const overrides = validateCoordinateOverrides(coordinates, device.coordinateProfile);
                    if (Object.keys(overrides).length === 0) delete device.coordinates;
                    else device.coordinates = overrides;
                }
                return device;
            });
            forgetDevice(request.params.udid);
            return redactDevice(updated);
        },
    );
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/coordinates', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        const base = coordinatesForProfile(device.coordinateProfile).tiktok;
        const effective = resolveDeviceCoordinates(device.coordinateProfile, device.coordinates).tiktok;
        return {
            profile: device.coordinateProfile ?? 'iphone8',
            screenSize: coordinatesForProfile(device.coordinateProfile).screenSize,
            points: CALIBRATABLE_POINTS.map((name) => ({
                name, label: POINT_LABELS[name],
                default: base[name], current: effective[name],
                overridden: Boolean(device.coordinates?.[name]),
            })),
        };
    });
    app.delete<{ Params: { udid: string } }>('/api/devices/:udid', async (request, reply) => {
        const exists = (await loadRegisteredDevices()).some(({ udid }) => udid === request.params.udid);
        if (!exists) return reply.code(404).send({ error: 'Device not found' });
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Stop the running automation before removing this device' });
        }
        for (const schedule of await options.scheduler.listSchedules(500, request.params.udid, null)) {
            if (!['cancelled', 'completed'].includes(schedule.status)) {
                await options.scheduler.setScheduleStatus(schedule.id, 'cancelled');
            }
        }
        await mutateRegisteredDevices((devices) => {
            const index = devices.findIndex(({ udid }) => udid === request.params.udid);
            if (index >= 0) devices.splice(index, 1);
        });
        forgetDevice(request.params.udid);
        return reply.code(204).send();
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/checks', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        if (!isLocalDevice(device, hostId)) {
            return reply.code(409).send({ error: `This phone is on host ${device.hostId}; run its checks from that host's dashboard` });
        }
        const identity = (await connectedDevices()).find(({ udid }) => udid === device.udid) ?? device;
        const results = [];
        for (const plugin of options.plugins.list()) {
            for (const check of plugin.registrationChecks ?? []) {
                results.push({ pluginId: plugin.id, checkId: check.id, ...(await check.run(identity, device.pluginData[plugin.id] ?? {})) });
            }
        }
        return results;
    });

    // The phone-facing handlers, shared by the dashboard's /api routes (for this
    // host's phones) and the host agent's /agent routes (for another host's
    // dashboard). A phone another host owns never reaches these: /api proxies
    // it to its host and /agent refuses it, so a request cannot loop.
    const localPhone = {
        async info(udid: string, reply: FastifyReply) {
            const device = (await discover()).find((entry) => entry.udid === udid);
            if (!device) return reply.code(404).send({ error: 'Device is not connected' });
            return reply.send({ device, screen: await remote.getScreenInfo(device.udid) });
        },
        async screenshot(udid: string, fresh: boolean, reply: FastifyReply) {
            try {
                // Served from the shared per-device cache so N dashboard tabs cost one
                // WDA round trip; `?fresh=1` bypasses it for a client that needs now.
                const frame = await screenshots.get(udid, fresh ? 0 : undefined);
                return reply.header('cache-control', 'no-store').type('image/png').send(frame);
            } catch {
                // A flapping device shouldn't spew 500s into the log every 5s from the grid poll.
                return reply.code(503).header('cache-control', 'no-store').send();
            }
        },
        async thumbnail(udid: string, requestedWidth: string | undefined, ifNoneMatch: string | undefined, reply: FastifyReply) {
            const width = thumbnailWidth(requestedWidth);
            let frame: Buffer;
            try {
                frame = await screenshots.get(udid, { timeoutMs: gridScreenshotTimeoutMs() });
            } catch (error) {
                // WDA unreachable or refusing is "not ready"; anything else is a fault.
                return reply.code(503).header('cache-control', 'no-store')
                    .header('x-device-state', error instanceof RemoteDeviceError ? 'not-ready' : 'error').send();
            }
            const etag = thumbnails.etag(udid, frame, width);
            reply.header('etag', etag).header('cache-control', 'private, max-age=2');
            if (ifNoneMatch === etag) return reply.code(304).send();
            try {
                const body = await thumbnails.thumbnail(udid, frame, width);
                return reply.type('image/jpeg').send(body);
            } catch {
                reply.removeHeader('etag');
                return reply.code(503).header('cache-control', 'no-store').header('x-device-state', 'error').send();
            }
        },
        async stream(udid: string, request: FastifyRequest, reply: FastifyReply) {
            // Close the upstream device stream the moment the browser goes away —
            // otherwise every HTMX fragment swap leaks a live MJPEG connection.
            const abort = new AbortController();
            request.raw.once('close', () => abort.abort());
            const upstream = await remote.getMjpegStream(udid, abort.signal);
            if (!upstream.body) return reply.code(503).send({ error: 'Device stream is unavailable' });
            return reply.header('cache-control', 'no-store, no-cache, must-revalidate')
                .type(upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=--BoundaryString')
                .send(Readable.from(upstream.body as AsyncIterable<Uint8Array>));
        },
        async action(udid: string, action: RemoteAction, reply: FastifyReply) {
            if (await options.scheduler.activeExecution(udid)) {
                return reply.code(409).send({ error: 'Remote input is disabled while automation is running' });
            }
            await remote.performAction(udid, action);
            return reply.send({ ok: true });
        },
        async locked(udid: string, reply: FastifyReply) {
            return reply.send({ locked: await remote.isLocked(udid) });
        },
        async wdaLog(udid: string, requestedLines: string | undefined, request: FastifyRequest, reply: FastifyReply) {
            const requested = Number(requestedLines ?? 200);
            const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 1_000) : 200;
            let lines: string[] | undefined;
            try {
                lines = await wdaLogs(udid, limit);
            } catch (error) {
                request.log.warn({ error: errorMessage(error) }, 'wda-service log request failed');
                return reply.code(503).send({ error: 'WDA service is unavailable' });
            }
            return reply.header('cache-control', 'no-store').send({ udid, lines: lines ?? [] });
        },
        async connection(registered: RegisteredDevice, reply: FastifyReply) {
            // Prefer the real per-device state the wda-service supervisor tracks
            // (physical, wda, appium, retryCount, message).
            try {
                const response = await requestWdaService('/devices', { timeoutMs: 2_000 });
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    const status = (JSON.parse(response.body).devices as DeviceConnectionStatus[])
                        .find((entry) => entry.udid === registered.udid);
                    if (status) return reply.send(status);
                }
            } catch { /* supervisor socket unavailable — fall back to a probe */ }
            const connected = (await connectedDevices()).some(({ udid }) => udid === registered.udid);
            let wda = false;
            try {
                wda = (await fetch(`http://127.0.0.1:${registered.wdaLocalPort ?? 8100}/status`, { signal: AbortSignal.timeout(2_000) })).ok;
            } catch { /* WDA not up */ }
            const fallback: DeviceConnectionStatus = {
                udid: registered.udid, physical: connected ? 'connected' : 'disconnected',
                wda: wda ? 'ready' : connected ? 'connecting' : 'disconnected', appium: 'unavailable',
                managed: false, message: wda ? 'WDA is ready' : connected ? 'Waiting for WDA' : 'Reconnect the USB cable',
                retryCount: 0, updatedAt: new Date().toISOString(),
            };
            return reply.send(fallback);
        },
    };
    const wdaLogs = options.wdaLogs ?? supervisorLogs;
    /** GET a small JSON document for another host's phone from its agent and relay it. */
    const proxyJson = async (owner: string, udid: string, rest: string, reply: FastifyReply, timeoutMs = 5_000) => {
        try {
            return relay(reply, await agent.request(owner, `/agent/devices/${encodeURIComponent(udid)}${rest}`, { timeoutMs }));
        } catch (error) {
            return agentFailure(reply, error);
        }
    };

    // NB: /remote/screenshot and /remote/action below are the canonical
    // endpoints — they carry the activeExecution guard and the cached
    // per-device client. The old unprefixed /screenshot and /actions twins
    // that bypassed both were removed.
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/info', async (request, reply) => {
        const owner = await ownerOf(request.params.udid);
        if (owner) return proxyJson(owner, request.params.udid, '/remote/info', reply);
        return localPhone.info(request.params.udid, reply);
    });
    app.get<{ Params: { udid: string }; Querystring: { fresh?: string } }>('/api/devices/:udid/remote/screenshot', async (request, reply) => {
        // Another host's phone: the fleet remote fetches it from that host's agent (its cache).
        return localPhone.screenshot(request.params.udid, Boolean(request.query.fresh), reply);
    });
    // The grid's still: a small JPEG of the same cached frame, with an ETag so an
    // unchanged screen costs a 304 and no body. The full-size PNG above stays for
    // the device page and calibration. Another host's phone is thumbnailed on
    // that host, so only the small JPEG crosses the network.
    app.get<{ Params: { udid: string }; Querystring: { w?: string } }>('/api/devices/:udid/remote/thumbnail', async (request, reply) => {
        const owner = await ownerOf(request.params.udid);
        if (!owner) return localPhone.thumbnail(request.params.udid, request.query.w, request.headers['if-none-match'], reply);
        const width = thumbnailWidth(request.query.w);
        const ifNoneMatch = request.headers['if-none-match'];
        try {
            const upstream = await agent.request(owner, `/agent/devices/${encodeURIComponent(request.params.udid)}/remote/thumbnail?w=${width}`, {
                headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}, timeoutMs: gridScreenshotTimeoutMs() + 2_000,
            });
            return relay(reply, upstream);
        } catch {
            return reply.code(503).header('cache-control', 'no-store').header('x-device-state', 'not-ready').send();
        }
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/stream', async (request, reply) => {
        try {
            return await localPhone.stream(request.params.udid, request, reply);
        } catch (error) {
            return agentFailure(reply, error);
        }
    });
    app.post<{ Params: { udid: string }; Body: RemoteAction }>('/api/devices/:udid/remote/action', async (request, reply) => {
        try {
            return await localPhone.action(request.params.udid, request.body, reply);
        } catch (error) {
            return agentFailure(reply, error);
        }
    });
    // The phone's recent WDA supervisor + xcodebuild output (the full history
    // is in WDA_LOG_DIR/<udid>.log on the host). Admins only: build output names
    // the signing team and host paths.
    app.get<{ Params: { udid: string }; Querystring: { lines?: string } }>('/api/devices/:udid/wda-log', async (request, reply) => {
        const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!registered) return reply.code(404).send({ error: 'Device is not registered' });
        if (!isLocalDevice(registered, hostId)) {
            const lines = Number(request.query.lines ?? 200);
            return proxyJson(registered.hostId!, registered.udid, `/wda-log?lines=${Number.isSafeInteger(lines) ? lines : 200}`, reply);
        }
        return localPhone.wdaLog(request.params.udid, request.query.lines, request, reply);
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/connection', async (request, reply) => {
        const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!registered) return reply.code(404).send({ error: 'Device is not registered' });
        if (!isLocalDevice(registered, hostId)) return proxyJson(registered.hostId!, registered.udid, '/connection', reply);
        return localPhone.connection(registered, reply);
    });

    // ---- the host agent: another host's dashboard reaching this host's phones ----
    // Bearer PHONE_FARM_AGENT_TOKEN (shared by the farm), off (404) when unset.
    // Only this host's registered phones answer; anything else is a 404, which
    // also means a request can never be bounced on to a third host. Reached over
    // Tailscale through the PHONE_FARM_AGENT_BIND listener (src/agent/listener.ts).
    const agentGuard = async (request: FastifyRequest, reply: FastifyReply, udid?: string): Promise<RegisteredDevice | true | undefined> => {
        const expected = agentToken();
        if (!expected) { await reply.code(404).send({ error: 'Not found' }); return; }
        if (!tokenMatches(bearerToken(request.headers.authorization), expected)) {
            await reply.code(401).header('www-authenticate', 'Bearer realm="agent"').send({ error: 'Authentication required' });
            return;
        }
        if (udid === undefined) return true;
        const device = (await loadRegisteredDevices()).find((entry) => entry.udid === udid);
        if (!device || !isLocalDevice(device, hostId)) { await reply.code(404).send({ error: 'Device not found on this host' }); return; }
        return device;
    };
    app.get('/agent/status', async (request, reply) => {
        if (!await agentGuard(request, reply)) return reply;
        const [registered, connected, supervisor] = await Promise.all([
            loadRegisteredDevices(), discover(), wdaStatuses().catch(() => null),
        ]);
        const online = new Map(connected.map((device) => [device.udid, device]));
        const states = new Map((supervisor ?? []).map((status) => [status.udid, status]));
        const body: AgentStatusResponse = {
            hostId,
            devices: localDevices(registered, hostId).map((device) => ({
                udid: device.udid,
                connected: device.disabled ? null : online.get(device.udid) ?? null,
                status: states.get(device.udid) ?? null,
            })),
        };
        return reply.header('cache-control', 'no-store').send(body);
    });
    app.get<{ Params: { udid: string } }>('/agent/devices/:udid/remote/info', async (request, reply) => {
        if (!await agentGuard(request, reply, request.params.udid)) return reply;
        return localPhone.info(request.params.udid, reply);
    });
    app.get<{ Params: { udid: string }; Querystring: { fresh?: string } }>('/agent/devices/:udid/remote/screenshot', async (request, reply) => {
        if (!await agentGuard(request, reply, request.params.udid)) return reply;
        return localPhone.screenshot(request.params.udid, Boolean(request.query.fresh), reply);
    });
    app.get<{ Params: { udid: string }; Querystring: { w?: string } }>('/agent/devices/:udid/remote/thumbnail', async (request, reply) => {
        if (!await agentGuard(request, reply, request.params.udid)) return reply;
        return localPhone.thumbnail(request.params.udid, request.query.w, request.headers['if-none-match'], reply);
    });
    app.get<{ Params: { udid: string } }>('/agent/devices/:udid/remote/stream', async (request, reply) => {
        if (!await agentGuard(request, reply, request.params.udid)) return reply;
        return localPhone.stream(request.params.udid, request, reply);
    });
    app.get<{ Params: { udid: string } }>('/agent/devices/:udid/remote/locked', async (request, reply) => {
        if (!await agentGuard(request, reply, request.params.udid)) return reply;
        return localPhone.locked(request.params.udid, reply);
    });
    app.post<{ Params: { udid: string }; Body: RemoteAction }>('/agent/devices/:udid/remote/action', async (request, reply) => {
        if (!await agentGuard(request, reply, request.params.udid)) return reply;
        return localPhone.action(request.params.udid, request.body, reply);
    });
    app.get<{ Params: { udid: string }; Querystring: { lines?: string } }>('/agent/devices/:udid/wda-log', async (request, reply) => {
        if (!await agentGuard(request, reply, request.params.udid)) return reply;
        return localPhone.wdaLog(request.params.udid, request.query.lines, request, reply);
    });
    app.get<{ Params: { udid: string } }>('/agent/devices/:udid/connection', async (request, reply) => {
        const device = await agentGuard(request, reply, request.params.udid);
        if (!device || device === true) return reply;
        return localPhone.connection(device, reply);
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/reconnect', async (request, reply) => {
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Cannot reconnect while automation is running' });
        }
        forgetDevice(request.params.udid);
        return reply.code(202).send({ ok: true, message: 'The shared WDA supervisor will reconnect automatically' });
    });

    // Lists: the caller's tenant only (in the query and again here), and within
    // it only the phones they can see. Platform staff may narrow with ?tenant=.
    app.get<{ Querystring: { deviceUdid?: string; tenant?: string } }>('/api/schedules', async (request) => {
        const scope = await listableUdids(request, request.query.deviceUdid);
        const tenant = tenantFilter(request);
        if (!scope) {
            const schedules = await options.scheduler.listSchedules(200, request.query.deviceUdid, tenant);
            return { schedules: schedules.map((schedule) => ({ ...schedule, access: 'operate' })) };
        }
        if (!scope.size) return { schedules: [] };
        const schedules = await options.scheduler.listSchedules(200, [...scope.keys()], tenant);
        return {
            schedules: schedules.filter(({ deviceUdid, tenantId }) => scope.has(deviceUdid) && tenantId === tenant)
                .map((schedule) => ({ ...schedule, access: scope.get(schedule.deviceUdid) })),
        };
    });
    app.get<{ Querystring: { deviceUdid?: string; tenant?: string } }>('/api/executions', async (request) => {
        const scope = await listableUdids(request, request.query.deviceUdid);
        const tenant = tenantFilter(request);
        if (!scope) {
            const executions = await options.scheduler.listExecutions(200, request.query.deviceUdid, tenant);
            return { executions: executions.map((execution) => ({ ...execution, access: 'operate' })) };
        }
        if (!scope.size) return { executions: [] };
        const executions = await options.scheduler.listExecutions(200, [...scope.keys()], tenant);
        return {
            executions: executions.filter(({ deviceUdid, tenantId }) => scope.has(deviceUdid) && tenantId === tenant)
                .map((execution) => ({ ...execution, access: scope.get(execution.deviceUdid) })),
        };
    });
    app.get<{ Params: { id: string } }>('/api/executions/:id', async (request, reply) => {
        const execution = await options.scheduler.execution(request.params.id);
        return execution ?? reply.code(404).send({ error: 'Execution not found' });
    });
    app.post<{ Body: CreateTaskInput & { assetIds?: string[] } }>('/api/schedules', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.body.deviceUdid);
        if (!device) return reply.code(404).send({ error: 'Device not found' });
        if (device.disabled) return reply.code(409).send({ error: 'This device is disabled — activate it before scheduling automation' });
        const schedule = await options.scheduler.createTask(
            request.body, device.pluginData[request.body.task.pluginId] ?? {}, new Date(), request.body.assetIds ?? [],
        );
        return reply.code(201).send(schedule);
    });
    app.patch<{
        Params: { id: string };
        Body: { timing?: ScheduleTiming; runWindowMinutes?: number; recurringPublishConfirmed?: boolean };
    }>('/api/schedules/:id', async (request, reply) => {
        const current = await options.scheduler.schedule(request.params.id);
        if (!current) return reply.code(404).send({ error: 'Schedule not found' });
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === current.deviceUdid);
        if (!device) return reply.code(404).send({ error: 'Scheduled device is not registered' });
        const payload = request.body.recurringPublishConfirmed === undefined
            ? current.payload
            : { ...current.payload, recurringPublishConfirmed: request.body.recurringPublishConfirmed };
        const schedule = await options.scheduler.updateSchedule(request.params.id, {
            ...(request.body.timing ? { timing: request.body.timing } : {}),
            ...(request.body.runWindowMinutes !== undefined ? { runWindowMinutes: request.body.runWindowMinutes } : {}),
            task: {
                pluginId: current.pluginId, taskType: current.taskType,
                taskVersion: current.taskVersion, payload,
            },
        }, device.pluginData[current.pluginId] ?? {});
        return schedule ?? reply.code(409).send({ error: 'Completed or cancelled schedules cannot be edited' });
    });
    const changeStatus = async (id: string, status: 'active' | 'paused' | 'cancelled', reply: FastifyReply) => {
        try {
            const schedule = await options.scheduler.setScheduleStatus(id, status);
            return schedule ?? reply.code(404).send({ error: 'Schedule not found' });
        } catch (error) {
            if (error instanceof ScheduleTransitionError) return reply.code(409).send({ error: errorMessage(error) });
            throw error;
        }
    };
    app.post<{ Params: { id: string }; Body: { status: 'active' | 'paused' | 'cancelled' } }>('/api/schedules/:id/status',
        (request, reply) => changeStatus(request.params.id, request.body.status, reply));
    for (const action of ['pause', 'resume', 'cancel'] as const) {
        const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
        app.post<{ Params: { id: string } }>(`/api/schedules/:id/${action}`,
            (request, reply) => changeStatus(request.params.id, status, reply));
    }
    app.post<{ Params: { id: string } }>('/api/executions/:id/stop', async (request, reply) => {
        const result = await options.scheduler.requestStop(request.params.id);
        if (result === 'not-found') return reply.code(404).send({ error: 'Execution not found' });
        if (request.headers['hx-request']) {
            const execution = await options.scheduler.execution(request.params.id);
            return reply.type('text/html').send(await renderActivity(execution?.deviceUdid ?? ''));
        }
        return { result };
    });
    app.post<{ Params: { id: string } }>('/api/executions/:id/retry', async (request, reply) => {
        const execution = await options.scheduler.retryExecution(request.params.id);
        return execution ?? reply.code(409).send({ error: 'Execution is not retryable' });
    });

    // Uploads belong to the uploader's tenant (platform staff name one with
    // ?tenant=, default the default tenant) and count against its budget. The
    // file on disk is named by a random UUID, never by what the browser sent.
    app.post('/api/assets', async (request, reply) => {
        const access = accessOf(request);
        const tenantId = access.platform ? tenantFilter(request) ?? DEFAULT_TENANT_ID : access.tenantId ?? '';
        if (tenantService && !(await tenantService.store.tenantById(tenantId))) return reply.code(404).send({ error: 'Organisation not found' });
        const { usedBytes, budgetBytes } = await options.scheduler.uploadUsage(tenantId);
        let remaining = budgetBytes - usedBytes;
        const dataRoot = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
        const uploadDirectory = path.join(dataRoot, 'uploads');
        await mkdir(uploadDirectory, { recursive: true });
        const created: Array<{ relativePath: string; originalName: string; mimeType: string; size: number; sha256: string }> = [];
        const written: string[] = [];
        try {
            for await (const part of request.files()) {
                const relativePath = path.join('uploads', crypto.randomUUID());
                const file = path.join(dataRoot, relativePath);
                const handle = await open(file, 'wx', 0o600);
                written.push(file);
                const hash = crypto.createHash('sha256');
                let size = 0;
                try {
                    // A file over the per-file cap makes this loop throw (413); one
                    // that would overrun the tenant's budget stops it here.
                    for await (const chunk of part.file) {
                        const buffer = Buffer.from(chunk);
                        size += buffer.length;
                        if (size > remaining) throw new UploadQuotaError(budgetBytes);
                        hash.update(buffer);
                        await handle.write(buffer);
                    }
                } finally {
                    await handle.close();
                }
                remaining -= size;
                created.push({ relativePath, originalName: path.basename(part.filename || 'upload').slice(0, 255), mimeType: part.mimetype, size, sha256: hash.digest('hex') });
            }
            const uploadedBy = requestUsers.get(request)?.id ?? null;
            return reply.code(201).send(await options.scheduler.registerAssets(created, { tenantId, uploadedBy }));
        } catch (error) {
            // Nothing half-uploaded stays on disk or counts against the budget.
            await Promise.all(written.map((file) => rm(file, { force: true })));
            throw error;
        }
    });
    app.delete<{ Body: { assetIds?: unknown } }>('/api/assets', async (request, reply) => {
        const ids = request.body?.assetIds;
        if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) {
            return reply.code(400).send({ error: 'assetIds must be a list of asset ids' });
        }
        // A tenant admin deletes only their tenant's media; one foreign id and nothing is deleted.
        const access = accessOf(request);
        if (!(await options.scheduler.deleteAssets(ids, access.platform ? undefined : access.tenantId ?? ''))) {
            return reply.code(404).send({ error: 'Asset not found' });
        }
        return reply.code(204).send();
    });

    for (const plugin of options.plugins.list()) {
        if (plugin.registerRoutes) await plugin.registerRoutes({
            app, routePrefix: `/plugins/${plugin.id}`, scheduler: options.scheduler, remote,
            loadDevices: loadRegisteredDevices, saveDevices: saveRegisteredDevices, mutateDevices: mutateRegisteredDevices, renderActivity,
            requestActor: (request) => {
                const user = requestUsers.get(request);
                return user ? { userId: user.id, tenantId: accessOf(request).tenantId } : null;
            },
        });
    }

    if (themed) {
        const theme = themed;
        // Templates request these with a ?v=<contenthash>. A versioned request is
        // safe to cache forever; a bare one (bookmark) must revalidate via ETag.
        const asset = (contentType: string, body: string | Buffer, unversionedCache = 'no-cache') => {
            const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
            return async (request: FastifyRequest, reply: FastifyReply) => {
                const versioned = Boolean((request.query as { v?: string }).v);
                reply.header('cache-control', versioned ? 'public, max-age=31536000, immutable' : unversionedCache)
                    .header('etag', etag);
                if (request.headers['if-none-match'] === etag) return reply.code(304).send();
                return reply.type(contentType).send(body);
            };
        };
        app.get('/assets/styles.css', asset('text/css', theme.styles));
        app.get('/assets/device.js', asset('text/javascript', theme.deviceScript));
        app.get('/assets/tasks.js', asset('text/javascript', theme.tasksScript));
        app.get('/assets/register-device.js', asset('text/javascript', theme.registerDeviceScript));
        app.get('/assets/grid.js', asset('text/javascript', theme.gridScript));
        app.get('/assets/htmx.min.js', asset('text/javascript', theme.htmx));
        if (theme.teamScript) app.get('/assets/team.js', asset('text/javascript', theme.teamScript));
        if (logo) app.get('/assets/brand-logo', asset(logo.contentType, logo.body));
        // Whitelisted by name: the parameter is only ever a map key, never a path.
        const fontRoutes = new Map([...theme.fonts].map(([name, body]) => [name, asset('font/woff2', body, 'public, max-age=86400')]));
        app.get<{ Params: { file: string } }>('/assets/fonts/:file', async (request, reply) => {
            const serve = fontRoutes.get(request.params.file);
            if (!serve) return reply.code(404).send({ error: 'Font not found' });
            return serve(request, reply);
        });
        app.get('/api/fragments/devices', async (request, reply) => {
            const admin = accessOf(request).platform;
            const [devices, supervisor] = await Promise.all([
                visibleDevices(request),
                // One supervisor read per poll. If the socket is down we cannot tell
                // ready from not-ready, so connected phones render a preview as before.
                wdaStatuses().catch(() => null),
            ]);
            const wdaState = new Map((supervisor ?? []).map((status) => [status.udid, status]));
            const active = devices.filter((device) => !device.disabled);
            const disabled = devices.filter((device) => device.disabled);
            const refreshMs = gridPollSeconds(active.length) * 1000;
            // Disconnect / Reconnect change device settings: platform staff only.
            const toggleButton = (udid: string, label: string, next: boolean) => !admin ? '' :
                `<button type="button" id="toggle-${deviceKey(udid)}" class="button secondary device-toggle" data-toggle-device="${encodeURIComponent(udid)}" data-disabled="${next}">${label}</button>`;
            let online = 0;
            let attention = 0;
            const cards = active.map((device) => {
                const accounts = Object.values(device.pluginData).flatMap((value) => {
                    const candidate = value.accounts;
                    return Array.isArray(candidate) ? candidate.filter((entry) => typeof entry === 'string') : [];
                });
                // Another host's phone carries the state its host's agent reported.
                const status = device.connected ? ('remoteStatus' in device ? device.remoteStatus ?? undefined : wdaState.get(device.udid)) : undefined;
                const state = !device.connected ? 'offline' : !status || status.wda === 'ready' ? 'ready' : 'not-ready';
                if (state === 'ready') online += 1;
                else if (state === 'not-ready') attention += 1;
                // A still, not a live stream. The server markup never carries a src:
                // grid.js fetches a small JPEG thumbnail per card on its own staggered
                // timer and htmx preserves the <img> (by its stable id) across the poll
                // swap, so a refresh never blanks or re-downloads a picture.
                // The rack slot is what turns "iPhone 14 is offline" into a phone
                // somebody can walk up to, so it shows online and offline alike,
                // as a badge on the phone frame.
                const place = [device.rack ? `Rack ${device.rack}` : '', device.rackSlot ? `Slot ${device.rackSlot}` : ''].filter(Boolean).join(' · ');
                const slot = place ? `<p class="rack-slot" title="${escapeHtml(place)}">${escapeHtml(place)}</p>` : '';
                const preview = state === 'ready'
                    ? `<div class="device-preview-frame">${slot}<img id="${previewId(device.udid)}" class="device-preview" hx-preserve="true" data-thumb-src="/api/devices/${encodeURIComponent(device.udid)}/remote/thumbnail" data-refresh-ms="${refreshMs}" alt="Screen of ${escapeHtml(device.name)}" draggable="false" decoding="async"></div>`
                    : `<div class="device-preview-frame unavailable">${slot}<div class="device-icon" aria-hidden="true"></div></div>`;
                // The frame takes the phone's real proportions (numbers only).
                const ratio = screenRatioStyle(device.coordinateProfile);
                const pill = state === 'ready'
                    ? '<span class="connected"><span></span>Online</span>'
                    : state === 'not-ready'
                        ? `<span class="connected not-ready" title="${escapeHtml(status?.message ?? '')}"><span></span>WDA not ready</span>`
                        : `<span class="connected offline"${'hostReachable' in device && !device.hostReachable ? ` title="${escapeHtml(`Host ${device.hostName ?? device.hostId} is not answering`)}"` : ''}><span></span>Offline</span>`;
                const age = state === 'ready' ? `<p class="preview-age">${escapeHtml(ageText(screenshots.peek(device.udid).at))}</p>` : '';
                const accountList = accounts.map(escapeHtml).join(', ');
                // Which Mac the phone hangs off (multi-host farms only).
                const host = device.hostName ? `<p class="device-meta device-host" title="Host">Host · ${escapeHtml(device.hostName)}</p>` : '';
                return `<article class="device-card" data-state="${state}"${ratio}>${preview}<div class="device-copy"><h2 title="${escapeHtml(device.name)}">${escapeHtml(device.name)}</h2>${pill}${host}<p class="device-meta" title="${escapeHtml(device.model ? `${device.model} · ${device.udid}` : device.udid)}">${device.connected ? `iOS ${escapeHtml(device.connected.osVersion)}` : escapeHtml(device.udid)}</p>${accounts.length ? `<p class="accounts" title="${accountList}">${accountList}</p>` : ''}${age}</div><div class="device-card-actions"><a id="open-${deviceKey(device.udid)}" class="button secondary" href="/devices/${encodeURIComponent(device.udid)}" aria-label="Open ${escapeHtml(device.name)}">Open</a>${toggleButton(device.udid, 'Disconnect', true)}</div></article>`;
            }).join('');
            const summary = active.length
                ? `<p class="grid-summary">${online} online · ${attention} need attention · ${active.length} total</p>` : '';
            const disabledPanel = disabled.length
                ? `<details class="disabled-devices"><summary>Disconnected devices (${disabled.length})</summary><ul>${disabled.map((device) => `<li><span>${escapeHtml(device.name)}</span>${toggleButton(device.udid, 'Reconnect', false)}</li>`).join('')}</ul></details>`
                : '';
            return reply.type('text/html').send(`<section id="device-list" class="device-list" hx-get="/api/fragments/devices" hx-trigger="every ${gridPollSeconds(active.length)}s" hx-swap="outerHTML" data-refresh-ms="${refreshMs}">${summary}${cards || (admin
                ? `<div class="empty-state"><div class="empty-icon" aria-hidden="true"></div><h2>No phones yet</h2><p>${disabled.length ? 'Every registered phone is disconnected. Reconnect one below, or register another.' : 'Plug an iPhone in over USB, trust this Mac, then register it.'}</p><a class="button primary" href="/devices/register">Register a phone</a></div>`
                : accessOf(request).tenantAdmin
                    ? `<div class="empty-state"><div class="empty-icon" aria-hidden="true"></div><h2>No phones yet</h2><p>${disabled.length ? 'Your phones are disconnected right now. The farm operator can reconnect them.' : 'Your organisation has no phones yet. The farm operator assigns phones to it.'}</p></div>`
                    : `<div class="empty-state"><div class="empty-icon" aria-hidden="true"></div><h2>No phones shared with you</h2><p>${disabled.length ? 'Your phones are disconnected right now. An admin can reconnect them.' : 'An admin has not given you access to any phone yet. Ask them to add you on the Team page.'}</p></div>`)}${disabledPanel}</section>`);
        });
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/summary', async (request, reply) => {
            const [connectedList, registeredList] = await Promise.all([connectedDevices(), loadRegisteredDevices()]);
            const registeredEntry = registeredList.find(({ udid }) => udid === request.params.udid);
            // Another host's phone: its host's agent says whether it is connected (and its screen).
            type RemoteInfo = { device: Device; screen: Awaited<ReturnType<RemoteControl['getScreenInfo']>> };
            let remoteInfo: RemoteInfo | null = null as RemoteInfo | null;
            if (registeredEntry && !isLocalDevice(registeredEntry, hostId)) {
                try {
                    const response = await agent.request(registeredEntry.hostId!, `/agent/devices/${encodeURIComponent(registeredEntry.udid)}/remote/info`, { timeoutMs: 5_000 });
                    if (response.ok) remoteInfo = await response.json() as RemoteInfo;
                } catch { /* host unreachable: rendered as disconnected */ }
            }
            const device = remoteInfo?.device ?? connectedList.find(({ udid }) => udid === request.params.udid && (!registeredEntry || isLocalDevice(registeredEntry, hostId)));
            if (!device) {
                // Registered but not on USB: keep the page header (name, UDID) so the
                // operator still knows which phone this is. Unknown UDIDs are a 404.
                const known = registeredList.find(({ udid }) => udid === request.params.udid);
                if (!known) return reply.code(404).type('text/html').send('<section id="device-summary" class="device-summary error"><div class="banner err" role="alert"><strong>Device not found</strong><p>No registered phone has this UDID.</p></div></section>');
                const knownPlace = [known.model, known.rack ? `Rack ${known.rack}` : '', known.rackSlot ? `Slot ${known.rackSlot}` : ''].filter(Boolean).join(' · ');
                const knownSlot = knownPlace ? `<p>${escapeHtml(knownPlace)}</p>` : '';
                return reply.type('text/html').send(`<section id="device-summary" class="device-summary error"><div class="device-summary-head"><div><span class="eyebrow">Registered device</span><h1>${escapeHtml(known.name)}</h1><span class="connected offline"><span></span>Offline</span>${knownSlot}</div><code title="UDID">${escapeHtml(known.udid)}</code></div><div class="banner err" role="alert"><strong>Device disconnected</strong><p>${isLocalDevice(known, hostId)
                    ? 'This phone is not visible over USB. Check the cable and hub port, unlock the phone and accept Trust, then reload this page.'
                    : escapeHtml(`This phone hangs off host ${known.hostId}, which reports it disconnected or is not answering. Check that host's cable, hub and agent, then reload this page.`)}</p></div></section>`);
            }
            const screen = remoteInfo?.screen ?? await remote.getScreenInfo(device.udid);
            const known = registeredEntry;
            const slot = [known?.rack ? `rack ${known.rack}` : '', known?.rackSlot ? `slot ${known.rackSlot}` : '']
                .filter(Boolean).map((part) => ` · ${escapeHtml(part)}`).join('');
            return reply.type('text/html').send(`<section id="device-summary" class="device-summary" data-screen-width="${screen.screenSize.width}" data-screen-height="${screen.screenSize.height}"><div><span class="eyebrow">Connected device</span><h1>${escapeHtml(device.name)}</h1><p>iOS ${escapeHtml(device.osVersion)} · ${screen.screenSize.width} × ${screen.screenSize.height} points · ${screen.scale}×${slot}</p></div><code title="UDID">${escapeHtml(device.udid)}</code></section>`);
        });
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/activity', async (request, reply) => {
            const access = accessOf(request);
            const device = access.platform ? undefined : (await loadOwnedDevices()).find(({ udid }) => udid === request.params.udid);
            const canOperate = access.platform || levelSatisfies(device ? access.levelFor(device) : null, 'operate');
            return reply.type('text/html').send(await renderActivity(request.params.udid, undefined, canOperate));
        });
    }

    app.get('/', async (request, reply) => {
        if (themed) return reply.type('text/html').send(personalize(themed.indexHtml, request));
        const admin = accessOf(request).platform;
        const devices = await visibleDevices(request);
        const cards = devices.map((device) => `<div class="card"><h2>${escapeHtml(device.name)}</h2><p class="muted"><code>${escapeHtml(device.udid)}</code>${device.hostName ? ` · host ${escapeHtml(device.hostName)}` : ''}</p><p>${device.disabled ? 'Disconnected' : device.connected ? `Online · iOS ${escapeHtml(device.connected.osVersion)}` : 'Offline'}</p><a class="button" href="/devices/${encodeURIComponent(device.udid)}">Open device</a></div>`).join('');
        const connected = admin ? await connectedDevices() : [];
        const registeredIds = new Set(devices.map(({ udid }) => udid));
        const candidates = connected.filter(({ udid }) => !registeredIds.has(udid)).map((device) => `<option value="${escapeHtml(device.udid)}" data-name="${escapeHtml(device.name)}">${escapeHtml(device.name)} · ${escapeHtml(device.osVersion)}</option>`).join('');
        const registration = candidates ? `<section class="card"><h2>Register connected device</h2><form id="register-device"><select name="udid">${candidates}</select> <button>Register</button></form><p id="register-result" class="muted"></p><script>document.getElementById('register-device').addEventListener('submit',async function(e){e.preventDefault();var s=e.currentTarget.udid;var o=s.options[s.selectedIndex];var r=await fetch('/api/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({udid:o.value,name:o.dataset.name,pluginData:{}})});document.getElementById('register-result').textContent=r.ok?'Registered. Reloading…':(await r.json()).error;if(r.ok)setTimeout(function(){location.reload()},500)});</script></section>` : '';
        return reply.type('text/html').send(renderPage('Devices', `<h1>Devices</h1>${registration}<div class="grid">${cards || '<p>No devices registered.</p>'}</div>`, request));
    });
    app.get('/devices/register', async (request, reply) => {
        if (!themed) return reply.type('text/html').send(renderPage('Register device', '<h1>Register device</h1><p>Use <code>POST /api/device-registrations</code> to start device setup.</p>', request));
        return reply.type('text/html').send(personalize(themed.registerDeviceHtml, request));
    });
    app.get<{ Params: { udid: string } }>('/devices/:udid', async (request, reply) => {
        const device = (await loadOwnedDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).type('text/html').send(renderPage('Not found', '<section class="card"><h1>Device not found</h1><p class="muted">No registered phone has this UDID. It may have been removed, or the link is from another farm.</p><p><a class="button" href="/">Back to devices</a></p></section>', request));
        const access = accessOf(request);
        const level = access.levelFor(device);
        const canOperate = levelSatisfies(level, 'operate');
        if (themed) {
            const rendered = options.dashboardTheme?.renderDevice
                ? options.dashboardTheme.renderDevice(themed.deviceHtml, device) : themed.deviceHtml;
            return reply.type('text/html').send(personalize(rendered.replaceAll('__DEVICE_UDID__', encodeURIComponent(device.udid)), request, level));
        }
        const schedules = (await options.scheduler.listSchedules(50, device.udid)).filter(({ tenantId }) => (tenantId ?? DEFAULT_TENANT_ID) === device.tenantId);
        const executions = (await options.scheduler.listExecutions(50, device.udid)).filter(({ tenantId }) => (tenantId ?? DEFAULT_TENANT_ID) === device.tenantId);
        const panels: string[] = [];
        for (const plugin of options.plugins.list()) {
            for (const panel of [...(plugin.devicePanels ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
                try {
                    panels.push(`<section class="card" data-plugin="${escapeHtml(plugin.id)}"><h2>${escapeHtml(panel.title)}</h2>${await readFile(panel.fragmentPath, 'utf8')}</section>`);
                } catch (error) {
                    panels.push(`<section class="card"><h2>${escapeHtml(panel.title)}</h2><p>Panel unavailable: ${escapeHtml(errorMessage(error))}</p></section>`);
                }
            }
        }
        const scheduleRows = schedules.map((item) => `<tr><td>${escapeHtml(item.pluginId)}/${escapeHtml(item.taskType)}</td><td>${escapeHtml(JSON.stringify(item.timing))}<br><span class="muted">Next: ${escapeHtml(item.nextRunAt?.toISOString() ?? '—')}</span></td><td>${escapeHtml(item.status)}</td><td>${!canOperate ? '' : item.status === 'active' ? `<button data-schedule="${item.id}" data-status="paused">Pause</button>` : item.status === 'paused' ? `<button data-schedule="${item.id}" data-status="active">Resume</button>` : ''} ${canOperate && !['cancelled', 'completed'].includes(item.status) ? `<button data-schedule="${item.id}" data-status="cancelled">Cancel</button>` : ''}</td></tr>`).join('');
        const executionRows = executions.map((item) => `<tr><td>${escapeHtml(item.pluginId)}/${escapeHtml(item.taskType)}</td><td>${escapeHtml(item.status)}<br><span class="muted">${escapeHtml(item.scheduledFor.toISOString())}</span></td><td><a href="/api/executions/${item.id}"><code>${escapeHtml(item.id)}</code></a></td><td>${!canOperate ? '' : ['queued', 'running'].includes(item.status) ? `<button data-stop="${item.id}">Stop</button>` : ['failed', 'stopped'].includes(item.status) ? `<button data-retry="${item.id}">Retry</button>` : ''}</td></tr>`).join('');
        const udidJs = encodeURIComponent(device.udid);
        const passcodeCard = !access.platform ? '' : !isLocalDevice(device, hostId)
            // The passcode lives on the owning Mac only (never in Postgres).
            ? `<section class="card"><h2>Unlock passcode</h2><p class="muted">${device.passcodeSet ? 'A passcode is set' : 'No passcode set'} on host ${escapeHtml(device.hostId ?? '')}. Set it from that host's dashboard.</p></section>`
            : `<section class="card"><h2>Unlock passcode</h2><p class="muted">${device.passcode ? 'A passcode is set.' : 'No passcode set.'} Stored only on this Mac (devices.json or device-secrets.json), never shown.</p><form id="pc"><input id="pcv" type="password" inputmode="numeric" placeholder="4+ digits" autocomplete="new-password"> <button class="button secondary">Save</button> <button type="button" id="pcc" class="button secondary">Clear</button> <span id="pcr" class="muted"></span></form></section><script>(function(){var f=document.getElementById('pc'),v=document.getElementById('pcv'),r=document.getElementById('pcr');async function set(p){r.textContent='…';var x=await fetch('/api/devices/${udidJs}',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({passcode:p})});if(x.ok){r.textContent=p?'Saved.':'Cleared.';v.value=''}else{r.textContent=((await x.json().catch(function(){return{}})).error)||'Failed'}}f.addEventListener('submit',function(e){e.preventDefault();if(!/^\\d{4,}$/.test(v.value.trim())){r.textContent='4+ digits';return}set(v.value.trim())});document.getElementById('pcc').addEventListener('click',function(){if(confirm('Clear passcode?'))set('')})})();</script>`;
        const controls = `<script>document.addEventListener('click',async function(e){var b=e.target.closest('button');if(!b)return;var url,body,method='POST';if(b.dataset.schedule){url='/api/schedules/'+b.dataset.schedule+'/status';body={status:b.dataset.status}}else if(b.dataset.stop){url='/api/executions/'+b.dataset.stop+'/stop'}else if(b.dataset.retry){url='/api/executions/'+b.dataset.retry+'/retry'}else if(b.dataset.remove){if(!confirm('Remove this device? Its schedules will be cancelled.'))return;url='/api/devices/'+encodeURIComponent(b.dataset.remove);method='DELETE'}else{return}b.disabled=true;var r=await fetch(url,{method:method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):'{}'});if(r.ok){location.href=b.dataset.remove?'/':location.href;if(!b.dataset.remove)location.reload()}else{b.disabled=false;alert((await r.json().catch(function(){return{}})).error||'Request failed')}});</script>`;
        return reply.type('text/html').send(renderPage(device.name, `<h1>${escapeHtml(device.name)}</h1><p><code>${escapeHtml(device.udid)}</code></p>${panels.join('')}<section class="card"><h2>Scheduled and recurring jobs</h2><table><tr><th>Task</th><th>Timing</th><th>Status</th><th>Actions</th></tr>${scheduleRows || '<tr><td colspan="4">No schedules.</td></tr>'}</table></section><section class="card"><h2>Execution history</h2><table><tr><th>Task</th><th>Status</th><th>ID/logs</th><th>Actions</th></tr>${executionRows || '<tr><td colspan="4">No executions.</td></tr>'}</table></section>${passcodeCard}${access.platform ? `<section class="card"><h2>Danger zone</h2><p class="muted">Removing a device cancels its schedules and forgets its configuration. WebDriverAgent stays installed on the phone.</p><button data-remove="${escapeHtml(device.udid)}" class="button secondary">Remove device</button></section>` : ''}${controls}`, request));
    });
    app.get('/tasks', async (request, reply) => reply.type('text/html').send(
        themed ? personalize(themed.tasksHtml, request)
            : renderPage('Tasks', '<h1>Tasks</h1><p>The JSON API exposes schedules and execution history. Installed plugins add task forms to each device page.</p>', request),
    ));
    app.get('/docs', async (request, reply) => reply.type('text/html').send(renderPage('API', '<h1>API</h1><p>Use <code>/api/plugins</code>, <code>/api/devices</code>, <code>/api/schedules</code>, and <code>/api/executions</code>. Lists answer only with the phones the signed-in user may see.</p>', request)));

    if (isBuiltinAuthProvider(provider)) {
        registerBuiltinAuthRoutes(app, {
            provider, renderShell, accessOf,
            loadDevices: loadOwnedDevices,
            tenantOfDevice: async (udid) => (await deviceTenants()).tenantOf(udid),
            log: (event) => app.log.info({ audit: event }, `audit ${event.event}`),
        });
    }

    app.setErrorHandler((error, request, reply) => {
        request.log.error(error);
        const failure = error as Error & { statusCode?: number };
        void reply.code(failure.statusCode && failure.statusCode >= 400 ? failure.statusCode : 400)
            .send({ error: failure.message });
    });
    return app;
}

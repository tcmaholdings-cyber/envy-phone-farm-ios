import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';

import { connectedDevices, type Device } from '../devices/discovery.js';
import { loadRegisteredDevices, mutateRegisteredDevices, saveRegisteredDevices, redactDevice, PASSCODE_PATTERN, type RegisteredDevice } from '../devices/registry.js';
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
import { brandHtml, brandingFromEnv, footerHtml, logoContentType, type Branding } from '../branding.js';
import type { AuthProvider, PluginNavLink } from '../plugin.js';
import type { PluginRegistry } from '../registry.js';
import type { CreateTaskInput, JsonObject, ScheduleTiming } from '../types.js';
import { ScheduleTransitionError, type SchedulerRepository } from '../scheduler/repository.js';

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
}

export interface DashboardTheme {
    rootDirectory: string;
    renderDevice?(template: string, device: RegisteredDevice): string;
}

interface LoadedDashboardTheme {
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

function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character] ?? character);
}

// Brand name, credit, logo and footer come from the environment (src/branding.ts)
// so a licensee can white-label the dashboard without forking.
function page(title: string, body: string, logoutPath: string | undefined, navLinks: readonly PluginNavLink[], branding: Branding, footer: string): string {
    const logout = logoutPath ? `<a class="logout" href="${escapeHtml(logoutPath)}">Log out</a>` : '';
    const extra = navLinks.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join('');
    // A minimal copy of the dashboard tokens (static/dashboard/styles.css :root),
    // system fonts only, so un-themed pages and errors match the dark dashboard.
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(branding.title)}</title><style>
:root{color-scheme:dark;--bg:#0a0a0c;--bg-2:#101014;--panel:#141419;--line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.16);--ink:#f6f6f8;--muted:#a9a9b4;--pink-2:#ff5fae;--pink-deep:#d6166f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Helvetica Neue",sans-serif}
nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 20px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--bg-2)}
nav a{color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;text-decoration:none}nav a:hover{color:var(--ink)}nav .home{margin-right:auto;color:var(--ink);letter-spacing:.18em}
main{max-width:1100px;margin:24px auto;padding:0 20px}h1{font-size:28px;letter-spacing:.01em;text-transform:uppercase;margin:0 0 12px}h2{font-size:15px;letter-spacing:.06em;text-transform:uppercase}
.card{margin:14px 0;padding:18px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
button,.button{display:inline-flex;align-items:center;min-height:36px;padding:0 16px;border:0;border-radius:999px;background:var(--pink-deep);color:#fff;font:600 12px system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;cursor:pointer}
.button.secondary{border:1px solid var(--line-strong);background:transparent;color:var(--ink)}a{color:var(--pink-2)}
input,select,textarea{min-height:36px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:10px;background:var(--bg-2);color:var(--ink);font:inherit}
:focus-visible{outline:2px solid var(--pink-2);outline-offset:2px}footer{max-width:1100px;margin:24px auto;padding:16px 20px;color:var(--muted);font-size:12px}footer a{color:var(--muted)}</style></head>
<body><nav><a class="home" href="/">${escapeHtml(branding.name)}</a><a href="/">Devices</a><a href="/tasks">Tasks</a><a href="/docs">API</a>${extra}${logout}</nav><main>${body}</main><footer>${footer}</footer></body></html>`;
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

async function registeredWithStatus(discover: () => Promise<Device[]> = connectedDevices) {
    const [registered, connected] = await Promise.all([loadRegisteredDevices(), discover()]);
    const online = new Map(connected.map((device) => [device.udid, device]));
    return registered.map((device) => ({
        ...redactDevice(device),
        connected: device.disabled ? null : online.get(device.udid) ?? null,
    }));
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
    const app = Fastify({ logger: options.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
    await app.register(formbody);
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 } });

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

    if (options.authProvider) {
        await options.authProvider.registerRoutes(app);
        app.addHook('onRequest', async (request, reply) => {
            if (options.authProvider?.isPublicPath(request.url.split('?')[0] ?? request.url)) return;
            const user = await options.authProvider?.authenticate(request, reply);
            if (!user && !reply.sent) await reply.code(401).send({ error: 'Authentication required' });
        });
    }

    const remote: RemoteControl = options.remote ?? new RegistryWdaRemoteControl();
    const discover = options.discoverDevices ?? connectedDevices;
    const wdaStatuses = options.wdaStatuses ?? supervisorStatuses;
    const screenshots = createScreenshotCache(remote);
    const thumbnails = createThumbnailCache();
    const forgetDevice = (udid: string) => {
        remote.forget?.(udid);
        screenshots.forget(udid);
        thumbnails.forget(udid);
    };
    const logoutPath = options.authProvider?.logoutPath;
    const authNavHtml = logoutPath
        ? `<a class="button secondary app-logout" href="${escapeHtml(logoutPath)}">Log out</a>` : '';
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
    const renderPage = (title: string, body: string) => page(title, body, logoutPath, navLinks, branding, footer);

    let themed: LoadedDashboardTheme | null = null;
    if (options.dashboardTheme) {
        const root = options.dashboardTheme.rootDirectory;
        const require = createRequire(import.meta.url);
        const [indexHtml, deviceHtml, tasksHtml, registerDeviceHtml, rawStyles, deviceScript, tasksScript, registerDeviceScript, gridScript, htmx] = await Promise.all([
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
            'grid.js': assetHash(gridScript), 'htmx.min.js': assetHash(htmx),
            ...fontVersions,
        };
        const finalize = (html: string) => {
            let out = html.replaceAll('__AUTH_NAV__', authNavHtml).replaceAll('__PLUGIN_NAV__', pluginNavHtml)
                .replaceAll('__BRAND__', brand).replaceAll('__BRAND_TITLE__', escapeHtml(branding.title))
                .replaceAll('__FOOTER__', footer);
            for (const [name, v] of Object.entries(versions)) out = out.replaceAll(`/assets/${name}`, `/assets/${name}?v=${v}`);
            return out;
        };
        themed = {
            indexHtml: finalize(indexHtml), deviceHtml: finalize(deviceHtml),
            tasksHtml: finalize(tasksHtml), registerDeviceHtml: finalize(registerDeviceHtml),
            styles, deviceScript, tasksScript, registerDeviceScript, gridScript, htmx, fonts,
        };
    }

    const renderActivity = async (deviceUdid: string, message?: string): Promise<string> => {
        const executions = await options.scheduler.listExecutions(25, deviceUdid);
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
        const canStop = execution.status === 'queued' || (execution.status === 'running' && (definition?.supportsStop(execution.payload) ?? true));
        const stop = canStop
            ? `<form hx-post="/api/executions/${execution.id}/stop" hx-target="#device-activity" hx-swap="outerHTML"><button class="button secondary" type="submit">Stop</button></form>` : '';
        return `<section id="device-activity" class="run-panel" hx-get="/api/devices/${encodeURIComponent(deviceUdid)}/fragments/activity" hx-trigger="every 1s" hx-swap="outerHTML"><div class="run-heading"><span class="status ${escapeHtml(execution.status)}"><span class="dot"></span>${escapeHtml(execution.status)}</span><span class="run-meta">${escapeHtml(summary)} · <time datetime="${escapeHtml(execution.scheduledFor.toISOString())}" data-local-time>${escapeHtml(execution.scheduledFor.toISOString().slice(0, 16).replace('T', ' '))} UTC</time></span></div>${errorBanner}${stop}<pre role="log" aria-live="polite">${detail?.logs.length ? detail.logs.map(escapeHtml).join('\n') : escapeHtml(execution.error ?? 'Waiting for worker output…')}</pre></section>`;
    };

    app.get('/health', async () => {
        const body: Record<string, unknown> = {
            ok: true,
            plugins: options.plugins.list().map(({ id, version }) => ({ id, version })),
        };
        // Deploy tooling writes a RELEASED file (sha, subject, deployedAt) into the
        // working directory; surface it so "what's live" is answerable over HTTP.
        try {
            body.release = JSON.parse(await readFile(path.resolve(process.env.PHONE_FARM_RELEASE_FILE ?? 'RELEASED'), 'utf8'));
        } catch { /* no release marker — fine */ }
        return body;
    });
    app.get('/api/plugins', async () => options.plugins.list().map((plugin) => ({
        id: plugin.id, version: plugin.version, displayName: plugin.displayName,
        tasks: plugin.tasks.map(({ type, version, displayName }) => ({ type, version, displayName })),
    })));
    app.get('/api/devices', async () => registeredWithStatus(discover));
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
    app.post<{ Body: { name?: string; udid?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinateProfile?: string; rackSlot?: string; pluginData?: Record<string, JsonObject> } }>(
        '/api/devices', async (request, reply) => {
            const { name, udid, wdaLocalPort, mjpegLocalPort, passcode, coordinateProfile, rackSlot, pluginData } = request.body;
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
                    ...(passcode !== undefined ? { passcode } : {}),
                };
                devices.push(device);
                return device;
            });
            return reply.code(201).send(redactDevice(created));
        },
    );
    app.patch<{ Params: { udid: string }; Body: { name?: string; wdaLocalPort?: number; mjpegLocalPort?: number; passcode?: string; coordinates?: unknown; disabled?: boolean; coordinateProfile?: string; rackSlot?: string; pluginData?: Record<string, JsonObject> } }>(
        '/api/devices/:udid', async (request, reply) => {
            const { passcode, coordinates, name, wdaLocalPort, mjpegLocalPort, disabled, coordinateProfile, rackSlot, pluginData } = request.body;
            if (passcode !== undefined && passcode !== '' && !PASSCODE_PATTERN.test(passcode)) {
                return reply.code(400).send({ error: 'Device passcode must contain at least four digits' });
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
        for (const schedule of await options.scheduler.listSchedules(500, request.params.udid)) {
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
        const identity = (await connectedDevices()).find(({ udid }) => udid === device.udid) ?? device;
        const results = [];
        for (const plugin of options.plugins.list()) {
            for (const check of plugin.registrationChecks ?? []) {
                results.push({ pluginId: plugin.id, checkId: check.id, ...(await check.run(identity, device.pluginData[plugin.id] ?? {})) });
            }
        }
        return results;
    });

    // NB: /remote/screenshot and /remote/action below are the canonical
    // endpoints — they carry the activeExecution guard and the cached
    // per-device client. The old unprefixed /screenshot and /actions twins
    // that bypassed both were removed.
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/info', async (request, reply) => {
        const device = (await connectedDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).send({ error: 'Device is not connected' });
        return { device, screen: await remote.getScreenInfo(device.udid) };
    });
    app.get<{ Params: { udid: string }; Querystring: { fresh?: string } }>('/api/devices/:udid/remote/screenshot', async (request, reply) => {
        try {
            // Served from the shared per-device cache so N dashboard tabs cost one
            // WDA round trip; `?fresh=1` bypasses it for a client that needs now.
            const frame = await screenshots.get(request.params.udid, request.query.fresh ? 0 : undefined);
            return reply.header('cache-control', 'no-store').type('image/png').send(frame);
        } catch {
            // A flapping device shouldn't spew 500s into the log every 5s from the grid poll.
            return reply.code(503).header('cache-control', 'no-store').send();
        }
    });
    // The grid's still: a small JPEG of the same cached frame, with an ETag so an
    // unchanged screen costs a 304 and no body. The full-size PNG above stays for
    // the device page and calibration.
    app.get<{ Params: { udid: string }; Querystring: { w?: string } }>('/api/devices/:udid/remote/thumbnail', async (request, reply) => {
        const width = thumbnailWidth(request.query.w);
        let frame: Buffer;
        try {
            frame = await screenshots.get(request.params.udid, { timeoutMs: gridScreenshotTimeoutMs() });
        } catch (error) {
            // WDA unreachable or refusing is "not ready"; anything else is a fault.
            return reply.code(503).header('cache-control', 'no-store')
                .header('x-device-state', error instanceof RemoteDeviceError ? 'not-ready' : 'error').send();
        }
        const etag = thumbnails.etag(request.params.udid, frame, width);
        reply.header('etag', etag).header('cache-control', 'private, max-age=2');
        if (request.headers['if-none-match'] === etag) return reply.code(304).send();
        try {
            const body = await thumbnails.thumbnail(request.params.udid, frame, width);
            return reply.type('image/jpeg').send(body);
        } catch {
            reply.removeHeader('etag');
            return reply.code(503).header('cache-control', 'no-store').header('x-device-state', 'error').send();
        }
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/remote/stream', async (request, reply) => {
        // Close the upstream device stream the moment the browser goes away —
        // otherwise every HTMX fragment swap leaks a live MJPEG connection.
        const abort = new AbortController();
        request.raw.once('close', () => abort.abort());
        const upstream = await remote.getMjpegStream(request.params.udid, abort.signal);
        if (!upstream.body) return reply.code(503).send({ error: 'Device stream is unavailable' });
        return reply.header('cache-control', 'no-store, no-cache, must-revalidate')
            .type(upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=--BoundaryString')
            .send(Readable.from(upstream.body as AsyncIterable<Uint8Array>));
    });
    app.post<{ Params: { udid: string }; Body: RemoteAction }>('/api/devices/:udid/remote/action', async (request, reply) => {
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Remote input is disabled while automation is running' });
        }
        await remote.performAction(request.params.udid, request.body);
        return { ok: true };
    });
    app.get<{ Params: { udid: string } }>('/api/devices/:udid/connection', async (request, reply) => {
        const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!registered) return reply.code(404).send({ error: 'Device is not registered' });
        // Prefer the real per-device state the wda-service supervisor tracks
        // (physical, wda, appium, retryCount, message).
        try {
            const response = await requestWdaService('/devices', { timeoutMs: 2_000 });
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const status = (JSON.parse(response.body).devices as DeviceConnectionStatus[])
                    .find((entry) => entry.udid === registered.udid);
                if (status) return status;
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
        return fallback;
    });
    app.post<{ Params: { udid: string } }>('/api/devices/:udid/reconnect', async (request, reply) => {
        if (await options.scheduler.activeExecution(request.params.udid)) {
            return reply.code(409).send({ error: 'Cannot reconnect while automation is running' });
        }
        forgetDevice(request.params.udid);
        return reply.code(202).send({ ok: true, message: 'The shared WDA supervisor will reconnect automatically' });
    });

    app.get<{ Querystring: { deviceUdid?: string } }>('/api/schedules', async (request) => ({
        schedules: await options.scheduler.listSchedules(200, request.query.deviceUdid),
    }));
    app.get<{ Querystring: { deviceUdid?: string } }>('/api/executions', async (request) => ({
        executions: await options.scheduler.listExecutions(200, request.query.deviceUdid),
    }));
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

    app.post('/api/assets', async (request, reply) => {
        const dataRoot = path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
        const uploadDirectory = path.join(dataRoot, 'uploads');
        await mkdir(uploadDirectory, { recursive: true });
        const created: Array<{ relativePath: string; originalName: string; mimeType: string; size: number; sha256: string }> = [];
        for await (const part of request.files()) {
            const id = crypto.randomUUID();
            const relativePath = path.join('uploads', id);
            const handle = await open(path.join(dataRoot, relativePath), 'wx', 0o600);
            const hash = crypto.createHash('sha256');
            let size = 0;
            try {
                for await (const chunk of part.file) {
                    const buffer = Buffer.from(chunk);
                    size += buffer.length;
                    hash.update(buffer);
                    await handle.write(buffer);
                }
            } finally {
                await handle.close();
            }
            created.push({ relativePath, originalName: part.filename, mimeType: part.mimetype, size, sha256: hash.digest('hex') });
        }
        return reply.code(201).send(await options.scheduler.registerAssets(created));
    });
    app.delete<{ Body: { assetIds: string[] } }>('/api/assets', async (request, reply) => {
        await options.scheduler.deleteAssets(request.body.assetIds ?? []);
        return reply.code(204).send();
    });

    for (const plugin of options.plugins.list()) {
        if (plugin.registerRoutes) await plugin.registerRoutes({
            app, routePrefix: `/plugins/${plugin.id}`, scheduler: options.scheduler, remote,
            loadDevices: loadRegisteredDevices, saveDevices: saveRegisteredDevices, mutateDevices: mutateRegisteredDevices, renderActivity,
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
        if (logo) app.get('/assets/brand-logo', asset(logo.contentType, logo.body));
        // Whitelisted by name: the parameter is only ever a map key, never a path.
        const fontRoutes = new Map([...theme.fonts].map(([name, body]) => [name, asset('font/woff2', body, 'public, max-age=86400')]));
        app.get<{ Params: { file: string } }>('/assets/fonts/:file', async (request, reply) => {
            const serve = fontRoutes.get(request.params.file);
            if (!serve) return reply.code(404).send({ error: 'Font not found' });
            return serve(request, reply);
        });
        app.get('/api/fragments/devices', async (_request, reply) => {
            const [devices, supervisor] = await Promise.all([
                registeredWithStatus(discover),
                // One supervisor read per poll. If the socket is down we cannot tell
                // ready from not-ready, so connected phones render a preview as before.
                wdaStatuses().catch(() => null),
            ]);
            const wdaState = new Map((supervisor ?? []).map((status) => [status.udid, status]));
            const active = devices.filter((device) => !device.disabled);
            const disabled = devices.filter((device) => device.disabled);
            const refreshMs = gridPollSeconds(active.length) * 1000;
            const toggleButton = (udid: string, label: string, next: boolean) =>
                `<button type="button" id="toggle-${deviceKey(udid)}" class="button secondary device-toggle" data-toggle-device="${encodeURIComponent(udid)}" data-disabled="${next}">${label}</button>`;
            let online = 0;
            let attention = 0;
            const cards = active.map((device) => {
                const accounts = Object.values(device.pluginData).flatMap((value) => {
                    const candidate = value.accounts;
                    return Array.isArray(candidate) ? candidate.filter((entry) => typeof entry === 'string') : [];
                });
                const status = device.connected ? wdaState.get(device.udid) : undefined;
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
                const slot = device.rackSlot ? `<p class="rack-slot" title="Slot ${escapeHtml(device.rackSlot)}">Slot ${escapeHtml(device.rackSlot)}</p>` : '';
                const preview = state === 'ready'
                    ? `<div class="device-preview-frame">${slot}<img id="${previewId(device.udid)}" class="device-preview" hx-preserve="true" data-thumb-src="/api/devices/${encodeURIComponent(device.udid)}/remote/thumbnail" data-refresh-ms="${refreshMs}" alt="Screen of ${escapeHtml(device.name)}" draggable="false" decoding="async"></div>`
                    : `<div class="device-preview-frame unavailable">${slot}<div class="device-icon" aria-hidden="true"></div></div>`;
                // The frame takes the phone's real proportions (numbers only).
                const ratio = screenRatioStyle(device.coordinateProfile);
                const pill = state === 'ready'
                    ? '<span class="connected"><span></span>Online</span>'
                    : state === 'not-ready'
                        ? `<span class="connected not-ready" title="${escapeHtml(status?.message ?? '')}"><span></span>WDA not ready</span>`
                        : '<span class="connected offline"><span></span>Offline</span>';
                const age = state === 'ready' ? `<p class="preview-age">${escapeHtml(ageText(screenshots.peek(device.udid).at))}</p>` : '';
                const accountList = accounts.map(escapeHtml).join(', ');
                return `<article class="device-card" data-state="${state}"${ratio}>${preview}<div class="device-copy"><h2 title="${escapeHtml(device.name)}">${escapeHtml(device.name)}</h2>${pill}<p class="device-meta" title="${escapeHtml(device.udid)}">${device.connected ? `iOS ${escapeHtml(device.connected.osVersion)}` : escapeHtml(device.udid)}</p>${accounts.length ? `<p class="accounts" title="${accountList}">${accountList}</p>` : ''}${age}</div><div class="device-card-actions"><a id="open-${deviceKey(device.udid)}" class="button secondary" href="/devices/${encodeURIComponent(device.udid)}" aria-label="Open ${escapeHtml(device.name)}">Open</a>${toggleButton(device.udid, 'Disconnect', true)}</div></article>`;
            }).join('');
            const summary = active.length
                ? `<p class="grid-summary">${online} online · ${attention} need attention · ${active.length} total</p>` : '';
            const disabledPanel = disabled.length
                ? `<details class="disabled-devices"><summary>Disconnected devices (${disabled.length})</summary><ul>${disabled.map((device) => `<li><span>${escapeHtml(device.name)}</span>${toggleButton(device.udid, 'Reconnect', false)}</li>`).join('')}</ul></details>`
                : '';
            return reply.type('text/html').send(`<section id="device-list" class="device-list" hx-get="/api/fragments/devices" hx-trigger="every ${gridPollSeconds(active.length)}s" hx-swap="outerHTML" data-refresh-ms="${refreshMs}">${summary}${cards || `<div class="empty-state"><div class="empty-icon" aria-hidden="true"></div><h2>No phones yet</h2><p>${disabled.length ? 'Every registered phone is disconnected. Reconnect one below, or register another.' : 'Plug an iPhone in over USB, trust this Mac, then register it.'}</p><a class="button primary" href="/devices/register">Register a phone</a></div>`}${disabledPanel}</section>`);
        });
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/summary', async (request, reply) => {
            const [connectedList, registeredList] = await Promise.all([connectedDevices(), loadRegisteredDevices()]);
            const device = connectedList.find(({ udid }) => udid === request.params.udid);
            if (!device) {
                // Registered but not on USB: keep the page header (name, UDID) so the
                // operator still knows which phone this is. Unknown UDIDs are a 404.
                const known = registeredList.find(({ udid }) => udid === request.params.udid);
                if (!known) return reply.code(404).type('text/html').send('<section id="device-summary" class="device-summary error"><div class="banner err" role="alert"><strong>Device not found</strong><p>No registered phone has this UDID.</p></div></section>');
                const knownSlot = known.rackSlot ? `<p>Slot ${escapeHtml(known.rackSlot)}</p>` : '';
                return reply.type('text/html').send(`<section id="device-summary" class="device-summary error"><div class="device-summary-head"><div><span class="eyebrow">Registered device</span><h1>${escapeHtml(known.name)}</h1><span class="connected offline"><span></span>Offline</span>${knownSlot}</div><code title="UDID">${escapeHtml(known.udid)}</code></div><div class="banner err" role="alert"><strong>Device disconnected</strong><p>This phone is not visible over USB. Check the cable and hub port, unlock the phone and accept Trust, then reload this page.</p></div></section>`);
            }
            const screen = await remote.getScreenInfo(device.udid);
            const rackSlot = registeredList.find(({ udid }) => udid === device.udid)?.rackSlot;
            const slot = rackSlot ? ` · slot ${escapeHtml(rackSlot)}` : '';
            return reply.type('text/html').send(`<section id="device-summary" class="device-summary" data-screen-width="${screen.screenSize.width}" data-screen-height="${screen.screenSize.height}"><div><span class="eyebrow">Connected device</span><h1>${escapeHtml(device.name)}</h1><p>iOS ${escapeHtml(device.osVersion)} · ${screen.screenSize.width} × ${screen.screenSize.height} points · ${screen.scale}×${slot}</p></div><code title="UDID">${escapeHtml(device.udid)}</code></section>`);
        });
        app.get<{ Params: { udid: string } }>('/api/devices/:udid/fragments/activity', async (request, reply) => {
            return reply.type('text/html').send(await renderActivity(request.params.udid));
        });
    }

    app.get('/', async (_request, reply) => {
        if (themed) return reply.type('text/html').send(themed.indexHtml);
        const devices = await registeredWithStatus(discover);
        const cards = devices.map((device) => `<div class="card"><h2>${escapeHtml(device.name)}</h2><p class="muted"><code>${escapeHtml(device.udid)}</code></p><p>${device.disabled ? 'Disconnected' : device.connected ? `Online · iOS ${escapeHtml(device.connected.osVersion)}` : 'Offline'}</p><a class="button" href="/devices/${encodeURIComponent(device.udid)}">Open device</a></div>`).join('');
        const connected = await connectedDevices();
        const registeredIds = new Set(devices.map(({ udid }) => udid));
        const candidates = connected.filter(({ udid }) => !registeredIds.has(udid)).map((device) => `<option value="${escapeHtml(device.udid)}" data-name="${escapeHtml(device.name)}">${escapeHtml(device.name)} · ${escapeHtml(device.osVersion)}</option>`).join('');
        const registration = candidates ? `<section class="card"><h2>Register connected device</h2><form id="register-device"><select name="udid">${candidates}</select> <button>Register</button></form><p id="register-result" class="muted"></p><script>document.getElementById('register-device').addEventListener('submit',async function(e){e.preventDefault();var s=e.currentTarget.udid;var o=s.options[s.selectedIndex];var r=await fetch('/api/devices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({udid:o.value,name:o.dataset.name,pluginData:{}})});document.getElementById('register-result').textContent=r.ok?'Registered. Reloading…':(await r.json()).error;if(r.ok)setTimeout(function(){location.reload()},500)});</script></section>` : '';
        return reply.type('text/html').send(renderPage('Devices', `<h1>Devices</h1>${registration}<div class="grid">${cards || '<p>No devices registered.</p>'}</div>`));
    });
    app.get('/devices/register', async (_request, reply) => {
        if (!themed) return reply.type('text/html').send(renderPage('Register device', '<h1>Register device</h1><p>Use <code>POST /api/device-registrations</code> to start device setup.</p>'));
        return reply.type('text/html').send(themed.registerDeviceHtml);
    });
    app.get<{ Params: { udid: string } }>('/devices/:udid', async (request, reply) => {
        const device = (await loadRegisteredDevices()).find(({ udid }) => udid === request.params.udid);
        if (!device) return reply.code(404).type('text/html').send(renderPage('Not found', '<section class="card"><h1>Device not found</h1><p class="muted">No registered phone has this UDID. It may have been removed, or the link is from another farm.</p><p><a class="button" href="/">Back to devices</a></p></section>'));
        if (themed) {
            const rendered = options.dashboardTheme?.renderDevice
                ? options.dashboardTheme.renderDevice(themed.deviceHtml, device) : themed.deviceHtml;
            return reply.type('text/html').send(rendered.replaceAll('__DEVICE_UDID__', encodeURIComponent(device.udid)));
        }
        const schedules = await options.scheduler.listSchedules(50, device.udid);
        const executions = await options.scheduler.listExecutions(50, device.udid);
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
        const scheduleRows = schedules.map((item) => `<tr><td>${escapeHtml(item.pluginId)}/${escapeHtml(item.taskType)}</td><td>${escapeHtml(JSON.stringify(item.timing))}<br><span class="muted">Next: ${escapeHtml(item.nextRunAt?.toISOString() ?? '—')}</span></td><td>${escapeHtml(item.status)}</td><td>${item.status === 'active' ? `<button data-schedule="${item.id}" data-status="paused">Pause</button>` : item.status === 'paused' ? `<button data-schedule="${item.id}" data-status="active">Resume</button>` : ''} ${!['cancelled', 'completed'].includes(item.status) ? `<button data-schedule="${item.id}" data-status="cancelled">Cancel</button>` : ''}</td></tr>`).join('');
        const executionRows = executions.map((item) => `<tr><td>${escapeHtml(item.pluginId)}/${escapeHtml(item.taskType)}</td><td>${escapeHtml(item.status)}<br><span class="muted">${escapeHtml(item.scheduledFor.toISOString())}</span></td><td><a href="/api/executions/${item.id}"><code>${escapeHtml(item.id)}</code></a></td><td>${['queued', 'running'].includes(item.status) ? `<button data-stop="${item.id}">Stop</button>` : ['failed', 'stopped'].includes(item.status) ? `<button data-retry="${item.id}">Retry</button>` : ''}</td></tr>`).join('');
        const udidJs = encodeURIComponent(device.udid);
        const passcodeCard = `<section class="card"><h2>Unlock passcode</h2><p class="muted">${device.passcode ? 'A passcode is set.' : 'No passcode set.'} Stored in devices.json, never shown.</p><form id="pc"><input id="pcv" type="password" inputmode="numeric" placeholder="4+ digits" autocomplete="new-password"> <button class="button secondary">Save</button> <button type="button" id="pcc" class="button secondary">Clear</button> <span id="pcr" class="muted"></span></form></section><script>(function(){var f=document.getElementById('pc'),v=document.getElementById('pcv'),r=document.getElementById('pcr');async function set(p){r.textContent='…';var x=await fetch('/api/devices/${udidJs}',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({passcode:p})});if(x.ok){r.textContent=p?'Saved.':'Cleared.';v.value=''}else{r.textContent=((await x.json().catch(function(){return{}})).error)||'Failed'}}f.addEventListener('submit',function(e){e.preventDefault();if(!/^\\d{4,}$/.test(v.value.trim())){r.textContent='4+ digits';return}set(v.value.trim())});document.getElementById('pcc').addEventListener('click',function(){if(confirm('Clear passcode?'))set('')})})();</script>`;
        const controls = `<script>document.addEventListener('click',async function(e){var b=e.target.closest('button');if(!b)return;var url,body,method='POST';if(b.dataset.schedule){url='/api/schedules/'+b.dataset.schedule+'/status';body={status:b.dataset.status}}else if(b.dataset.stop){url='/api/executions/'+b.dataset.stop+'/stop'}else if(b.dataset.retry){url='/api/executions/'+b.dataset.retry+'/retry'}else if(b.dataset.remove){if(!confirm('Remove this device? Its schedules will be cancelled.'))return;url='/api/devices/'+encodeURIComponent(b.dataset.remove);method='DELETE'}else{return}b.disabled=true;var r=await fetch(url,{method:method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):'{}'});if(r.ok){location.href=b.dataset.remove?'/':location.href;if(!b.dataset.remove)location.reload()}else{b.disabled=false;alert((await r.json().catch(function(){return{}})).error||'Request failed')}});</script>`;
        return reply.type('text/html').send(renderPage(device.name, `<h1>${escapeHtml(device.name)}</h1><p><code>${escapeHtml(device.udid)}</code></p>${panels.join('')}<section class="card"><h2>Scheduled and recurring jobs</h2><table><tr><th>Task</th><th>Timing</th><th>Status</th><th>Actions</th></tr>${scheduleRows || '<tr><td colspan="4">No schedules.</td></tr>'}</table></section><section class="card"><h2>Execution history</h2><table><tr><th>Task</th><th>Status</th><th>ID/logs</th><th>Actions</th></tr>${executionRows || '<tr><td colspan="4">No executions.</td></tr>'}</table></section>${passcodeCard}<section class="card"><h2>Danger zone</h2><p class="muted">Removing a device cancels its schedules and forgets its configuration. WebDriverAgent stays installed on the phone.</p><button data-remove="${escapeHtml(device.udid)}" class="button secondary">Remove device</button></section>${controls}`));
    });
    app.get('/tasks', async (_request, reply) => reply.type('text/html').send(
        themed?.tasksHtml ?? renderPage('Tasks', '<h1>Tasks</h1><p>The JSON API exposes schedules and execution history. Installed plugins add task forms to each device page.</p>'),
    ));
    app.get('/docs', async (_request, reply) => reply.type('text/html').send(renderPage('API', '<h1>API</h1><p>Use <code>/api/plugins</code>, <code>/api/devices</code>, <code>/api/schedules</code>, and <code>/api/executions</code>. This route follows the configured authentication policy.</p>')));

    app.setErrorHandler((error, request, reply) => {
        request.log.error(error);
        const failure = error as Error & { statusCode?: number };
        void reply.code(failure.statusCode && failure.statusCode >= 400 ? failure.statusCode : 400)
            .send({ error: failure.message });
    });
    return app;
}

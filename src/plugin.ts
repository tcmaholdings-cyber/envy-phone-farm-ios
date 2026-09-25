import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type {
    DeviceIdentity,
    JsonObject,
    JsonValue,
    StoredAsset,
    TaskExecutionResult,
    TaskRetryPolicy,
} from './types.js';
import type { SchedulerRepository } from './scheduler/repository.js';
import type { RegisteredDevice } from './devices/registry.js';
import type { RemoteControl } from './devices/wda-remote.js';

export interface DeviceAutomation {
    activateApp(bundleId: string): Promise<void>;
    terminateApp(bundleId: string): Promise<void>;
    pause(milliseconds: number, signal?: AbortSignal): Promise<void>;
    screenshot(): Promise<Buffer>;
    tap(x: number, y: number): Promise<void>;
    swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number): Promise<void>;
}

export interface TaskValidationContext {
    timingKind: 'now' | 'once' | 'daily' | 'weekly';
    devicePluginData: JsonObject;
}

export interface TaskExecutionContext {
    executionId: string;
    attempt: number;
    workspaceDirectory: string;
    device: DeviceIdentity;
    devicePluginData: JsonObject;
    automation: DeviceAutomation;
    assets: StoredAsset[];
    signal: AbortSignal;
    log(line: string): Promise<void>;
    runProcess(specification: PluginProcessSpecification): Promise<TaskExecutionResult>;
    /**
     * Call immediately *before* an irreversible side effect (a public post).
     * From then on the execution is never retried or re-run. A subprocess
     * reports the same thing by printing `EFFECT_COMMITTED_MARKER`
     * (src/scheduler/effects.ts). Optional so older hosts stay compatible.
     */
    commitEffect?(description: string): Promise<void>;
}

export interface PluginProcessSpecification {
    entrypoint: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface TaskDefinition<TPayload extends JsonObject = JsonObject> {
    type: string;
    version: number;
    displayName: string;
    validate(payload: JsonValue, context: TaskValidationContext): TPayload;
    summarize(payload: TPayload): string;
    estimateDurationMs(payload: TPayload): number;
    retryPolicy(payload: TPayload): TaskRetryPolicy;
    supportsStop(payload: TPayload): boolean;
    execute(context: TaskExecutionContext, payload: TPayload): Promise<TaskExecutionResult>;
}

export interface RegistrationCheckResult {
    status: 'passed' | 'blocked' | 'failed';
    message: string;
}

export interface RegistrationCheck {
    id: string;
    displayName: string;
    run(device: DeviceIdentity, pluginData: JsonObject): Promise<RegistrationCheckResult>;
}

export interface DevicePanel {
    id: string;
    title: string;
    fragmentPath: string;
    scriptPath?: string;
    order?: number;
}

export interface WdaExtension {
    id: string;
    patchFiles: Array<{ path: string; sha256: string }>;
}

/** A link a plugin contributes to the dashboard's top navigation. */
export interface PluginNavLink {
    label: string;
    href: string;
    order?: number;
}

export interface PluginRouteContext {
    app: FastifyInstance;
    routePrefix: string;
    scheduler: SchedulerRepository;
    remote: RemoteControl;
    loadDevices(): Promise<RegisteredDevice[]>;
    saveDevices(devices: RegisteredDevice[]): Promise<void>;
    /** Load → mutate → save devices.json atomically under the shared in-process lock. Prefer this over load+saveDevices. */
    mutateDevices<T>(mutate: (devices: RegisteredDevice[]) => T | Promise<T>): Promise<T>;
    renderActivity(deviceUdid: string, message?: string): Promise<string>;
}

/**
 * Who may call a plugin route when scoped access is on (the built-in accounts).
 * `device` checks the user's level on the phone named by the route's `:udid`
 * parameter. A plugin route without a declaration is admin-only.
 */
export type PluginRouteAccess =
    | { kind: 'signed-in' }
    | { kind: 'admin' }
    | { kind: 'device'; level: DeviceAccessLevel };

export interface PhoneFarmPlugin {
    id: string;
    version: string;
    displayName: string;
    tasks: readonly TaskDefinition[];
    navLinks?: readonly PluginNavLink[];
    devicePanels?: readonly DevicePanel[];
    registrationChecks?: readonly RegistrationCheck[];
    wdaExtensions?: readonly WdaExtension[];
    registerRoutes?(context: PluginRouteContext): Promise<void> | void;
    /** Keys are `METHOD /url/:pattern`, exactly as registered, e.g. `POST /api/devices/:udid/posts`. */
    routeAccess?: Readonly<Record<string, PluginRouteAccess>>;
}

/** How far a user may go with one phone: see it, or also drive it. */
export type DeviceAccessLevel = 'view' | 'operate';

/**
 * One access grant, to a user (`userId`) or a group (`groupId`). `scopeValue`
 * is null for `all`, the rack label for `rack`, the marketing model name for
 * `model` and the UDID for `device`.
 */
export interface DeviceAccessGrant {
    userId?: string | null;
    groupId?: string | null;
    scopeType: 'all' | 'rack' | 'model' | 'device';
    scopeValue?: string | null;
    level: DeviceAccessLevel;
}

/**
 * Scoped access for a signed-in user. A provider that returns it gets per-device
 * authorization (src/auth/policy.ts); a provider that omits it keeps the
 * original all-or-nothing behaviour, where every signed-in user can do everything.
 */
export interface UserAccess {
    role: 'admin' | 'operator';
    groupIds: string[];
    grants: DeviceAccessGrant[];
}

export interface AuthenticatedUser {
    id: string;
    email?: string;
    roles: string[];
    /** Shown in the navigation next to "Log out". */
    displayName?: string;
    /** When true, every page except the provider's password page is refused until the password changes. */
    mustChangePassword?: boolean;
    access?: UserAccess;
}

export interface AuthProvider {
    id: string;
    registerRoutes(app: FastifyInstance): Promise<void> | void;
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null>;
    isPublicPath(path: string): boolean;
    /** Path a "Log out" link points at, e.g. "/auth/logout". Omit to hide the link. */
    logoutPath?: string;
    /** `POST` renders Log out as a same-origin form (CSRF-safe) instead of a link. Default `GET`. */
    logoutMethod?: 'GET' | 'POST';
    /** Where an unauthenticated browser page navigation is redirected. Omit to answer 401. */
    loginPath?: string;
    /** Where a user with `mustChangePassword` is sent. */
    passwordChangePath?: string;
    close?(): Promise<void>;
}

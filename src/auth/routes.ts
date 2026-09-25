import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { RegisteredDevice } from '../devices/registry.js';
import type { SchedulerRepository } from '../scheduler/repository.js';
import { DEFAULT_TENANT_ID } from '../tenancy.js';
import { escapeHtml, jsonForScript } from '../html.js';
import type { RequestAccess } from './access.js';
import { auditCsv, type AuditEntry, type AuditLog } from './audit.js';
import { AccountError, type Actor, type AuditEvent, type PublicUser, type TeamSnapshot } from './accounts.js';
import {
    clearSessionCookie, LOGIN_PATH, LOGOUT_PATH, PASSWORD_PATH, SESSION_COOKIE, setSessionCookie, type BuiltinAuthProvider,
} from './builtin.js';
import { clientIp } from './net.js';
import { MIN_PASSWORD_LENGTH } from './password.js';
import { effectiveLevel, type AccessLevel, type PolicyGrant } from './policy.js';
import type { GrantRecord, GroupRecord } from './store.js';
import type { TenantRecord } from './tenants.js';

/**
 * The built-in accounts' pages and API: sign-in, sign-out, password change,
 * and the admin Team panel. Registered by createApp when
 * PHONE_FARM_AUTH_PLUGIN=builtin, so they render inside the dashboard theme.
 * Authorization is the dashboard's route table (route-access.ts); handlers here
 * only need the signed-in actor.
 */

export interface ShellOptions {
    title: string;
    /** Inner HTML of <main>; every dynamic value in it must already be escaped. */
    main: string;
    mainClass?: string;
    bodyClass?: string;
    /** No navigation (the sign-in page). */
    bare?: boolean;
    /** The nav link to mark as the current page. */
    current?: string;
    /** Scripts from /assets to load as modules. */
    scripts?: string[];
    /** Load htmx (the page uses hx-* attributes). */
    htmx?: boolean;
}

/** A registered phone labelled with the tenant that owns it. */
export type OwnedDevice = RegisteredDevice & { tenantId: string };

export interface BuiltinRouteContext {
    provider: BuiltinAuthProvider;
    renderShell(request: FastifyRequest | null, options: ShellOptions): string;
    accessOf(request: FastifyRequest): RequestAccess;
    loadDevices(): Promise<OwnedDevice[]>;
    tenantOfDevice(udid: string): Promise<string>;
    /** The audit log to read back on /audit; null means rows only reach the server log. */
    auditLog: AuditLog | null;
    /** For moving a phone between tenants: its running work and the old owner's schedules. */
    scheduler: Pick<SchedulerRepository, 'activeExecution' | 'listSchedules' | 'setScheduleStatus'>;
    log(event: AuditEvent): void;
}

/** Only same-site relative paths survive as a post-login destination. */
export function safeNextPath(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
    if (/[\r\n]/.test(value) || value.startsWith(LOGIN_PATH) || value.startsWith(LOGOUT_PATH)) return '/';
    return value.slice(0, 2048);
}

function wantsJson(request: FastifyRequest): boolean {
    const type = request.headers['content-type'] ?? '';
    const accept = request.headers.accept ?? '';
    return type.includes('application/json') || (accept.includes('application/json') && !accept.includes('text/html'));
}

function field(body: unknown, name: string): unknown {
    return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

function isoTime(value: Date | null | undefined): string {
    if (!value) return '<span class="muted">Never</span>';
    const iso = value.toISOString();
    return `<time datetime="${escapeHtml(iso)}" data-local-time>${escapeHtml(iso.slice(0, 16).replace('T', ' '))} UTC</time>`;
}

const LEVEL_LABEL: Record<AccessLevel, string> = { view: 'View', operate: 'Operate' };

function scopeLabel(grant: Pick<GrantRecord, 'scopeType' | 'scopeValue'>, devices: readonly RegisteredDevice[]): string {
    switch (grant.scopeType) {
        case 'all': return 'All phones';
        case 'rack': return `Rack ${grant.scopeValue ?? ''}`;
        case 'model': return `Model · ${grant.scopeValue ?? ''}`;
        case 'device': {
            const device = devices.find(({ udid }) => udid === grant.scopeValue);
            return device ? `Phone · ${device.name}` : `Phone · ${grant.scopeValue ?? ''} (not registered)`;
        }
        default: return String(grant.scopeType);
    }
}

function distinctSorted(values: Array<string | undefined>): string[] {
    const seen = new Map<string, string>();
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export interface TeamTenant { id: string; slug: string; name: string; status?: string }

/** Which organisation the Team page shows, and (platform staff) which others it can switch to. */
export interface TeamContext {
    /** The organisation shown; null for the platform accounts; undefined when there are no tenants to speak of. */
    tenant?: TeamTenant | null;
    /** Platform staff only: every organisation, for the switcher. */
    tenants?: readonly TeamTenant[];
}

const ROLE_LABEL: Record<string, string> = { platform: 'Platform', admin: 'Admin', operator: 'Operator' };

/** The Team page body. Exported for tests; every value is escaped here. */
export function renderTeamMain(team: TeamSnapshot, devices: readonly (RegisteredDevice & { tenantId?: string })[], currentUserId: string, context: TeamContext = {}): string {
    const staffView = context.tenant === null;
    const groupsById = new Map(team.groups.map((group) => [group.id, group]));
    const usersById = new Map(team.users.map((user) => [user.id, user]));
    const groupsOf = (userId: string) => team.memberships.filter((membership) => membership.userId === userId)
        .map(({ groupId }) => groupsById.get(groupId)).filter((group): group is GroupRecord => Boolean(group));
    const membersOf = (groupId: string) => team.memberships.filter((membership) => membership.groupId === groupId)
        .map(({ userId }) => usersById.get(userId)).filter((user): user is PublicUser => Boolean(user));
    const admins = team.users.filter((user) => user.role === (staffView ? 'platform' : 'admin') && !user.disabled).length;

    const status = (user: PublicUser) => user.disabled
        ? '<span class="status paused"><span class="dot"></span>Disabled</span>'
        : user.mustChangePassword
            ? '<span class="status queued"><span class="dot"></span>Password change pending</span>'
            : '<span class="status active"><span class="dot"></span>Active</span>';

    const userRows = team.users.map((user) => {
        const you = user.id === currentUserId ? ' <span class="you-badge">You</span>' : '';
        const chips = groupsOf(user.id).map((group) => `<span class="chip">${escapeHtml(group.name)}</span>`).join('') || '<span class="muted">—</span>';
        const data = `data-id="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}"`;
        return `<tr data-user-id="${escapeHtml(user.id)}"><td><strong>${escapeHtml(user.displayName)}</strong>${you}</td><td><code>${escapeHtml(user.username)}</code></td><td><span class="role-badge ${user.role === 'operator' ? 'operator' : 'admin'}">${escapeHtml(ROLE_LABEL[user.role] ?? user.role)}</span></td><td><div class="chip-list">${chips}</div></td><td>${isoTime(user.lastLoginAt)}</td><td>${status(user)}</td><td><div class="inline-actions row-actions">`
            + `<button class="icon-button" type="button" data-action="edit-user" ${data} data-name="${escapeHtml(user.displayName)}" data-role="${escapeHtml(user.role)}">Edit</button>`
            + `<button class="icon-button" type="button" data-action="reset-password" ${data}>Reset password</button>`
            + (user.id === currentUserId ? '' : `<button class="icon-button" type="button" data-action="toggle-user" ${data} data-disabled="${user.disabled ? 'false' : 'true'}">${user.disabled ? 'Enable' : 'Disable'}</button>`
                + `<button class="icon-button danger" type="button" data-action="delete-user" ${data}>Delete</button>`)
            + '</div></td></tr>';
    }).join('');

    const userOptions = team.users.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)} (${escapeHtml(user.username)})</option>`).join('');
    const groupRows = team.groups.map((group) => {
        const members = membersOf(group.id);
        const chips = members.map((user) => `<span class="chip">${escapeHtml(user.displayName)}<button class="chip-remove" type="button" data-action="remove-member" data-group="${escapeHtml(group.id)}" data-id="${escapeHtml(user.id)}" aria-label="Remove ${escapeHtml(user.displayName)} from ${escapeHtml(group.name)}">×</button></span>`).join('');
        return `<tr data-group-id="${escapeHtml(group.id)}"><td><strong>${escapeHtml(group.name)}</strong>${group.description ? `<p class="cell-note">${escapeHtml(group.description)}</p>` : ''}</td><td><div class="chip-list">${chips || '<span class="muted">No members</span>'}</div></td><td><form class="inline-add" data-form="add-member" data-group="${escapeHtml(group.id)}"><label class="visually-hidden" for="member-${escapeHtml(group.id)}">Add a member to ${escapeHtml(group.name)}</label><select id="member-${escapeHtml(group.id)}" name="userId" required><option value="">Add a person…</option>${userOptions}</select><button class="button secondary" type="submit">Add</button></form></td><td><div class="inline-actions row-actions"><button class="icon-button" type="button" data-action="rename-group" data-id="${escapeHtml(group.id)}" data-name="${escapeHtml(group.name)}" data-description="${escapeHtml(group.description)}">Rename</button><button class="icon-button danger" type="button" data-action="delete-group" data-id="${escapeHtml(group.id)}" data-name="${escapeHtml(group.name)}">Delete</button></div></td></tr>`;
    }).join('');

    const subjectName = (grant: GrantRecord) => grant.userId
        ? `<strong>${escapeHtml(usersById.get(grant.userId)?.displayName ?? 'Unknown user')}</strong>`
        : `<strong>${escapeHtml(groupsById.get(grant.groupId ?? '')?.name ?? 'Unknown group')}</strong> <span class="chip">Group</span>`;
    const grantRows = [...team.grants]
        .sort((a, b) => Number(Boolean(a.groupId)) - Number(Boolean(b.groupId)))
        .map((grant) => `<tr data-grant-id="${escapeHtml(grant.id)}"><td>${subjectName(grant)}</td><td>${escapeHtml(scopeLabel(grant, devices))}</td><td><span class="level-chip ${grant.level}">${LEVEL_LABEL[grant.level]}</span></td><td><div class="inline-actions row-actions"><button class="icon-button danger" type="button" data-action="delete-grant" data-id="${escapeHtml(grant.id)}">Remove</button></div></td></tr>`)
        .join('');

    const operators = team.users.filter((user) => user.role === 'operator');
    const subjectOptions = `<optgroup label="People">${operators.map((user) => `<option value="user:${escapeHtml(user.id)}">${escapeHtml(user.displayName)} (${escapeHtml(user.username)})</option>`).join('')}</optgroup><optgroup label="Groups">${team.groups.map((group) => `<option value="group:${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}</optgroup>`;

    const effective = operators.map((user) => {
        const groupIds = team.memberships.filter(({ userId }) => userId === user.id).map(({ groupId }) => groupId);
        const grants: PolicyGrant[] = team.grants;
        const reachable = devices.flatMap((device) => {
            const level = effectiveLevel({ id: user.id, role: user.role, tenantId: user.tenantId, disabled: user.disabled }, groupIds, grants, device);
            return level ? [`<li><span>${escapeHtml(device.name)}</span><span class="level-chip ${level}">${LEVEL_LABEL[level]}</span></li>`] : [];
        });
        return `<article class="effective-card"><h3>${escapeHtml(user.displayName)}${user.disabled ? ' <span class="muted">(disabled)</span>' : ''}</h3>${reachable.length ? `<ul>${reachable.join('')}</ul>` : '<p class="muted">No phones.</p>'}</article>`;
    }).join('');

    const scopes = {
        rack: distinctSorted(devices.map(({ rack }) => rack)),
        model: distinctSorted(devices.map(({ model }) => model)),
        device: devices.map((device) => ({ value: device.udid, label: `${device.name}${device.rack ? ` · rack ${device.rack}` : ''}` })),
    };
    const groupChoices = team.groups.map((group) => `<label><input type="checkbox" name="groupIds" value="${escapeHtml(group.id)}"> ${escapeHtml(group.name)}</label>`).join('');
    // Platform accounts have no groups or grants: they reach every phone of every organisation.
    const tenantSections = staffView ? '' : `<section class="panel team-section" aria-labelledby="groups-title"><div class="section-heading"><div><span class="eyebrow">Groups</span><h2 id="groups-title">Groups</h2></div><span class="run-meta">Grant a group access once; every member gets it.</span></div>
<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Group</th><th scope="col">Members</th><th scope="col">Add member</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${groupRows || '<tr><td colspan="4" class="muted">No groups yet. Create one for a shift or a rack team.</td></tr>'}</tbody></table></div></section>
<section class="panel team-section" aria-labelledby="access-title"><div class="section-heading"><div><span class="eyebrow">Access</span><h2 id="access-title">Phone access</h2></div><span class="run-meta">View shows a phone · Operate also drives it</span></div>
<form id="grant-form" class="grant-form" data-form="add-grant"><div class="field"><label for="grant-subject">Who</label><select id="grant-subject" name="subject" required><option value="">Choose a person or group…</option>${subjectOptions}</select></div><div class="field"><label for="grant-scope">Scope</label><select id="grant-scope" name="scopeType"><option value="all">All phones</option><option value="rack">A rack</option><option value="model">A model</option><option value="device">One phone</option></select></div><div class="field"><label for="grant-value">Which</label><select id="grant-value" name="scopeValue" disabled><option value="">Every phone</option></select></div><div class="field"><label for="grant-level">Level</label><select id="grant-level" name="level"><option value="view">View</option><option value="operate">Operate</option></select></div><button class="button primary" type="submit">Grant access</button></form>
<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Who</th><th scope="col">Scope</th><th scope="col">Level</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${grantRows || '<tr><td colspan="4" class="muted">No access granted yet. Operators see no phones until they get a grant.</td></tr>'}</tbody></table></div></section>
<section class="panel team-section" aria-labelledby="effective-title"><div class="section-heading"><div><span class="eyebrow">Result</span><h2 id="effective-title">What each operator can reach</h2></div><span class="run-meta">Their own grants plus their groups', highest level wins</span></div>
<div class="effective-grid">${effective || '<p class="muted">No operators yet.</p>'}</div></section>
`;
    const where = context.tenant === undefined ? '' : context.tenant === null ? 'Platform staff' : context.tenant.name;
    const switcher = context.tenants?.length ? `<form class="tenant-switch inline-add" method="get" action="/team"><label class="visually-hidden" for="team-tenant">Organisation</label><select id="team-tenant" name="tenant"><option value="platform"${staffView ? ' selected' : ''}>Platform staff</option>${context.tenants.map((tenant) => `<option value="${escapeHtml(tenant.id)}"${context.tenant?.id === tenant.id ? ' selected' : ''}>${escapeHtml(tenant.name)}${tenant.status === 'suspended' ? ' (suspended)' : ''}</option>`).join('')}</select><button class="button secondary" type="submit">Show</button></form>` : '';
    const intro = staffView
        ? 'Platform staff run the farm: every organisation, every phone, phone registration and the Tenants page. They belong to no organisation.'
        : 'Who can sign in, the groups they belong to, and which phones each person can see or drive. Admins can do everything in this organisation; operators only reach phones granted to them or to one of their groups.';
    const roleOptions = staffView
        ? '<option value="platform">Platform — every organisation and the farm itself</option>'
        : '<option value="operator">Operator — only granted phones</option><option value="admin">Admin — everything in this organisation, including the Team page</option>';

    return `<header class="page-header"><div><span class="eyebrow">Access${where ? ` · ${escapeHtml(where)}` : ''}</span><h1>Team</h1><p>${intro}</p></div><div class="page-actions">${switcher}${staffView ? '' : '<button class="button secondary" type="button" data-action="new-group">New group</button>'}<button class="button primary" type="button" data-action="new-user">Add person</button></div></header>
<div id="team-error" class="banner err" role="alert" hidden></div>
<section class="panel team-section" aria-labelledby="people-title"><div class="section-heading"><div><span class="eyebrow">People</span><h2 id="people-title">Users</h2></div><span class="run-meta">${team.users.length} ${team.users.length === 1 ? 'person' : 'people'} · ${admins} active ${staffView ? 'platform' : admins === 1 ? 'admin' : 'admins'}</span></div>
<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Name</th><th scope="col">Username</th><th scope="col">Role</th><th scope="col">Groups</th><th scope="col">Last sign-in</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${userRows || '<tr><td colspan="7" class="muted">Nobody yet.</td></tr>'}</tbody></table></div></section>
${tenantSections}<script type="application/json" id="team-scopes">${jsonForScript(scopes)}</script>
<dialog id="user-dialog"><form id="user-form" class="modal" data-form="user"><div class="modal-head"><div><span class="eyebrow">Team</span><h2 id="user-dialog-title">Add person</h2></div><button class="icon-button" type="button" data-close>Close</button></div>
<p id="user-dialog-help">They get a temporary password, shown once, and choose their own at first sign-in.</p>
<div class="field" data-create-only><label for="user-username">Username</label><input id="user-username" name="username" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{1,31}" placeholder="e.g. maria" required></div>
<div class="field"><label for="user-name">Display name</label><input id="user-name" name="displayName" type="text" maxlength="80" placeholder="e.g. Maria (VA)"></div>
<div class="field"><label for="user-role">Role</label><select id="user-role" name="role">${roleOptions}</select></div>
${groupChoices ? `<fieldset data-create-only><legend>Groups</legend><div class="choices">${groupChoices}</div></fieldset>` : ''}
<p id="user-result" class="field-error" aria-live="polite"></p>
<div class="form-actions"><span class="spacer"></span><button class="button secondary" type="button" data-close>Cancel</button><button class="button primary" type="submit">Save</button></div></form></dialog>
<dialog id="secret-dialog"><div class="modal"><div class="modal-head"><div><span class="eyebrow">Shown once</span><h2>Temporary password</h2></div></div>
<p>Give this to <strong id="secret-user"></strong> privately. It will not be shown again; they must choose a new password when they first sign in.</p>
<output id="secret-value" class="secret-value"></output>
<div class="form-actions"><button id="secret-copy" class="button secondary" type="button">Copy</button><span class="spacer"></span><button id="secret-done" class="button primary" type="button">Done</button></div></div></dialog>
<dialog id="group-dialog"><form id="group-form" class="modal" data-form="group"><div class="modal-head"><div><span class="eyebrow">Team</span><h2 id="group-dialog-title">New group</h2></div><button class="icon-button" type="button" data-close>Close</button></div>
<div class="field"><label for="group-name">Name</label><input id="group-name" name="name" type="text" maxlength="60" required placeholder="e.g. Night shift"></div>
<div class="field"><label for="group-description">Description <small>(optional)</small></label><input id="group-description" name="description" type="text" maxlength="200"></div>
<p id="group-result" class="field-error" aria-live="polite"></p>
<div class="form-actions"><span class="spacer"></span><button class="button secondary" type="button" data-close>Cancel</button><button class="button primary" type="submit">Save</button></div></form></dialog>`;
}

/** The audit page body. Exported for tests; every value is escaped here. */
export function renderAuditMain(entries: readonly AuditEntry[], options: {
    names: ReadonlyMap<string, string>; tenants: ReadonlyMap<string, string>; showTenant: boolean; olderHref: string | null; csvHref: string;
}): string {
    const cell = (value: string | null | undefined) => (value ? escapeHtml(value) : '<span class="muted">—</span>');
    const rows = entries.map((entry) => {
        const who = entry.actorUserId ? options.names.get(entry.actorUserId) ?? `${entry.actorRole ?? 'user'} (not in this organisation)` : entry.actorRole;
        const target = [entry.targetUdid, ...(entry.targetIds ?? [])].filter(Boolean).join(' · ');
        const what = entry.event === 'http' ? `${entry.method ?? ''} ${entry.route ?? '(no route)'}` : entry.event;
        const outcome = entry.status === null ? '' : `<span class="status ${entry.status < 400 ? 'active' : 'paused'}"><span class="dot"></span>${entry.status}</span>`;
        return `<tr><td>${isoTime(entry.at)}</td>${options.showTenant ? `<td>${cell(entry.tenantId ? options.tenants.get(entry.tenantId) ?? entry.tenantId : 'platform')}</td>` : ''}<td>${cell(who)}</td><td><code>${escapeHtml(what)}</code>${entry.detail ? `<p class="cell-note">${escapeHtml(entry.detail)}</p>` : ''}</td><td>${cell(target)}</td><td>${outcome}</td><td>${cell(entry.ip)}</td></tr>`;
    }).join('');
    const columns = options.showTenant ? 7 : 6;
    return `<header class="page-header"><div><span class="eyebrow">Access</span><h1>Audit log</h1><p>Every change made through the dashboard or the API, newest first: who, from where, what, and whether it worked. Request bodies, passwords and typed text are never recorded.</p></div><div class="page-actions"><a class="button secondary" href="${escapeHtml(options.csvHref)}">Download CSV</a></div></header>
<section class="panel team-section"><div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">When</th>${options.showTenant ? '<th scope="col">Organisation</th>' : ''}<th scope="col">Who</th><th scope="col">What</th><th scope="col">Target</th><th scope="col">Result</th><th scope="col">IP</th></tr></thead><tbody>${rows || `<tr><td colspan="${columns}" class="muted">Nothing recorded yet.</td></tr>`}</tbody></table></div>${options.olderHref ? `<p><a class="button secondary" href="${escapeHtml(options.olderHref)}">Older entries</a></p>` : ''}</section>`;
}

export interface TenantStats { phones: number; users: number }

function limitText(used: number, limit: number | undefined): string {
    return typeof limit === 'number' ? `${used} / ${limit}` : String(used);
}

function megabytes(bytes: number | undefined): string {
    return typeof bytes === 'number' ? `${Math.round(bytes / 1024 ** 2).toLocaleString('en')} MB` : 'Default (5 GB)';
}

/** The Tenants page panel (platform staff). Exported for tests; every value is escaped here. */
export function renderTenantsPanel(tenants: readonly TenantRecord[], stats: ReadonlyMap<string, TenantStats>, devices: readonly OwnedDevice[], notice?: { ok: boolean; message: string }): string {
    const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    const rows = tenants.map((tenant) => {
        const counts = stats.get(tenant.id) ?? { phones: 0, users: 0 };
        const suspended = tenant.status === 'suspended';
        const toggle = tenant.id === DEFAULT_TENANT_ID ? '<span class="muted">Default</span>'
            : `<button class="icon-button${suspended ? '' : ' danger'}" type="button" hx-patch="/api/tenants/${escapeHtml(tenant.id)}" hx-vals='${escapeHtml(JSON.stringify({ status: suspended ? 'active' : 'suspended' }))}' hx-target="#tenants-panel" hx-swap="outerHTML"${suspended ? '' : ` hx-confirm="${escapeHtml(`Suspend ${tenant.name}? Its people are signed out and its schedules stop until you activate it again.`)}"`}>${suspended ? 'Activate' : 'Suspend'}</button>`;
        return `<tr data-tenant-id="${escapeHtml(tenant.id)}"><td><strong>${escapeHtml(tenant.name)}</strong></td><td><code>${escapeHtml(tenant.slug)}</code></td><td><span class="status ${suspended ? 'paused' : 'active'}"><span class="dot"></span>${suspended ? 'Suspended' : 'Active'}</span></td><td>${escapeHtml(limitText(counts.phones, tenant.quotas.maxPhones))}</td><td>${escapeHtml(limitText(counts.users, tenant.quotas.maxUsers))}</td><td>${escapeHtml(megabytes(tenant.quotas.maxUploadBytes))}</td><td><div class="inline-actions row-actions"><a class="icon-button" href="/team?tenant=${encodeURIComponent(tenant.id)}">Team</a>${toggle}</div></td></tr>`;
    }).join('');
    const phoneOptions = devices.map((device) => `<option value="${escapeHtml(device.udid)}">${escapeHtml(device.name)} · ${escapeHtml(byId.get(device.tenantId)?.name ?? device.tenantId)}</option>`).join('');
    const tenantOptions = tenants.map((tenant) => `<option value="${escapeHtml(tenant.id)}">${escapeHtml(tenant.name)}</option>`).join('');
    const banner = notice ? `<div class="banner ${notice.ok ? 'ok' : 'err'}" role="${notice.ok ? 'status' : 'alert'}"><strong>${escapeHtml(notice.message)}</strong></div>` : '';
    return `<div id="tenants-panel">${banner}
<section class="panel team-section" aria-labelledby="tenants-title"><div class="section-heading"><div><span class="eyebrow">Customers</span><h2 id="tenants-title">Organisations</h2></div><span class="run-meta">${tenants.length} ${tenants.length === 1 ? 'organisation' : 'organisations'}</span></div>
<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">Name</th><th scope="col">Short name</th><th scope="col">Status</th><th scope="col">Phones</th><th scope="col">People</th><th scope="col">Upload budget</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>
<form class="grant-form" hx-post="/api/tenants" hx-target="#tenants-panel" hx-swap="outerHTML"><div class="field"><label for="tenant-name">Name</label><input id="tenant-name" name="name" type="text" maxlength="80" required placeholder="e.g. Acme Media"></div><div class="field"><label for="tenant-slug">Short name</label><input id="tenant-slug" name="slug" type="text" maxlength="40" pattern="[a-z0-9][a-z0-9\-]{1,39}" required placeholder="acme"></div><div class="field"><label for="tenant-phones">Max phones</label><input id="tenant-phones" name="maxPhones" type="number" min="0" placeholder="No limit"></div><div class="field"><label for="tenant-users">Max people</label><input id="tenant-users" name="maxUsers" type="number" min="0" placeholder="No limit"></div><div class="field"><label for="tenant-upload">Upload budget (MB)</label><input id="tenant-upload" name="maxUploadMb" type="number" min="0" placeholder="5120"></div><button class="button primary" type="submit">Add organisation</button></form></section>
<section class="panel team-section" aria-labelledby="assign-title"><div class="section-heading"><div><span class="eyebrow">Phones</span><h2 id="assign-title">Assign a phone</h2></div><span class="run-meta">Moving a phone cancels the old organisation's schedules on it</span></div>
<form class="grant-form" hx-post="/api/tenant-devices" hx-target="#tenants-panel" hx-swap="outerHTML"><div class="field"><label for="assign-phone">Phone</label><select id="assign-phone" name="udid" required><option value="">Choose a phone…</option>${phoneOptions}</select></div><div class="field"><label for="assign-tenant">Organisation</label><select id="assign-tenant" name="tenantId" required>${tenantOptions}</select></div><button class="button primary" type="submit">Assign</button></form></section></div>`;
}

function authCard(title: string, eyebrow: string, intro: string, inner: string): string {
    return `<section class="panel auth-card"><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1><p>${intro}</p>${inner}</section>`;
}

export function registerBuiltinAuthRoutes(app: FastifyInstance, context: BuiltinRouteContext): void {
    const { provider, renderShell } = context;
    const accounts = provider.accounts;
    accounts.audit = context.log;
    accounts.tenantOfDevice = context.tenantOfDevice;
    if (provider.tenants) provider.tenants.audit = context.log;

    const actorOf = (request: FastifyRequest): Actor => {
        const session = provider.sessionOf(request);
        if (!session) throw new AccountError(401, 'Authentication required');
        return { id: session.user.id, username: session.user.username };
    };

    const loginPage = (options: { error?: string; username?: string; next: string; notice?: string }) => renderShell(null, {
        title: 'Sign in', bare: true, bodyClass: 'page-auth', mainClass: 'auth-shell',
        main: authCard('Sign in', 'Dashboard', 'Use the account an admin created for you.', `${options.notice ? `<div class="banner ok" role="status"><strong>${escapeHtml(options.notice)}</strong></div>` : ''}${options.error ? `<div class="banner err" role="alert"><strong>${escapeHtml(options.error)}</strong></div>` : ''}<form class="auth-form" method="post" action="${LOGIN_PATH}"><input type="hidden" name="next" value="${escapeHtml(options.next)}"><div class="field"><label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus value="${escapeHtml(options.username ?? '')}"></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required></div><div class="form-actions"><button class="button primary" type="submit">Sign in</button></div></form>`),
    });

    const passwordPage = (request: FastifyRequest, options: { error?: string; mustChange: boolean }) => renderShell(request, {
        title: 'Change password', bare: options.mustChange, bodyClass: 'page-auth', mainClass: 'auth-shell',
        main: authCard(options.mustChange ? 'Choose your password' : 'Change password', 'Your account',
            options.mustChange ? 'You signed in with a temporary password. Choose your own before you continue.' : 'Signing in elsewhere ends when the password changes.',
            `${options.error ? `<div class="banner err" role="alert"><strong>${escapeHtml(options.error)}</strong></div>` : ''}<form class="auth-form" method="post" action="${PASSWORD_PATH}"><div class="field"><label for="current-password">${options.mustChange ? 'Temporary password' : 'Current password'}</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="new-password">New password <span class="field-help">At least ${MIN_PASSWORD_LENGTH} characters. A short sentence is easy to remember.</span></label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="256" required></div><div class="field"><label for="confirm-password">Repeat new password</label><input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="256" required></div><div class="form-actions">${options.mustChange ? `<button class="button secondary" type="submit" form="password-logout">Log out</button>` : '<a class="button secondary" href="/">Cancel</a>'}<span class="spacer"></span><button class="button primary" type="submit">Save password</button></div></form>${options.mustChange ? `<form id="password-logout" method="post" action="${LOGOUT_PATH}" hidden></form>` : ''}`),
    });

    app.get<{ Querystring: { next?: string } }>(LOGIN_PATH, async (request, reply) => {
        const next = safeNextPath(request.query.next);
        if (await accounts.resolveSession(request.cookies?.[SESSION_COOKIE])) return reply.redirect(next);
        return reply.header('cache-control', 'no-store').type('text/html').send(loginPage({ next }));
    });

    app.post(LOGIN_PATH, async (request, reply) => {
        const body = request.body;
        const next = safeNextPath(field(body, 'next'));
        const ip = clientIp(request);
        const result = await accounts.login(field(body, 'username'), field(body, 'password'), {
            ip, userAgent: request.headers['user-agent'],
        });
        reply.header('cache-control', 'no-store');
        if (!result.ok) {
            // One message for unknown user, wrong password and disabled account.
            const throttled = result.reason === 'throttled';
            const message = throttled
                ? 'Too many sign-in attempts. Wait a few minutes, then try again.'
                : 'That username and password do not match an active account.';
            if (throttled) reply.header('retry-after', String(Math.ceil((result.retryAfterMs ?? 60_000) / 1000)));
            reply.code(throttled ? 429 : 401);
            if (wantsJson(request)) return reply.send({ error: message });
            const username = typeof field(body, 'username') === 'string' ? String(field(body, 'username')).slice(0, 64) : '';
            return reply.type('text/html').send(loginPage({ error: message, username, next }));
        }
        setSessionCookie(request, reply, result.token, Math.floor(accounts.absoluteTimeoutMs / 1000));
        const destination = result.user.mustChangePassword ? PASSWORD_PATH : next;
        if (wantsJson(request)) return reply.send({ ok: true, mustChangePassword: result.user.mustChangePassword });
        return reply.redirect(destination, 303);
    });

    app.post(LOGOUT_PATH, async (request, reply) => {
        await accounts.logout(request.cookies?.[SESSION_COOKIE], clientIp(request));
        clearSessionCookie(request, reply);
        reply.header('cache-control', 'no-store');
        if (wantsJson(request)) return reply.send({ ok: true });
        return reply.redirect(LOGIN_PATH, 303);
    });

    app.get(PASSWORD_PATH, async (request, reply) => {
        const session = provider.sessionOf(request);
        if (!session) return reply.redirect(LOGIN_PATH);
        return reply.header('cache-control', 'no-store').type('text/html')
            .send(passwordPage(request, { mustChange: session.user.mustChangePassword }));
    });

    app.post(PASSWORD_PATH, async (request, reply) => {
        const session = provider.sessionOf(request);
        if (!session) return reply.code(401).send({ error: 'Authentication required' });
        const body = request.body;
        const mustChange = session.user.mustChangePassword;
        try {
            if (field(body, 'newPassword') !== field(body, 'confirmPassword')) throw new AccountError(400, 'The two new passwords do not match.');
            await accounts.changePassword(session.user.id, session.session.id, field(body, 'currentPassword'), field(body, 'newPassword'));
        } catch (error) {
            if (!(error instanceof AccountError)) throw error;
            reply.code(error.statusCode);
            if (wantsJson(request)) return reply.send({ error: error.message });
            return reply.type('text/html').send(passwordPage(request, { error: error.message, mustChange }));
        }
        if (wantsJson(request)) return reply.send({ ok: true });
        return reply.redirect('/', 303);
    });

    app.get('/api/me', async (request, reply) => {
        const session = provider.sessionOf(request);
        if (!session) return reply.code(401).send({ error: 'Authentication required' });
        const { id, username, displayName, role, mustChangePassword, tenantId } = session.user;
        return { id, username, displayName, role, tenantId, mustChangePassword };
    });

    // ---------- Team panel (tenant admins and platform staff, through the route table) ----------
    // A tenant admin always gets their own tenant. Platform staff pick one with
    // ?tenant=<id> (default: the default tenant), or ?tenant=platform for the
    // platform accounts themselves.

    /** The tenant a Team request names: an id, null for the platform accounts, undefined for the default. */
    const requestedTenant = (request: FastifyRequest): string | null | undefined => {
        const value = (request.query as { tenant?: unknown } | undefined)?.tenant;
        if (value === 'platform') return null;
        return typeof value === 'string' && value ? value : undefined;
    };

    app.get('/team', async (request, reply) => {
        const actor = actorOf(request);
        const requested = requestedTenant(request);
        const team = await accounts.team(actor, requested);
        const scope = requested === null ? null : await accounts.scopeTenant(actor, requested);
        const devices = (await context.loadDevices()).filter((device) => device.tenantId === scope);
        const access = context.accessOf(request);
        const tenants = provider.tenants ? await provider.tenants.list() : [];
        const shown = scope === null ? null : tenants.find(({ id }) => id === scope);
        return reply.header('cache-control', 'no-store').type('text/html').send(renderShell(request, {
            title: 'Team', current: '/team', bodyClass: 'page-team', scripts: ['team.js'],
            main: renderTeamMain(team, devices, actor.id, {
                ...(shown !== undefined ? { tenant: shown } : {}),
                ...(access.platform ? { tenants } : {}),
            }),
        }));
    });

    app.get('/api/team', async (request) => accounts.team(actorOf(request), requestedTenant(request)));

    app.post('/api/team/users', async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const tenantId = body.tenantId ?? requestedTenant(request) ?? undefined;
        const created = await accounts.createUser(actorOf(request), { ...body, username: body.username, tenantId });
        // The temporary password is in this one response and nowhere else.
        return reply.code(201).header('cache-control', 'no-store').send(created);
    });

    app.patch<{ Params: { id: string } }>('/api/team/users/:id', async (request) =>
        accounts.updateUser(actorOf(request), request.params.id, (request.body ?? {}) as Record<string, unknown>));

    app.delete<{ Params: { id: string } }>('/api/team/users/:id', async (request, reply) => {
        await accounts.deleteUser(actorOf(request), request.params.id);
        return reply.code(204).send();
    });

    app.post<{ Params: { id: string } }>('/api/team/users/:id/reset-password', async (request, reply) => {
        const reset = await accounts.resetPassword(actorOf(request), request.params.id);
        return reply.header('cache-control', 'no-store').send(reset);
    });

    app.post('/api/team/groups', async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const tenantId = body.tenantId ?? requestedTenant(request) ?? undefined;
        return reply.code(201).send(await accounts.createGroup(actorOf(request), { ...body, tenantId }));
    });

    app.patch<{ Params: { id: string } }>('/api/team/groups/:id', async (request) =>
        accounts.updateGroup(actorOf(request), request.params.id, (request.body ?? {}) as Record<string, unknown>));

    app.delete<{ Params: { id: string } }>('/api/team/groups/:id', async (request, reply) => {
        await accounts.deleteGroup(actorOf(request), request.params.id);
        return reply.code(204).send();
    });

    app.post<{ Params: { id: string } }>('/api/team/groups/:id/members', async (request, reply) => {
        await accounts.addMember(actorOf(request), request.params.id, field(request.body, 'userId'));
        return reply.code(204).send();
    });

    app.delete<{ Params: { id: string; userId: string } }>('/api/team/groups/:id/members/:userId', async (request, reply) => {
        await accounts.removeMember(actorOf(request), request.params.id, request.params.userId);
        return reply.code(204).send();
    });

    app.post('/api/team/grants', async (request, reply) =>
        reply.code(201).send(await accounts.createGrant(actorOf(request), (request.body ?? {}) as Record<string, unknown>)));

    app.delete<{ Params: { id: string } }>('/api/team/grants/:id', async (request, reply) => {
        await accounts.deleteGrant(actorOf(request), request.params.id);
        return reply.code(204).send();
    });

    // ---------- audit log (tenant admins: their tenant; platform staff: all, or ?tenant=) ----------

    const auditQuery = (request: FastifyRequest, csv: boolean) => {
        const access = context.accessOf(request);
        const query = (request.query ?? {}) as Record<string, unknown>;
        const limit = Number(query.limit);
        const before = Number(query.before);
        const tenant = query.tenant;
        return {
            // A tenant admin always gets their own tenant, whatever they ask for.
            tenantId: access.platform ? (tenant === 'platform' ? null : typeof tenant === 'string' && tenant ? tenant : undefined) : access.tenantId ?? '',
            limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, csv ? 10_000 : 500) : csv ? 10_000 : 100,
            ...(Number.isSafeInteger(before) && before > 0 ? { before } : {}),
        };
    };
    const readAudit = async (request: FastifyRequest, csv: boolean) => {
        const query = auditQuery(request, csv);
        const entries = context.auditLog ? await context.auditLog.list(query) : [];
        return { query, entries, nextBefore: entries.length === query.limit ? entries.at(-1)!.id : null };
    };

    app.get('/api/audit', async (request, reply) => {
        const csv = (request.query as { format?: unknown } | undefined)?.format === 'csv';
        const { entries, nextBefore } = await readAudit(request, csv);
        reply.header('cache-control', 'no-store');
        if (!csv) return reply.send({ entries, nextBefore });
        const day = new Date().toISOString().slice(0, 10);
        return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="audit-${day}.csv"`).send(auditCsv(entries));
    });

    app.get('/audit', async (request, reply) => {
        const access = context.accessOf(request);
        const { query, entries, nextBefore } = await readAudit(request, false);
        const [users, tenants] = await Promise.all([
            accounts.store.listUsers(access.platform ? undefined : access.tenantId ?? ''),
            access.platform && provider.tenants ? provider.tenants.list() : Promise.resolve([]),
        ]);
        const keep = new URLSearchParams();
        if (typeof query.tenantId === 'string') keep.set('tenant', query.tenantId);
        else if (query.tenantId === null) keep.set('tenant', 'platform');
        const older = nextBefore ? new URLSearchParams(keep) : null;
        older?.set('before', String(nextBefore));
        const csv = new URLSearchParams(keep);
        csv.set('format', 'csv');
        return reply.header('cache-control', 'no-store').type('text/html').send(renderShell(request, {
            title: 'Audit log', current: '/audit', bodyClass: 'page-team',
            main: renderAuditMain(entries, {
                names: new Map(users.map((user) => [user.id, user.username])),
                tenants: new Map(tenants.map((tenant) => [tenant.id, tenant.slug])),
                showTenant: access.platform, olderHref: older ? `/audit?${older}` : null, csvHref: `/api/audit?${csv}`,
            }),
        }));
    });

    // ---------- tenants (platform staff only, through the route table) ----------

    const tenantService = provider.tenants;
    const tenantStats = async (): Promise<Map<string, TenantStats>> => {
        const [devices, users] = await Promise.all([context.loadDevices(), accounts.store.listUsers()]);
        const stats = new Map<string, TenantStats>();
        const entry = (id: string) => stats.get(id) ?? (stats.set(id, { phones: 0, users: 0 }), stats.get(id)!);
        for (const device of devices) entry(device.tenantId).phones += 1;
        for (const user of users) if (user.tenantId) entry(user.tenantId).users += 1;
        return stats;
    };
    const tenantsPanel = async (notice?: { ok: boolean; message: string }) => {
        const [tenants, stats, devices] = await Promise.all([tenantService!.list(), tenantStats(), context.loadDevices()]);
        return renderTenantsPanel(tenants, stats, devices, notice);
    };
    /** Forms post fields; API clients post { quotas }. Empty fields mean the deployment default. */
    const quotasFrom = (body: Record<string, unknown>) => {
        if (body.quotas !== undefined) return body.quotas;
        const mb = body.maxUploadMb;
        const fromForm = {
            ...(body.maxPhones !== undefined ? { maxPhones: body.maxPhones } : {}),
            ...(body.maxUsers !== undefined ? { maxUsers: body.maxUsers } : {}),
            ...(mb !== undefined ? { maxUploadBytes: mb === '' || mb === null ? null : Number(mb) * 1024 ** 2 } : {}),
        };
        return Object.keys(fromForm).length ? fromForm : undefined;
    };
    /** htmx gets the re-rendered panel (errors as a banner); API clients get JSON and the real status. */
    const tenantAction = async (request: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status: number; json: unknown; message: string }>) => {
        if (!tenantService) return reply.code(404).send({ error: 'Tenants are not configured' });
        const htmx = Boolean(request.headers['hx-request']);
        try {
            const result = await run();
            if (htmx) return reply.type('text/html').send(await tenantsPanel({ ok: true, message: result.message }));
            return reply.code(result.status).send(result.json);
        } catch (error) {
            if (!(error instanceof AccountError)) throw error;
            if (htmx) return reply.type('text/html').send(await tenantsPanel({ ok: false, message: error.message }));
            return reply.code(error.statusCode).send({ error: error.message });
        }
    };

    app.get('/tenants', async (request, reply) => {
        if (!tenantService) return reply.code(404).send({ error: 'Tenants are not configured' });
        return reply.header('cache-control', 'no-store').type('text/html').send(renderShell(request, {
            title: 'Organisations', current: '/tenants', bodyClass: 'page-team', htmx: true,
            main: `<header class="page-header"><div><span class="eyebrow">Platform</span><h1>Organisations</h1><p>Each organisation (tenant) has its own phones, people, schedules and media, and never sees another's. Phones not assigned to anyone belong to the default organisation.</p></div></header>${await tenantsPanel()}`,
        }));
    });

    app.get('/api/tenants', async (_request, reply) => {
        if (!tenantService) return reply.code(404).send({ error: 'Tenants are not configured' });
        const [tenants, stats] = await Promise.all([tenantService.list(), tenantStats()]);
        return { tenants: tenants.map((tenant) => ({ ...tenant, ...(stats.get(tenant.id) ?? { phones: 0, users: 0 }) })) };
    });

    app.post('/api/tenants', async (request, reply) => tenantAction(request, reply, async () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const tenant = await tenantService!.create(actorOf(request), { slug: body.slug, name: body.name, quotas: quotasFrom(body) });
        return { status: 201, json: tenant, message: `Added ${tenant.name}.` };
    }));

    app.patch<{ Params: { id: string } }>('/api/tenants/:id', async (request, reply) => tenantAction(request, reply, async () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const tenant = await tenantService!.update(actorOf(request), request.params.id, { name: body.name, status: body.status, quotas: quotasFrom(body) });
        return { status: 200, json: tenant, message: `${tenant.name} is ${tenant.status}.` };
    }));

    app.post('/api/tenant-devices', async (request, reply) => tenantAction(request, reply, async () => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const devices = await context.loadDevices();
        const device = typeof body.udid === 'string' ? devices.find(({ udid }) => udid === body.udid) : undefined;
        if (!device) throw new AccountError(404, 'Device not found');
        if (await context.scheduler.activeExecution(device.udid)) throw new AccountError(409, 'Stop the running automation before moving this phone');
        const { tenant } = await tenantService!.assignDevice(actorOf(request), device.udid, body.tenantId, devices.map(({ udid }) => udid));
        // The old owner's schedules must not keep running on a phone that is no longer theirs.
        let cancelled = 0;
        for (const schedule of await context.scheduler.listSchedules(500, device.udid, null)) {
            if (schedule.tenantId !== tenant.id && !['cancelled', 'completed'].includes(schedule.status)) {
                await context.scheduler.setScheduleStatus(schedule.id, 'cancelled');
                cancelled += 1;
            }
        }
        return {
            status: 200, json: { udid: device.udid, tenantId: tenant.id, cancelledSchedules: cancelled },
            message: `${device.name} now belongs to ${tenant.name}${cancelled ? `; ${cancelled} old ${cancelled === 1 ? 'schedule was' : 'schedules were'} cancelled` : ''}.`,
        };
    }));
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_DEVICES, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';
import { twoTenantFarm } from './tenant-support.js';

await useDevicesFile(TEST_DEVICES);
const { hashPassword } = await import('../src/auth/password.js');
const { auditCsv, auditRetentionDays, csvCell, pruneAuditLog } = await import('../src/auth/audit.js');

test('every state-changing request leaves one row: who, route pattern, target, outcome, request id — never the body', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const rows = () => farm.auditLog.entries.filter(({ event }) => event !== 'http' || true);
    const before = rows().length;
    // A read is not audited.
    await inject(farm.app, { method: 'GET', url: '/api/devices', cookies: farm.acme.cookies.operator });
    assert.equal(rows().length, before);

    const response = await inject(farm.app, {
        method: 'POST', url: '/api/devices/udid-r2-mini/remote/action', cookies: farm.acme.cookies.operator,
        payload: { type: 'tap', x: 4242, y: 5353, text: 'hunter2-secret' },
    });
    assert.equal(response.statusCode, 200);
    const row = farm.auditLog.entries.at(-1)!;
    assert.equal(row.event, 'remote.action');
    assert.equal(row.detail, 'action=tap');
    assert.equal(row.route, '/api/devices/:udid/remote/action');
    assert.equal(row.method, 'POST');
    assert.equal(row.targetUdid, 'udid-r2-mini');
    assert.equal(row.status, 200);
    assert.equal(row.actorUserId, farm.acme.operator.id);
    assert.equal(row.actorRole, 'operator');
    assert.equal(row.tenantId, farm.acme.tenantId);
    assert.equal(row.requestId, response.headers['x-request-id']);
    assert.match(row.requestId!, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(row).includes('hunter2') && !JSON.stringify(row).includes('5353'), 'no body values');

    // Refusals are recorded too, with their status.
    await inject(farm.app, { method: 'PATCH', url: '/api/devices/udid-r1-mini', cookies: farm.acme.cookies.admin, payload: { passcode: '98765' } });
    const refused = farm.auditLog.entries.at(-1)!;
    assert.equal(refused.status, 404);
    assert.equal(refused.route, '/api/devices/:udid');
    assert.ok(!JSON.stringify(farm.auditLog.entries).includes('98765'), 'a passcode never reaches the log');

    // A cross-site form post is blocked before anyone is known, and still recorded.
    await farm.app.inject({ method: 'POST', url: '/api/schedules/s-acme/pause', headers: { origin: 'https://evil.example' }, cookies: farm.acme.cookies.admin });
    const blocked = farm.auditLog.entries.at(-1)!;
    assert.equal(blocked.status, 403);
    assert.equal(blocked.actorUserId, null);
});

test('sign-ins, sign-outs and Team changes are recorded as account events, without secrets', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    const password = 'correct horse battery';
    await farm.store.updateUser(farm.acme.admin.id, { passwordHash: await hashPassword(password) });
    const login = (secret: string) => inject(farm.app, {
        method: 'POST', url: '/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ username: 'acme-admin', password: secret }).toString(),
    });
    await login('wrong guess 123456');
    await login(password);
    const events = farm.auditLog.entries.map(({ event }) => event);
    assert.ok(events.includes('login.failure') && events.includes('login.success'));
    const success = farm.auditLog.entries.find(({ event }) => event === 'login.success')!;
    assert.equal(success.actorUserId, farm.acme.admin.id);
    assert.equal(success.tenantId, farm.acme.tenantId);
    const serialized = JSON.stringify(farm.auditLog.entries);
    assert.ok(!serialized.includes(password) && !serialized.includes('wrong guess'), 'no password, right or wrong');

    const created = await inject(farm.app, { method: 'POST', url: '/api/team/users', cookies: farm.acme.cookies.admin, payload: { username: 'newbie' } });
    const temporary = created.json().temporaryPassword as string;
    const userCreated = farm.auditLog.entries.find(({ event }) => event === 'user.created')!;
    assert.equal(userCreated.tenantId, farm.acme.tenantId);
    assert.match(userCreated.detail!, /target=newbie/);
    assert.ok(!JSON.stringify(farm.auditLog.entries).includes(temporary), 'a temporary password never reaches the log');
    const grant = await inject(farm.app, {
        method: 'POST', url: '/api/team/grants', cookies: farm.acme.cookies.admin,
        payload: { subjectType: 'user', subjectId: created.json().user.id, scopeType: 'all', level: 'view' },
    });
    assert.equal(grant.statusCode, 201);
    assert.ok(farm.auditLog.entries.some(({ event, tenantId }) => event === 'grant.created' && tenantId === farm.acme.tenantId));
});

test('the audit view: platform sees every tenant, a tenant admin only theirs, an operator nothing', async (context) => {
    const farm = await twoTenantFarm();
    context.after(() => farm.app.close());
    // Platform staff act on an Acme phone: the row is Acme's, so Acme's admin can see it.
    await inject(farm.app, { method: 'POST', url: '/api/devices/udid-r2-mini/reconnect', cookies: farm.platformCookie, payload: {} });
    await inject(farm.app, { method: 'POST', url: '/api/schedules/s-bel/pause', cookies: farm.beloura.cookies.operator, payload: {} });
    const read = (cookies: Record<string, string>, query = '') => inject(farm.app, { method: 'GET', url: `/api/audit${query}`, cookies });
    const acme = (await read(farm.acme.cookies.admin, `?tenant=${farm.beloura.tenantId}`)).json() as { entries: Array<{ tenantId: string; route: string; actorUserId: string }> };
    assert.ok(acme.entries.length > 0);
    assert.ok(acme.entries.every(({ tenantId }) => tenantId === farm.acme.tenantId), 'asking for another tenant changes nothing');
    assert.ok(acme.entries.some(({ route, actorUserId }) => route === '/api/devices/:udid/reconnect' && actorUserId === farm.platform.id));
    const all = (await read(farm.platformCookie)).json() as { entries: Array<{ tenantId: string }> };
    assert.ok(all.entries.some(({ tenantId }) => tenantId === farm.beloura.tenantId) && all.entries.some(({ tenantId }) => tenantId === farm.acme.tenantId));
    const onlyBeloura = (await read(farm.platformCookie, `?tenant=${farm.beloura.tenantId}`)).json() as { entries: Array<{ tenantId: string }> };
    assert.ok(onlyBeloura.entries.every(({ tenantId }) => tenantId === farm.beloura.tenantId));
    assert.equal((await read(farm.acme.cookies.operator)).statusCode, 403);
    assert.equal((await inject(farm.app, { method: 'GET', url: '/audit', cookies: farm.acme.cookies.operator, headers: { accept: 'text/html' } })).statusCode, 403);

    // Keyset pagination.
    const first = (await read(farm.platformCookie, '?limit=1')).json() as { entries: Array<{ id: number }>; nextBefore: number };
    assert.equal(first.entries.length, 1);
    const second = (await read(farm.platformCookie, `?limit=1&before=${first.nextBefore}`)).json() as { entries: Array<{ id: number }> };
    assert.ok(second.entries[0]!.id < first.entries[0]!.id);

    // CSV export.
    const csv = await read(farm.acme.cookies.admin, '?format=csv');
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /^text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.match(csv.body, /^id,at,tenantId,actorUserId,actorRole,ip,method,route,event,targetUdid,targetIds,status,requestId,detail\r\n/);
    assert.ok(!csv.body.includes(farm.beloura.tenantId));

    // The page escapes what it shows.
    await inject(farm.app, { method: 'POST', url: '/api/team/groups', cookies: farm.acme.cookies.admin, payload: { name: '<script>alert(1)</script>' } });
    const page = await inject(farm.app, { method: 'GET', url: '/audit', cookies: farm.acme.cookies.admin });
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /<script>alert/);
    assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page.body, /<a class="nav-link" href="\/audit" aria-current="page">Audit<\/a>/);
});

test('CSV cells cannot smuggle a spreadsheet formula, and quote what needs quoting', () => {
    assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('-2'), "'-2");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(['x', 'y']), 'x y');
    assert.equal(csvCell(new Date(0)), '1970-01-01T00:00:00.000Z');
    assert.equal(auditCsv([]).split('\r\n')[0], 'id,at,tenantId,actorUserId,actorRole,ip,method,route,event,targetUdid,targetIds,status,requestId,detail');
});

test('retention: PHONE_FARM_AUDIT_RETENTION_DAYS, default 365, never under 30, 0 keeps everything', async () => {
    assert.equal(auditRetentionDays({}), 365);
    assert.equal(auditRetentionDays({ PHONE_FARM_AUDIT_RETENTION_DAYS: '90' }), 90);
    assert.equal(auditRetentionDays({ PHONE_FARM_AUDIT_RETENTION_DAYS: '7' }), 30, 'the database refuses younger deletes anyway');
    assert.equal(auditRetentionDays({ PHONE_FARM_AUDIT_RETENTION_DAYS: '0' }), null);
    assert.equal(auditRetentionDays({ PHONE_FARM_AUDIT_RETENTION_DAYS: 'forever' }), 365);
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
        async query(text: string, values?: unknown[]) {
            queries.push({ text, values });
            return text.includes('to_regclass') ? { rows: [{ present: 'auth.audit_log' }] } : { rows: [], rowCount: 4 };
        },
    };
    assert.equal(await pruneAuditLog(pool as never, 90), 4);
    assert.deepEqual(queries.at(-1), { text: 'delete from auth.audit_log where at < now() - make_interval(days => $1)', values: [90] });
    assert.equal(await pruneAuditLog(pool as never, null), 0);
});

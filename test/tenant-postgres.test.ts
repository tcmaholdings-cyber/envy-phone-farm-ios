import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createDatabaseConnection } from '../src/database/client.js';
import { PgAuditLog } from '../src/auth/audit.js';
import { PgAuthStore, PgTenantStore } from '../src/auth/pg-store.js';
import { PluginRegistry } from '../src/registry.js';
import { SchedulerRepository, UploadQuotaError } from '../src/scheduler/repository.js';
import { DEFAULT_TENANT_ID } from '../src/tenancy.js';

/**
 * Opt-in: runs only with PHONE_FARM_TEST_DATABASE_URL pointing at a migrated,
 * disposable database (never production). It creates a tenant named
 * `test-<random>` and removes what it can afterwards; audit rows stay, since
 * the database refuses to delete them (that is the point). CI does not set it.
 */
const url = process.env.PHONE_FARM_TEST_DATABASE_URL;

test('real Postgres: tenant-scoped accounts, phones, schedules, media and the append-only audit log', { skip: !url }, async (context) => {
    const connection = createDatabaseConnection(url);
    const suffix = crypto.randomBytes(4).toString('hex');
    const udid = `test-${suffix}-phone`;
    const auth = new PgAuthStore(connection);
    const tenants = new PgTenantStore(connection);
    // No queue: only paths that never enqueue are exercised.
    const repository = new SchedulerRepository(connection, {} as never, new PluginRegistry([]));
    const tenant = await tenants.createTenant({ slug: `test-${suffix}`, name: 'Test tenant', quotas: { maxUploadBytes: 100 } });
    context.after(async () => {
        const pool = connection.pool;
        await pool.query('delete from scheduler.executions where tenant_id = $1', [tenant.id]);
        await pool.query('delete from scheduler.schedules where tenant_id = $1', [tenant.id]);
        await pool.query('delete from scheduler.assets where tenant_id = $1', [tenant.id]);
        await pool.query('delete from auth.users where tenant_id = $1', [tenant.id]);
        await pool.query('delete from auth.groups where tenant_id = $1', [tenant.id]);
        await pool.query('delete from auth.tenant_devices where tenant_id = $1', [tenant.id]);
        await pool.query('delete from auth.tenants where id = $1', [tenant.id]);
        await connection.close();
    });

    // Accounts: listings are filtered in SQL.
    await assert.rejects(tenants.createTenant({ slug: `test-${suffix}`, name: 'again', quotas: {} }), /already taken/);
    const operator = await auth.createUser({ username: `test-${suffix}-va`, tenantId: tenant.id, displayName: 'VA', role: 'operator', passwordHash: 'x', mustChangePassword: false });
    const group = await auth.createGroup({ tenantId: tenant.id, name: 'night', description: '' });
    await auth.addMember(group.id, operator.id);
    await auth.createGrant({ userId: operator.id, groupId: null, scopeType: 'all', scopeValue: null, level: 'view' });
    assert.deepEqual((await auth.listUsers(tenant.id)).map(({ username }) => username), [`test-${suffix}-va`]);
    assert.ok((await auth.listUsers(null)).every(({ role, tenantId }) => role === 'platform' && tenantId === null));
    assert.ok(!(await auth.listUsers(DEFAULT_TENANT_ID)).some(({ id }) => id === operator.id));
    assert.equal((await auth.listMemberships(tenant.id)).length, 1);
    assert.ok(!(await auth.listMemberships(DEFAULT_TENANT_ID)).some(({ userId }) => userId === operator.id));
    assert.equal((await auth.listGrants(tenant.id)).length, 1);
    assert.ok(!(await auth.listGrants(DEFAULT_TENANT_ID)).some(({ userId }) => userId === operator.id));
    assert.equal(await auth.userById('not-a-uuid'), null);
    assert.equal(await tenants.countUsers(tenant.id), 1);
    await assert.rejects(connection.pool.query(
        `insert into auth.users (username, display_name, role, password_hash, tenant_id) values ($1, 'x', 'platform', 'x', $2)`, [`test-${suffix}-bad`, tenant.id],
    ), /users_tenant_matches_role/, 'platform staff never belong to a tenant');

    // Phones: an explicit owner, else the default tenant.
    assert.equal(await repository.tenantForDevice(udid), DEFAULT_TENANT_ID);
    await tenants.assignDevice(udid, tenant.id);
    await tenants.assignDevice(udid, tenant.id);
    assert.equal(await repository.tenantForDevice(udid), tenant.id);
    assert.equal((await tenants.deviceAssignments()).get(udid), tenant.id);

    // Media: owned, budgeted, deleted only within the tenant.
    const [asset] = await repository.registerAssets([{ relativePath: `uploads/test-${suffix}-a`, originalName: 'a', mimeType: 'video/mp4', size: 60, sha256: 'x' }], { deviceUdid: udid });
    await assert.rejects(repository.registerAssets([{ relativePath: `uploads/test-${suffix}-b`, originalName: 'b', mimeType: 'video/mp4', size: 60, sha256: 'x' }], { tenantId: tenant.id }), UploadQuotaError);
    assert.deepEqual(await repository.uploadUsage(tenant.id), { usedBytes: 60, budgetBytes: 100 });
    assert.equal(await repository.deleteAssets([asset!.id], DEFAULT_TENANT_ID), false);
    assert.equal(await repository.deleteAssets(['nope'], tenant.id), false);

    // Schedules: a phone's rows are its current owner's; a suspended tenant's are not queued.
    const due = new Date(Date.now() - 60_000);
    const inserted = await connection.pool.query<{ id: string }>(
        `insert into scheduler.schedules (tenant_id, device_udid, plugin_id, task_type, task_version, payload, timing, next_run_at)
         values ($1, $2, 'test.uninstalled', 'noop', 1, '{}', '{"kind":"once","runAt":"2026-01-01T00:00:00.000Z"}', $3) returning id`, [tenant.id, udid, due],
    );
    const scheduleId = inserted.rows[0]!.id;
    assert.equal((await repository.listSchedules(10, udid)).length, 1);
    assert.equal((await repository.listSchedules(10, udid, DEFAULT_TENANT_ID)).length, 0);
    assert.ok(await repository.schedule(scheduleId, tenant.id));
    assert.equal(await repository.schedule(scheduleId, DEFAULT_TENANT_ID), null);
    await tenants.assignDevice(udid, DEFAULT_TENANT_ID);
    assert.equal((await repository.listSchedules(10, udid)).length, 0, 'moved away: the old tenant\'s history does not follow the phone');
    assert.equal((await repository.listSchedules(10, udid, null)).length, 1);
    await tenants.updateTenant(tenant.id, { status: 'suspended' });
    await repository.materializeDue(new Date(), scheduleId);
    assert.equal((await repository.listExecutions(10, udid, tenant.id)).length, 0, 'suspended: nothing materialised');
    await tenants.updateTenant(tenant.id, { status: 'active' });
    await repository.materializeDue(new Date(), scheduleId);
    const [skipped] = await repository.listExecutions(10, udid, tenant.id);
    assert.equal(skipped?.status, 'skipped', 'an uninstalled task is recorded as skipped');
    assert.equal(skipped?.tenantId, tenant.id, 'the run inherits the schedule\'s tenant');

    // Audit: rows go in and come back per tenant; the database refuses edits and young deletes.
    const log = new PgAuditLog(connection);
    await log.record({
        tenantId: tenant.id, actorUserId: operator.id, actorRole: 'operator', ip: '127.0.0.1', method: 'POST', route: '/api/x/:id',
        event: 'http', targetUdid: udid, targetIds: ['a'], status: 200, requestId: crypto.randomUUID(), detail: null,
    });
    const [row] = await log.list({ tenantId: tenant.id, limit: 5 });
    assert.equal(row?.route, '/api/x/:id');
    assert.deepEqual(row?.targetIds, ['a']);
    assert.deepEqual(await log.list({ tenantId: 'not-a-uuid', limit: 5 }), []);
    await assert.rejects(connection.pool.query('update auth.audit_log set detail = $1 where id = $2', ['edited', row!.id]), /append-only/);
    await assert.rejects(connection.pool.query('delete from auth.audit_log where id = $1', [row!.id]), /append-only/);
    await assert.rejects(connection.pool.query('truncate auth.audit_log'), /append-only/);
});

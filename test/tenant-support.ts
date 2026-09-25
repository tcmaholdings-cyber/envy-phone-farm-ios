import crypto from 'node:crypto';

import { createAuthApp, DEFAULT_TENANT_ID, seedUser, sessionFor, type FakeExecution, type FakeSchedule } from './auth-support.js';

/**
 * Two tenants on one farm, for the isolation tests. Call `useDevicesFile(TEST_DEVICES)` first.
 *
 * - beloura (the default tenant): udid-r1-mini, udid-r1-se, udid-loose
 * - acme: udid-r2-mini
 *
 * Each tenant has an admin and an operator holding an `all`/operate grant (the
 * broadest an operator can get), a group, a grant, a schedule, an execution and
 * an uploaded asset. `history` is an acme execution left on a beloura phone —
 * a phone that moved between tenants.
 */
export async function twoTenantFarm() {
    const row = { pluginId: 'com.git-agni.tiktok', taskType: 'doomscroll', taskVersion: 1, payload: {}, createdAt: new Date(0) };
    const schedule = (id: string, deviceUdid: string, tenantId: string): FakeSchedule => ({
        ...row, id, deviceUdid, tenantId, status: 'active', timing: { kind: 'now' }, nextRunAt: null, runWindowMinutes: 30,
    });
    const execution = (id: string, deviceUdid: string, tenantId: string, status = 'failed'): FakeExecution => ({
        ...row, id, deviceUdid, tenantId, status, scheduledFor: new Date(0), error: null,
    });
    const acmeId = crypto.randomUUID();
    const harness = await createAuthApp({
        schedules: [schedule('s-bel', 'udid-r1-mini', DEFAULT_TENANT_ID), schedule('s-acme', 'udid-r2-mini', acmeId)],
        executions: [
            execution('e-bel', 'udid-r1-mini', DEFAULT_TENANT_ID), execution('e-acme', 'udid-r2-mini', acmeId),
            execution('e-history', 'udid-r1-se', acmeId),
        ],
    });
    const { store, tenantStore, scheduler } = harness;
    tenantStore.tenants.push({ id: acmeId, slug: 'acme', name: 'Acme', status: 'active', quotas: {}, createdAt: new Date(0) });
    await tenantStore.assignDevice('udid-r2-mini', acmeId);

    const platform = await seedUser(store, 'root', 'platform');
    const tenant = async (slug: string, tenantId: string, phone: string) => {
        const admin = await seedUser(store, `${slug}-admin`, 'admin', `${slug} admin`, tenantId);
        const operator = await seedUser(store, `${slug}-va`, 'operator', `${slug} VA`, tenantId);
        const group = await store.createGroup({ tenantId, name: `${slug} crew`, description: '' });
        await store.addMember(group.id, operator.id);
        const grant = await store.createGrant({ userId: operator.id, groupId: null, scopeType: 'all', scopeValue: null, level: 'operate' });
        const [asset] = await scheduler.registerAssets([{ relativePath: `uploads/${slug}`, size: 10 }], { tenantId });
        return {
            tenantId, phone, admin, operator, group, grant, asset: asset!,
            cookies: {
                admin: { pf_session: await sessionFor(store, admin.id) },
                operator: { pf_session: await sessionFor(store, operator.id) },
            },
        };
    };
    const beloura = await tenant('beloura', DEFAULT_TENANT_ID, 'udid-r1-mini');
    const acme = await tenant('acme', acmeId, 'udid-r2-mini');
    return {
        ...harness, platform, beloura, acme,
        platformCookie: { pf_session: await sessionFor(store, platform.id) },
        ids: {
            beloura: { schedule: 's-bel', execution: 'e-bel' },
            acme: { schedule: 's-acme', execution: 'e-acme', history: 'e-history' },
        },
    };
}

export type TwoTenantFarm = Awaited<ReturnType<typeof twoTenantFarm>>;
export type FarmTenant = TwoTenantFarm['beloura'];

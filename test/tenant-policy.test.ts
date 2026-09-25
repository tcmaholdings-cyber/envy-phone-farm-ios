import assert from 'node:assert/strict';
import test from 'node:test';

import { requestAccessFor } from '../src/auth/access.js';
import {
    assignableRoles, canManageTeam, canSeeTenant, effectiveLevel, hasAnyOperateGrant, isPlatform, isTenantAdmin,
    type PolicyDevice, type PolicyGrant, type PolicyUser,
} from '../src/auth/policy.js';

/**
 * The tenancy rules, exhaustively: every role against a resource of its own
 * tenant, of another tenant, and of no known tenant. "Can see" false is what
 * the dashboard turns into a 404 for phones, schedules, executions, assets,
 * users and groups alike.
 */

const A = 'tenant-a';
const B = 'tenant-b';

const users: Record<string, PolicyUser> = {
    platform: { id: 'p', role: 'platform', tenantId: null },
    adminA: { id: 'aa', role: 'admin', tenantId: A },
    operatorA: { id: 'oa', role: 'operator', tenantId: A },
    // Invalid rows the database refuses; the policy must still fail closed.
    adminWithoutTenant: { id: 'ax', role: 'admin', tenantId: null },
    operatorWithoutTenant: { id: 'ox', role: 'operator', tenantId: null },
};

// The operator holds the broadest grant there is: `all`, operate.
const grantsFor = (user: PolicyUser): PolicyGrant[] => [{ userId: user.id, scopeType: 'all', level: 'operate' }];

const tenants: Array<[label: string, tenantId: string | null | undefined]> = [['own', A], ['other', B], ['null', null], ['unknown', undefined]];

test('canSeeTenant: platform sees every tenant; a tenant user only their own; nobody without a tenant sees anything', () => {
    const expected: Record<string, Record<string, boolean>> = {
        platform: { own: true, other: true, null: true, unknown: true },
        adminA: { own: true, other: false, null: false, unknown: false },
        operatorA: { own: true, other: false, null: false, unknown: false },
        adminWithoutTenant: { own: false, other: false, null: false, unknown: false },
        operatorWithoutTenant: { own: false, other: false, null: false, unknown: false },
    };
    for (const [name, user] of Object.entries(users)) {
        for (const [label, tenantId] of tenants) {
            assert.equal(canSeeTenant(user, tenantId), expected[name]![label], `${name} → ${label}`);
            assert.equal(canSeeTenant({ ...user, disabled: true }, tenantId), false, `disabled ${name} → ${label}`);
        }
    }
    assert.equal(canSeeTenant(null, A), false);
    assert.equal(canSeeTenant(undefined, A), false);
});

test('effectiveLevel: another tenant\'s phone is unreachable whatever the grants; platform reaches all', () => {
    const phone = (tenantId: string | null | undefined): PolicyDevice => ({ udid: 'x', rack: '1', model: 'iPhone 12 mini', tenantId });
    const expected: Record<string, Record<string, 'operate' | 'view' | null>> = {
        platform: { own: 'operate', other: 'operate', null: 'operate', unknown: 'operate' },
        adminA: { own: 'operate', other: null, null: null, unknown: null },
        operatorA: { own: 'operate', other: null, null: null, unknown: null },
        adminWithoutTenant: { own: null, other: null, null: null, unknown: null },
        operatorWithoutTenant: { own: null, other: null, null: null, unknown: null },
    };
    for (const [name, user] of Object.entries(users)) {
        for (const [label, tenantId] of tenants) {
            assert.equal(effectiveLevel(user, [], grantsFor(user), phone(tenantId)), expected[name]![label], `${name} → ${label}`);
            assert.equal(effectiveLevel({ ...user, disabled: true }, [], grantsFor(user), phone(tenantId)), null);
        }
    }
    // Without a grant an operator reaches nothing even in their own tenant; an admin needs none.
    assert.equal(effectiveLevel(users.operatorA, [], [], phone(A)), null);
    assert.equal(effectiveLevel(users.adminA, [], [], phone(A)), 'operate');
    // A grant naming another tenant's phone by UDID does not reach it.
    assert.equal(effectiveLevel(users.operatorA, [], [{ userId: 'oa', scopeType: 'device', scopeValue: 'x', level: 'operate' }], phone(B)), null);
    // An unknown role is nothing.
    assert.equal(effectiveLevel({ id: 'r', role: 'root' as never, tenantId: A }, [], grantsFor({ id: 'r', role: 'operator' }), phone(A)), null);
});

test('canManageTeam: a tenant admin manages only their own tenant; operators never; platform everything', () => {
    const expected: Record<string, Record<string, boolean>> = {
        platform: { own: true, other: true, null: true, unknown: true },
        adminA: { own: true, other: false, null: false, unknown: false },
        operatorA: { own: false, other: false, null: false, unknown: false },
        adminWithoutTenant: { own: false, other: false, null: false, unknown: false },
        operatorWithoutTenant: { own: false, other: false, null: false, unknown: false },
    };
    for (const [name, user] of Object.entries(users)) {
        for (const [label, tenantId] of tenants) {
            assert.equal(canManageTeam(user, tenantId), expected[name]![label], `${name} → ${label}`);
        }
        assert.equal(canManageTeam({ ...user, disabled: true }, A), false);
    }
});

test('roles: who is platform, who is a tenant admin, and which roles each may hand out', () => {
    assert.equal(isPlatform(users.platform), true);
    assert.equal(isPlatform(users.adminA), false);
    assert.equal(isTenantAdmin(users.adminA), true);
    assert.equal(isTenantAdmin(users.adminWithoutTenant), false, 'an admin without a tenant is nobody\'s admin');
    assert.equal(isTenantAdmin(users.platform), false);
    assert.deepEqual([...assignableRoles(users.platform)], ['platform', 'admin', 'operator']);
    assert.deepEqual([...assignableRoles(users.adminA)], ['admin', 'operator'], 'a tenant admin cannot mint platform staff');
    assert.deepEqual([...assignableRoles(users.operatorA)], []);
    assert.deepEqual([...assignableRoles(users.adminWithoutTenant)], []);
    assert.deepEqual([...assignableRoles(null)], []);
});

test('hasAnyOperateGrant (uploads): platform and tenant admins yes; operators only with an operate grant and a tenant', () => {
    assert.equal(hasAnyOperateGrant(users.platform, [], []), true);
    assert.equal(hasAnyOperateGrant(users.adminA, [], []), true);
    assert.equal(hasAnyOperateGrant(users.adminWithoutTenant, [], []), false);
    assert.equal(hasAnyOperateGrant(users.operatorA, [], grantsFor(users.operatorA)), true);
    assert.equal(hasAnyOperateGrant(users.operatorWithoutTenant, [], grantsFor(users.operatorWithoutTenant)), false);
    assert.equal(hasAnyOperateGrant(users.operatorA, [], []), false);
});

test('request access carries the tenant and answers canSeeTenant for list and id checks', () => {
    const operator = requestAccessFor({
        id: 'oa', roles: ['operator'], access: { role: 'operator', tenantId: A, groupIds: [], grants: grantsFor(users.operatorA) },
    });
    assert.equal(operator.tenantId, A);
    assert.equal(operator.platform, false);
    assert.equal(operator.tenantAdmin, false);
    assert.equal(operator.canSeeTenant(A), true);
    assert.equal(operator.canSeeTenant(B), false);
    assert.equal(operator.levelFor({ udid: 'x', tenantId: B }), null);
    const admin = requestAccessFor({ id: 'aa', roles: ['admin'], access: { role: 'admin', tenantId: A, groupIds: [], grants: [] } });
    assert.equal(admin.tenantAdmin, true);
    assert.equal(admin.canSeeTenant(B), false);
    const platform = requestAccessFor({ id: 'p', roles: ['platform'], access: { role: 'platform', tenantId: null, groupIds: [], grants: [] } });
    assert.equal(platform.platform, true);
    assert.equal(platform.tenantId, null);
    assert.equal(platform.canSeeTenant(B), true);
    assert.equal(platform.levelFor({ udid: 'x', tenantId: B }), 'operate');
});

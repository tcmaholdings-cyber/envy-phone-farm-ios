import assert from 'node:assert/strict';
import test from 'node:test';

import { FULL_ACCESS, NO_ACCESS, requestAccessFor } from '../src/auth/access.js';
import {
    effectiveLevel, grantAppliesToUser, grantMatchesDevice, hasAnyOperateGrant, isPlatform, levelSatisfies, maxLevel,
    type PolicyDevice, type PolicyGrant, type PolicyUser,
} from '../src/auth/policy.js';

// Everything here lives in one tenant; test/tenant-policy.test.ts covers crossing tenants.
const T = 'tenant-1';
const operator: PolicyUser = { id: 'u1', role: 'operator', tenantId: T };
const admin: PolicyUser = { id: 'a1', role: 'platform', tenantId: null };
const phone: PolicyDevice = { udid: 'udid-1', rack: '1', model: 'iPhone 12 mini', tenantId: T };
const other: PolicyDevice = { udid: 'udid-2', rack: '2', model: 'iPhone SE (2nd generation)', tenantId: T };
const bare: PolicyDevice = { udid: 'udid-3', tenantId: T };

test('levels: operate satisfies view, view does not satisfy operate, nothing satisfies anything', () => {
    assert.equal(levelSatisfies('operate', 'view'), true);
    assert.equal(levelSatisfies('operate', 'operate'), true);
    assert.equal(levelSatisfies('view', 'view'), true);
    assert.equal(levelSatisfies('view', 'operate'), false);
    assert.equal(levelSatisfies(null, 'view'), false);
    assert.equal(levelSatisfies(undefined, 'view'), false);
    assert.equal(maxLevel(null, 'view'), 'view');
    assert.equal(maxLevel('operate', 'view'), 'operate');
    assert.equal(maxLevel('view', 'operate'), 'operate');
    assert.equal(maxLevel(null, null), null);
});

test('scope all matches every phone, including one with no rack or model', () => {
    const grant: PolicyGrant = { userId: 'u1', scopeType: 'all', scopeValue: null, level: 'view' };
    for (const device of [phone, other, bare]) assert.equal(grantMatchesDevice(grant, device), true);
});

test('scope rack matches the rack label, trimmed and case-insensitively, and never a phone without a rack', () => {
    assert.equal(grantMatchesDevice({ scopeType: 'rack', scopeValue: '1', level: 'view' }, phone), true);
    assert.equal(grantMatchesDevice({ scopeType: 'rack', scopeValue: ' 1 ', level: 'view' }, phone), true);
    assert.equal(grantMatchesDevice({ scopeType: 'rack', scopeValue: 'b', level: 'view' }, { udid: 'x', rack: 'B' }), true);
    assert.equal(grantMatchesDevice({ scopeType: 'rack', scopeValue: '1', level: 'view' }, other), false);
    assert.equal(grantMatchesDevice({ scopeType: 'rack', scopeValue: '', level: 'view' }, bare), false, 'an empty rack is not a wildcard');
    assert.equal(grantMatchesDevice({ scopeType: 'rack', scopeValue: null, level: 'view' }, bare), false);
});

test('scope model matches the model name, and never a phone whose model is unknown', () => {
    assert.equal(grantMatchesDevice({ scopeType: 'model', scopeValue: 'iphone 12 MINI', level: 'view' }, phone), true);
    assert.equal(grantMatchesDevice({ scopeType: 'model', scopeValue: 'iPhone 12', level: 'view' }, phone), false, 'no prefix matching');
    assert.equal(grantMatchesDevice({ scopeType: 'model', scopeValue: 'iPhone 12 mini', level: 'view' }, bare), false);
});

test('scope device matches the exact UDID only', () => {
    assert.equal(grantMatchesDevice({ scopeType: 'device', scopeValue: 'udid-1', level: 'view' }, phone), true);
    assert.equal(grantMatchesDevice({ scopeType: 'device', scopeValue: 'UDID-1', level: 'view' }, phone), false);
    assert.equal(grantMatchesDevice({ scopeType: 'device', scopeValue: null, level: 'view' }, phone), false);
});

test('an unknown scope type matches nothing', () => {
    assert.equal(grantMatchesDevice({ scopeType: 'everything' as never, scopeValue: null, level: 'view' }, phone), false);
});

test('a grant applies to its user, or to members of its group, and to nobody else', () => {
    assert.equal(grantAppliesToUser({ userId: 'u1', scopeType: 'all', level: 'view' }, 'u1', []), true);
    assert.equal(grantAppliesToUser({ userId: 'u2', scopeType: 'all', level: 'view' }, 'u1', ['g1']), false);
    assert.equal(grantAppliesToUser({ groupId: 'g1', scopeType: 'all', level: 'view' }, 'u1', ['g1']), true);
    assert.equal(grantAppliesToUser({ groupId: 'g2', scopeType: 'all', level: 'view' }, 'u1', ['g1']), false);
    assert.equal(grantAppliesToUser({ scopeType: 'all', level: 'view' }, 'u1', ['g1']), false, 'a subject-less grant applies to nobody');
});

test('an operator with no grants sees nothing', () => {
    assert.equal(effectiveLevel(operator, [], [], phone), null);
});

test('platform staff operate everything without grants; disabled platform staff get nothing', () => {
    assert.equal(effectiveLevel(admin, [], [], phone), 'operate');
    assert.equal(effectiveLevel(admin, [], [], bare), 'operate');
    assert.equal(effectiveLevel({ ...admin, disabled: true }, [], [], phone), null);
    assert.equal(isPlatform(admin), true);
    assert.equal(isPlatform({ ...admin, disabled: true }), false);
    assert.equal(isPlatform(operator), false);
    assert.equal(isPlatform(null), false);
});

test('a disabled or missing user gets nothing, whatever the grants say', () => {
    const grants: PolicyGrant[] = [{ userId: 'u1', scopeType: 'all', level: 'operate' }];
    assert.equal(effectiveLevel({ ...operator, disabled: true }, [], grants, phone), null);
    assert.equal(effectiveLevel(null, [], grants, phone), null);
    assert.equal(effectiveLevel(undefined, [], grants, phone), null);
});

test('each scope type grants its own phones and nothing else', () => {
    const cases: Array<[PolicyGrant, PolicyDevice[], PolicyDevice[]]> = [
        [{ userId: 'u1', scopeType: 'all', level: 'view' }, [phone, other, bare], []],
        [{ userId: 'u1', scopeType: 'rack', scopeValue: '2', level: 'view' }, [other], [phone, bare]],
        [{ userId: 'u1', scopeType: 'model', scopeValue: 'iPhone 12 mini', level: 'view' }, [phone], [other, bare]],
        [{ userId: 'u1', scopeType: 'device', scopeValue: 'udid-3', level: 'view' }, [bare], [phone, other]],
    ];
    for (const [grant, yes, no] of cases) {
        for (const device of yes) assert.equal(effectiveLevel(operator, [], [grant], device), 'view', `${grant.scopeType} → ${device.udid}`);
        for (const device of no) assert.equal(effectiveLevel(operator, [], [grant], device), null, `${grant.scopeType} ↛ ${device.udid}`);
    }
});

test('group grants are inherited only by members', () => {
    const grants: PolicyGrant[] = [{ groupId: 'night', scopeType: 'rack', scopeValue: '1', level: 'operate' }];
    assert.equal(effectiveLevel(operator, ['night'], grants, phone), 'operate');
    assert.equal(effectiveLevel(operator, ['day'], grants, phone), null);
    assert.equal(effectiveLevel(operator, [], grants, phone), null);
});

test('the effective level is the highest over own and group grants, in any order', () => {
    const view: PolicyGrant = { userId: 'u1', scopeType: 'all', level: 'view' };
    const operate: PolicyGrant = { groupId: 'g1', scopeType: 'device', scopeValue: 'udid-1', level: 'operate' };
    assert.equal(effectiveLevel(operator, ['g1'], [view, operate], phone), 'operate');
    assert.equal(effectiveLevel(operator, ['g1'], [operate, view], phone), 'operate');
    assert.equal(effectiveLevel(operator, ['g1'], [view, operate], other), 'view', 'the operate grant covers only udid-1');
    assert.equal(effectiveLevel(operator, [], [view, operate], phone), 'view', 'not in g1: only the own grant counts');
});

test("another user's grants never leak", () => {
    const grants: PolicyGrant[] = [{ userId: 'u2', scopeType: 'all', level: 'operate' }];
    assert.equal(effectiveLevel(operator, [], grants, phone), null);
});

test('a grant with an invalid level is ignored', () => {
    const grants = [{ userId: 'u1', scopeType: 'all', level: 'root' }] as unknown as PolicyGrant[];
    assert.equal(effectiveLevel(operator, [], grants, phone), null);
});

test('hasAnyOperateGrant: an operate grant of the user or a group, or an admin', () => {
    assert.equal(hasAnyOperateGrant(operator, [], [{ userId: 'u1', scopeType: 'all', level: 'view' }]), false);
    assert.equal(hasAnyOperateGrant(operator, ['g'], [{ groupId: 'g', scopeType: 'rack', scopeValue: '1', level: 'operate' }]), true);
    assert.equal(hasAnyOperateGrant(operator, [], [{ userId: 'u2', scopeType: 'all', level: 'operate' }]), false);
    assert.equal(hasAnyOperateGrant(admin, [], []), true);
    assert.equal(hasAnyOperateGrant({ ...operator, disabled: true }, [], [{ userId: 'u1', scopeType: 'all', level: 'operate' }]), false);
});

test('request access: no user sees nothing; no scoped access means everything (legacy providers); operators are scoped', () => {
    assert.equal(NO_ACCESS.levelFor(phone), null);
    assert.equal(FULL_ACCESS.levelFor(phone), 'operate');
    assert.equal(requestAccessFor(null).platform, false);
    const legacy = requestAccessFor({ id: 'x', roles: [] });
    assert.equal(legacy.platform, true);
    assert.equal(legacy.levelFor(bare), 'operate');
    const scoped = requestAccessFor({
        id: 'u1', roles: ['operator'],
        access: { role: 'operator', tenantId: T, groupIds: ['g1'], grants: [{ groupId: 'g1', scopeType: 'model', scopeValue: 'iPhone 12 mini', level: 'view' }] },
    });
    assert.equal(scoped.platform, false);
    assert.equal(scoped.tenantId, T);
    assert.equal(scoped.levelFor(phone), 'view');
    assert.equal(scoped.levelFor(other), null);
    assert.equal(scoped.anyOperate, false);
    // `admin` without a tenant is what a provider written before tenants meant: everything.
    assert.equal(requestAccessFor({ id: 'a', roles: ['admin'], access: { role: 'admin', groupIds: [], grants: [] } }).platform, true);
    assert.equal(requestAccessFor({ id: 'p', roles: ['platform'], access: { role: 'platform', groupIds: [], grants: [] } }).platform, true);
    const tenantAdmin = requestAccessFor({ id: 'a', roles: ['admin'], access: { role: 'admin', tenantId: T, groupIds: [], grants: [] } });
    assert.equal(tenantAdmin.platform, false);
    assert.equal(tenantAdmin.tenantAdmin, true);
    assert.equal(tenantAdmin.levelFor(phone), 'operate');
    assert.equal(tenantAdmin.levelFor({ ...phone, tenantId: 'tenant-2' }), null);
});

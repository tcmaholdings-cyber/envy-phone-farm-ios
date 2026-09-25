import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChildProcess } from 'node:child_process';

import { DeviceConnectionManager, supervisorEnvironment } from '../src/devices/connection-manager.js';
import { signingAuthArgs, signingTeamXctestrunKey, wdaBuildArgs, wdaLaunchArgs, xctestrunFor } from '../src/devices/wda/runner-args.js';

const env = { XCODE_ORG_ID: 'TEAM123456', WDA_BUNDLE_ID: 'com.example.wda' };

test('wdaLaunchArgs builds from the project with the Team by default', () => {
    const args = wdaLaunchArgs(env, 'udid-1', '/p/WebDriverAgent.xcodeproj');
    assert.deepEqual(args.slice(0, 7), [
        'test-without-building', '-project', '/p/WebDriverAgent.xcodeproj', '-scheme', 'WebDriverAgentRunner',
        '-destination', 'id=udid-1',
    ]);
    assert.ok(args.includes('DEVELOPMENT_TEAM=TEAM123456'));
    assert.throws(() => wdaLaunchArgs({}, 'udid-1', '/p'), /XCODE_ORG_ID is required/);
});

test('wdaLaunchArgs runs a copied build from WDA_XCTESTRUN without any signing settings', () => {
    const args = wdaLaunchArgs({ WDA_XCTESTRUN: '/w/WDA.xctestrun' }, 'udid-2', '/p');
    assert.deepEqual(args, ['test-without-building', '-xctestrun', '/w/WDA.xctestrun', '-destination', 'id=udid-2']);
});

test('a phone with a signing team launches that team\'s prebuilt WDA, falling back to WDA_XCTESTRUN', () => {
    const teams = { WDA_XCTESTRUN: '/w/default.xctestrun', WDA_XCTESTRUN_TEAMB00002: '/w/team-b.xctestrun', WDA_XCTESTRUN_ALIAS_X: '/w/alias.xctestrun' };
    assert.deepEqual(wdaLaunchArgs(teams, 'u', '/p', { signingTeam: 'teamb00002' }),
        ['test-without-building', '-xctestrun', '/w/team-b.xctestrun', '-destination', 'id=u']);
    assert.equal(xctestrunFor(teams, 'alias-x'), '/w/alias.xctestrun', 'non-token characters become _');
    assert.equal(xctestrunFor(teams, 'TEAMC00003'), '/w/default.xctestrun', 'no team build: the host default');
    assert.equal(xctestrunFor(teams), '/w/default.xctestrun');
    assert.equal(xctestrunFor({}, 'TEAMC00003'), undefined);
    assert.equal(signingTeamXctestrunKey(' teamb00002 '), 'WDA_XCTESTRUN_TEAMB00002');
});

test('without any prebuilt WDA the phone\'s team signs the project build instead of XCODE_ORG_ID', () => {
    const args = wdaLaunchArgs(env, 'u', '/p', { signingTeam: 'TEAMB00002' });
    assert.ok(args.includes('DEVELOPMENT_TEAM=TEAMB00002'));
    assert.ok(!args.includes('DEVELOPMENT_TEAM=TEAM123456'));
    assert.ok(wdaLaunchArgs(env, 'u', '/p', { signingTeam: '  ' }).includes('DEVELOPMENT_TEAM=TEAM123456'));
});

test('the supervisor environment carries the phone\'s team and never inherits another', () => {
    const inherited = { WDA_SIGNING_TEAM: 'LEAKED', WDA_LOCAL_PORT: '8100' };
    const withTeam = supervisorEnvironment({ udid: 'u', name: 'u', pluginData: {}, signingTeam: 'TEAMB00002', wdaLocalPort: 8105 }, inherited);
    assert.equal(withTeam.WDA_SIGNING_TEAM, 'TEAMB00002');
    assert.equal(withTeam.WDA_LOCAL_PORT, '8105');
    assert.equal(withTeam.IOS_UDID, 'u');
    assert.equal(supervisorEnvironment({ udid: 'v', name: 'v', pluginData: {} }, inherited).WDA_SIGNING_TEAM, '');
});

test('changing a phone\'s signing team relaunches its supervisor with the new team', async () => {
    let team: string | undefined = 'TEAMA00001';
    const launches: Array<string | undefined> = [];
    const killed: string[] = [];
    const manager = new DeviceConnectionManager({
        hostId: 'h',
        loadDevices: async () => [{ udid: 'u', name: 'u', pluginData: {}, ...(team ? { signingTeam: team } : {}) }],
        connectedUdids: async () => ['u'],
        endpointReady: async () => false,
        spawnSupervisor: (device) => {
            launches.push(device.signingTeam);
            const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
            const child = {
                exitCode: null as number | null, killed: false, stdout: null, stderr: null,
                once(event: string, callback: (...args: unknown[]) => void) { (handlers[event] ??= []).push(callback); },
                kill() {
                    child.killed = true; child.exitCode = 0; killed.push(device.udid);
                    setImmediate(() => handlers.exit?.forEach((fn) => fn(0, null)));
                },
            };
            return child as unknown as ChildProcess;
        },
        now: () => 0,
    });
    await manager.reconcile();
    await manager.reconcile();
    assert.deepEqual(launches, ['TEAMA00001'], 'an unchanged team does not relaunch');
    team = 'TEAMB00002';
    await manager.reconcile();
    assert.deepEqual(killed, ['u']);
    assert.deepEqual(launches, ['TEAMA00001', 'TEAMB00002']);
    team = undefined;
    await manager.reconcile();
    assert.deepEqual(launches, ['TEAMA00001', 'TEAMB00002', undefined]);
    await manager.close();
});

test('wdaBuildArgs signs for one device, or generically into a derived data folder', () => {
    const device = wdaBuildArgs({ ...env, ALLOW_PROVISIONING_DEVICE_REGISTRATION: 'true' }, '/p', { udid: 'u' });
    assert.ok(device.includes('-allowProvisioningDeviceRegistration'));
    assert.deepEqual(device.slice(device.indexOf('-destination'), device.indexOf('-destination') + 2), ['-destination', 'id=u']);

    const generic = wdaBuildArgs({ ...env, ALLOW_PROVISIONING_DEVICE_REGISTRATION: 'true' }, '/p', { generic: true, derivedDataPath: '/d' });
    assert.ok(!generic.includes('-allowProvisioningDeviceRegistration'), 'a generic build has no device to register');
    assert.ok(generic.includes('generic/platform=iOS'));
    assert.deepEqual(generic.slice(generic.indexOf('-derivedDataPath'), generic.indexOf('-derivedDataPath') + 2), ['-derivedDataPath', '/d']);
});

test('wdaBuildArgs signs with an App Store Connect API key when all three settings are set', () => {
    const key = { XCODE_AUTH_KEY_PATH: '/k/AuthKey_ABC.p8', XCODE_AUTH_KEY_ID: 'ABC', XCODE_AUTH_KEY_ISSUER_ID: 'issuer' };
    const args = wdaBuildArgs({ ...env, ...key }, '/p', { generic: true, derivedDataPath: '/d' });
    const at = args.indexOf('-authenticationKeyPath');
    assert.deepEqual(args.slice(at, at + 6), [
        '-authenticationKeyPath', '/k/AuthKey_ABC.p8', '-authenticationKeyID', 'ABC', '-authenticationKeyIssuerID', 'issuer',
    ]);
    assert.deepEqual(signingAuthArgs(env), [], 'no key configured: Xcode account signing as before');
    assert.throws(() => signingAuthArgs({ XCODE_AUTH_KEY_ID: 'ABC' }), /all of XCODE_AUTH_KEY_PATH/);
});

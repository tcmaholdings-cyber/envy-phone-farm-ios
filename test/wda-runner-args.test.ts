import assert from 'node:assert/strict';
import test from 'node:test';

import { wdaBuildArgs, wdaLaunchArgs } from '../src/devices/wda/runner-args.js';

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

test('wdaBuildArgs signs for one device, or generically into a derived data folder', () => {
    const device = wdaBuildArgs({ ...env, ALLOW_PROVISIONING_DEVICE_REGISTRATION: 'true' }, '/p', { udid: 'u' });
    assert.ok(device.includes('-allowProvisioningDeviceRegistration'));
    assert.deepEqual(device.slice(device.indexOf('-destination'), device.indexOf('-destination') + 2), ['-destination', 'id=u']);

    const generic = wdaBuildArgs({ ...env, ALLOW_PROVISIONING_DEVICE_REGISTRATION: 'true' }, '/p', { generic: true, derivedDataPath: '/d' });
    assert.ok(!generic.includes('-allowProvisioningDeviceRegistration'), 'a generic build has no device to register');
    assert.ok(generic.includes('generic/platform=iOS'));
    assert.deepEqual(generic.slice(generic.indexOf('-derivedDataPath'), generic.indexOf('-derivedDataPath') + 2), ['-derivedDataPath', '/d']);
});

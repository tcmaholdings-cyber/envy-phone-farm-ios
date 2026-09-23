import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CALIBRATABLE_POINTS, coordinatesForProfile, resolveDeviceCoordinates, validateCoordinateOverrides,
} from '../src/devices/coordinates.js';

test('resolveDeviceCoordinates applies single-tap overrides over the profile', () => {
    const base = coordinatesForProfile('iphone8');
    assert.equal(resolveDeviceCoordinates('iphone8', undefined), base);

    const resolved = resolveDeviceCoordinates('iphone8', { like: { x: 350, y: 320 } });
    assert.deepEqual(resolved.tiktok.like, { x: 350, y: 320 });
    assert.deepEqual(resolved.tiktok.save, base.tiktok.save, 'untouched points keep the profile value');
    assert.deepEqual(resolved.tiktok.picker, base.tiktok.picker, 'non-calibratable fields are untouched');
});

test('validateCoordinateOverrides enforces known keys, numbers and screen bounds', () => {
    assert.deepEqual(validateCoordinateOverrides({ like: { x: 10.6, y: 20.2 } }, 'iphone8'), { like: { x: 11, y: 20 } });
    assert.throws(() => validateCoordinateOverrides({ nope: { x: 1, y: 1 } }, 'iphone8'), /Unknown calibratable point/);
    assert.throws(() => validateCoordinateOverrides({ like: { x: 1, y: 999 } }, 'iphone8'), /outside the 375×667 screen/);
    assert.throws(() => validateCoordinateOverrides({ like: { x: 'a', y: 1 } }, 'iphone8'), /must be numbers/);
    assert.throws(() => validateCoordinateOverrides([], 'iphone8'), /must be an object/);
});

test('every calibratable point exists on the profile', () => {
    const tiktok = coordinatesForProfile('iphone8').tiktok;
    for (const name of CALIBRATABLE_POINTS) {
        const point = tiktok[name];
        assert.equal(typeof point.x, 'number', name);
        assert.equal(typeof point.y, 'number', name);
    }
});

test('the TikTok copy of every profile matches src/devices/coordinates.ts', async () => {
    const devices = await import('../src/devices/coordinates.js');
    const tiktok = await import('../src/tiktok/coordinates.js');
    assert.deepEqual(Object.keys(tiktok.DEVICE_COORDINATES), Object.keys(devices.DEVICE_COORDINATES));
    for (const [name, profile] of Object.entries(devices.DEVICE_COORDINATES)) {
        const copy = tiktok.coordinatesForProfile(name);
        assert.deepEqual(copy.passcodeKeypad, profile.passcodeKeypad, name);
        assert.deepEqual(copy.tiktok, profile.tiktok, name);
    }
});

test('X, XS, 12 mini, 13 mini and 13 resolve to a profile that fits their screen', async () => {
    const { modelNameForProductType, profileForProductType } = await import('../src/devices/coordinates.js');
    const expected: Array<[string, string, string, number, number]> = [
        ['iPhone10,3', 'iPhone X', 'iphoneX', 375, 812],
        ['iPhone10,6', 'iPhone X', 'iphoneX', 375, 812],
        ['iPhone11,2', 'iPhone XS', 'iphoneX', 375, 812],
        ['iPhone13,1', 'iPhone 12 mini', 'iphoneX', 375, 812],
        ['iPhone14,4', 'iPhone 13 mini', 'iphoneX', 375, 812],
        ['iPhone14,5', 'iPhone 13', 'iphone13', 390, 844],
        ['iPhone13,2', 'iPhone 12', 'iphone13', 390, 844],
        ['iPhone10,1', 'iPhone 8', 'iphone8', 375, 667],
        ['iPhone14,6', 'iPhone SE (3rd generation)', 'iphone8', 375, 667],
    ];
    for (const [productType, model, profile, width, height] of expected) {
        assert.equal(modelNameForProductType(productType), model, productType);
        assert.equal(profileForProductType(productType), profile, productType);
        assert.deepEqual(coordinatesForProfile(profile).screenSize, { width, height }, productType);
    }
    assert.equal(profileForProductType('iPhone11,6'), undefined, 'XS Max (414 × 896) has no profile yet');
});

test('every profile keeps its touch targets on screen', () => {
    for (const name of ['iphone8', 'iphoneX', 'iphone13']) {
        const { screenSize: { width, height }, tiktok, passcodeKeypad } = coordinatesForProfile(name);
        for (const point of CALIBRATABLE_POINTS) {
            const { x, y } = tiktok[point];
            assert.ok(x >= 0 && x <= width && y >= 0 && y <= height, `${name}.${point}`);
        }
        for (const x of passcodeKeypad.columnX) assert.ok(x > 0 && x < width, `${name} keypad x`);
        for (const y of passcodeKeypad.rowY) assert.ok(y > 0 && y < height, `${name} keypad y`);
        assert.ok(tiktok.swipe.startY < height && tiktok.picker.cellY < height, `${name} swipe/picker`);
    }
});

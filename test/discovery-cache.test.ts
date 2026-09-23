import assert from 'node:assert/strict';
import test from 'node:test';

import { createSharedSweep } from '../src/devices/discovery.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => { resolve = settle; });
    return { promise, resolve };
}

test('concurrent callers join one in-flight sweep instead of each running their own', async () => {
    let runs = 0;
    const gate = deferred<string[]>();
    const sweep = createSharedSweep(async () => { runs += 1; return gate.promise; });

    const waiting = [sweep.get(), sweep.get(), sweep.get()];
    assert.equal(runs, 1, 'three overlapping callers must not start three usbmux sweeps');

    gate.resolve(['udid-a', 'udid-b']);
    for (const result of await Promise.all(waiting)) {
        assert.deepEqual(result, ['udid-a', 'udid-b']);
    }
    assert.equal(runs, 1);
});

test('a result younger than maxAgeMs is served from memory, and 0 forces a fresh read', async () => {
    let runs = 0;
    const sweep = createSharedSweep(async () => { runs += 1; return runs; });

    assert.equal(await sweep.get(10_000), 1);
    assert.equal(await sweep.get(10_000), 1, 'a fresh cached sweep must not hit usbmux again');
    assert.equal(runs, 1);

    assert.equal(await sweep.get(0), 2, 'maxAgeMs 0 must bypass the cache');
    assert.equal(runs, 2);

    assert.equal(await sweep.get(-1), 3, 'a negative age is treated as "no cache"');
    assert.equal(runs, 3);
});

test('an expired entry and a forgotten entry both re-read', async () => {
    let runs = 0;
    const sweep = createSharedSweep(async () => { runs += 1; return runs; });

    assert.equal(await sweep.get(10_000), 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await sweep.get(1), 2, 'an entry older than maxAgeMs must be refreshed');

    sweep.forget();
    assert.equal(await sweep.get(10_000), 3, 'forget() drops the cached value');
});

test('a failed sweep is not cached and does not wedge later callers', async () => {
    let runs = 0;
    const sweep = createSharedSweep(async () => {
        runs += 1;
        if (runs === 1) throw new Error('usbmux is unavailable');
        return runs;
    });

    await assert.rejects(sweep.get(10_000), /usbmux is unavailable/);
    assert.equal(await sweep.get(10_000), 2, 'the next caller must start a new sweep');
});

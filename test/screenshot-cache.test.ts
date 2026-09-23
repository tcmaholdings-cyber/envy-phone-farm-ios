import assert from 'node:assert/strict';
import test from 'node:test';

import { createScreenshotCache } from '../src/devices/screenshot-cache.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
    return { promise, resolve, reject };
}

test('overlapping requests for one device share a single WDA round trip', async () => {
    const calls: string[] = [];
    const gate = deferred<Buffer>();
    const cache = createScreenshotCache({
        async getScreenshot(udid) { calls.push(udid); return gate.promise; },
    }, 10_000);

    const waiting = [cache.get('udid-a'), cache.get('udid-a'), cache.get('udid-a')];
    assert.deepEqual(calls, ['udid-a'], 'three dashboard tabs must not queue three screenshots');

    gate.resolve(Buffer.from('frame'));
    for (const frame of await Promise.all(waiting)) assert.equal(frame.toString(), 'frame');
});

test('devices are cached independently and a fresh frame is reused', async () => {
    const calls: string[] = [];
    let counter = 0;
    const cache = createScreenshotCache({
        async getScreenshot(udid) { calls.push(udid); counter += 1; return Buffer.from(`frame-${counter}`); },
    }, 10_000);

    assert.equal((await cache.get('udid-a')).toString(), 'frame-1');
    assert.equal((await cache.get('udid-b')).toString(), 'frame-2');
    assert.equal((await cache.get('udid-a')).toString(), 'frame-1', 'a fresh frame is served from the cache');
    assert.deepEqual(calls, ['udid-a', 'udid-b']);
});

test('an expired frame, an explicit fresh read, and forget() all go back to the device', async () => {
    let counter = 0;
    const cache = createScreenshotCache({
        async getScreenshot() { counter += 1; return Buffer.from(`frame-${counter}`); },
    }, 10_000);

    assert.equal((await cache.get('udid-a')).toString(), 'frame-1');
    assert.equal((await cache.get('udid-a', 0)).toString(), 'frame-2', 'maxAgeMs 0 bypasses the cache');

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await cache.get('udid-a', 1)).toString(), 'frame-3', 'a frame older than maxAgeMs is refetched');

    cache.forget('udid-a');
    assert.equal((await cache.get('udid-a')).toString(), 'frame-4');
});

test('a failed screenshot is not cached and, with no cooldown, the next request retries', async () => {
    let attempts = 0;
    const cache = createScreenshotCache({
        async getScreenshot() {
            attempts += 1;
            if (attempts === 1) throw new Error('WebDriverAgent is unavailable');
            return Buffer.from('frame');
        },
    }, { ttlMs: 10_000, failureCooldownMs: 0 });

    await assert.rejects(cache.get('udid-a'), /WebDriverAgent is unavailable/);
    assert.equal((await cache.get('udid-a')).toString(), 'frame');
});

function flaky(outcomes: Array<string | Error>): { source: { getScreenshot(udid: string, options?: { timeoutMs?: number }): Promise<Buffer> }; calls: Array<{ timeoutMs?: number } | undefined> } {
    const calls: Array<{ timeoutMs?: number } | undefined> = [];
    return {
        calls,
        source: {
            async getScreenshot(_udid, options) {
                calls.push(options);
                const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
                if (next instanceof Error) throw next;
                return Buffer.from(next ?? '');
            },
        },
    };
}

test('within the failure cooldown a dead phone fails at once without another WDA call', async () => {
    const { source, calls } = flaky([new Error('WebDriverAgent is unavailable'), 'frame']);
    const cache = createScreenshotCache(source, { ttlMs: 10_000, failureCooldownMs: 60_000 });

    await assert.rejects(cache.get('udid-a'), /unavailable/);
    await assert.rejects(cache.get('udid-a'), /unavailable/);
    assert.equal(calls.length, 1, 'the cooldown must not go back to the device');
    assert.ok(cache.peek('udid-a').failedAt, 'peek reports when the device failed');

    assert.equal((await cache.get('udid-a', 0)).toString(), 'frame', 'a fresh read (maxAge 0) bypasses the cooldown');
    assert.equal(calls.length, 2);
    assert.equal(cache.peek('udid-a').failedAt, undefined, 'a success clears the failure');
});

test('after the cooldown expires the device is asked again', async () => {
    const { source, calls } = flaky([new Error('down'), 'frame']);
    const cache = createScreenshotCache(source, { ttlMs: 10_000, failureCooldownMs: 5 });

    await assert.rejects(cache.get('udid-a'), /down/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await cache.get('udid-a')).toString(), 'frame');
    assert.equal(calls.length, 2);
});

test('allowStale serves the last good frame, flagged stale, during a cooldown', async () => {
    const { source } = flaky(['good', new Error('down')]);
    const cache = createScreenshotCache(source, { ttlMs: 1, failureCooldownMs: 60_000 });

    const first = await cache.getFrame('udid-a');
    assert.equal(first.frame.toString(), 'good');
    assert.equal(first.stale, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(cache.get('udid-a'), /down/);

    const stale = await cache.getFrame('udid-a', { allowStale: true });
    assert.equal(stale.frame.toString(), 'good');
    assert.equal(stale.stale, true);
    assert.equal(stale.at, first.at);
    await assert.rejects(cache.get('udid-a'), /down/, 'without allowStale the cooldown still rejects');
});

test('forget() clears the cooldown and peek() reports the frame age', async () => {
    const { source, calls } = flaky([new Error('down'), 'frame']);
    const cache = createScreenshotCache(source, { ttlMs: 10_000, failureCooldownMs: 60_000 });

    assert.deepEqual(cache.peek('udid-a'), {});
    await assert.rejects(cache.get('udid-a'), /down/);
    cache.forget('udid-a');
    assert.deepEqual(cache.peek('udid-a'), {});
    const before = Date.now();
    assert.equal((await cache.get('udid-a')).toString(), 'frame');
    assert.equal(calls.length, 2);
    const peek = cache.peek('udid-a');
    assert.equal(peek.frame?.toString(), 'frame');
    assert.ok((peek.at ?? 0) >= before);
});

test('PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS is honoured', async (context) => {
    context.after(() => { delete process.env.PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS; });

    process.env.PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS = '0';
    const retrying = flaky([new Error('down'), 'frame']);
    const noCooldown = createScreenshotCache(retrying.source, 10_000);
    await assert.rejects(noCooldown.get('udid-a'), /down/);
    assert.equal((await noCooldown.get('udid-a')).toString(), 'frame');

    process.env.PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS = '60000';
    const holding = flaky([new Error('down'), 'frame']);
    const withCooldown = createScreenshotCache(holding.source, 10_000);
    await assert.rejects(withCooldown.get('udid-a'), /down/);
    await assert.rejects(withCooldown.get('udid-a'), /down/);
    assert.equal(holding.calls.length, 1);
});

test('a per-call timeout is passed through to the source', async () => {
    const { source, calls } = flaky(['frame']);
    const cache = createScreenshotCache(source, { ttlMs: 10_000 });
    await cache.get('udid-a', { timeoutMs: 3_000 });
    assert.deepEqual(calls, [{ timeoutMs: 3_000 }]);
});

test('a default-deadline request never joins or inherits the cooldown of a short grid fetch', async () => {
    const calls: Array<{ timeoutMs?: number } | undefined> = [];
    const gridGate = deferred<Buffer>();
    const cache = createScreenshotCache({
        async getScreenshot(_udid, options) {
            calls.push(options);
            return options?.timeoutMs ? gridGate.promise : Buffer.from('full');
        },
    }, { ttlMs: 10_000, failureCooldownMs: 60_000 });

    const grid = cache.get('udid-a', { timeoutMs: 3_000 });
    const full = cache.get('udid-a');
    assert.equal(calls.length, 2, 'the longer caller starts its own fetch');
    assert.equal((await full).toString(), 'full');
    gridGate.reject(new Error('timed out'));
    await assert.rejects(grid, /timed out/);

    const failing = { short: true };
    const cooled = createScreenshotCache({
        async getScreenshot(_udid, options) {
            calls.push(options);
            if (failing.short && options?.timeoutMs) throw new Error('timed out');
            return Buffer.from('full');
        },
    }, { ttlMs: 10_000, failureCooldownMs: 60_000 });
    await assert.rejects(cooled.get('udid-b', { timeoutMs: 3_000 }), /timed out/);
    assert.equal((await cooled.get('udid-b')).toString(), 'full', 'a short timeout does not cool down the default deadline');
    assert.equal(calls.length, 4);
});

test('a short grid fetch still joins a longer in-flight fetch', async () => {
    const calls: Array<{ timeoutMs?: number } | undefined> = [];
    const gate = deferred<Buffer>();
    const cache = createScreenshotCache({
        async getScreenshot(_udid, options) { calls.push(options); return gate.promise; },
    }, { ttlMs: 10_000 });
    const full = cache.get('udid-a');
    const grid = cache.get('udid-a', { timeoutMs: 3_000 });
    assert.equal(calls.length, 1);
    gate.resolve(Buffer.from('frame'));
    assert.equal((await grid).toString(), 'frame');
    assert.equal((await full).toString(), 'frame');
});

test('a short grid fetch that fails cools down later short fetches', async () => {
    const calls: Array<{ timeoutMs?: number } | undefined> = [];
    const cache = createScreenshotCache({
        async getScreenshot(_udid, options) { calls.push(options); throw new Error('down'); },
    }, { ttlMs: 10_000, failureCooldownMs: 60_000 });
    await assert.rejects(cache.get('udid-a', { timeoutMs: 3_000 }), /down/);
    await assert.rejects(cache.get('udid-a', { timeoutMs: 3_000 }), /down/);
    assert.equal(calls.length, 1);
});

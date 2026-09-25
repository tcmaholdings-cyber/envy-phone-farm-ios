import assert from 'node:assert/strict';

import type { LoginThrottleOptions, LoginThrottleStore } from '../src/auth/throttle.js';

/**
 * The throttle's rules as scenarios, run against every store (in memory, the
 * Postgres one over a fake pool, and — opt-in — real Postgres), so moving the
 * throttle into the database cannot change what it does.
 */

export const BACKOFF_POLICY: LoginThrottleOptions = {
    username: { freeAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 },
    ip: { freeAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 8_000 },
};

export const EXPIRY_POLICY: LoginThrottleOptions = {
    resetAfterMs: 60_000, username: { freeAttempts: 1, baseDelayMs: 5_000, maxDelayMs: 5_000 },
};

/** `prefix` keeps a real-database run's keys apart from anything else in the table. */
export async function throttleBackoffScenario(throttle: LoginThrottleStore, advance: (ms: number) => void, prefix = ''): Promise<void> {
    const [kash, rex, mikey] = [`${prefix}kash`, `${prefix}rex`, `${prefix}mikey`];
    const ip = (value: string) => `${prefix}${value}`;
    for (let index = 0; index < 3; index += 1) {
        assert.equal(await throttle.retryAfterMs(kash, ip('1.1.1.1')), 0);
        await throttle.recordFailure(kash, ip('1.1.1.1'));
    }
    assert.equal(await throttle.retryAfterMs(kash, ip('1.1.1.1')), 1_000, 'fourth attempt waits the base delay');
    assert.equal(await throttle.retryAfterMs(kash, ip('2.2.2.2')), 1_000, 'the username lock follows the name to a new IP');
    assert.equal(await throttle.retryAfterMs(rex, ip('1.1.1.1')), 0, 'other names from that IP are fine so far');
    advance(1_000);
    await throttle.recordFailure(kash, ip('1.1.1.1'));
    assert.equal(await throttle.retryAfterMs(kash, ip('3.3.3.3')), 2_000, 'doubles');
    advance(2_000);
    await throttle.recordFailure(rex, ip('1.1.1.1'));
    // 5 failures from 1.1.1.1 now: the IP is at its free limit.
    assert.equal(await throttle.retryAfterMs(mikey, ip('1.1.1.1')), 1_000, 'the IP lock covers every username');
    for (let index = 0; index < 10; index += 1) { advance(10_000); await throttle.recordFailure(kash, ip('9.9.9.9')); }
    assert.equal(await throttle.retryAfterMs(kash, ip('8.8.8.8')), 8_000, 'capped at maxDelayMs');
    await throttle.recordSuccess(kash);
    assert.equal(await throttle.retryAfterMs(kash, ip('8.8.8.8')), 0, 'success clears the username');
    assert.equal(await throttle.retryAfterMs(`${prefix}anyone`, ip('9.9.9.9')), 8_000, 'but not the IP');
}

export async function throttleExpiryScenario(throttle: LoginThrottleStore, advance: (ms: number) => void, prefix = ''): Promise<void> {
    const nobody = `${prefix}nobody-at-all`;
    const ip = `${prefix}1.1.1.1`;
    await throttle.recordFailure(nobody, ip);
    assert.ok(await throttle.retryAfterMs(nobody, ip) > 0);
    advance(60_001);
    assert.equal(await throttle.retryAfterMs(nobody, ip), 0);
    // A failure after the quiet period starts the count again rather than adding to it.
    await throttle.recordFailure(nobody, ip);
    assert.equal(await throttle.retryAfterMs(nobody, ip), 5_000);
}

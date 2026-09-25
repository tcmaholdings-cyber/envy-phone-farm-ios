import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import { PgLoginThrottle, type ThrottleQueryable } from '../src/auth/throttle.js';
import { BACKOFF_POLICY, EXPIRY_POLICY, throttleBackoffScenario, throttleExpiryScenario } from './throttle-scenarios.js';

/**
 * The sign-in throttle in auth.login_throttle keeps the in-memory rules: the
 * same scenarios as test/auth-primitives.test.ts, over a fake pool that
 * implements the three statements, and (opt-in) over real Postgres.
 */

/** Just enough of auth.login_throttle to run PgLoginThrottle's statements. */
function fakeThrottlePool() {
    const rows = new Map<string, { failures: number; lastFailureAt: Date }>();
    const statements: string[] = [];
    const pool: ThrottleQueryable = {
        async query(text: string, values: unknown[] = []) {
            statements.push(text.replace(/\s+/g, ' ').trim());
            if (text.startsWith('select key, failures, last_failure_at from auth.login_throttle')) {
                const keys = values[0] as string[];
                return { rows: keys.flatMap((key) => (rows.has(key) ? [{ key, failures: rows.get(key)!.failures, last_failure_at: rows.get(key)!.lastFailureAt }] : [])) };
            }
            if (text.startsWith('insert into auth.login_throttle')) {
                const [first, second, at, stale] = values as [string, string, Date, Date];
                for (const key of [first, second]) {
                    const current = rows.get(key);
                    rows.set(key, { failures: !current || current.lastFailureAt < stale ? 1 : current.failures + 1, lastFailureAt: at });
                }
                return { rows: [] };
            }
            if (text.startsWith('delete from auth.login_throttle where last_failure_at <')) {
                for (const [key, row] of rows) if (row.lastFailureAt < (values[0] as Date)) rows.delete(key);
                return { rows: [] };
            }
            if (text.startsWith('delete from auth.login_throttle where key =')) {
                rows.delete(values[0] as string);
                return { rows: [] };
            }
            throw new Error(`unexpected statement: ${text}`);
        },
    };
    return { pool, rows, statements };
}

test('Postgres throttle: free attempts, exponential backoff, per username and per IP', async () => {
    let now = Date.UTC(2026, 8, 25);
    const { pool } = fakeThrottlePool();
    await throttleBackoffScenario(new PgLoginThrottle(pool, { now: () => now, ...BACKOFF_POLICY }), (ms) => { now += ms; });
});

test('Postgres throttle: entries expire after a quiet period and restart from one failure', async () => {
    let now = Date.UTC(2026, 8, 25);
    const { pool } = fakeThrottlePool();
    await throttleExpiryScenario(new PgLoginThrottle(pool, { now: () => now, ...EXPIRY_POLICY }), (ms) => { now += ms; });
});

test('Postgres throttle: state lives in the table, so a second replica (or a restart) sees the same count', async () => {
    let now = Date.UTC(2026, 8, 25);
    const { pool, rows, statements } = fakeThrottlePool();
    const replicaA = new PgLoginThrottle(pool, { now: () => now, ...BACKOFF_POLICY });
    const replicaB = new PgLoginThrottle(pool, { now: () => now, ...BACKOFF_POLICY });
    for (let index = 0; index < 3; index += 1) await (index % 2 ? replicaB : replicaA).recordFailure('kash', '1.1.1.1');
    assert.equal(await new PgLoginThrottle(pool, { now: () => now, ...BACKOFF_POLICY }).retryAfterMs('kash', '5.5.5.5'), 1_000);
    assert.deepEqual([...rows.keys()].sort(), ['ip:1.1.1.1', 'u:kash'], 'keys name a username or an IP, nothing else');
    // Forgotten rows are swept, at most every ten minutes per replica.
    now += 61 * 60_000;
    await replicaA.recordFailure('rex', '2.2.2.2');
    assert.deepEqual([...rows.keys()].sort(), ['ip:2.2.2.2', 'u:rex']);
    assert.ok(statements.every((statement) => !statement.includes('password')));
});

const url = process.env.PHONE_FARM_TEST_DATABASE_URL;

test('real Postgres: the throttle scenarios hold against auth.login_throttle', { skip: !url }, async (context) => {
    const pool = new Pool({ connectionString: url, max: 2 });
    const prefix = `test-${crypto.randomBytes(4).toString('hex')}-`;
    context.after(async () => {
        await pool.query(`delete from auth.login_throttle where key like $1 or key like $2`, [`u:${prefix}%`, `ip:${prefix}%`]);
        await pool.end();
    });
    let now = Date.now();
    await throttleBackoffScenario(new PgLoginThrottle(pool, { now: () => now, ...BACKOFF_POLICY }), (ms) => { now += ms; }, prefix);
    await throttleExpiryScenario(new PgLoginThrottle(pool, { now: () => now, ...EXPIRY_POLICY }), (ms) => { now += ms; }, `${prefix}x-`);
});

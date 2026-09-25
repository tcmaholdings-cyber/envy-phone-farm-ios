import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { readWorkerHeartbeats, startWorkerHeartbeat, type Queryable } from '../src/observability/heartbeat.js';

function recordingPool(fail = false) {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const pool: Queryable = {
        async query(text: string, values?: unknown[]) {
            calls.push({ text, values });
            if (fail) throw new Error('connection refused');
            return { rows: [] };
        },
    };
    return { pool, calls };
}

test('the worker heartbeat upserts host, pid, start time and queue count on the database clock', async () => {
    const { pool, calls } = recordingPool();
    let queues = 2;
    const startedAt = new Date('2026-09-25T10:00:00Z');
    const heartbeat = startWorkerHeartbeat(pool, () => queues, { host: 'mini-1', pid: 4242, startedAt, intervalMs: 60_000 });
    await heartbeat.beat();
    queues = 5;
    await heartbeat.beat();
    await heartbeat.stop();
    assert.equal(calls.length, 3, 'one beat at start, two explicit');
    assert.match(calls[0]!.text, /insert into scheduler\.worker_heartbeats/);
    assert.match(calls[0]!.text, /on conflict \(host\) do update/);
    assert.match(calls[0]!.text, /now\(\)/);
    assert.deepEqual(calls[1]!.values, ['mini-1', 4242, startedAt, 2]);
    assert.deepEqual(calls[2]!.values, ['mini-1', 4242, startedAt, 5]);
});

test('a failing heartbeat never throws into the worker', async (context) => {
    const { pool } = recordingPool(true);
    const errors: unknown[] = [];
    context.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
    const heartbeat = startWorkerHeartbeat(pool, () => 0, { intervalMs: 60_000 });
    await heartbeat.beat();
    await heartbeat.beat();
    await heartbeat.stop();
    assert.equal(errors.length, 1, 'the same error is reported once, not every 15 s');
});

test('readWorkerHeartbeats returns ages as numbers', async () => {
    const pool: Queryable = {
        async query() {
            return { rows: [{ host: 'mini-1', pid: 1, started_at: new Date(0), queues: 3, age_seconds: '12.5' }] as never[] };
        },
    };
    assert.deepEqual(await readWorkerHeartbeats(pool), [{ host: 'mini-1', pid: 1, startedAt: new Date(0), queues: 3, ageSeconds: 12.5 }]);
});

test('migration 0003 creates the heartbeat table and is in the journal', async () => {
    const sql = await readFile(new URL('../drizzle/0003_worker_heartbeat.sql', import.meta.url), 'utf8');
    assert.match(sql, /CREATE TABLE "scheduler"\."worker_heartbeats"/);
    for (const column of ['host', 'pid', 'started_at', 'beat_at', 'queues']) assert.match(sql, new RegExp(`"${column}"`));
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    assert.deepEqual(journal.entries.map(({ idx }) => idx), journal.entries.map((_entry, index) => index));
    assert.ok(journal.entries.some(({ tag }) => tag === '0003_worker_heartbeat'));
});

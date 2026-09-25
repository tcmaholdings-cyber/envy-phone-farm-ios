import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_TASK_START_CONCURRENCY, DEFAULT_TASK_START_WARMUP_MS,
    createStartGate, taskStartConcurrency, taskStartWarmupMs,
} from '../src/scheduler/start-gate.js';

const never = () => new AbortController().signal;

test('the start gate admits at most `limit` tasks and wakes the next one in order', async () => {
    const gate = createStartGate(2);
    const first = await gate.acquire(never());
    const second = await gate.acquire(never());
    assert.equal(gate.wouldWait(), true);
    const order: string[] = [];
    const third = gate.acquire(never()).then((release) => { order.push('third'); return release; });
    const fourth = gate.acquire(never()).then((release) => { order.push('fourth'); return release; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, []);
    assert.deepEqual(gate.stats(), { active: 2, waiting: 2 });
    first();
    first(); // idempotent: a second release must not free another slot
    await third;
    assert.deepEqual(order, ['third']);
    assert.deepEqual(gate.stats(), { active: 2, waiting: 1 });
    second();
    (await fourth)();
    assert.deepEqual(order, ['third', 'fourth']);
});

test('a waiter that is aborted leaves the queue and never takes a slot', async () => {
    const gate = createStartGate(1);
    const held = await gate.acquire(never());
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort(new Error('Stop requested'));
    await assert.rejects(waiting, /Stop requested/);
    assert.deepEqual(gate.stats(), { active: 1, waiting: 0 });
    held();
    assert.deepEqual(gate.stats(), { active: 0, waiting: 0 });
    const aborted = new AbortController();
    aborted.abort(new Error('already'));
    await assert.rejects(gate.acquire(aborted.signal), /already/);
});

test('a limit of 0 never queues', async () => {
    const gate = createStartGate(0);
    await Promise.all(Array.from({ length: 50 }, () => gate.acquire(never())));
    assert.equal(gate.wouldWait(), false);
    assert.equal(gate.stats().active, 50);
});

test('start concurrency and warm-up come from the environment with safe defaults', () => {
    assert.equal(taskStartConcurrency({}), DEFAULT_TASK_START_CONCURRENCY);
    assert.equal(taskStartConcurrency({ PHONE_FARM_TASK_START_CONCURRENCY: '8' }), 8);
    assert.equal(taskStartConcurrency({ PHONE_FARM_TASK_START_CONCURRENCY: '0' }), 0);
    assert.equal(taskStartConcurrency({ PHONE_FARM_TASK_START_CONCURRENCY: '-1' }), DEFAULT_TASK_START_CONCURRENCY);
    assert.equal(taskStartConcurrency({ PHONE_FARM_TASK_START_CONCURRENCY: 'lots' }), DEFAULT_TASK_START_CONCURRENCY);
    assert.equal(taskStartWarmupMs({}), DEFAULT_TASK_START_WARMUP_MS);
    assert.equal(taskStartWarmupMs({ PHONE_FARM_TASK_START_WARMUP_SECONDS: '5' }), 5_000);
    assert.equal(taskStartWarmupMs({ PHONE_FARM_TASK_START_WARMUP_SECONDS: 'x' }), DEFAULT_TASK_START_WARMUP_MS);
});

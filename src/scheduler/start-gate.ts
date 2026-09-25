/**
 * Limits how many task subprocesses start at the same moment.
 *
 * Starting a task opens an Appium session and a burst of WDA connections, each
 * of them tunnelled through usbmuxd. Thirty phones started together overflow
 * usbmuxd's accept backlog and every client on the host — this worker, Appium,
 * wda-service — gets ECONNREFUSED on /var/run/usbmuxd. A slot is held from
 * spawn until the task has had its warm-up (or exits, whichever comes first),
 * so a batch starts a few phones at a time instead of all at once.
 */
export interface StartGate {
    /** Resolves with an idempotent `release` once a slot is free; rejects if `signal` aborts first. */
    acquire(signal: AbortSignal): Promise<() => void>;
    /** True when an `acquire` made now would have to queue. */
    wouldWait(): boolean;
    /** Slots in use and callers waiting, for tests and diagnostics. */
    stats(): { active: number; waiting: number };
}

export const DEFAULT_TASK_START_CONCURRENCY = 4;
export const DEFAULT_TASK_START_WARMUP_MS = 20_000;

/** PHONE_FARM_TASK_START_CONCURRENCY: default 4; 0 means no limit. */
export function taskStartConcurrency(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number(env.PHONE_FARM_TASK_START_CONCURRENCY);
    return env.PHONE_FARM_TASK_START_CONCURRENCY !== undefined && Number.isInteger(configured) && configured >= 0
        ? configured : DEFAULT_TASK_START_CONCURRENCY;
}

/** PHONE_FARM_TASK_START_WARMUP_SECONDS: how long a started task holds its slot; default 20. */
export function taskStartWarmupMs(env: NodeJS.ProcessEnv = process.env): number {
    const seconds = Number(env.PHONE_FARM_TASK_START_WARMUP_SECONDS);
    return env.PHONE_FARM_TASK_START_WARMUP_SECONDS !== undefined && Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000 : DEFAULT_TASK_START_WARMUP_MS;
}

export function createStartGate(limit: number): StartGate {
    let active = 0;
    const waiters: Array<() => void> = [];
    const grant = (): (() => void) => {
        active++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            active--;
            waiters.shift()?.();
        };
    };
    return {
        acquire(signal) {
            if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
            if (limit <= 0 || active < limit) return Promise.resolve(grant());
            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    const index = waiters.indexOf(wake);
                    if (index >= 0) waiters.splice(index, 1);
                    reject(signal.reason ?? new Error('Aborted'));
                };
                const wake = () => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(grant());
                };
                waiters.push(wake);
                signal.addEventListener('abort', onAbort, { once: true });
            });
        },
        wouldWait: () => limit > 0 && active >= limit,
        stats: () => ({ active, waiting: waiters.length }),
    };
}

/**
 * Sign-in throttling, in memory, per username and per client IP.
 *
 * A key gets `freeAttempts` failures for nothing; after that each further
 * failure locks it for `baseDelayMs * 2^(failures - freeAttempts)`, capped at
 * `maxDelayMs`. A key forgets its failures after `resetAfterMs` of quiet, and a
 * successful sign-in clears the username key (not the IP key, so one good
 * account cannot launder guesses against others from the same address).
 *
 * Unknown usernames are throttled exactly like real ones, so the throttle does
 * not reveal which accounts exist. The state resets when the web process restarts.
 */

export interface ThrottlePolicy {
    freeAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

export interface LoginThrottleOptions {
    username?: ThrottlePolicy;
    ip?: ThrottlePolicy;
    resetAfterMs?: number;
    now?: () => number;
    maxEntries?: number;
}

interface Entry { failures: number; lastFailureAt: number }

export const DEFAULT_USERNAME_POLICY: ThrottlePolicy = { freeAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 15 * 60_000 };
export const DEFAULT_IP_POLICY: ThrottlePolicy = { freeAttempts: 20, baseDelayMs: 30_000, maxDelayMs: 15 * 60_000 };

export class LoginThrottle {
    private readonly entries = new Map<string, Entry>();
    private readonly usernamePolicy: ThrottlePolicy;
    private readonly ipPolicy: ThrottlePolicy;
    private readonly resetAfterMs: number;
    private readonly now: () => number;
    private readonly maxEntries: number;

    constructor(options: LoginThrottleOptions = {}) {
        this.usernamePolicy = options.username ?? DEFAULT_USERNAME_POLICY;
        this.ipPolicy = options.ip ?? DEFAULT_IP_POLICY;
        this.resetAfterMs = options.resetAfterMs ?? 60 * 60_000;
        this.now = options.now ?? Date.now;
        this.maxEntries = options.maxEntries ?? 10_000;
    }

    /** Milliseconds until another attempt is allowed for this username/IP pair; 0 when allowed now. */
    retryAfterMs(username: string, ip: string): number {
        return Math.max(this.wait(`u:${username}`, this.usernamePolicy), this.wait(`ip:${ip}`, this.ipPolicy));
    }

    recordFailure(username: string, ip: string): void {
        this.bump(`u:${username}`);
        this.bump(`ip:${ip}`);
    }

    recordSuccess(username: string): void {
        this.entries.delete(`u:${username}`);
    }

    private entry(key: string): Entry | undefined {
        const entry = this.entries.get(key);
        if (entry && this.now() - entry.lastFailureAt > this.resetAfterMs) {
            this.entries.delete(key);
            return undefined;
        }
        return entry;
    }

    private wait(key: string, policy: ThrottlePolicy): number {
        const entry = this.entry(key);
        if (!entry || entry.failures < policy.freeAttempts) return 0;
        const delay = Math.min(policy.baseDelayMs * 2 ** (entry.failures - policy.freeAttempts), policy.maxDelayMs);
        return Math.max(0, entry.lastFailureAt + delay - this.now());
    }

    private bump(key: string): void {
        const entry = this.entry(key) ?? { failures: 0, lastFailureAt: 0 };
        entry.failures += 1;
        entry.lastFailureAt = this.now();
        this.entries.set(key, entry);
        if (this.entries.size > this.maxEntries) this.prune();
    }

    private prune(): void {
        const cutoff = this.now() - this.resetAfterMs;
        for (const [key, entry] of this.entries) if (entry.lastFailureAt < cutoff) this.entries.delete(key);
        // Still over budget (a flood of distinct keys): drop the oldest.
        const excess = this.entries.size - this.maxEntries;
        if (excess > 0) for (const key of [...this.entries.keys()].slice(0, excess)) this.entries.delete(key);
    }
}

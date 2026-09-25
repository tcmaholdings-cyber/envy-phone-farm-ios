/**
 * Sign-in throttling, per username and per client IP.
 *
 * A key gets `freeAttempts` failures for nothing; after that each further
 * failure locks it for `baseDelayMs * 2^(failures - freeAttempts)`, capped at
 * `maxDelayMs`. A key forgets its failures after `resetAfterMs` of quiet, and a
 * successful sign-in clears the username key (not the IP key, so one good
 * account cannot launder guesses against others from the same address).
 *
 * Unknown usernames are throttled exactly like real ones, so the throttle does
 * not reveal which accounts exist.
 *
 * Two stores share these rules: `PgLoginThrottle` (auth.login_throttle), which
 * the built-in accounts use so the counts survive a restart and are shared by
 * every web replica, and the in-memory `LoginThrottle` for tests and tools.
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

/** What AccountService needs from a throttle; the in-memory one answers synchronously. */
export interface LoginThrottleStore {
    retryAfterMs(username: string, ip: string): number | Promise<number>;
    recordFailure(username: string, ip: string): void | Promise<void>;
    recordSuccess(username: string): void | Promise<void>;
}

export const DEFAULT_USERNAME_POLICY: ThrottlePolicy = { freeAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 15 * 60_000 };
export const DEFAULT_IP_POLICY: ThrottlePolicy = { freeAttempts: 20, baseDelayMs: 30_000, maxDelayMs: 15 * 60_000 };
const DEFAULT_RESET_AFTER_MS = 60 * 60_000;

const usernameKey = (username: string) => `u:${username}`;
const ipKey = (ip: string) => `ip:${ip}`;

/** Milliseconds `entry` is still locked for under `policy` at `now`; 0 when free (or forgotten). */
export function lockRemainingMs(entry: Entry | undefined, policy: ThrottlePolicy, now: number, resetAfterMs: number): number {
    if (!entry || now - entry.lastFailureAt > resetAfterMs || entry.failures < policy.freeAttempts) return 0;
    const delay = Math.min(policy.baseDelayMs * 2 ** (entry.failures - policy.freeAttempts), policy.maxDelayMs);
    return Math.max(0, entry.lastFailureAt + delay - now);
}

export class LoginThrottle implements LoginThrottleStore {
    private readonly entries = new Map<string, Entry>();
    private readonly usernamePolicy: ThrottlePolicy;
    private readonly ipPolicy: ThrottlePolicy;
    private readonly resetAfterMs: number;
    private readonly now: () => number;
    private readonly maxEntries: number;

    constructor(options: LoginThrottleOptions = {}) {
        this.usernamePolicy = options.username ?? DEFAULT_USERNAME_POLICY;
        this.ipPolicy = options.ip ?? DEFAULT_IP_POLICY;
        this.resetAfterMs = options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS;
        this.now = options.now ?? Date.now;
        this.maxEntries = options.maxEntries ?? 10_000;
    }

    /** Milliseconds until another attempt is allowed for this username/IP pair; 0 when allowed now. */
    retryAfterMs(username: string, ip: string): number {
        return Math.max(this.wait(usernameKey(username), this.usernamePolicy), this.wait(ipKey(ip), this.ipPolicy));
    }

    recordFailure(username: string, ip: string): void {
        this.bump(usernameKey(username));
        this.bump(ipKey(ip));
    }

    recordSuccess(username: string): void {
        this.entries.delete(usernameKey(username));
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
        return lockRemainingMs(this.entry(key), policy, this.now(), this.resetAfterMs);
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

/** The slice of a pg Pool this needs. */
export interface ThrottleQueryable {
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** How often (at most) a replica sweeps forgotten rows out of auth.login_throttle. */
const PRUNE_INTERVAL_MS = 10 * 60_000;

/**
 * The throttle in Postgres (auth.login_throttle, drizzle/0006_tenants.sql):
 * shared by every web replica and kept across restarts, so restarting the
 * web process or adding a replica does not hand an attacker fresh attempts.
 * A failure is one atomic upsert per key, so concurrent guesses on two
 * replicas are all counted.
 */
export class PgLoginThrottle implements LoginThrottleStore {
    private readonly usernamePolicy: ThrottlePolicy;
    private readonly ipPolicy: ThrottlePolicy;
    private readonly resetAfterMs: number;
    private readonly now: () => number;
    private lastPruneAt = 0;

    constructor(private readonly pool: ThrottleQueryable, options: LoginThrottleOptions = {}) {
        this.usernamePolicy = options.username ?? DEFAULT_USERNAME_POLICY;
        this.ipPolicy = options.ip ?? DEFAULT_IP_POLICY;
        this.resetAfterMs = options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS;
        this.now = options.now ?? Date.now;
    }

    async retryAfterMs(username: string, ip: string): Promise<number> {
        const keys = [usernameKey(username), ipKey(ip)];
        const { rows } = await this.pool.query(
            'select key, failures, last_failure_at from auth.login_throttle where key = any($1::text[])', [keys],
        );
        const entries = new Map((rows as Array<{ key: string; failures: number; last_failure_at: Date | string }>).map((row) => [
            row.key, { failures: Number(row.failures), lastFailureAt: new Date(row.last_failure_at).getTime() },
        ]));
        const now = this.now();
        return Math.max(
            lockRemainingMs(entries.get(keys[0]!), this.usernamePolicy, now, this.resetAfterMs),
            lockRemainingMs(entries.get(keys[1]!), this.ipPolicy, now, this.resetAfterMs),
        );
    }

    async recordFailure(username: string, ip: string): Promise<void> {
        const now = this.now();
        // A key quiet for longer than resetAfterMs starts again from one failure.
        await this.pool.query(
            `insert into auth.login_throttle (key, failures, last_failure_at) values ($1, 1, $3), ($2, 1, $3)
             on conflict (key) do update set
               failures = case when auth.login_throttle.last_failure_at < $4 then 1 else auth.login_throttle.failures + 1 end,
               last_failure_at = $3`,
            [usernameKey(username), ipKey(ip), new Date(now), new Date(now - this.resetAfterMs)],
        );
        if (now - this.lastPruneAt > PRUNE_INTERVAL_MS) {
            this.lastPruneAt = now;
            await this.pool.query('delete from auth.login_throttle where last_failure_at < $1', [new Date(now - this.resetAfterMs)]);
        }
    }

    async recordSuccess(username: string): Promise<void> {
        await this.pool.query('delete from auth.login_throttle where key = $1', [usernameKey(username)]);
    }
}

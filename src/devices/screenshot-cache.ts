export const DEFAULT_SCREENSHOT_TTL_MS = 4_000;
export const DEFAULT_SCREENSHOT_FAILURE_COOLDOWN_MS = 20_000;

export interface ScreenshotFetchOptions {
    /** Per-call WebDriverAgent deadline; the source's own default applies when omitted. */
    timeoutMs?: number;
}

export interface ScreenshotSource {
    getScreenshot(udid: string, options?: ScreenshotFetchOptions): Promise<Buffer>;
}

export interface ScreenshotGetOptions extends ScreenshotFetchOptions {
    /** Reuse a frame younger than this. 0 means "fetch now" and also skips the failure cooldown. */
    maxAgeMs?: number;
    /** During a failure cooldown, resolve the last good frame (flagged stale) instead of rejecting. */
    allowStale?: boolean;
}

export interface CachedFrame {
    frame: Buffer;
    /** When the frame was taken (epoch ms). */
    at: number;
    /** True when the device is failing and this is the last good frame from before. */
    stale: boolean;
}

export interface ScreenshotPeek {
    frame?: Buffer;
    at?: number;
    failedAt?: number;
}

export interface ScreenshotCache {
    /** The device's most recent frame, fetching one only when the cached frame is older than `maxAgeMs`. */
    get(udid: string, options?: number | ScreenshotGetOptions): Promise<Buffer>;
    /** Like get(), but reports when the frame was taken and whether it is a stale fallback. */
    getFrame(udid: string, options?: number | ScreenshotGetOptions): Promise<CachedFrame>;
    /** What the cache holds for a device right now, without touching the device. */
    peek(udid: string): ScreenshotPeek;
    /** Drop the cached frame and any failure cooldown for a device (registry change, removal, reconnect). */
    forget(udid: string): void;
}

export interface ScreenshotCacheOptions {
    ttlMs?: number;
    failureCooldownMs?: number;
}

function configuredMs(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const configured = Number(raw);
    return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

interface Entry {
    at: number;
    frame?: Buffer;
    inFlight?: Promise<CachedFrame>;
    /** Deadline of the in-flight fetch; Infinity means the source's default. */
    inFlightDeadline?: number;
    failedAt?: number;
    /** Deadline of the fetch that failed, so a short grid timeout never cools down a longer caller. */
    failedDeadline?: number;
    error?: unknown;
}

/**
 * The device grid asks every connected phone for a still on each poll, and each
 * open dashboard tab repeats that. Two things went wrong at rack scale: N
 * viewers cost N WDA round trips per device, and a poll that arrived while the
 * previous screenshot was still in flight queued a second one behind it. This
 * coalesces concurrent requests onto one in-flight fetch per device and holds
 * the frame briefly so extra viewers are free.
 *
 * A phone whose WebDriverAgent is down fails slowly (a connect or read
 * timeout), and every grid refresh used to pay that again. After a failure the
 * device sits in a cooldown during which requests fail at once (or get the last
 * good frame, flagged stale, when the caller allows it), so one dead phone
 * cannot hold a browser connection slot per poll.
 */
export function createScreenshotCache(
    source: ScreenshotSource,
    options: number | ScreenshotCacheOptions = {},
): ScreenshotCache {
    const settings = typeof options === 'number' ? { ttlMs: options } : options;
    const defaultTtlMs = settings.ttlMs ?? configuredMs('PHONE_FARM_SCREENSHOT_TTL_MS', DEFAULT_SCREENSHOT_TTL_MS);
    const cooldownMs = settings.failureCooldownMs
        ?? configuredMs('PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS', DEFAULT_SCREENSHOT_FAILURE_COOLDOWN_MS);
    const entries = new Map<string, Entry>();

    const getFrame = (udid: string, requested: number | ScreenshotGetOptions = {}): Promise<CachedFrame> => {
        const { maxAgeMs = defaultTtlMs, allowStale = false, timeoutMs } = typeof requested === 'number'
            ? { maxAgeMs: requested } : requested;
        // The source's default deadline is the longest any caller gets.
        const deadline = timeoutMs ?? Number.POSITIVE_INFINITY;
        let entry = entries.get(udid);
        if (entry?.frame && maxAgeMs > 0 && Date.now() - entry.at < maxAgeMs) {
            return Promise.resolve({ frame: entry.frame, at: entry.at, stale: false });
        }
        // Join an in-flight fetch only when it is allowed at least as long as this
        // caller: a 3 s grid fetch must not cut short a default-deadline request.
        if (entry?.inFlight && (entry.inFlightDeadline ?? Number.POSITIVE_INFINITY) >= deadline) return entry.inFlight;
        if (entry?.failedAt !== undefined && maxAgeMs > 0 && Date.now() - entry.failedAt < cooldownMs
            && deadline <= (entry.failedDeadline ?? Number.POSITIVE_INFINITY)) {
            if (allowStale && entry.frame) return Promise.resolve({ frame: entry.frame, at: entry.at, stale: true });
            return Promise.reject(entry.error);
        }
        if (!entry) {
            entry = { at: 0 };
            entries.set(udid, entry);
        }
        const current = entry;
        const pending: Promise<CachedFrame> = source.getScreenshot(udid, timeoutMs === undefined ? undefined : { timeoutMs })
            .then((frame) => {
                current.frame = frame;
                current.at = Date.now();
                delete current.failedAt;
                delete current.failedDeadline;
                delete current.error;
                return { frame, at: current.at, stale: false };
            }, (error: unknown) => {
                current.failedAt = Date.now();
                current.failedDeadline = deadline;
                current.error = error;
                throw error;
            })
            .finally(() => {
                if (current.inFlight === pending) {
                    delete current.inFlight;
                    delete current.inFlightDeadline;
                }
            });
        current.inFlight = pending;
        current.inFlightDeadline = deadline;
        return pending;
    };

    return {
        getFrame,
        get(udid, requested) {
            return getFrame(udid, requested).then(({ frame }) => frame);
        },
        peek(udid) {
            const entry = entries.get(udid);
            if (!entry) return {};
            return {
                ...(entry.frame ? { frame: entry.frame, at: entry.at } : {}),
                ...(entry.failedAt !== undefined ? { failedAt: entry.failedAt } : {}),
            };
        },
        forget(udid) {
            entries.delete(udid);
        },
    };
}

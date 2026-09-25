import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-phone WDA supervisor output (xcodebuild + `[wda-state]` lines).
 *
 * The supervisor child (`src/devices/wda/start.ts`) forwards everything
 * xcodebuild prints. That output is the only record of *why* WDA failed on a
 * phone, so it is kept twice: the last few hundred lines in memory (served by
 * the wda-service socket and the dashboard's admin log route) and a
 * size-rotated file per UDID under `.wda/logs/` for after-the-fact digging.
 */

/** Splits a byte stream into complete lines; a partial line waits for the next chunk. */
export class LineSplitter {
    private buffer = '';

    constructor(private readonly maxLineLength = 16 * 1024) {}

    push(chunk: Buffer | string): string[] {
        this.buffer += chunk.toString();
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        // A runaway line with no newline (a progress bar, a binary dump) must not
        // grow without bound: emit it in fixed-size pieces.
        while (this.buffer.length > this.maxLineLength) {
            lines.push(this.buffer.slice(0, this.maxLineLength));
            this.buffer = this.buffer.slice(this.maxLineLength);
        }
        return lines;
    }

    /** Whatever is left once the stream has ended. */
    flush(): string[] {
        const rest = this.buffer;
        this.buffer = '';
        return rest ? [rest] : [];
    }
}

/** A fixed-capacity ring of the most recent lines. */
export class RecentLines {
    private readonly lines: string[] = [];

    constructor(private readonly capacity: number) {}

    push(line: string): void {
        if (this.capacity <= 0) return;
        this.lines.push(line);
        if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    }

    /** The last `limit` lines, oldest first. */
    tail(limit = this.capacity): string[] {
        const count = Math.max(0, Math.min(limit, this.lines.length));
        return count ? this.lines.slice(-count) : [];
    }
}

/**
 * Appends to `file`, rotating to `file.1` … `file.<maxFiles>` once it would
 * exceed `maxBytes`. Writes are queued and applied in order by one async chain,
 * so thirty chatty phones never block the wda-service event loop.
 */
export class RotatingFileWriter {
    private size: number | undefined;
    private chain: Promise<void> = Promise.resolve();
    private pending: string[] = [];
    private scheduled = false;
    private failed = false;

    constructor(
        readonly file: string,
        private readonly maxBytes: number,
        private readonly maxFiles: number,
    ) {}

    write(text: string): void {
        if (this.failed) return;
        this.pending.push(text);
        if (this.scheduled) return;
        this.scheduled = true;
        this.chain = this.chain.then(() => this.drain());
    }

    /** Resolves once everything written so far is on disk. */
    async flush(): Promise<void> {
        await this.chain;
    }

    private async drain(): Promise<void> {
        this.scheduled = false;
        const text = this.pending.join('');
        this.pending = [];
        if (!text) return;
        try {
            await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            if (this.size === undefined) this.size = await stat(this.file).then((info) => info.size, () => 0);
            const bytes = Buffer.byteLength(text);
            if (this.size > 0 && this.size + bytes > this.maxBytes) await this.rotate();
            const handle = await open(this.file, 'a', 0o600);
            try {
                await handle.write(text);
            } finally {
                await handle.close();
            }
            this.size += bytes;
        } catch (error) {
            // Logging must never take the supervisor down; say so once and stop.
            this.failed = true;
            console.error(`WDA log ${this.file} disabled: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async rotate(): Promise<void> {
        if (this.maxFiles <= 0) {
            await rm(this.file, { force: true });
        } else {
            await rm(`${this.file}.${this.maxFiles}`, { force: true });
            for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
                await rename(`${this.file}.${index}`, `${this.file}.${index + 1}`).catch(ignoreMissing);
            }
            await rename(this.file, `${this.file}.1`).catch(ignoreMissing);
            await chmod(`${this.file}.1`, 0o600).catch(ignoreMissing);
        }
        this.size = 0;
    }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
    if (error.code !== 'ENOENT') throw error;
}

export interface WdaLogOptions {
    /** Directory for `<udid>.log`; `null` keeps lines in memory only. */
    directory: string | null;
    maxBytes: number;
    maxFiles: number;
    recentLines: number;
    now?: () => number;
}

export const DEFAULT_WDA_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_WDA_LOG_FILES = 3;
export const DEFAULT_WDA_RECENT_LINES = 200;

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** `WDA_LOG_DIR` (default `.wda/logs`), `WDA_LOG_MAX_BYTES`, `WDA_LOG_FILES`, `WDA_LOG_RECENT_LINES`. */
export function wdaLogOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WdaLogOptions {
    return {
        directory: path.resolve(env.WDA_LOG_DIR ?? '.wda/logs'),
        maxBytes: positiveInteger(env.WDA_LOG_MAX_BYTES, DEFAULT_WDA_LOG_MAX_BYTES) || DEFAULT_WDA_LOG_MAX_BYTES,
        maxFiles: positiveInteger(env.WDA_LOG_FILES, DEFAULT_WDA_LOG_FILES),
        recentLines: positiveInteger(env.WDA_LOG_RECENT_LINES, DEFAULT_WDA_RECENT_LINES),
    };
}

/** A UDID is hex and dashes; anything else is replaced so it can never escape the log directory. */
export function logFileName(udid: string): string {
    return `${udid.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'unknown'}.log`;
}

/** Replace a device passcode that appears as a standalone token. Secrets never reach a log. */
export function redactSecret(line: string, secret: string | undefined): string {
    if (!secret || secret.length < 4) return line;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return line.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g'), '[redacted]');
}

export class WdaLogStore {
    private readonly recent = new Map<string, RecentLines>();
    private readonly writers = new Map<string, RotatingFileWriter>();
    private readonly now: () => number;

    constructor(private readonly options: WdaLogOptions = {
        directory: null, maxBytes: DEFAULT_WDA_LOG_MAX_BYTES, maxFiles: DEFAULT_WDA_LOG_FILES, recentLines: DEFAULT_WDA_RECENT_LINES,
    }) {
        this.now = options.now ?? Date.now;
    }

    append(udid: string, line: string): void {
        const stamped = `${new Date(this.now()).toISOString()} ${line}`;
        let ring = this.recent.get(udid);
        if (!ring) {
            ring = new RecentLines(this.options.recentLines);
            this.recent.set(udid, ring);
        }
        ring.push(stamped);
        if (!this.options.directory) return;
        let writer = this.writers.get(udid);
        if (!writer) {
            writer = new RotatingFileWriter(path.join(this.options.directory, logFileName(udid)), this.options.maxBytes, this.options.maxFiles);
            this.writers.set(udid, writer);
        }
        writer.write(`${stamped}\n`);
    }

    /** The last `limit` stamped lines for a phone, oldest first; undefined when it has none. */
    tail(udid: string, limit?: number): string[] | undefined {
        return this.recent.get(udid)?.tail(limit);
    }

    /** Drop the in-memory lines for a phone that is no longer supervised (the file stays). */
    forget(udid: string): void {
        this.recent.delete(udid);
        const writer = this.writers.get(udid);
        this.writers.delete(udid);
        void writer?.flush();
    }

    async flush(): Promise<void> {
        await Promise.all(Array.from(this.writers.values(), (writer) => writer.flush()));
    }
}

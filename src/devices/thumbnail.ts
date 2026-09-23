import crypto from 'node:crypto';

import sharp from 'sharp';

export const DEFAULT_THUMBNAIL_WIDTH = 240;
export const MIN_THUMBNAIL_WIDTH = 120;
export const MAX_THUMBNAIL_WIDTH = 480;

/**
 * A grid still does not need the phone's native 1125×2436 PNG (up to a megabyte
 * or more per frame through the tunnel). A 240px JPEG is a few tens of KB and
 * looks the same at card size.
 */
export function makeThumbnail(png: Buffer, width = DEFAULT_THUMBNAIL_WIDTH): Promise<Buffer> {
    return sharp(png)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
}

/** `?w=` from the query string, clamped to the range the grid can sensibly ask for. */
export function thumbnailWidth(requested: unknown): number {
    const value = Number(requested);
    if (requested === undefined || requested === '' || !Number.isFinite(value)) return DEFAULT_THUMBNAIL_WIDTH;
    return Math.min(MAX_THUMBNAIL_WIDTH, Math.max(MIN_THUMBNAIL_WIDTH, Math.round(value)));
}

interface ThumbnailEntry {
    frame: Buffer;
    etag: string;
    thumbnails: Map<number, Promise<Buffer>>;
}

export interface ThumbnailCache {
    /** The ETag for a frame; computed once per frame. */
    etag(udid: string, frame: Buffer, width: number): string;
    /** The resized frame; the resize runs once per new frame and width. */
    thumbnail(udid: string, frame: Buffer, width: number): Promise<Buffer>;
    forget(udid: string): void;
}

/**
 * Keyed on frame identity: the screenshot cache hands back the same Buffer until
 * the device produces a new frame, so N viewers of one frame cost one resize.
 */
export function createThumbnailCache(resize: (png: Buffer, width: number) => Promise<Buffer> = makeThumbnail): ThumbnailCache {
    const entries = new Map<string, ThumbnailEntry>();
    const entryFor = (udid: string, frame: Buffer): ThumbnailEntry => {
        const existing = entries.get(udid);
        if (existing && existing.frame === frame) return existing;
        const hash = crypto.createHash('sha1').update(frame).digest('hex').slice(0, 16);
        const entry: ThumbnailEntry = { frame, etag: `t-${hash}`, thumbnails: new Map() };
        entries.set(udid, entry);
        return entry;
    };
    return {
        etag(udid, frame, width) {
            const { etag } = entryFor(udid, frame);
            // Different widths are different bodies, so they need different validators.
            return width === DEFAULT_THUMBNAIL_WIDTH ? `"${etag}"` : `"${etag}-w${width}"`;
        },
        thumbnail(udid, frame, width) {
            const entry = entryFor(udid, frame);
            let pending = entry.thumbnails.get(width);
            if (!pending) {
                pending = resize(frame, width);
                entry.thumbnails.set(width, pending);
                pending.catch(() => {
                    if (entry.thumbnails.get(width) === pending) entry.thumbnails.delete(width);
                });
            }
            return pending;
        },
        forget(udid) {
            entries.delete(udid);
        },
    };
}

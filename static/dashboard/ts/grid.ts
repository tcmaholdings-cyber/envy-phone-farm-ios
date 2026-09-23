// Device grid: loads and refreshes each card's screen thumbnail on its own
// staggered timer, so the htmx poll of #device-list only swaps card metadata.
// The server never puts a src on the preview <img>; htmx keeps the element
// (hx-preserve, stable id) across the swap and this script owns its picture.
// Wrapped in a block so its names do not collide with the other dashboard
// scripts, which tsc compiles as global scripts.
(() => {
    const MAX_IN_FLIGHT = 4; // below Chrome's 6-per-host so the htmx poll always gets a slot
    const MAX_BACKOFF_MS = 60_000;
    const DEFAULT_REFRESH_MS = 5_000;
    const epoch = performance.now();

    interface Tile {
        img: HTMLImageElement;
        src: string;
        refreshMs: number;
        index: number;
        count: number;
        visible: boolean;
        due: boolean;
        inFlight: boolean;
        queued: boolean;
        timer?: number;
        etag?: string;
        objectUrl?: string;
        lastOkAt?: number;
        failing: boolean;
        backoffMs?: number;
    }

    interface HtmxApi {
        ajax(method: string, url: string, options: { target: string; swap: string }): Promise<void>;
    }

    const tiles = new Map<HTMLImageElement, Tile>();
    const queue: Tile[] = [];
    let inFlight = 0;
    let lastSummary: string | null = null;

    const observer = 'IntersectionObserver' in window
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const tile = tiles.get(entry.target as HTMLImageElement);
                if (!tile) continue;
                tile.visible = entry.isIntersecting;
                if (tile.visible && tile.due) enqueue(tile);
            }
        }, { rootMargin: '200px 0px' })
        : null;

    function listRefreshMs(): number {
        const list = document.getElementById('device-list');
        const value = Number(list?.dataset.refreshMs);
        return Number.isFinite(value) && value >= 1000 ? value : DEFAULT_REFRESH_MS;
    }

    function cardOf(tile: Tile): HTMLElement | null {
        return tile.img.closest('.device-card');
    }

    function ageLabel(at: number | undefined): string {
        if (!at) return '';
        const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
        if (seconds < 60) return `updated ${seconds}s ago`;
        const minutes = Math.round(seconds / 60);
        return minutes < 60 ? `updated ${minutes}m ago` : `updated ${Math.round(minutes / 60)}h ago`;
    }

    function paintCard(tile: Tile): void {
        const card = cardOf(tile);
        if (!card) return;
        card.classList.toggle('stale', tile.failing);
        const age = card.querySelector<HTMLElement>('.preview-age');
        if (age && tile.lastOkAt) age.textContent = ageLabel(tile.lastOkAt);
    }

    function nextDelay(tile: Tile): number {
        if (tile.failing && tile.backoffMs) return tile.backoffMs;
        // Phase-lock each card to its own slot in the cycle so fetches are spread
        // evenly instead of arriving in a burst every refresh.
        const offset = (tile.index * tile.refreshMs) / Math.max(1, tile.count);
        const elapsed = performance.now() - epoch - offset;
        const remainder = ((elapsed % tile.refreshMs) + tile.refreshMs) % tile.refreshMs;
        return tile.refreshMs - remainder;
    }

    function schedule(tile: Tile): void {
        if (tile.timer !== undefined) window.clearTimeout(tile.timer);
        tile.timer = window.setTimeout(() => {
            tile.timer = undefined;
            tile.due = true;
            enqueue(tile);
        }, nextDelay(tile));
    }

    function enqueue(tile: Tile): void {
        if (!tiles.has(tile.img)) return;
        tile.due = true;
        // Hidden tab or scrolled-off card: stay due, fetch when it comes back.
        if (document.hidden || !tile.visible || tile.inFlight || tile.queued) return;
        tile.queued = true;
        queue.push(tile);
        pump();
    }

    function pump(): void {
        while (inFlight < MAX_IN_FLIGHT && queue.length) {
            const tile = queue.shift()!;
            tile.queued = false;
            if (!tiles.has(tile.img) || document.hidden || !tile.visible) continue;
            void load(tile);
        }
    }

    async function load(tile: Tile): Promise<void> {
        tile.inFlight = true;
        tile.due = false;
        inFlight += 1;
        try {
            // The validator is sent by hand (and the HTTP cache bypassed) so an
            // unchanged screen reaches this code as a real 304 with no body.
            const headers: Record<string, string> = tile.etag ? { 'if-none-match': tile.etag } : {};
            const response = await fetch(tile.src, { cache: 'no-store', headers });
            setConnectionLost(false);
            if (response.status === 304) {
                tile.lastOkAt = Date.now();
                succeed(tile);
            } else if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const probe = new Image();
                probe.src = url;
                try {
                    await probe.decode();
                } catch {
                    URL.revokeObjectURL(url);
                    throw new Error('thumbnail did not decode');
                }
                if (!tiles.has(tile.img)) {
                    URL.revokeObjectURL(url);
                    return;
                }
                const previous = tile.objectUrl;
                tile.img.src = url;
                tile.objectUrl = url;
                if (previous) URL.revokeObjectURL(previous);
                tile.etag = response.headers.get('etag') ?? undefined;
                tile.lastOkAt = Date.now();
                succeed(tile);
            } else {
                fail(tile);
            }
        } catch (error) {
            // A TypeError from fetch means the server itself is unreachable.
            if (error instanceof TypeError) setConnectionLost(true);
            fail(tile);
        } finally {
            tile.inFlight = false;
            inFlight -= 1;
            if (tiles.has(tile.img)) schedule(tile);
            pump();
        }
    }

    function succeed(tile: Tile): void {
        tile.failing = false;
        tile.backoffMs = undefined;
        paintCard(tile);
    }

    function fail(tile: Tile): void {
        // Keep the last frame; mark it stale and back off.
        tile.failing = true;
        tile.backoffMs = Math.min(MAX_BACKOFF_MS, (tile.backoffMs ?? tile.refreshMs) * 2);
        paintCard(tile);
    }

    function forgetTile(tile: Tile): void {
        if (tile.timer !== undefined) window.clearTimeout(tile.timer);
        if (tile.objectUrl) URL.revokeObjectURL(tile.objectUrl);
        observer?.unobserve(tile.img);
        tiles.delete(tile.img);
    }

    function scan(): void {
        const refreshMs = listRefreshMs();
        const images = Array.from(document.querySelectorAll<HTMLImageElement>('#device-list img[data-thumb-src]'));
        const present = new Set(images);
        for (const tile of Array.from(tiles.values())) {
            if (!present.has(tile.img) || !tile.img.isConnected) forgetTile(tile);
        }
        images.forEach((img, index) => {
            const existing = tiles.get(img);
            if (existing) {
                existing.index = index;
                existing.count = images.length;
                existing.refreshMs = refreshMs;
                paintCard(existing);
                return;
            }
            const tile: Tile = {
                img, src: img.dataset.thumbSrc ?? '', refreshMs, index, count: images.length,
                visible: observer === null, due: true, inFlight: false, queued: false, failing: false,
            };
            if (!tile.src) return;
            tiles.set(img, tile);
            if (observer) observer.observe(img);
            else enqueue(tile);
        });
        announce();
    }

    function announce(): void {
        const summary = document.querySelector('#device-list .grid-summary')?.textContent?.trim() ?? '';
        const announcer = document.getElementById('grid-announcer');
        if (announcer && lastSummary !== null && summary && summary !== lastSummary) announcer.textContent = summary;
        if (summary) lastSummary = summary;
    }

    function setConnectionLost(lost: boolean): void {
        const banner = document.getElementById('connection-banner');
        if (banner) banner.hidden = !lost;
        document.getElementById('device-list')?.classList.toggle('stale', lost);
    }

    function showGridError(message: string | null): void {
        const banner = document.getElementById('grid-error');
        if (!banner) return;
        banner.textContent = message ?? '';
        banner.hidden = !message;
    }

    function refreshAges(): void {
        for (const tile of tiles.values()) paintCard(tile);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        for (const tile of tiles.values()) if (tile.due) enqueue(tile);
    });

    // htmx swaps #device-list by outerHTML, so the old target is detached by the
    // time afterSwap fires; the settle that follows is the reliable moment to
    // pick up added and removed previews.
    document.body.addEventListener('htmx:afterSettle', () => scan());
    document.body.addEventListener('htmx:sendError', () => setConnectionLost(true));
    document.body.addEventListener('htmx:responseError', () => setConnectionLost(true));
    document.body.addEventListener('htmx:afterRequest', (event) => {
        const detail = (event as CustomEvent<{ successful?: boolean }>).detail;
        if (detail?.successful) setConnectionLost(false);
    });

    // Disconnect / Reconnect buttons on the cards and in the disabled list.
    document.addEventListener('click', async (event) => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-toggle-device]');
        if (!button) return;
        event.preventDefault();
        button.disabled = true;
        showGridError(null);
        try {
            const response = await fetch(`/api/devices/${button.dataset.toggleDevice ?? ''}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ disabled: button.dataset.disabled === 'true' }),
            });
            if (response.ok) {
                const htmx = (window as unknown as { htmx?: HtmxApi }).htmx;
                if (htmx) await htmx.ajax('GET', '/api/fragments/devices', { target: '#device-list', swap: 'outerHTML' });
                return;
            }
            const body = await response.json().catch(() => ({})) as { error?: string };
            button.disabled = false;
            showGridError(body.error ?? 'Request failed');
        } catch {
            button.disabled = false;
            showGridError('Could not reach the server. Try again.');
        }
    });

    window.setInterval(refreshAges, 5_000);
    scan();
})();

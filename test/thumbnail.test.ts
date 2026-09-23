import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import { makeThumbnail, thumbnailWidth } from '../src/devices/thumbnail.js';
import { RemoteDeviceError, type RemoteControl } from '../src/devices/wda-remote.js';

function png(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 45, b: 142 } } }).png().toBuffer();
}

test('makeThumbnail returns a JPEG no wider than 240px and never enlarges', async () => {
    const large = await makeThumbnail(await png(1125, 2436));
    assert.equal(large[0], 0xff);
    assert.equal(large[1], 0xd8);
    const largeMeta = await sharp(large).metadata();
    assert.equal(largeMeta.format, 'jpeg');
    assert.ok((largeMeta.width ?? 0) <= 240);

    const small = await sharp(await makeThumbnail(await png(100, 200))).metadata();
    assert.equal(small.width, 100, 'a smaller input is not enlarged');
});

test('thumbnailWidth clamps ?w= to 120-480', () => {
    assert.equal(thumbnailWidth(undefined), 240);
    assert.equal(thumbnailWidth('nonsense'), 240);
    assert.equal(thumbnailWidth('10'), 120);
    assert.equal(thumbnailWidth('10000'), 480);
    assert.equal(thumbnailWidth('300'), 300);
});

test('the thumbnail route serves a cacheable JPEG, 304s an unchanged frame, and 503s a dead phone', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-thumb-'));
    const configPath = path.join(directory, 'devices.json');
    await writeFile(configPath, JSON.stringify([{ name: 'Phone A', udid: 'udid-a', pluginData: {} }]));
    process.env.DEVICES_CONFIG_PATH = configPath;
    process.env.PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS = '0';
    context.after(() => { delete process.env.PHONE_FARM_SCREENSHOT_FAILURE_COOLDOWN_MS; });

    const { createApp } = await import('../src/api/app.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const { PluginRegistry } = await import('../src/registry.js');
    type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;

    const frame = await png(1125, 2436);
    const timeouts: Array<number | undefined> = [];
    const remote = {
        async getScreenshot(udid: string, options?: { timeoutMs?: number }) {
            timeouts.push(options?.timeoutMs);
            if (udid === 'udid-dead') throw new RemoteDeviceError('WebDriverAgent is unavailable');
            if (udid === 'udid-broken') throw new Error('boom');
            return frame;
        },
    } as unknown as RemoteControl;
    const scheduler = { async activeExecution() { return null; } } as unknown as SchedulerRepository;
    const app = await createApp({ plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme, remote });
    context.after(() => app.close());

    const first = await inject(app, { method: 'GET', url: '/api/devices/udid-a/remote/thumbnail' });
    assert.equal(first.statusCode, 200);
    assert.match(String(first.headers['content-type']), /^image\/jpeg/);
    assert.equal(first.headers['cache-control'], 'private, max-age=2');
    const etag = String(first.headers.etag);
    assert.match(etag, /^"t-[0-9a-f]{16}"$/);
    assert.equal(first.rawPayload[0], 0xff);
    assert.ok(first.rawPayload.length < frame.length, 'the thumbnail is smaller than the PNG');
    assert.equal(timeouts[0], 3_000, 'the grid path uses the short WDA deadline');

    const unchanged = await inject(app, { method: 'GET', url: '/api/devices/udid-a/remote/thumbnail', headers: { 'if-none-match': etag } });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.rawPayload.length, 0);

    const wide = await inject(app, { method: 'GET', url: '/api/devices/udid-a/remote/thumbnail?w=10000' });
    assert.equal(wide.statusCode, 200);
    assert.ok(((await sharp(wide.rawPayload).metadata()).width ?? 0) <= 480);
    assert.notEqual(wide.headers.etag, etag, 'a different width is a different body');

    const dead = await inject(app, { method: 'GET', url: '/api/devices/udid-dead/remote/thumbnail' });
    assert.equal(dead.statusCode, 503);
    assert.equal(dead.headers['cache-control'], 'no-store');
    assert.equal(dead.headers['x-device-state'], 'not-ready');

    const broken = await inject(app, { method: 'GET', url: '/api/devices/udid-broken/remote/thumbnail' });
    assert.equal(broken.statusCode, 503);
    assert.equal(broken.headers['x-device-state'], 'error');

    const full = await inject(app, { method: 'GET', url: '/api/devices/udid-a/remote/screenshot' });
    assert.equal(full.statusCode, 200);
    assert.match(String(full.headers['content-type']), /^image\/png/, 'the full-size screenshot is unchanged');
});

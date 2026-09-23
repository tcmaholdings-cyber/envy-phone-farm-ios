import { inject } from './support.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DeviceConnectionStatus } from '../src/devices/connection-manager.js';

const registered = [
    { name: 'Ready <script>alert(1)</script>', udid: 'udid-ready', pluginData: {} },
    { name: 'Waiting Phone', udid: 'udid-waiting', pluginData: {} },
    { name: 'Offline Phone', udid: 'udid-offline', pluginData: {} },
];
const connected = ['udid-ready', 'udid-waiting'].map((udid) => ({ name: udid, osVersion: '17.5', udid }));

function status(udid: string, wda: DeviceConnectionStatus['wda'], message: string): DeviceConnectionStatus {
    return {
        udid, physical: 'connected', wda, appium: 'ready', managed: true, message,
        retryCount: 0, updatedAt: new Date(0).toISOString(),
    };
}

// registry.ts freezes its default path at first import, so set the env before
// any src module loads and pull everything in dynamically.
async function build(context: TestContext, wdaStatuses: () => Promise<DeviceConnectionStatus[]>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-grid-fragment-'));
    const configPath = path.join(directory, 'devices.json');
    await writeFile(configPath, JSON.stringify(registered));
    process.env.DEVICES_CONFIG_PATH = configPath;

    const { createApp } = await import('../src/api/app.js');
    const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
    const { PluginRegistry } = await import('../src/registry.js');
    type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;

    const scheduler = { async activeExecution() { return null; } } as unknown as SchedulerRepository;
    const app = await createApp({
        plugins: new PluginRegistry([]), scheduler, dashboardTheme: defaultDashboardTheme,
        discoverDevices: async () => connected, wdaStatuses,
    });
    context.after(() => app.close());
    return app;
}

async function grid(context: TestContext, wdaStatuses: () => Promise<DeviceConnectionStatus[]>) {
    const app = await build(context, wdaStatuses);
    return async () => {
        const response = await inject(app, { method: 'GET', url: '/api/fragments/devices' });
        assert.equal(response.statusCode, 200);
        return response.body;
    };
}

function card(body: string, udid: string): string {
    const match = body.match(new RegExp(`<article class="device-card"[^>]*>(?:(?!</article>).)*/devices/${udid}"(?:(?!</article>).)*</article>`));
    assert.ok(match, `card for ${udid}`);
    return match[0];
}

test('only WDA-ready phones get a preview; the others say why', async (context) => {
    const fetch = await grid(context, async () => [
        status('udid-ready', 'ready', 'WDA is ready'),
        status('udid-waiting', 'connecting', 'Waiting for <WDA> on port 8105'),
    ]);
    const body = await fetch();

    const ready = card(body, 'udid-ready');
    assert.match(ready, /data-state="ready"/);
    assert.match(ready, /<img id="preview-[0-9a-f]{12}" class="device-preview" hx-preserve="true" data-thumb-src="\/api\/devices\/udid-ready\/remote\/thumbnail" data-refresh-ms="5000"/);
    assert.match(ready, /Screen of Ready &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(ready, /<img[^>]* src=/, 'grid.js owns the picture; the server never sets a src');

    const waiting = card(body, 'udid-waiting');
    assert.match(waiting, /data-state="not-ready"/);
    assert.match(waiting, /device-preview-frame unavailable/);
    assert.match(waiting, /WDA not ready/);
    assert.match(waiting, /title="Waiting for &lt;WDA&gt; on port 8105"/);
    assert.doesNotMatch(waiting, /<img/);

    const offline = card(body, 'udid-offline');
    assert.match(offline, /data-state="offline"/);
    assert.doesNotMatch(offline, /<img/);

    assert.match(body, /<p class="grid-summary">1 online · 1 need attention · 3 total<\/p>/);
    for (const banned of ['?t=', 'onerror', '<script', 'aria-live']) {
        assert.ok(!body.includes(banned), `fragment must not contain ${banned}`);
    }

    const again = await fetch();
    assert.equal(again.match(/id="(preview-[0-9a-f]{12})"/)?.[1], body.match(/id="(preview-[0-9a-f]{12})"/)?.[1],
        'preview ids are stable across polls so htmx can preserve the image');
});

test('when the WDA supervisor is unreachable, connected phones still get a preview', async (context) => {
    const fetch = await grid(context, async () => { throw new Error('ENOENT wda-service.sock'); });
    const body = await fetch();
    assert.match(card(body, 'udid-ready'), /data-thumb-src=/);
    assert.match(card(body, 'udid-waiting'), /data-thumb-src=/);
    assert.match(card(body, 'udid-offline'), /data-state="offline"/);
    assert.match(body, /2 online · 0 need attention · 3 total/);
});

test('card actions carry stable ids so htmx restores keyboard focus after a poll', async (context) => {
    const fetch = await grid(context, async () => [status('udid-ready', 'ready', 'WDA is ready')]);
    const body = await fetch();
    for (const udid of ['udid-ready', 'udid-waiting', 'udid-offline']) {
        const html = card(body, udid);
        const key = html.match(/id="open-([0-9a-f]{12})"/)?.[1];
        assert.ok(key, `open link id for ${udid}`);
        assert.match(html, new RegExp(`<button type="button" id="toggle-${key}" class="button secondary device-toggle"`));
        assert.match(html, new RegExp(`<p class="device-meta" title="${udid}">`), 'the full UDID is readable on hover');
    }
    const ready = card(body, 'udid-ready');
    assert.equal(ready.match(/id="preview-([0-9a-f]{12})"/)?.[1], ready.match(/id="open-([0-9a-f]{12})"/)?.[1]);
    const again = await fetch();
    assert.equal(card(again, 'udid-offline').match(/id="toggle-([0-9a-f]{12})"/)?.[1], card(body, 'udid-offline').match(/id="toggle-([0-9a-f]{12})"/)?.[1]);
});

test('the summary for a registered but unplugged phone keeps its header', async (context) => {
    const app = await build(context, async () => []);
    const response = await inject(app, { method: 'GET', url: '/api/devices/udid-offline/fragments/summary' });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /<section id="device-summary" class="device-summary error">/);
    assert.match(response.body, /<span class="eyebrow">Registered device<\/span><h1>Offline Phone<\/h1>/);
    assert.match(response.body, /<span class="connected offline"><span><\/span>Offline<\/span>/);
    assert.match(response.body, /<code title="UDID">udid-offline<\/code>/);
    assert.match(response.body, /Device disconnected/);
    assert.doesNotMatch(response.body, /data-screen-width/, 'device.js must not try to stream');

    const unknown = await inject(app, { method: 'GET', url: '/api/devices/udid-nobody/fragments/summary' });
    assert.equal(unknown.statusCode, 404);
});

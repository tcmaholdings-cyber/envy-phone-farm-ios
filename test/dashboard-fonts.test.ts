import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp, DASHBOARD_FONTS } from '../src/api/app.js';
import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { inject } from './support.js';

async function app() {
    return createApp({ plugins: new PluginRegistry([]), scheduler: {} as SchedulerRepository, dashboardTheme: defaultDashboardTheme });
}

test('the self-hosted fonts are served from a whitelist, cacheably', async (context) => {
    const server = await app();
    context.after(() => server.close());
    for (const name of DASHBOARD_FONTS) {
        const bare = await inject(server, { method: 'GET', url: `/assets/fonts/${name}` });
        assert.equal(bare.statusCode, 200, name);
        assert.equal(bare.headers['content-type'], 'font/woff2', name);
        assert.equal(bare.rawPayload.subarray(0, 4).toString('latin1'), 'wOF2', `${name} is a WOFF2 file`);
        assert.equal(bare.headers['cache-control'], 'public, max-age=86400', name);
        const etag = String(bare.headers.etag);
        const revalidated = await inject(server, { method: 'GET', url: `/assets/fonts/${name}`, headers: { 'if-none-match': etag } });
        assert.equal(revalidated.statusCode, 304, name);
        const versioned = await inject(server, { method: 'GET', url: `/assets/fonts/${name}?v=x` });
        assert.match(String(versioned.headers['cache-control']), /immutable/, name);
    }
    for (const url of ['/assets/fonts/OFL.txt', '/assets/fonts/..%2Fstyles.css', '/assets/fonts/..%2F..%2F..%2Fpackage.json', '/assets/fonts/nope.woff2']) {
        const response = await inject(server, { method: 'GET', url });
        assert.equal(response.statusCode, 404, url);
    }
});

test('every themed page preloads the fonts at the same versioned URL the stylesheet uses', async (context) => {
    const server = await app();
    context.after(() => server.close());
    const css = (await inject(server, { method: 'GET', url: '/assets/styles.css' })).body;
    const cssFontUrls = new Set([...css.matchAll(/url\((\/assets\/fonts\/[^)]+)\)/g)].map((match) => match[1]));
    for (const url of cssFontUrls) assert.match(url!, /\?v=[\w-]+$/, 'stylesheet font URLs are content-hashed');
    for (const page of ['/', '/tasks', '/devices/register']) {
        const html = (await inject(server, { method: 'GET', url: page })).body;
        const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map((match) => match[1]);
        assert.equal(preloads.length, 2, page);
        for (const href of preloads) assert.ok(cssFontUrls.has(href), `${page}: ${href} matches a stylesheet URL`);
        assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, 'no external font host');
    }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/api/app.js';
import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { inject } from './support.js';

async function app() {
    return createApp({ plugins: new PluginRegistry([]), scheduler: {} as SchedulerRepository, dashboardTheme: defaultDashboardTheme });
}

test('each page marks its own nav link as current, and only that one', async (context) => {
    const server = await app();
    context.after(() => server.close());
    const pages: Array<[string, string]> = [['/', 'Devices'], ['/tasks', 'Tasks'], ['/devices/register', 'Register']];
    for (const [url, label] of pages) {
        const html = (await inject(server, { method: 'GET', url })).body;
        const current = [...html.matchAll(/<a class="nav-link" href="[^"]+" aria-current="page">([^<]+)<\/a>/g)].map((match) => match[1]);
        assert.deepEqual(current, [label], url);
    }
});

test('the grid page is wide, has no poll re-announcement, and starts with skeletons', async (context) => {
    const server = await app();
    context.after(() => server.close());
    const html = (await inject(server, { method: 'GET', url: '/' })).body;
    assert.match(html, /<body class="page-grid">/);
    assert.match(html, /<title>Devices · /);
    assert.match(html, /href="\/devices\/register">Register a phone</);
    assert.equal((html.match(/device-card skeleton/g) ?? []).length, 8);
});

test('the fallback 404 page is dark, escaped and offers a way back', async (context) => {
    const server = await app();
    context.after(() => server.close());
    const response = await inject(server, { method: 'GET', url: '/devices/%3Cscript%3E' });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /--bg:#0a0a0c/);
    assert.match(response.body, /Device not found/);
    assert.match(response.body, /href="\/">Back to devices</);
    assert.doesNotMatch(response.body, /<script>/);
});

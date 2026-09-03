import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/api/app.js';
import { brandingFromEnv, brandHtml, footerHtml } from '../src/branding.js';
import { defaultDashboardTheme } from '../src/dashboard-theme.js';
import { PluginRegistry } from '../src/registry.js';
import type { SchedulerRepository } from '../src/scheduler/repository.js';
import { inject } from './support.js';

const BRAND_KEYS = [
    'PHONE_FARM_BRAND_NAME', 'PHONE_FARM_BRAND_TITLE', 'PHONE_FARM_BRAND_BY', 'PHONE_FARM_BRAND_BY_URL',
    'PHONE_FARM_BRAND_LOGO', 'PHONE_FARM_FOOTER_TEXT', 'PHONE_FARM_BRAND_URL',
] as const;

function withEnv(values: Partial<Record<(typeof BRAND_KEYS)[number], string>>): () => void {
    const saved = Object.fromEntries(BRAND_KEYS.map((key) => [key, process.env[key]]));
    for (const key of BRAND_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return () => {
        for (const key of BRAND_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    };
}

async function app() {
    return createApp({
        plugins: new PluginRegistry([]),
        scheduler: {} as SchedulerRepository,
        dashboardTheme: defaultDashboardTheme,
    });
}

test('stock branding: iOS Farm / by Handler, Agniverse footer, no logo', async (context) => {
    context.after(withEnv({}));
    const branding = brandingFromEnv();
    assert.equal(branding.name, 'iOS Farm');
    assert.match(brandHtml(branding), /class="brand-name" href="\/">iOS Farm</);
    assert.match(brandHtml(branding), /href="https:\/\/gethandler.ai"[^>]*>by Handler</);
    assert.doesNotMatch(brandHtml(branding), /brand-logo/);
    assert.match(footerHtml(branding), /Agniverse/);

    const server = await app();
    context.after(() => server.close());
    const res = await inject(server, { method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<title>[^<]*· Handler<\/title>/);
    assert.match(res.body, /iOS Farm/);
    assert.doesNotMatch(res.body, /__BRAND__|__BRAND_TITLE__|__FOOTER__/);
    const logo = await inject(server, { method: 'GET', url: '/assets/brand-logo' });
    assert.equal(logo.statusCode, 404);
});

test('white-label branding from the environment, with a served logo', async (context) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-farm-brand-'));
    const logoPath = path.join(dir, 'logo.png');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await writeFile(logoPath, png);
    context.after(withEnv({
        PHONE_FARM_BRAND_NAME: 'Envy <Farm>',
        PHONE_FARM_BRAND_TITLE: 'Envy',
        PHONE_FARM_BRAND_BY: 'by Envy LLC',
        PHONE_FARM_BRAND_BY_URL: 'https://envy.example',
        PHONE_FARM_BRAND_LOGO: logoPath,
        PHONE_FARM_FOOTER_TEXT: '© Envy LLC',
        PHONE_FARM_BRAND_URL: 'https://envy.example',
    }));

    const server = await app();
    context.after(() => server.close());
    for (const url of ['/', '/tasks', '/devices/register']) {
        const res = await inject(server, { method: 'GET', url });
        assert.equal(res.statusCode, 200, url);
        assert.match(res.body, /class="brand-name" href="\/">Envy &lt;Farm&gt;</, url);
        assert.match(res.body, /href="https:\/\/envy.example"[^>]*>by Envy LLC</, url);
        assert.match(res.body, /<img class="brand-logo" src="\/assets\/brand-logo\?v=[\w-]+"/, url);
        assert.match(res.body, /<title>[^<]*· Envy<\/title>/, url);
        assert.match(res.body, /<a href="https:\/\/envy.example"[^>]*>© Envy LLC<\/a>/, url);
        assert.doesNotMatch(res.body, /Handler|Agniverse/, url);
    }
    const logo = await inject(server, { method: 'GET', url: '/assets/brand-logo?v=x' });
    assert.equal(logo.statusCode, 200);
    assert.equal(logo.headers['content-type'], 'image/png');
    assert.ok(logo.rawPayload.equals(png));
    assert.match(String(logo.headers['cache-control']), /immutable/);
});

test('an empty PHONE_FARM_BRAND_BY hides the credit; a missing logo file is skipped with a warning', async (context) => {
    context.after(withEnv({ PHONE_FARM_BRAND_BY: '', PHONE_FARM_BRAND_LOGO: '/nonexistent/logo.png' }));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    context.after(() => { console.warn = original; });

    const server = await app();
    context.after(() => server.close());
    const res = await inject(server, { method: 'GET', url: '/' });
    assert.doesNotMatch(res.body, /brand-by|brand-logo/);
    assert.ok(warnings.some((line) => line.includes('PHONE_FARM_BRAND_LOGO')));
});

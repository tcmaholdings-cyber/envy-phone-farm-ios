import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DASHBOARD_FONTS } from '../src/api/app.js';

// The dashboard stylesheet is the Envy theme. Every colour must be a token in
// :root so another deployment re-skins by editing that block alone, and the
// palette rules (no white text on hot pink, an 11px type floor) stay true as
// the file grows.
const stylesheet = new URL('../static/dashboard/styles.css', import.meta.url);

/** The stylesheet with comments and every `:root { … }` token block removed. */
async function outsideRoot(): Promise<string> {
    const css = (await readFile(stylesheet, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    return css.replace(/:root\s*\{[^{}]*\}/g, '');
}

function declarationValues(css: string): Array<{ property: string; value: string }> {
    return [...css.matchAll(/([-a-z]+)\s*:\s*([^;{}]+)/g)]
        .filter(([, property]) => !['hover', 'focus', 'active', 'root', 'not', 'is', 'has', 'checked', 'disabled'].includes(property!))
        .map(([, property, value]) => ({ property: property!, value: value!.trim() }));
}

test('no raw colour literals outside :root in styles.css', async () => {
    const offenders = declarationValues(await outsideRoot())
        .filter(({ value }) => /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(value.replace(/#fff\b/gi, '')))
        .map(({ property, value }) => `${property}: ${value}`);
    assert.deepEqual(offenders, [], 'use a :root token instead of a literal colour');
});

test('type never drops below 11px and Poppins 300 is not used', async () => {
    const css = await outsideRoot();
    const small = [...css.matchAll(/font(?:-size)?\s*:[^;{}]*?(\d+(?:\.\d+)?)px/g)]
        .map((match) => Number(match[1])).filter((size) => size < 11);
    assert.deepEqual(small, [], 'the smallest type size is 11px');
    assert.doesNotMatch(css, /font-weight\s*:\s*300|font\s*:\s*300\b/, 'no light weight');
});

test('white text never sits on the #ff2d8e pink', async () => {
    const css = await outsideRoot();
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const onPink = /background(?:-color)?\s*:\s*var\(--pink\)/.test(body!);
        const white = /(?:^|;)\s*color\s*:\s*(?:#fff\b|var\(--ink-on-accent\))/.test(body!);
        assert.ok(!(onPink && white), `${selector!.trim()} puts white text on --pink; use --pink-deep`);
    }
});

test('every @font-face URL is a whitelisted, served font', async () => {
    const css = await readFile(stylesheet, 'utf8');
    const urls = [...css.matchAll(/url\(\/assets\/fonts\/([^)]+)\)/g)].map((match) => match[1]);
    assert.ok(urls.length >= 4);
    for (const name of urls) assert.ok((DASHBOARD_FONTS as readonly string[]).includes(name!), `${name} is not in DASHBOARD_FONTS`);
});

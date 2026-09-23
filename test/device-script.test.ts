import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = () => readFile(new URL('../static/dashboard/assets/device.js', import.meta.url), 'utf8');
const template = () => readFile(new URL('../static/dashboard/templates/device.html', import.meta.url), 'utf8');

// device.js has no DOM test harness; pin the contract between the summary
// fragment the server renders and what the compiled script reacts to.
test('device.js switches the screen controls off for a disconnected summary', async () => {
    const source = await script();
    assert.match(source, /#device-summary\.error/, 'the disconnected fragment is detected');
    assert.match(source, /Phone disconnected/);
    assert.match(source, /Not connected/);
    assert.match(source, /aria-disabled/);
});

test('device.js localizes run times rendered as <time data-local-time>', async () => {
    assert.match(await script(), /time\[data-local-time\]/);
});

test('remote controls use one monochrome icon set, not colour emoji', async () => {
    const html = await template();
    assert.doesNotMatch(html, /\u{1F513}|◼|◻/u);
    assert.ok((html.match(/class="control-icon"/g) ?? []).length >= 4);
});

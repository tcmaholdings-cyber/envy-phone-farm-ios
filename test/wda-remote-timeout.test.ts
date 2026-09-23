import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { RemoteDeviceError, WdaRemoteControl } from '../src/devices/wda-remote.js';

test('getScreenshot honours a per-call timeout instead of the 10s client default', async (context) => {
    // A WebDriverAgent that accepts the connection and never answers.
    const server = http.createServer(() => { /* hang */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    }));
    const { port } = server.address() as AddressInfo;
    const remote = new WdaRemoteControl({ wdaUrl: `http://127.0.0.1:${port}`, deviceUdid: 'udid-a', timeoutMs: 10_000 });

    const started = Date.now();
    await assert.rejects(remote.getScreenshot('udid-a', { timeoutMs: 200 }), RemoteDeviceError);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `expected the 200ms deadline, took ${elapsed}ms`);
});

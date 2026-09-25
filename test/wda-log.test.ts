import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { DeviceConnectionManager } from '../src/devices/connection-manager.js';
import {
    LineSplitter, logFileName, RecentLines, redactSecret, RotatingFileWriter, WdaLogStore, wdaLogOptionsFromEnv,
} from '../src/devices/wda-log.js';
import { createWdaServiceHttpServer } from '../src/devices/wda-service-http.js';
import { requestWdaService } from '../src/devices/wda-service-client.js';

test('LineSplitter only emits complete lines and caps a runaway line', () => {
    const splitter = new LineSplitter(32);
    assert.deepEqual(splitter.push('Unlock iPh'), []);
    assert.deepEqual(splitter.push('one to Continue\r\nnext'), ['Unlock iPhone to Continue']);
    assert.deepEqual(splitter.push(' line\n'), ['next line']);
    assert.deepEqual(splitter.push('tail'), []);
    assert.deepEqual(splitter.flush(), ['tail']);
    assert.deepEqual(splitter.flush(), []);
    const capped = new LineSplitter(8);
    assert.deepEqual(capped.push('0123456789abcdefgh'), ['01234567', '89abcdef']);
    assert.deepEqual(capped.flush(), ['gh']);
});

test('RecentLines keeps only the newest lines', () => {
    const ring = new RecentLines(3);
    for (const line of ['a', 'b', 'c', 'd', 'e']) ring.push(line);
    assert.deepEqual(ring.tail(), ['c', 'd', 'e']);
    assert.deepEqual(ring.tail(2), ['d', 'e']);
    assert.deepEqual(new RecentLines(0).tail(), []);
});

test('RotatingFileWriter rotates by size and keeps a bounded number of files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-wda-log-'));
    const file = path.join(directory, 'phone.log');
    const writer = new RotatingFileWriter(file, 100, 2);
    for (let index = 0; index < 10; index += 1) {
        writer.write(`${String(index).padStart(2, '0')}${'x'.repeat(37)}\n`); // 40 bytes each
        await writer.flush();
    }
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, ['phone.log', 'phone.log.1', 'phone.log.2']);
    for (const name of files) assert.ok((await stat(path.join(directory, name))).size <= 100, name);
    const current = await readFile(file, 'utf8');
    assert.match(current, /^08x+\n09x+\n$/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('file names cannot escape the log directory and passcodes are redacted', () => {
    assert.equal(logFileName('00008030-001A2B3C'), '00008030-001A2B3C.log');
    assert.equal(logFileName('../../etc/passwd'), '__.._etc_passwd.log');
    assert.equal(redactSecret('typed 482913 into the field', '482913'), 'typed [redacted] into the field');
    assert.equal(redactSecret('build 14829130 ok', '482913'), 'build 14829130 ok');
    assert.equal(redactSecret('anything', undefined), 'anything');
});

test('wdaLogOptionsFromEnv defaults to 5 MB x 3 under .wda/logs', () => {
    const options = wdaLogOptionsFromEnv({});
    assert.equal(options.directory, path.resolve('.wda/logs'));
    assert.equal(options.maxBytes, 5 * 1024 * 1024);
    assert.equal(options.maxFiles, 3);
    assert.equal(options.recentLines, 200);
    assert.equal(wdaLogOptionsFromEnv({ WDA_LOG_DIR: '/tmp/x', WDA_LOG_MAX_BYTES: '1000', WDA_LOG_FILES: '5' }).maxFiles, 5);
});

function fakeChild() {
    const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, killed: false,
        kill() {
            child.killed = true;
            child.exitCode = 0;
            setImmediate(() => child.emit('exit', 0, null));
            return true;
        },
    });
    return child;
}

test('the supervisor keeps xcodebuild output per phone, parses split state lines, and writes the log file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-wda-mgr-'));
    const logs = new WdaLogStore({ directory, maxBytes: 1024 * 1024, maxFiles: 3, recentLines: 200, now: () => 0 });
    const child = fakeChild();
    let clock = 1_000;
    const manager = new DeviceConnectionManager({
        loadDevices: async () => [{ name: 'One', udid: 'udid-1', passcode: '482913', pluginData: {} }],
        connectedUdids: async () => ['udid-1'],
        endpointReady: async () => false,
        spawnSupervisor: () => child as never,
        now: () => clock,
        logs,
    });
    await manager.reconcile();
    child.stdout.write('Testing started on iPh');
    child.stderr.write('stderr line one\n');
    child.stdout.write('one\n[wda-state] {"state":"err');
    child.stdout.write('or","message":"WDA exited with code 65; retrying in 2s"}\n');
    child.stdout.write('passcode 482913 typed\n');
    await new Promise((resolve) => setImmediate(resolve));

    const status = manager.status('udid-1')!;
    assert.equal(status.wda, 'error');
    assert.equal(status.restarts, 1);
    assert.ok(status.notReadySince);
    assert.equal(status.disconnectedSince, undefined);

    const lines = manager.logs('udid-1')!;
    assert.ok(lines.some((line) => line.endsWith('Testing started on iPhone')), lines.join('\n'));
    assert.ok(lines.some((line) => line.endsWith('stderr line one')));
    assert.ok(lines.some((line) => line.endsWith('passcode [redacted] typed')));
    assert.ok(!lines.some((line) => line.includes('482913')));
    assert.deepEqual(manager.logs('udid-1', 1)!.length, 1);
    assert.equal(manager.logs('nope'), undefined);

    clock = 2_000;
    child.stdout.write('[wda-state] {"state":"ready","message":"WDA is ready"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.status('udid-1')!.notReadySince, undefined);

    await manager.close();
    const file = await readFile(path.join(directory, 'udid-1.log'), 'utf8');
    assert.match(file, /Testing started on iPhone/);
    assert.doesNotMatch(file, /482913/);
});

test('the wda-service socket API serves a phone\'s recent log lines', async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-wda-sock-'));
    const socketPath = path.join(directory, 's.sock');
    const server = createWdaServiceHttpServer({
        async start() {}, async close() {}, status: () => undefined, statuses: () => [], reconnect: async () => undefined,
        logs: (udid, limit) => (udid === 'udid-1' ? ['a', 'b', 'c'].slice(-(limit ?? 3)) : undefined),
    }, () => {});
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const found = await requestWdaService('/devices/udid-1/logs?lines=2', { socketPath });
    assert.equal(found.statusCode, 200);
    assert.deepEqual(JSON.parse(found.body), { udid: 'udid-1', lines: ['b', 'c'] });
    const missing = await requestWdaService('/devices/other/logs', { socketPath });
    assert.equal(missing.statusCode, 404);
});

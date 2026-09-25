import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const launchd = fileURLToPath(new URL('../deploy/launchd/', import.meta.url));
const PUSH_URL = 'https://hc-ping.example/secret-check-uuid';

/**
 * A copy of deploy/launchd in a throwaway repo, with a fake curl that answers
 * the readiness URL with FAKE_READY_CODE and records every URL it was asked
 * for. No network, no launchctl.
 */
async function sandbox(envFile: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pf-heartbeat-'));
    await mkdir(path.join(root, 'deploy/launchd'), { recursive: true });
    for (const name of ['heartbeat.sh', 'install-agents.sh']) {
        await copyFile(path.join(launchd, name), path.join(root, 'deploy/launchd', name));
    }
    await writeFile(path.join(root, '.env'), envFile, { mode: 0o600 });
    const calls = path.join(root, 'curl-calls');
    const fakeCurl = path.join(root, 'fake-curl');
    await writeFile(fakeCurl, `#!/bin/bash
url="\${@: -1}"
echo "$url" >> "${calls}"
case "$url" in
  */health/ready) printf '{"ok":false}\\n%s' "\${FAKE_READY_CODE:-200}" ;;
  *) exit "\${FAKE_PUSH_EXIT:-0}" ;;
esac
`);
    await chmod(fakeCurl, 0o755);
    const heartbeat = (env: Record<string, string> = {}, args: string[] = []) => run('/bin/bash', [path.join(root, 'deploy/launchd/heartbeat.sh'), ...args], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, CURL: fakeCurl, ...env },
    }).catch((error: { code?: number; stdout?: string }) => ({ stdout: error.stdout ?? '', stderr: '', code: error.code }));
    const called = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { root, heartbeat, called };
}

test('heartbeat.sh pings the push URL only when /health/ready answers 200', async () => {
    const { heartbeat, called } = await sandbox(`WEB_PORT=3999\nPHONE_FARM_HEARTBEAT_URL="${PUSH_URL}"\n`);
    const ok = await heartbeat();
    assert.deepEqual(await called(), ['http://127.0.0.1:3999/health/ready', PUSH_URL]);
    assert.doesNotMatch(ok.stdout, /secret-check-uuid/, 'the push URL is a credential and is never printed');
    assert.match(ok.stdout, /heartbeat ok/);
    // A second healthy run logs nothing: the state has not changed.
    assert.equal((await heartbeat()).stdout, '');
});

test('heartbeat.sh stays silent towards the monitor when the farm is not ready', async () => {
    const { heartbeat, called } = await sandbox(`PHONE_FARM_HEARTBEAT_URL=${PUSH_URL}\n`);
    const result = await heartbeat({ FAKE_READY_CODE: '503' });
    assert.deepEqual(await called(), ['http://127.0.0.1:3000/health/ready']);
    assert.match(result.stdout, /not-ready: .* answered 503/);
    assert.doesNotMatch(result.stdout, /secret-check-uuid/);
});

test('heartbeat.sh does nothing to the monitor without PHONE_FARM_HEARTBEAT_URL, and --check never pings', async () => {
    const { heartbeat, called } = await sandbox('WEB_PORT=3000\n');
    await heartbeat();
    assert.deepEqual(await called(), ['http://127.0.0.1:3000/health/ready']);
    const configured = await sandbox(`PHONE_FARM_HEARTBEAT_URL=${PUSH_URL}\n`);
    const check = await configured.heartbeat({}, ['--check']);
    assert.match(check.stdout, /^200 /);
    assert.deepEqual(await configured.called(), ['http://127.0.0.1:3000/health/ready']);
});

test('the environment wins over .env and PHONE_FARM_READY_URL overrides the local URL', async () => {
    const { heartbeat, called } = await sandbox('PHONE_FARM_HEARTBEAT_URL=https://from-dotenv.example/x\n');
    await heartbeat({ PHONE_FARM_HEARTBEAT_URL: 'https://from-env.example/y', PHONE_FARM_READY_URL: 'http://127.0.0.1:4000/health/ready' });
    assert.deepEqual(await called(), ['http://127.0.0.1:4000/health/ready', 'https://from-env.example/y']);
});

async function dryRunInstaller(envFile: string): Promise<string> {
    const { root } = await sandbox(envFile);
    const { stdout } = await run('/bin/bash', [path.join(root, 'deploy/launchd/install-agents.sh'), '--dry-run'], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, PHONE_FARM_LAUNCHD_PREFIX: 'com.test.pf' },
    });
    return stdout;
}

test('install-agents.sh adds a 60 s heartbeat agent only when the push URL is configured, and never writes it into the plist', async () => {
    const withUrl = await dryRunInstaller(`PHONE_FARM_HEARTBEAT_URL=${PUSH_URL}\n`);
    assert.match(withUrl, /com\.test\.pf\.heartbeat\.plist/);
    assert.match(withUrl, /deploy\/launchd\/heartbeat\.sh<\/string>/);
    assert.match(withUrl, /<key>StartInterval<\/key><integer>60<\/integer>/);
    assert.doesNotMatch(withUrl, /secret-check-uuid/);
    for (const name of ['db', 'appium', 'wda-service', 'worker', 'web']) assert.match(withUrl, new RegExp(`com\\.test\\.pf\\.${name}\\.plist`));
    // The long-running agents keep their KeepAlive and get no StartInterval.
    assert.equal(withUrl.match(/StartInterval/g)?.length, 1);

    const without = await dryRunInstaller('WEB_PORT=3000\n# PHONE_FARM_HEARTBEAT_URL=\n');
    assert.doesNotMatch(without, /heartbeat\.plist/);
    assert.match(without, /PHONE_FARM_HEARTBEAT_URL is not set/);
});

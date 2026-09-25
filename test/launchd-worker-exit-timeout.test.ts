import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the launchd worker agent gets an ExitTimeOut longer than the drain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pf-launchd-'));
    await mkdir(path.join(root, 'deploy', 'launchd'), { recursive: true });
    const installer = path.join(root, 'deploy', 'launchd', 'install-agents.sh');
    await copyFile(fileURLToPath(new URL('../deploy/launchd/install-agents.sh', import.meta.url)), installer);
    await writeFile(path.join(root, '.env'), '');
    const run = spawnSync('bash', [installer, '--dry-run'], {
        encoding: 'utf8', env: { ...process.env, HOME: root, PHONE_FARM_WORKER_EXIT_TIMEOUT: '' },
    });
    assert.equal(run.status, 0, run.stderr);
    const plists = Object.fromEntries(run.stdout.split('----- ').slice(1).map((chunk) => {
        const [target = '', ...body] = chunk.split('\n');
        return [path.basename(target, '.plist').split('.').pop() ?? '', body.join('\n')];
    }));
    const timeout = /<key>ExitTimeOut<\/key><integer>(\d+)<\/integer>/.exec(plists.worker ?? '');
    assert.ok(timeout, 'worker plist declares ExitTimeOut');
    assert.ok(Number(timeout[1]) > 120 + 15, 'above WORKER_DRAIN_SECONDS + WORKER_KILL_GRACE_SECONDS defaults');
    assert.doesNotMatch(plists.web ?? '', /ExitTimeOut/);
});

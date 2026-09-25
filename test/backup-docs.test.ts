import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The nightly backup in docs/operations.md is the only copy of uploaded media.
// Run its `tar` step as documented against a fake shared/ directory and check
// the archive holds every file a scheduler.assets row can point at: uploads/
// (POST /api/assets) and assets/ (the TikTok post form).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function documentedTarCommand(): string {
    const operations = readFileSync(path.join(repoRoot, 'docs/operations.md'), 'utf8');
    const section = operations.slice(operations.indexOf('## Backups'));
    const match = /&& (tar czf backups\/state-[^\n]*?) \\\n/.exec(section);
    assert.ok(match, 'docs/operations.md → Backups has a `tar czf backups/state-…` step');
    return match[1]!;
}

test('the documented backup archives every uploaded media file', () => {
    const shared = mkdtempSync(path.join(os.tmpdir(), 'phone-farm-backup-'));
    try {
        const write = (relative: string, content: string) => {
            mkdirSync(path.dirname(path.join(shared, relative)), { recursive: true });
            writeFileSync(path.join(shared, relative), content);
        };
        write('.env', 'WEB_PORT=3999\n');
        write('devices.json', '[]\n');
        write('.scheduler-data/uploads/9f1c2d3e-upload', 'dashboard upload\n');
        write('.scheduler-data/assets/post-abc123/00-clip.mp4', 'post media\n');
        mkdirSync(path.join(shared, 'backups'));

        const result = spawnSync('bash', ['-c', `set -eo pipefail; ${documentedTarCommand()}`], { cwd: shared, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);

        const archive = spawnSync('bash', ['-c', 'tar -tzf backups/state-*.tgz'], { cwd: shared, encoding: 'utf8' });
        assert.equal(archive.status, 0, archive.stderr);
        const entries = archive.stdout.split('\n');
        for (const file of ['.env', 'devices.json', '.scheduler-data/uploads/9f1c2d3e-upload', '.scheduler-data/assets/post-abc123/00-clip.mp4']) {
            assert.ok(entries.includes(file), `${file} is in the backup (got: ${entries.join(', ')})`);
        }
    } finally {
        rmSync(shared, { recursive: true, force: true });
    }
});

test('the documented restore puts the uploaded media back', () => {
    const operations = readFileSync(path.join(repoRoot, 'docs/operations.md'), 'utf8');
    const backups = operations.slice(operations.indexOf('## Backups'), operations.indexOf('## Upgrading the software'));
    const restore = backups.slice(backups.indexOf('Restore'));
    assert.match(restore, /tar xzf backups\/state-/);
    assert.match(restore, /\.scheduler-data/);
});

test('the documented restore works from shared/, like the backup', () => {
    // shared/ has no docker-compose.yml or package.json: both ship in each release.
    const operations = readFileSync(path.join(repoRoot, 'docs/operations.md'), 'utf8');
    const backups = operations.slice(operations.indexOf('## Backups'), operations.indexOf('## Upgrading the software'));
    const backup = backups.slice(0, backups.indexOf('Restore'));
    const restore = backups.slice(backups.indexOf('Restore'));
    const compose = '-f ../current/docker-compose.yml';
    assert.ok(backup.includes(`docker compose ${compose} exec -T postgres pg_dump`), 'backup names the release compose file');
    assert.ok(restore.includes(`docker compose ${compose} exec -T postgres psql`), 'restore names the release compose file');
    assert.ok(restore.includes('cd ~/phone-farm/shared'), 'restore starts in shared/');
    assert.match(restore, /cd \.\.\/current && npm run db:migrate/, 'migrations run from the release, not shared/');
});

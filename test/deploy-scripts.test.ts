import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Exercises scripts/{release,migrate-to-releases,deploy,rollback}.sh and the
// launchd installer end to end against a temporary HOME. launchctl, npm, curl,
// docker and lsof are stubs on PATH: nothing touches launchd, the network, a
// database or a real farm. The stub curl answers /health with the RELEASED file
// of whatever `current` points at, as the real web process would after a restart.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STUBS: Record<string, string> = {
    launchctl: `#!/bin/bash
echo "launchctl $*" >> "$STUB_LOG"
case "$1" in
  print) [ "\${FAKE_AGENTS_LOADED:-0}" = 1 ] ;;
  list) exit 0 ;;
  *) exit 0 ;;
esac`,
    npm: `#!/bin/bash
echo "npm $* @$(basename "$PWD")" >> "$STUB_LOG"
[ "$1" = --version ] && { echo 11.0.0; exit 0; }
case " $* " in
  *" ci "*) mkdir -p node_modules && echo installed > node_modules/.stub ;;
  *" deploy:smoke "*) exit "\${FAKE_SMOKE_EXIT:-0}" ;;
esac
exit 0`,
    curl: `#!/bin/bash
out=/dev/null url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; -w|--max-time) shift ;; -*) ;; *) url=$1 ;; esac
  shift
done
echo "curl $url" >> "$STUB_LOG"
id=$(basename "$(readlink "$PHONE_FARM_ROOT/current" 2>/dev/null)")
# Like src/api/app.ts: /health reports RELEASED's sha as a string, when it has one.
sha=$(sed -n 's/.*"sha": "\\([0-9a-f]*\\)".*/\\1/p' "$PHONE_FARM_ROOT/current/RELEASED" 2>/dev/null)
case "$url" in
  */health/ready)
    code=\${FAKE_READY_CODE:-404}
    [[ " \${FAKE_NOT_READY:-} " == *" $id "* ]] && code=503
    echo '{"ok":false,"checks":{"appium":"unreachable"}}' > "$out" ;;
  */health)
    if [[ " \${FAKE_UNHEALTHY:-} " == *" $id "* ]]; then code=503; echo '{}' > "$out"
    elif [ -n "$sha" ]; then code=200; printf '{"ok":true,"release":"%s"}' "$sha" > "$out"
    else code=200; printf '{"ok":true}' > "$out"; fi ;;
  *) code=404 ;;
esac
printf '%s' "$code"`,
    docker: '#!/bin/bash\nexit 1',
    lsof: '#!/bin/bash\nexit 0',
};

interface Farm { home: string; root: string; bin: string; log: string; repo: string }

function setup(): Farm {
    // Real path: macOS /var is a link to /private/var, and the scripts resolve links.
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pf-deploy-')));
    const home = path.join(base, 'home');
    const bin = path.join(base, 'bin');
    const repo = path.join(base, 'repo');
    mkdirSync(home, { recursive: true });
    mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
        writeFileSync(path.join(bin, name), `${body}\n`);
        chmodSync(path.join(bin, name), 0o755);
    }
    makeFixtureRepo(repo);
    return { home, root: path.join(home, 'phone-farm'), bin, log: path.join(base, 'calls.log'), repo };
}

function write(file: string, content: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
}

/** A tiny phone-farm-shaped git repo carrying the real scripts under test. */
function makeFixtureRepo(repo: string) {
    mkdirSync(repo, { recursive: true });
    cpSync(path.join(repoRoot, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
    write(path.join(repo, 'package.json'), JSON.stringify({
        name: 'fixture', scripts: { 'build:web': 'true', 'appium:install-driver': 'echo driver@1' },
    }, null, 2));
    write(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    write(path.join(repo, 'src/api/server.ts'), 'export {};\n');
    write(path.join(repo, 'src/devices/wda-service.ts'), 'export const v = 1;\n');
    write(path.join(repo, 'static/dashboard/assets/grid.js'), '// compiled\n');
    write(path.join(repo, 'drizzle/0000_init.sql'), 'select 1;\n');
    write(path.join(repo, 'docs/deploy.md'), '# deploy\n');
    write(path.join(repo, 'test/fixture.test.ts'), '// tests stay out of releases\n');
    write(path.join(repo, 'claudedocs/notes.md'), 'internal\n');
    write(path.join(repo, '.env.example'), 'WEB_PORT=3000\n');
    // Stand-in installer: records how it was called instead of touching launchd.
    write(path.join(repo, 'deploy/launchd/install-agents.sh'),
        '#!/bin/bash\necho "install-agents root=${PHONE_FARM_ROOT:-} from=$(cd "$(dirname "$0")/../.." && pwd)" >> "$STUB_LOG"\n');
    chmodSync(path.join(repo, 'deploy/launchd/install-agents.sh'), 0o755);
    write(path.join(repo, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\ndevices.json\n.wda/\ndist/\n');
    // Host state that must never ship.
    write(path.join(repo, '.env'), 'SECRET=1\n');
    write(path.join(repo, 'devices.json'), '[]\n');
    write(path.join(repo, '.wda/prebuilt/x'), 'signed\n');
    write(path.join(repo, 'node_modules/dep/index.js'), '\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Initial fixture');
}

function git(cwd: string, ...args: string[]) {
    const result = spawnSync('git', args, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function run(farm: Farm, script: string, args: string[] = [], env: Record<string, string> = {}) {
    const result = spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        env: {
            PATH: `${farm.bin}:${process.env.PATH}`, HOME: farm.home, TMPDIR: os.tmpdir(),
            STUB_LOG: farm.log, PHONE_FARM_ROOT: farm.root, PHONE_FARM_HEALTH_TIMEOUT: '4',
            FAKE_AGENTS_LOADED: '1', ...env,
        },
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
}

function release(farm: Farm, ...args: string[]) {
    const result = run(farm, path.join(farm.repo, 'scripts/release.sh'), ['--out', path.join(farm.repo, 'dist'), ...args]);
    assert.equal(result.code, 0, result.err);
    return result.out.trim().split('\n').at(-1)!;
}

function commit(farm: Farm, file: string, content: string, subject: string) {
    write(path.join(farm.repo, file), content);
    git(farm.repo, 'add', '-A');
    git(farm.repo, 'commit', '-q', '-m', subject);
    return git(farm.repo, 'rev-parse', 'HEAD').slice(0, 12);
}

/** A flat, pre-release ~/phone-farm like the one rsynced to the Mac mini. */
function makeFlatHost(farm: Farm) {
    const root = farm.root;
    for (const entry of ['package.json', 'package-lock.json', 'src', 'static', 'deploy']) {
        cpSync(path.join(farm.repo, entry), path.join(root, entry), { recursive: true });
    }
    write(path.join(root, '.env'), 'WEB_PORT=3999\nWDA_XCTESTRUN=' + root + '/.wda/prebuilt/x.xctestrun\n');
    write(path.join(root, 'devices.json'), '[{"udid":"u1"}]\n');
    write(path.join(root, '.wda/prebuilt/x.xctestrun'), 'signed build\n');
    write(path.join(root, '.appium2/node_modules/driver/package.json'), '{}\n');
    write(path.join(root, '.scheduler-data/assets/clip.mp4'), 'video\n');
    write(path.join(root, 'logs/web.log'), 'old log\n');
    write(path.join(root, 'node_modules/dep/index.js'), 'installed\n');
    write(path.join(root, 'stray-notes.txt'), 'kept, moved with the code\n');
}

const tarList = (tarball: string) => spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const currentId = (farm: Farm) => path.basename(readlinkSync(path.join(farm.root, 'current')));
const released = (farm: Farm, id: string) => JSON.parse(readFileSync(path.join(farm.root, 'releases', id, 'RELEASED'), 'utf8'));
const calls = (farm: Farm) => (existsSync(farm.log) ? readFileSync(farm.log, 'utf8') : '');

test('release.sh packs committed code only, with RELEASE.json and a checksum', () => {
    const farm = setup();
    const tarball = release(farm);
    const sha = git(farm.repo, 'rev-parse', 'HEAD');
    assert.equal(path.basename(tarball), `phone-farm-${sha.slice(0, 12)}.tgz`);
    const entries = tarList(tarball).map((entry) => entry.replace(/^[^/]+\//, ''));
    for (const expected of ['RELEASE.json', 'package.json', 'src/api/server.ts', 'static/dashboard/assets/grid.js',
        'scripts/deploy.sh', 'scripts/lib/release-common.sh', 'deploy/launchd/install-agents.sh', 'drizzle/0000_init.sql', 'docs/deploy.md', '.env.example']) {
        assert.ok(entries.includes(expected), `${expected} is in the release`);
    }
    for (const forbidden of ['.env', 'devices.json', '.wda/prebuilt/x', 'node_modules/dep/index.js', 'test/fixture.test.ts', 'claudedocs/notes.md']) {
        assert.ok(!entries.includes(forbidden), `${forbidden} is not in the release`);
    }
    const meta = JSON.parse(spawnSync('tar', ['-xzOf', tarball, `${path.basename(tarball, '.tgz')}/RELEASE.json`], { encoding: 'utf8' }).stdout);
    assert.equal(meta.id, sha.slice(0, 12));
    assert.equal(meta.sha, sha);
    assert.equal(meta.subject, 'Initial fixture');
    assert.equal(meta.nodeModules, false);
    const check = spawnSync('shasum', ['-a', '256', '-c', `${path.basename(tarball)}.sha256`], { cwd: path.dirname(tarball), encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
});

test('release.sh names a tagged release by its version and refuses a dirty tree or committed host state', () => {
    const farm = setup();
    assert.match(path.basename(release(farm, '--version', 'v1.2.3')), /^phone-farm-v1\.2\.3\.tgz$/);

    write(path.join(farm.repo, 'src/api/server.ts'), 'export const dirty = true;\n');
    const dirty = run(farm, path.join(farm.repo, 'scripts/release.sh'));
    assert.notEqual(dirty.code, 0);
    assert.match(dirty.err, /uncommitted changes/);
    git(farm.repo, 'checkout', '--', 'src/api/server.ts');

    // A root-level devices.json is outside RELEASE_PATHS and cannot ship; one
    // committed inside a shipped directory must stop the build.
    write(path.join(farm.repo, 'deploy/devices.json'), '[{"passcode":"123456"}]\n');
    git(farm.repo, 'add', '-f', 'deploy/devices.json');
    git(farm.repo, 'commit', '-q', '-m', 'Oops');
    const leaked = run(farm, path.join(farm.repo, 'scripts/release.sh'));
    assert.notEqual(leaked.code, 0);
    assert.match(leaked.err, /host state is committed: .*deploy\/devices\.json/);
});

test('migrate-to-releases.sh moves state into shared/, keeps it reachable, and is idempotent', () => {
    const farm = setup();
    makeFlatHost(farm);
    const envBefore = readFileSync(path.join(farm.root, '.env'), 'utf8');

    const dry = run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.ok(lstatSync(path.join(farm.root, '.env')).isFile(), 'dry run changes nothing');
    assert.ok(!existsSync(path.join(farm.root, 'current')));

    const migrated = run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--yes']);
    assert.equal(migrated.code, 0, migrated.err);
    const id = currentId(farm);
    assert.match(id, /^initial-\d{12}$/);
    const release = path.join(farm.root, 'releases', id);

    assert.equal(readFileSync(path.join(farm.root, 'shared/.env'), 'utf8'), envBefore, 'state moved intact');
    assert.equal(readFileSync(path.join(farm.root, 'shared/.wda/prebuilt/x.xctestrun'), 'utf8'), 'signed build\n');
    assert.equal(readFileSync(path.join(farm.root, 'shared/.scheduler-data/assets/clip.mp4'), 'utf8'), 'video\n');
    for (const item of ['.env', 'devices.json', '.wda', '.appium2', '.scheduler-data', 'logs']) {
        assert.equal(readlinkSync(path.join(release, item)), `../../shared/${item}`, `release links ${item}`);
        assert.equal(readlinkSync(path.join(farm.root, item)), `shared/${item}`, `compatibility link for ${item}`);
    }
    assert.equal(readFileSync(path.join(farm.root, '.wda/prebuilt/x.xctestrun'), 'utf8'), 'signed build\n', 'absolute WDA_XCTESTRUN still resolves');
    assert.ok(existsSync(path.join(release, 'node_modules/dep/index.js')), 'node_modules moved with the code');
    assert.ok(existsSync(path.join(release, 'stray-notes.txt')), 'unknown files are moved, not lost');
    assert.ok(existsSync(path.join(release, '.ready')));
    assert.equal(released(farm, id).id, id);
    assert.equal((lstatSync(path.join(farm.root, 'shared')).mode & 0o777), 0o700);

    const backups = readdirSync(path.join(farm.home, 'phone-farm-backups'));
    assert.equal(backups.length, 1);
    const archived = tarList(path.join(farm.home, 'phone-farm-backups', backups[0]!, 'state.tgz')).join('\n');
    assert.match(archived, /\.env/);
    assert.match(archived, /devices\.json/);
    assert.match(archived, /x\.xctestrun/);

    const log = calls(farm);
    for (const name of ['web', 'worker', 'wda-service', 'appium']) {
        assert.match(log, new RegExp(`launchctl bootout gui/\\d+/com\\.phone-farm\\.${name}\\n`));
    }
    assert.doesNotMatch(log, /bootout gui\/\d+\/com\.phone-farm\.db/, 'the db agent is left alone');
    assert.match(log, new RegExp(`install-agents root=${farm.root} from=${farm.root}/current`), 'agents reinstalled from current');

    const again = run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--yes']);
    assert.equal(again.code, 0, again.err);
    assert.match(again.err, /already in the release layout/);
    assert.equal(readdirSync(path.join(farm.home, 'phone-farm-backups')).length, 1, 'no second backup');
});

test('deploy.sh installs, migrates, flips, restarts web before worker, and is a no-op on re-run', () => {
    const farm = setup();
    makeFlatHost(farm);
    assert.equal(run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--yes']).code, 0);
    const initial = currentId(farm);
    const tarball = release(farm);
    const id = git(farm.repo, 'rev-parse', 'HEAD').slice(0, 12);
    writeFileSync(farm.log, '');

    const deployed = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [tarball]);
    assert.equal(deployed.code, 0, deployed.err);
    assert.equal(currentId(farm), id);
    const meta = released(farm, id);
    assert.equal(meta.id, id);
    assert.equal(meta.subject, 'Initial fixture');
    assert.ok(meta.deployedAt);
    assert.ok(existsSync(path.join(farm.root, 'releases', id, 'node_modules/dep/index.js')), 'node_modules cloned: lockfile unchanged');
    assert.equal(readlinkSync(path.join(farm.root, 'releases', id, 'devices.json')), '../../shared/devices.json');

    const log = calls(farm);
    const order = ['deploy:smoke', 'db:migrate', `kickstart -k gui/${process.getuid!()}/com.phone-farm.web`, `/health\n`,
        'com.phone-farm.worker', '/health/ready'].map((needle) => log.indexOf(needle));
    assert.ok(order.every((index) => index >= 0), `every step ran:\n${log}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `steps ran in order:\n${log}`);
    assert.doesNotMatch(log, /npm ci/, 'no reinstall when the lockfile is unchanged');
    assert.doesNotMatch(log, /com\.phone-farm\.wda-service/, 'wda-service untouched when its code did not change');
    assert.match(readFileSync(path.join(farm.root, 'shared/logs/deploy.log'), 'utf8'), new RegExp(`release ${id} is live`));
    assert.deepEqual(readFileSync(path.join(farm.root, '.history'), 'utf8').trim().split('\n'), [initial, id]);

    writeFileSync(farm.log, '');
    const again = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [tarball]);
    assert.equal(again.code, 0, again.err);
    assert.match(again.err, /already current/);
    assert.doesNotMatch(calls(farm), /kickstart|db:migrate/);
});

test('deploy.sh restarts wda-service and reinstalls deps only when their inputs change', () => {
    const farm = setup();
    makeFlatHost(farm);
    assert.equal(run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--yes']).code, 0);
    commit(farm, 'src/devices/wda-service.ts', 'export const v = 2;\n', 'Change the supervisor');
    commit(farm, 'package-lock.json', '{"lockfileVersion":3,"changed":true}\n', 'Bump a dependency');
    writeFileSync(farm.log, '');
    const deployed = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [release(farm)]);
    assert.equal(deployed.code, 0, deployed.err);
    const log = calls(farm);
    assert.match(log, /npm ci --no-audit --no-fund/);
    assert.match(log, /kickstart -k gui\/\d+\/com\.phone-farm\.wda-service/);
});

test('an unhealthy release is rolled back automatically; rollback.sh returns to the previous release', () => {
    const farm = setup();
    makeFlatHost(farm);
    assert.equal(run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--yes']).code, 0);
    const first = release(farm);
    const firstId = git(farm.repo, 'rev-parse', 'HEAD').slice(0, 12);
    assert.equal(run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [first]).code, 0);

    const badId = commit(farm, 'src/api/server.ts', 'export const broken = true;\n', 'Break the web process');
    const bad = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [release(farm)], { FAKE_UNHEALTHY: badId });
    assert.equal(bad.code, 2, bad.err);
    assert.match(bad.err, /rolling back/);
    assert.equal(currentId(farm), firstId);
    assert.equal(released(farm, firstId).rolledBackFrom, badId);
    assert.ok(existsSync(path.join(farm.root, 'releases', badId)), 'the bad release is kept for inspection');

    commit(farm, 'src/api/server.ts', 'export const unloadable = true;\n', 'Break an import');
    const smokeFail = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [release(farm)], { FAKE_SMOKE_EXIT: '1' });
    assert.equal(smokeFail.code, 1);
    assert.match(smokeFail.err, /smoke check failed/);
    assert.equal(currentId(farm), firstId, 'a failed smoke check never flips');

    const goodId = commit(farm, 'src/api/server.ts', 'export const fixed = true;\n', 'Fix the web process');
    assert.equal(run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [release(farm)]).code, 0);
    assert.equal(currentId(farm), goodId);

    const list = run(farm, path.join(farm.repo, 'scripts/rollback.sh'), ['--list']);
    assert.equal(list.code, 0, list.err);
    assert.match(list.out, new RegExp(`\\* ${goodId}`));

    const back = run(farm, path.join(farm.repo, 'scripts/rollback.sh'));
    assert.equal(back.code, 0, back.err);
    assert.equal(currentId(farm), firstId);
    assert.equal(released(farm, firstId).rolledBackFrom, goodId);

    const forward = run(farm, path.join(farm.repo, 'scripts/rollback.sh'), [goodId]);
    assert.equal(forward.code, 0, forward.err);
    assert.equal(currentId(farm), goodId);
    assert.notEqual(run(farm, path.join(farm.repo, 'scripts/rollback.sh'), [goodId]).code, 0, 'already current');
});

test('a release that never becomes ready is rolled back unless --skip-ready', () => {
    const farm = setup();
    makeFlatHost(farm);
    assert.equal(run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--yes']).code, 0);
    const firstId = commit(farm, 'src/api/server.ts', 'export const a = 1;\n', 'Ready release');
    assert.equal(run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [release(farm)], { FAKE_READY_CODE: '200' }).code, 0);

    const notReadyId = commit(farm, 'src/api/server.ts', 'export const a = 2;\n', 'Release whose worker never heartbeats');
    const tarball = release(farm);
    const env = { FAKE_READY_CODE: '200', FAKE_NOT_READY: notReadyId };
    const gated = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [tarball], env);
    assert.equal(gated.code, 2, gated.err);
    assert.match(gated.err, /health\/ready not ready .*appium/);
    assert.equal(currentId(farm), firstId);

    const skipped = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), ['--skip-ready', tarball], env);
    assert.equal(skipped.code, 0, skipped.err);
    assert.equal(currentId(farm), notReadyId);
});

test('deploy.sh keeps only the newest releases, never the live one', () => {
    const farm = setup();
    makeFlatHost(farm);
    assert.equal(run(farm, path.join(farm.repo, 'scripts/migrate-to-releases.sh'), ['--yes']).code, 0);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
        ids.push(commit(farm, 'src/api/server.ts', `export const n = ${index};\n`, `Release ${index}`));
        const result = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [release(farm)], { PHONE_FARM_KEEP_RELEASES: '2' });
        assert.equal(result.code, 0, result.err);
    }
    const left = readdirSync(path.join(farm.root, 'releases')).filter((entry) => !entry.startsWith('.')).sort();
    assert.deepEqual(left, [ids[1], ids[2]].sort());
    assert.equal(currentId(farm), ids[2]);
});

test('deploy.sh refuses a host that has not been migrated', () => {
    const farm = setup();
    makeFlatHost(farm);
    const result = run(farm, path.join(farm.repo, 'scripts/deploy.sh'), [release(farm)]);
    assert.equal(result.code, 1);
    assert.match(result.err, /migrate-to-releases\.sh/);
});

test('install-agents.sh points the agents at current and shared logs in the release layout', () => {
    const farm = setup();
    const releaseDir = path.join(farm.root, 'releases', 'abc');
    mkdirSync(path.join(farm.root, 'shared'), { recursive: true });
    cpSync(path.join(repoRoot, 'deploy'), path.join(releaseDir, 'deploy'), { recursive: true });
    write(path.join(farm.root, 'shared/.env'), 'WEB_PORT=3000\n');
    spawnSync('ln', ['-s', '../../shared/.env', path.join(releaseDir, '.env')]);
    spawnSync('ln', ['-s', 'releases/abc', path.join(farm.root, 'current')]);

    // Detected from its own location, and from PHONE_FARM_ROOT.
    for (const env of [{ PHONE_FARM_ROOT: '' }, {}]) {
        const result = run(farm, path.join(releaseDir, 'deploy/launchd/install-agents.sh'), ['--dry-run'], env);
        assert.equal(result.code, 0, result.err);
        assert.match(result.out, new RegExp(`<key>WorkingDirectory</key><string>${farm.root}/current</string>`));
        assert.match(result.out, new RegExp(`<string>${farm.root}/shared/logs/web\\.log</string>`));
        assert.match(result.out, new RegExp(`<string>${farm.root}/current/deploy/launchd/db-up\\.sh</string>`));
        assert.doesNotMatch(result.out, /releases\/abc/, 'plists never name a release');
    }
    const withHeartbeat = run(farm, path.join(releaseDir, 'deploy/launchd/install-agents.sh'), ['--dry-run'],
        { PHONE_FARM_HEARTBEAT_URL: 'https://heartbeat.invalid/ping' });
    assert.equal(withHeartbeat.code, 0, withHeartbeat.err);
    assert.match(withHeartbeat.out, new RegExp(`<string>${farm.root}/current/deploy/launchd/heartbeat\\.sh</string>`));
    assert.doesNotMatch(withHeartbeat.out, /heartbeat\.invalid/, 'the push URL stays out of the plist');
    assert.doesNotMatch(calls(farm), /launchctl/, 'a dry run does not touch launchd');
});

test('install-agents.sh keeps working from a flat checkout', () => {
    const farm = setup();
    const flat = path.join(farm.home, 'checkout');
    cpSync(path.join(repoRoot, 'deploy'), path.join(flat, 'deploy'), { recursive: true });
    write(path.join(flat, '.env'), 'WEB_PORT=3000\n');
    const result = run(farm, path.join(flat, 'deploy/launchd/install-agents.sh'), ['--dry-run'], { PHONE_FARM_ROOT: '' });
    assert.equal(result.code, 0, result.err);
    const real = spawnSync('pwd', ['-P'], { cwd: flat, encoding: 'utf8' }).stdout.trim();
    assert.match(result.out, new RegExp(`<key>WorkingDirectory</key><string>${real}</string>`));
    assert.match(result.out, new RegExp(`<string>${real}/logs/web\\.log</string>`));
});

test('every shell script parses', () => {
    const scripts = [
        ...readdirSync(path.join(repoRoot, 'scripts')).filter((file) => file.endsWith('.sh')).map((file) => `scripts/${file}`),
        'scripts/lib/release-common.sh',
        ...readdirSync(path.join(repoRoot, 'deploy/launchd')).filter((file) => file.endsWith('.sh')).map((file) => `deploy/launchd/${file}`),
    ];
    for (const script of scripts) {
        const result = spawnSync('bash', ['-n', path.join(repoRoot, script)], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
});

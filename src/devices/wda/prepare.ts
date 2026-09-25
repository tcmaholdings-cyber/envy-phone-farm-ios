import { spawn, type SpawnOptions } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signingTeamXctestrunKey, wdaBuildArgs } from './runner-args.js';
import { resolveDeveloperDir } from './xcode-env.js';
import { resolveBuildTargets } from './target-device.js';

function run(command: string, args: string[], options: SpawnOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
            }
        });
    });
}

const workspaceRoot = process.cwd();
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const driverPath = path.resolve(process.env.XCUITEST_DRIVER_PATH
    ?? '.appium2/node_modules/appium-xcuitest-driver');
const wdaRoot = path.join(driverPath, 'node_modules/appium-webdriveragent');
const projectPath = path.join(wdaRoot, 'WebDriverAgent.xcodeproj');
const touchCommandsPath = path.join(
    wdaRoot,
    'WebDriverAgentLib/Commands/FBTouchActionCommands.m',
);
const runnerInfoPlistPath = path.join(wdaRoot, 'WebDriverAgentRunner/Info.plist');
const customCommandsPath = path.join(wdaRoot, 'WebDriverAgentLib/Commands/FBCustomCommands.m');
const patchPath = path.join(
    packageRoot,
    'Patches/appium-webdriveragent-8.9.1-absolute-touch.patch',
);
const buttonsPatchPath = path.join(
    packageRoot,
    'Patches/appium-webdriveragent-8.9.1-sessionless-buttons.patch',
);

await Promise.all([
    access(projectPath), access(touchCommandsPath), access(runnerInfoPlistPath), access(customCommandsPath),
    access(patchPath), access(buttonsPatchPath),
]);
const touchCommands = await readFile(touchCommandsPath, 'utf8');
const runnerInfoPlist = await readFile(runnerInfoPlistPath, 'utf8');
if (touchCommands.includes('FBImportMedia') && runnerInfoPlist.includes('NSPhotoLibraryAddUsageDescription')) {
    console.log('WDA absolute-touch and Photos-import patch is already applied');
} else {
    await run('/usr/bin/patch', ['-p0', '-i', patchPath], { cwd: workspaceRoot });
    console.log('Applied WDA absolute-touch patch');
}
const customCommands = await readFile(customCommandsPath, 'utf8');
if (customCommands.includes('POST:@"/wda/pressButton"].withoutSession')) {
    console.log('WDA sessionless device-button patch is already applied');
} else {
    await run('/usr/bin/patch', ['-p0', '-i', buttonsPatchPath], { cwd: workspaceRoot });
    console.log('Applied WDA sessionless device-button patch');
}

const developerDir = resolveDeveloperDir();
const xcodeEnv = { env: { ...process.env, DEVELOPER_DIR: developerDir } };

// `--generic [dir]` signs one build for every device registered on the Team
// (no phone attached) so it can be copied to another host and run there with
// WDA_XCTESTRUN; see docs/operations.md.
// `--team <TEAMID>` signs that generic build with another Apple Team than
// XCODE_ORG_ID (Apple allows 100 devices per Team; phones carry `signingTeam`),
// into `.wda/prebuilt-<TEAMID>`, to be launched through WDA_XCTESTRUN_<TEAMID>.
const genericIndex = process.argv.indexOf('--generic');
if (genericIndex !== -1) {
    const next = process.argv[genericIndex + 1];
    const teamIndex = process.argv.indexOf('--team');
    const team = teamIndex !== -1 ? process.argv[teamIndex + 1]?.trim().toUpperCase() : undefined;
    if (teamIndex !== -1 && !(team && /^[A-Z0-9]{10}$/.test(team))) throw new Error('--team needs an Apple Team ID (10 letters/digits)');
    const derivedDataPath = path.resolve(next && !next.startsWith('--') ? next : team ? `.wda/prebuilt-${team}` : '.wda/prebuilt');
    const buildEnv = team ? { ...process.env, XCODE_ORG_ID: team } : process.env;
    await run('xcodebuild', wdaBuildArgs(buildEnv, projectPath, { generic: true, derivedDataPath }), xcodeEnv);
    const products = path.join(derivedDataPath, 'Build/Products');
    const xctestrun = (await readdir(products)).find((name) => name.endsWith('.xctestrun'));
    if (!xctestrun) throw new Error(`No .xctestrun was produced in ${products}`);
    console.log(`\nSigned WDA build: ${products}`);
    console.log('Copy that Build/Products folder to the phone host and set there:');
    console.log(`${team ? signingTeamXctestrunKey(team) : 'WDA_XCTESTRUN'}=<copied folder>/${xctestrun}`);
    process.exit(0);
}

// `--udid <udid>`, or `--all` for every registered device, or the sole
// registered / connected device, or IOS_UDID. Xcode needs a concrete device
// for a signed device build.
const targets = await resolveBuildTargets();

for (const udid of targets) {
    if (targets.length > 1) console.log(`\n=== WebDriverAgent build for ${udid} ===`);
    await run('xcodebuild', wdaBuildArgs(process.env, projectPath, { udid }), xcodeEnv);
}

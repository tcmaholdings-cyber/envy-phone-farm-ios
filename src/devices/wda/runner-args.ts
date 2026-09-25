const buildSettings = (env: NodeJS.ProcessEnv, teamId: string, bundleId: string): string[] => [
    `IPHONEOS_DEPLOYMENT_TARGET=${env.IOS_PLATFORM_VERSION ?? '16.7'}`,
    `DEVELOPMENT_TEAM=${teamId}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
    `CODE_SIGN_IDENTITY=${env.XCODE_SIGNING_ID ?? 'Apple Development'}`,
    'CODE_SIGN_STYLE=Automatic',
    'GCC_TREAT_WARNINGS_AS_ERRORS=0',
    'COMPILER_INDEX_STORE_ENABLE=NO',
];

/**
 * App Store Connect API key flags for xcodebuild's automatic signing, so a
 * signing Mac needs no Xcode Apple ID sign-in (which did not persist on the
 * laptop, 2026-09-25). All three env vars or none; a partial set is an error.
 */
export function signingAuthArgs(env: NodeJS.ProcessEnv): string[] {
    const keyPath = env.XCODE_AUTH_KEY_PATH;
    const keyId = env.XCODE_AUTH_KEY_ID;
    const issuerId = env.XCODE_AUTH_KEY_ISSUER_ID;
    if (!keyPath && !keyId && !issuerId) return [];
    if (!keyPath || !keyId || !issuerId) {
        throw new Error('Set all of XCODE_AUTH_KEY_PATH, XCODE_AUTH_KEY_ID and XCODE_AUTH_KEY_ISSUER_ID, or none');
    }
    return ['-authenticationKeyPath', keyPath, '-authenticationKeyID', keyId, '-authenticationKeyIssuerID', issuerId];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is required in .env`);
    return value;
}

/**
 * The env var holding a signing team's prebuilt WDA: `WDA_XCTESTRUN_<TEAM>`,
 * with the team upper-cased and anything but letters, digits and `_` as `_`.
 */
export function signingTeamXctestrunKey(signingTeam: string): string {
    return `WDA_XCTESTRUN_${signingTeam.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
}

export interface WdaLaunchOptions {
    /** The phone's Apple signing team (`signingTeam` in the registry); absent means the host default. */
    signingTeam?: string;
}

/**
 * Which prebuilt `.xctestrun` launches WDA for a phone: its team's
 * `WDA_XCTESTRUN_<TEAM>` when set, else the host-wide `WDA_XCTESTRUN`, else
 * none (build from the project). Apple caps a Team at 100 devices per
 * membership year, so a large farm runs several Teams side by side and each
 * phone must launch the build whose profile lists its UDID.
 */
export function xctestrunFor(env: NodeJS.ProcessEnv, signingTeam?: string): string | undefined {
    if (signingTeam?.trim()) {
        const specific = env[signingTeamXctestrunKey(signingTeam)];
        if (specific) return specific;
    }
    return env.WDA_XCTESTRUN || undefined;
}

/**
 * The `xcodebuild test-without-building` arguments that launch WDA on one device.
 *
 * With WDA_XCTESTRUN (or the phone's team's WDA_XCTESTRUN_<TEAM>) set, the host
 * runs a WDA build that was signed on another Mac (`wda:prepare -- --generic`,
 * then copied over): no Team, signing identity or Apple ID is needed here, only
 * Xcode to install and launch it. Without one, WDA is built from the project
 * signed by the phone's team (a real Team ID then) or XCODE_ORG_ID.
 */
export function wdaLaunchArgs(env: NodeJS.ProcessEnv, udid: string, projectPath: string, options: WdaLaunchOptions = {}): string[] {
    const xctestrun = xctestrunFor(env, options.signingTeam);
    if (xctestrun) {
        return ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${udid}`];
    }
    const team = options.signingTeam?.trim() || required(env, 'XCODE_ORG_ID');
    return [
        'test-without-building',
        '-project', projectPath,
        '-scheme', 'WebDriverAgentRunner',
        '-destination', `id=${udid}`,
        ...buildSettings(env, team, required(env, 'WDA_BUNDLE_ID')),
    ];
}

/**
 * The `xcodebuild build-for-testing` arguments that sign WDA.
 *
 * `udid` builds for one connected device. `generic` builds once for any iOS
 * device into `derivedDataPath`; Xcode's automatic signing then puts every
 * device registered on the Team into the profile, so the build can be copied
 * to a host whose phones never touched this Mac.
 */
export function wdaBuildArgs(
    env: NodeJS.ProcessEnv,
    projectPath: string,
    target: { udid: string } | { generic: true; derivedDataPath: string },
): string[] {
    return [
        'build-for-testing',
        '-allowProvisioningUpdates',
        ...signingAuthArgs(env),
        ...('udid' in target && env.ALLOW_PROVISIONING_DEVICE_REGISTRATION === 'true'
            ? ['-allowProvisioningDeviceRegistration']
            : []),
        '-project', projectPath,
        '-scheme', 'WebDriverAgentRunner',
        ...('udid' in target
            ? ['-destination', `id=${target.udid}`]
            : ['-destination', 'generic/platform=iOS', '-derivedDataPath', target.derivedDataPath]),
        ...buildSettings(env, required(env, 'XCODE_ORG_ID'), required(env, 'WDA_BUNDLE_ID')),
    ];
}

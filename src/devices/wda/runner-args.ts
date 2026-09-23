const buildSettings = (env: NodeJS.ProcessEnv, teamId: string, bundleId: string): string[] => [
    `IPHONEOS_DEPLOYMENT_TARGET=${env.IOS_PLATFORM_VERSION ?? '16.7'}`,
    `DEVELOPMENT_TEAM=${teamId}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
    `CODE_SIGN_IDENTITY=${env.XCODE_SIGNING_ID ?? 'Apple Development'}`,
    'CODE_SIGN_STYLE=Automatic',
    'GCC_TREAT_WARNINGS_AS_ERRORS=0',
    'COMPILER_INDEX_STORE_ENABLE=NO',
];

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is required in .env`);
    return value;
}

/**
 * The `xcodebuild test-without-building` arguments that launch WDA on one device.
 *
 * With WDA_XCTESTRUN set, the host runs a WDA build that was signed on another
 * Mac (`wda:prepare -- --generic`, then copied over): no Team, signing identity
 * or Apple ID is needed here, only Xcode to install and launch it.
 */
export function wdaLaunchArgs(env: NodeJS.ProcessEnv, udid: string, projectPath: string): string[] {
    if (env.WDA_XCTESTRUN) {
        return ['test-without-building', '-xctestrun', env.WDA_XCTESTRUN, '-destination', `id=${udid}`];
    }
    return [
        'test-without-building',
        '-project', projectPath,
        '-scheme', 'WebDriverAgentRunner',
        '-destination', `id=${udid}`,
        ...buildSettings(env, required(env, 'XCODE_ORG_ID'), required(env, 'WDA_BUNDLE_ID')),
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

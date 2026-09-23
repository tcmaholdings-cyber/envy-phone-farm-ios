import type { AuthProvider, PhoneFarmPlugin } from './plugin.js';

interface PluginModule {
    default?: PhoneFarmPlugin;
    plugin?: PhoneFarmPlugin;
}

interface AuthModule {
    default?: AuthProvider;
    authProvider?: AuthProvider;
}

export async function loadPlugins(moduleNames: readonly string[]): Promise<PhoneFarmPlugin[]> {
    return Promise.all(moduleNames.filter(Boolean).map(async (moduleName) => {
        const loaded = await import(moduleName) as PluginModule;
        const plugin = loaded.default ?? loaded.plugin;
        if (!plugin?.id || !Array.isArray(plugin.tasks)) {
            throw new Error(`${moduleName} does not export a PhoneFarmPlugin`);
        }
        return plugin;
    }));
}

/** `builtin` selects the accounts shipped in this package (src/auth); anything else is an ESM module name. */
export const BUILTIN_AUTH_PROVIDER = 'builtin';

export async function loadAuthProvider(moduleName: string | undefined): Promise<AuthProvider | null> {
    if (!moduleName) return null;
    if (moduleName.trim() === BUILTIN_AUTH_PROVIDER) {
        const { createBuiltinAuthProviderFromEnv } = await import('./auth/builtin.js');
        return createBuiltinAuthProviderFromEnv();
    }
    const loaded = await import(moduleName) as AuthModule;
    const provider = loaded.default ?? loaded.authProvider;
    if (!provider?.id || typeof provider.authenticate !== 'function') {
        throw new Error(`${moduleName} does not export an AuthProvider`);
    }
    return provider;
}

export function configuredPluginModules(value = process.env.PHONE_FARM_PLUGINS ?? ''): string[] {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Pre-flip smoke check for a release (`npm run deploy:smoke`, run by
 * scripts/deploy.sh inside releases/<id>/ with the host's .env).
 *
 * It starts nothing: no listener, no queue, no device traffic. It proves that
 * this release's code loads on this host, with these dependencies, against this
 * host's configuration:
 *   - every server and worker module imports (src/index.ts re-exports both);
 *   - the plugins web and worker would load resolve (invariant 2);
 *   - the configured auth provider constructs;
 *   - devices.json parses and validates under this release's rules.
 */
import { access } from 'node:fs/promises';

const checks: string[] = [];
const started = Date.now();

const core = await import('../src/index.js');
checks.push('modules import');

const { defaultPlugins } = await import('../src/api/server.js');
const registry = new core.PluginRegistry(await defaultPlugins());
const plugins = registry.list().map(({ id, version }) => `${id}@${version}`);
if (plugins.length === 0) throw new Error('no plugins loaded');
checks.push(`plugins: ${plugins.join(', ')}`);

const { loadAuthProvider } = await import('../src/loader.js');
const auth = await loadAuthProvider(process.env.PHONE_FARM_AUTH_PLUGIN);
checks.push(`auth: ${auth?.id ?? 'none'}`);
await auth?.close?.();

const devices = await core.loadRegisteredDevices();
checks.push(`devices.json: ${devices.length} registered`);

for (const asset of ['static/dashboard/assets/grid.js', 'static/dashboard/assets/device.js']) {
    await access(asset);
}
checks.push('browser assets present');

console.log(`deploy smoke ok in ${Date.now() - started} ms\n  ${checks.join('\n  ')}`);

import { parseArgs } from 'node:util';

import { createDatabaseConnection } from '../database/client.js';
import { AccountError, AccountService, normalizeUsername } from './accounts.js';
import { PgAuthStore, PgTenantStore } from './pg-store.js';
import { isUserRole } from './policy.js';

/**
 * Bootstrap and recovery for the built-in accounts:
 *
 *   npm run users -- create <username> --role platform|admin|operator [--tenant <slug>] [--name "Display name"]
 *   npm run users -- reset-password <username>
 *   npm run users -- list
 *
 * `platform` is farm-operator staff (every tenant). `admin` and `operator`
 * belong to one tenant: --tenant names it by its short name (default: the
 * deployment's default tenant, "beloura").
 *
 * A generated temporary password goes to stdout, alone on its line, and nowhere
 * else (not the log, not the database); everything else goes to stderr, so
 * `npm run -s users -- create kash --role admin > kash.txt` captures only the
 * password. The user must change it at first sign-in.
 */

const USAGE = `Usage:
  npm run users -- create <username> --role platform|admin|operator [--tenant <slug>] [--name "Display name"]
  npm run users -- reset-password <username>
  npm run users -- list`;

async function main(argv: string[]): Promise<number> {
    const { positionals, values } = parseArgs({
        args: argv, allowPositionals: true,
        options: { role: { type: 'string' }, name: { type: 'string' }, tenant: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    const [command, rawUsername] = positionals;
    if (values.help || !command) {
        console.error(USAGE);
        return command ? 0 : 1;
    }
    const connection = createDatabaseConnection();
    // CLI changes are audited to stderr, with the operator named as "cli".
    const tenants = new PgTenantStore(connection);
    const accounts = new AccountService({
        store: new PgAuthStore(connection),
        tenants,
        audit: (event) => console.error(`audit: ${JSON.stringify(event)}`),
    });
    try {
        const present = await connection.pool.query<{ present: string | null }>(`select to_regclass('auth.tenants')::text as present`);
        if (!present.rows[0]?.present) {
            console.error('The auth tables do not exist yet, or are out of date. Run: npm run db:migrate');
            return 1;
        }
        switch (command) {
            case 'create': {
                const username = normalizeUsername(rawUsername);
                const role = values.role ?? 'operator';
                if (!isUserRole(role)) throw new AccountError(400, '--role must be platform, admin or operator');
                if (role === 'platform' && values.tenant) throw new AccountError(400, 'Platform accounts belong to no tenant; drop --tenant');
                const tenant = values.tenant ? await tenants.tenantBySlug(values.tenant.trim().toLowerCase()) : null;
                if (values.tenant && !tenant) throw new AccountError(404, `No tenant "${values.tenant}"`);
                const existing = await accounts.store.userByUsername(username);
                if (existing) {
                    // Idempotent: re-running a bootstrap script does not rotate a password someone already uses.
                    console.error(`User "${username}" already exists (role ${existing.role}); nothing changed. Use reset-password to issue a new temporary password.`);
                    return 0;
                }
                const { temporaryPassword } = await accounts.createUser(null, { username, role, displayName: values.name, tenantId: tenant?.id });
                console.error(`Created ${role} "${username}"${role === 'platform' ? '' : ` in ${tenant?.slug ?? 'the default tenant'}`}. Temporary password (shown once; they must change it at first sign-in):`);
                console.log(temporaryPassword);
                return 0;
            }
            case 'reset-password': {
                const username = normalizeUsername(rawUsername);
                const user = await accounts.store.userByUsername(username);
                if (!user) throw new AccountError(404, `No user "${username}"`);
                const { temporaryPassword } = await accounts.resetPassword(null, user.id);
                console.error(`Reset "${username}"; every session was signed out. Temporary password (shown once):`);
                console.log(temporaryPassword);
                return 0;
            }
            case 'list': {
                const users = await accounts.store.listUsers();
                if (!users.length) { console.error('No users yet. Create the first platform account with: npm run users -- create <username> --role platform'); return 0; }
                const slugs = new Map((await tenants.listTenants()).map((tenant) => [tenant.id, tenant.slug]));
                const rows = users.map((user) => [
                    user.username, user.role, user.tenantId ? slugs.get(user.tenantId) ?? user.tenantId : '-',
                    user.disabled ? 'disabled' : user.mustChangePassword ? 'must-change-password' : 'active',
                    user.lastLoginAt?.toISOString() ?? 'never', user.displayName,
                ]);
                const header = ['USERNAME', 'ROLE', 'TENANT', 'STATUS', 'LAST SIGN-IN', 'NAME'];
                const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]!.length)));
                for (const row of [header, ...rows]) console.log(row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd());
                return 0;
            }
            default:
                console.error(`Unknown command "${command}".\n${USAGE}`);
                return 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    } finally {
        await connection.close();
    }
}

process.exitCode = await main(process.argv.slice(2));

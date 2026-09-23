import { parseArgs } from 'node:util';

import { createDatabaseConnection } from '../database/client.js';
import { AccountError, AccountService, normalizeUsername } from './accounts.js';
import { PgAuthStore } from './pg-store.js';
import { isUserRole } from './policy.js';

/**
 * Bootstrap and recovery for the built-in accounts:
 *
 *   npm run users -- create <username> --role admin|operator [--name "Display name"]
 *   npm run users -- reset-password <username>
 *   npm run users -- list
 *
 * A generated temporary password goes to stdout, alone on its line, and nowhere
 * else (not the log, not the database); everything else goes to stderr, so
 * `npm run -s users -- create kash --role admin > kash.txt` captures only the
 * password. The user must change it at first sign-in.
 */

const USAGE = `Usage:
  npm run users -- create <username> --role admin|operator [--name "Display name"]
  npm run users -- reset-password <username>
  npm run users -- list`;

async function main(argv: string[]): Promise<number> {
    const { positionals, values } = parseArgs({
        args: argv, allowPositionals: true,
        options: { role: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    const [command, rawUsername] = positionals;
    if (values.help || !command) {
        console.error(USAGE);
        return command ? 0 : 1;
    }
    const connection = createDatabaseConnection();
    // CLI changes are audited to stderr, with the operator named as "cli".
    const accounts = new AccountService({
        store: new PgAuthStore(connection),
        audit: (event) => console.error(`audit: ${JSON.stringify(event)}`),
    });
    try {
        const present = await connection.pool.query<{ present: string | null }>(`select to_regclass('auth.users')::text as present`);
        if (!present.rows[0]?.present) {
            console.error('The auth tables do not exist yet. Run: npm run db:migrate');
            return 1;
        }
        switch (command) {
            case 'create': {
                const username = normalizeUsername(rawUsername);
                const role = values.role ?? 'operator';
                if (!isUserRole(role)) throw new AccountError(400, '--role must be admin or operator');
                const existing = await accounts.store.userByUsername(username);
                if (existing) {
                    // Idempotent: re-running a bootstrap script does not rotate a password someone already uses.
                    console.error(`User "${username}" already exists (role ${existing.role}); nothing changed. Use reset-password to issue a new temporary password.`);
                    return 0;
                }
                const { temporaryPassword } = await accounts.createUser(null, { username, role, displayName: values.name });
                console.error(`Created ${role} "${username}". Temporary password (shown once; they must change it at first sign-in):`);
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
                if (!users.length) { console.error('No users yet. Create the first admin with: npm run users -- create <username> --role admin'); return 0; }
                const rows = users.map((user) => [
                    user.username, user.role, user.disabled ? 'disabled' : user.mustChangePassword ? 'must-change-password' : 'active',
                    user.lastLoginAt?.toISOString() ?? 'never', user.displayName,
                ]);
                const header = ['USERNAME', 'ROLE', 'STATUS', 'LAST SIGN-IN', 'NAME'];
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

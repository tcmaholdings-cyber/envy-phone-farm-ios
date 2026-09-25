import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_TENANT_SLUG = 'beloura';

const migration = await readFile(new URL('../drizzle/0006_tenants.sql', import.meta.url), 'utf8');
const statements = migration.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);

test('migration 0006 is in the journal, after every earlier migration', async () => {
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
    };
    assert.deepEqual(journal.entries.map(({ idx }) => idx), journal.entries.map((_entry, index) => index));
    const entry = journal.entries.find(({ tag }) => tag === '0006_tenants');
    assert.ok(entry, '0006_tenants is journalled');
    // The migrator applies a migration only when its `when` is newer than the last applied one.
    for (const other of journal.entries) if (other !== entry) assert.ok(other.when < entry.when, `${other.tag} must be older than 0006`);
    await readFile(new URL('../drizzle/meta/0006_snapshot.json', import.meta.url), 'utf8');
});

test('migration 0006 backfills the deployment into the default tenant', () => {
    assert.match(migration, new RegExp(`INSERT INTO "auth"\\."tenants" \\("id", "slug", "name"\\) VALUES \\('${DEFAULT_TENANT_ID}', '${DEFAULT_TENANT_SLUG}'`));
    for (const table of ['"scheduler"."schedules"', '"scheduler"."executions"', '"scheduler"."assets"', '"auth"."groups"']) {
        assert.match(migration, new RegExp(`ALTER TABLE ${table.replaceAll('.', '\\.')} ADD COLUMN "tenant_id" uuid DEFAULT '${DEFAULT_TENANT_ID}'::uuid NOT NULL`), table);
    }
    assert.match(migration, /ALTER TABLE "auth"\."users" ADD COLUMN "tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;/);
});

test('migration 0006 turns every existing admin into platform staff, explicitly', () => {
    assert.match(migration, /CASE WHEN "role"::text = 'admin' THEN 'platform' ELSE "role"::text END/);
    assert.match(migration, /UPDATE "auth"\."users" SET "tenant_id" = NULL WHERE "role" = 'platform'/);
    assert.match(migration, /CHECK \(\("auth"\."users"\."role" = 'platform'\) = \("auth"\."users"\."tenant_id" is null\)\)/);
    // ADD VALUE cannot be used in the migrator's single transaction; the enum is recreated instead.
    assert.doesNotMatch(statements.map((statement) => statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')).join('\n'), /ADD VALUE/);
    const order = ['CREATE TYPE "auth"."user_role" AS ENUM(\'platform\', \'admin\', \'operator\')', 'ALTER COLUMN "role" TYPE', 'ADD COLUMN "tenant_id"', 'SET "tenant_id" = NULL'];
    const positions = order.map((needle) => migration.indexOf(needle));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'role mapping happens before tenants are cleared');
});

test('migration 0006 makes the audit log append-only in the database', () => {
    assert.match(migration, /CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "auth"\."audit_log" FOR EACH ROW/);
    assert.match(migration, /CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "auth"\."audit_log"/);
    assert.match(migration, /IF OLD\."at" < now\(\) - interval '30 days' THEN/);
    assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON "auth"\."audit_log" FROM phone_farm_app/);
    // Every statement is a single unit for the migrator; function bodies stay whole.
    assert.ok(statements.some((statement) => statement.startsWith('CREATE FUNCTION') && statement.endsWith('$$;')));
});

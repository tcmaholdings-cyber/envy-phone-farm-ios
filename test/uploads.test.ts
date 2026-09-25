import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TEST_DEVICES, useDevicesFile } from './auth-support.js';
import { inject } from './support.js';
import { twoTenantFarm } from './tenant-support.js';

await useDevicesFile(TEST_DEVICES);
// Read when the app registers multipart, so it must be set before any app is created.
process.env.PHONE_FARM_MAX_UPLOAD_BYTES = '4096';
const { DEFAULT_MAX_UPLOAD_BYTES, maxUploadBytes, parseQuotas, tenantUploadBudget, DEFAULT_TENANT_UPLOAD_BYTES } = await import('../src/tenancy.js');

const boundary = 'pf-upload-boundary';
function multipart(files: Array<{ name: string; bytes: number }>): string {
    return files.map(({ name, bytes }) => `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: video/mp4\r\n\r\n${'x'.repeat(bytes)}\r\n`).join('') + `--${boundary}--\r\n`;
}

async function farmWithUploads() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-uploads-'));
    process.env.SCHEDULER_DATA_DIR = directory;
    const farm = await twoTenantFarm();
    const upload = (cookies: Record<string, string>, files: Array<{ name: string; bytes: number }>, query = '') => inject(farm.app, {
        method: 'POST', url: `/api/assets${query}`, cookies,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipart(files),
    });
    const onDisk = async () => readdir(path.join(directory, 'uploads')).catch(() => [] as string[]);
    return { farm, upload, onDisk };
}

test('the per-file cap comes from PHONE_FARM_MAX_UPLOAD_BYTES, default 200 MB; tenant budgets default to 5 GB', () => {
    assert.equal(maxUploadBytes({}), DEFAULT_MAX_UPLOAD_BYTES);
    assert.equal(DEFAULT_MAX_UPLOAD_BYTES, 200 * 1024 * 1024);
    assert.equal(maxUploadBytes({ PHONE_FARM_MAX_UPLOAD_BYTES: '1048576' }), 1_048_576);
    for (const bad of ['0', '-5', 'lots', '1.5']) assert.equal(maxUploadBytes({ PHONE_FARM_MAX_UPLOAD_BYTES: bad }), DEFAULT_MAX_UPLOAD_BYTES, bad);
    assert.equal(tenantUploadBudget({}), DEFAULT_TENANT_UPLOAD_BYTES);
    assert.equal(DEFAULT_TENANT_UPLOAD_BYTES, 5 * 1024 ** 3);
    assert.equal(tenantUploadBudget({ maxUploadBytes: 0 }), 0);
    assert.deepEqual(parseQuotas({ maxPhones: '10', maxUsers: 3, maxUploadBytes: null, other: 1 }, { maxUploadBytes: 5 }), { maxPhones: 10, maxUsers: 3 });
    assert.throws(() => parseQuotas({ maxPhones: -1 }), /whole number/);
    assert.throws(() => parseQuotas('lots'), /object/);
});

test('an upload belongs to the uploader\'s tenant and records who uploaded it', async (context) => {
    const { farm, upload, onDisk } = await farmWithUploads();
    context.after(() => farm.app.close());
    const response = await upload(farm.acme.cookies.operator, [{ name: '../../etc/passwd.mp4', bytes: 100 }]);
    assert.equal(response.statusCode, 201);
    const [created] = response.json() as Array<{ id: string }>;
    const asset = farm.scheduler.assets.find(({ id }) => id === created!.id)!;
    assert.equal(asset.tenantId, farm.acme.tenantId);
    assert.equal(asset.uploadedBy, farm.acme.operator.id);
    assert.match(asset.relativePath, /^uploads\/[0-9a-f-]{36}$/, 'stored under a random name, never the browser\'s');
    assert.deepEqual(await onDisk(), [path.basename(asset.relativePath)]);
    // Platform staff upload on a tenant's behalf with ?tenant=.
    const forAcme = await upload(farm.platformCookie, [{ name: 'a.mp4', bytes: 10 }], `?tenant=${farm.acme.tenantId}`);
    assert.equal(farm.scheduler.assets.find(({ id }) => id === (forAcme.json() as Array<{ id: string }>)[0]!.id)?.tenantId, farm.acme.tenantId);
    assert.equal((await upload(farm.platformCookie, [{ name: 'a.mp4', bytes: 10 }], '?tenant=00000000-0000-0000-0000-00000000dead')).statusCode, 404);
    // A tenant user cannot upload into another tenant by asking.
    const sneaky = await upload(farm.acme.cookies.operator, [{ name: 'a.mp4', bytes: 10 }], `?tenant=${farm.beloura.tenantId}`);
    assert.equal(farm.scheduler.assets.find(({ id }) => id === (sneaky.json() as Array<{ id: string }>)[0]!.id)?.tenantId, farm.acme.tenantId);
});

test('a file over the per-file cap is refused with 413 and leaves nothing behind', async (context) => {
    const { farm, upload, onDisk } = await farmWithUploads();
    context.after(() => farm.app.close());
    const before = farm.scheduler.assets.length;
    const response = await upload(farm.acme.cookies.operator, [{ name: 'small.mp4', bytes: 10 }, { name: 'huge.mp4', bytes: 8192 }]);
    assert.equal(response.statusCode, 413);
    assert.equal(farm.scheduler.assets.length, before, 'no asset recorded, not even the small one');
    assert.deepEqual(await onDisk(), [], 'no partial files on disk');
});

test('a tenant\'s total upload budget is enforced before anything is recorded', async (context) => {
    const { farm, upload, onDisk } = await farmWithUploads();
    context.after(() => farm.app.close());
    farm.scheduler.uploadBudget = 1000; // the farm fixture already holds 10 bytes per tenant
    assert.equal((await upload(farm.acme.cookies.operator, [{ name: 'a.mp4', bytes: 900 }])).statusCode, 201);
    const over = await upload(farm.acme.cookies.operator, [{ name: 'b.mp4', bytes: 200 }]);
    assert.equal(over.statusCode, 413);
    assert.match(over.json().error, /limited to 1000 bytes in total/);
    assert.equal((await onDisk()).length, 1);
    // Another tenant's budget is its own.
    assert.equal((await upload(farm.beloura.cookies.operator, [{ name: 'c.mp4', bytes: 900 }])).statusCode, 201);
    // Deleting media frees the budget; only an admin may, and only their own tenant's.
    const mine = farm.scheduler.assets.filter(({ tenantId }) => tenantId === farm.acme.tenantId).map(({ id }) => id);
    const deleteAs = (cookies: Record<string, string>, assetIds: string[]) => inject(farm.app, { method: 'DELETE', url: '/api/assets', cookies, payload: { assetIds } });
    assert.equal((await deleteAs(farm.acme.cookies.operator, mine)).statusCode, 403);
    assert.equal((await deleteAs(farm.beloura.cookies.admin, mine)).statusCode, 404);
    assert.equal((await deleteAs(farm.acme.cookies.admin, [...mine, farm.beloura.asset.id])).statusCode, 404, 'one foreign id and nothing is deleted');
    assert.equal((await deleteAs(farm.acme.cookies.admin, mine)).statusCode, 204);
    assert.equal((await deleteAs(farm.acme.cookies.admin, 'x' as never)).statusCode, 400);
    assert.equal((await upload(farm.acme.cookies.operator, [{ name: 'b.mp4', bytes: 200 }])).statusCode, 201);
});

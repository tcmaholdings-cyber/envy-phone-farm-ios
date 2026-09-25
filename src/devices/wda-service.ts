import { chmod, mkdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';

import { databaseUrl } from '../database/client.js';
import { startHostLease } from '../hosts/lease.js';
import type { WorkerHeartbeat } from '../observability/heartbeat.js';
import { DeviceConnectionManager } from './connection-manager.js';
import { localHostId } from './host-identity.js';
import { closeDeviceRegistry, loadRegisteredDevices, registryKind } from './registry.js';
import { createWdaServiceHttpServer } from './wda-service-http.js';
import { WdaLogStore, wdaLogOptionsFromEnv } from './wda-log.js';
import { requestWdaService } from './wda-service-client.js';
import { wdaServiceSocketPath } from './wda-service-protocol.js';

const socketPath = wdaServiceSocketPath();
const lockPath = `${socketPath}.lock`;
await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });

// Fail before taking the lock on a bad PHONE_FARM_HOST_ID / PHONE_FARM_REGISTRY or
// an unreachable / unmigrated shared registry, rather than polling it forever.
localHostId();
if (registryKind() === 'postgres') await loadRegisteredDevices();

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function serviceResponding(): Promise<boolean> {
    try {
        await requestWdaService('/health', { socketPath, timeoutMs: 750 });
        return true;
    } catch {
        return false;
    }
}

async function acquireServiceLock(): Promise<void> {
    try {
        await mkdir(lockPath, { mode: 0o700 });
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await serviceResponding()) {
            console.log(`WDA service is already running at ${socketPath}`);
            process.exit(0);
        }
        await delay(250);
    }
    await rmdir(lockPath);
    await acquireServiceLock();
}

if (await serviceResponding()) {
    console.log(`WDA service is already running at ${socketPath}`);
    process.exit(0);
}
await acquireServiceLock();
if (await serviceResponding()) {
    await rmdir(lockPath);
    console.log(`WDA service is already running at ${socketPath}`);
    process.exit(0);
}
await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
});

// Per-phone xcodebuild output: rotated files under WDA_LOG_DIR (.wda/logs) + the last lines in memory.
const logOptions = wdaLogOptionsFromEnv();
const hostId = localHostId();
const connections = new DeviceConnectionManager({ logs: new WdaLogStore(logOptions), hostId });
console.log(`WDA supervisor logs: ${logOptions.directory}/<udid>.log`);
// With the shared Postgres registry this host supervises only its own phones
// and keeps its fleet.hosts row (the lease) fresh, like the worker does.
let lease: { pool: Pool; beat: WorkerHeartbeat } | undefined;
if (registryKind() === 'postgres') {
    const pool = new Pool({ connectionString: databaseUrl(), max: 1, allowExitOnIdle: true });
    pool.on('error', (error) => console.error(`Host lease pool: ${error.message}`));
    lease = { pool, beat: startHostLease(pool, { hostId }) };
    console.log(`WDA service is host ${hostId} (shared Postgres registry)`);
}
let stopping = false;
let ready = false;
const server = createWdaServiceHttpServer(connections, () => void shutdown('request'), () => ready);

async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping WDA service after ${reason}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await connections.close();
    await lease?.beat.stop();
    await lease?.pool.end().catch(() => undefined);
    await closeDeviceRegistry();
    await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
    });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

server.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
});

await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
    });
});
await chmod(socketPath, 0o600);
console.log(`WDA service listening at ${socketPath}`);
try {
    await connections.start();
    ready = true;
    console.log('WDA service is ready');
} catch (error) {
    console.error(error);
    await shutdown('startup failure');
    process.exitCode = 1;
}

import type { DeviceConnectionPhase, DeviceConnectionStatus } from '../devices/connection-manager.js';
import { queueNameForDevice } from '../scheduler/queue.js';
import type { WorkerHeartbeatRow } from './heartbeat.js';
import type { QueueStat } from './probes.js';

/**
 * A hand-rolled Prometheus text-format (0.0.4) writer. The farm exposes a few
 * dozen series; a client library would be the heaviest thing in the process.
 */
export type Labels = Record<string, string>;
export interface Sample { labels?: Labels; value: number }

export function escapeLabelValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatValue(value: number): string {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return '+Inf';
    if (value === -Infinity) return '-Inf';
    return String(Math.round(value * 1000) / 1000);
}

export class PrometheusText {
    private readonly blocks: string[] = [];

    add(name: string, help: string, samples: Sample[], type: 'gauge' | 'counter' = 'gauge'): this {
        const lines = [`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${name} ${type}`];
        for (const { labels, value } of samples) {
            const entries = Object.entries(labels ?? {});
            const rendered = entries.length
                ? `{${entries.map(([key, label]) => `${key}="${escapeLabelValue(label)}"`).join(',')}}`
                : '';
            lines.push(`${name}${rendered} ${formatValue(value)}`);
        }
        this.blocks.push(lines.join('\n'));
        return this;
    }

    render(): string {
        return `${this.blocks.join('\n')}\n`;
    }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const WDA_STATES: readonly DeviceConnectionPhase[] = ['ready', 'connecting', 'unlock-required', 'error', 'disconnected'];
const EXECUTION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'stopped'] as const;

export interface MetricsSnapshot {
    now: number;
    uptimeSeconds: number;
    /** Registered phones (from devices.json); always available. */
    devices: ReadonlyArray<{ udid: string; name: string; disabled?: boolean }>;
    /** UDIDs usbmux sees, or null when discovery failed. */
    usbUdids: ReadonlySet<string> | null;
    /** wda-service statuses, or null when the service could not be asked. */
    wda: readonly DeviceConnectionStatus[] | null;
    queues: readonly QueueStat[] | null;
    executionsLastHour: Readonly<Record<string, number>> | null;
    heartbeats: readonly WorkerHeartbeatRow[] | null;
}

function secondsSince(now: number, iso: string | undefined): number {
    if (!iso) return 0;
    const at = Date.parse(iso);
    return Number.isFinite(at) ? Math.max(0, (now - at) / 1_000) : 0;
}

export function renderMetrics(snapshot: MetricsSnapshot): string {
    const out = new PrometheusText();
    const active = snapshot.devices.filter((device) => !device.disabled);
    const names = new Map(snapshot.devices.map((device) => [device.udid, device.name]));
    const phone = (udid: string): Labels => ({ udid, name: names.get(udid) ?? '' });

    out.add('phone_farm_process_uptime_seconds', 'Seconds since the web process started.', [{ value: snapshot.uptimeSeconds }]);
    out.add('phone_farm_metrics_source_up', 'Whether a metrics source answered this scrape (1) or failed (0).', [
        { labels: { source: 'usb' }, value: snapshot.usbUdids ? 1 : 0 },
        { labels: { source: 'wda_service' }, value: snapshot.wda ? 1 : 0 },
        { labels: { source: 'database' }, value: snapshot.queues && snapshot.executionsLastHour && snapshot.heartbeats ? 1 : 0 },
    ]);
    out.add('phone_farm_phones_registered', 'Registered phones by state (disabled phones are not supervised).', [
        { labels: { state: 'active' }, value: active.length },
        { labels: { state: 'disabled' }, value: snapshot.devices.length - active.length },
    ]);

    if (snapshot.usbUdids) {
        const usb = snapshot.usbUdids;
        out.add('phone_farm_phones_usb_connected', 'Active registered phones currently visible over USB.', [
            { value: active.filter(({ udid }) => usb.has(udid)).length },
        ]);
        out.add('phone_farm_phone_usb_connected', 'Whether this active phone is visible over USB (1) or not (0).',
            active.map(({ udid }) => ({ labels: phone(udid), value: usb.has(udid) ? 1 : 0 })));
    }

    if (snapshot.wda) {
        const wda = snapshot.wda;
        out.add('phone_farm_wda_phones', 'Supervised phones by WebDriverAgent state.',
            WDA_STATES.map((state) => ({ labels: { state }, value: wda.filter((status) => status.wda === state).length })));
        out.add('phone_farm_wda_restarts_total', 'Times WDA on this phone failed and was relaunched since wda-service started.',
            wda.map((status) => ({ labels: phone(status.udid), value: status.restarts ?? 0 })), 'counter');
        out.add('phone_farm_phone_wda_not_ready_seconds', 'Seconds this phone\'s WDA has not been ready (0 while ready).',
            wda.map((status) => ({
                labels: phone(status.udid),
                value: status.wda === 'ready' ? 0 : secondsSince(snapshot.now, status.notReadySince ?? status.updatedAt),
            })));
        out.add('phone_farm_phone_usb_disconnected_seconds', 'Seconds this phone has been off USB, per wda-service (0 while attached).',
            wda.map((status) => ({
                labels: phone(status.udid),
                value: status.physical === 'connected' ? 0 : secondsSince(snapshot.now, status.disconnectedSince ?? status.updatedAt),
            })));
    }

    if (snapshot.queues) {
        const queueUdid = new Map(snapshot.devices.map(({ udid }) => [queueNameForDevice(udid), udid]));
        const labels = (queue: string): Labels => {
            const udid = queueUdid.get(queue);
            return udid ? { queue, ...phone(udid) } : { queue, udid: '', name: '' };
        };
        const queues = snapshot.queues;
        out.add('phone_farm_queue_depth', 'Jobs waiting to run now (created or retry, start time reached), per pg-boss queue.',
            queues.map((stat) => ({ labels: labels(stat.queue), value: stat.queued })));
        out.add('phone_farm_queue_deferred', 'Jobs scheduled for a later start time, per pg-boss queue.',
            queues.map((stat) => ({ labels: labels(stat.queue), value: stat.deferred })));
        out.add('phone_farm_queue_active', 'Jobs running now, per pg-boss queue.',
            queues.map((stat) => ({ labels: labels(stat.queue), value: stat.active })));
        out.add('phone_farm_queue_oldest_job_age_seconds', 'Age of the oldest job waiting to run, per pg-boss queue (0 when none).',
            queues.map((stat) => ({ labels: labels(stat.queue), value: stat.oldestQueuedSeconds ?? 0 })));
        out.add('phone_farm_queue_depth_total', 'Jobs waiting to run now across all queues.',
            [{ value: queues.reduce((sum, stat) => sum + stat.queued, 0) }]);
        out.add('phone_farm_queue_oldest_job_age_seconds_max', 'Age of the oldest job waiting to run on any queue (0 when none).',
            [{ value: Math.max(0, ...queues.map((stat) => stat.oldestQueuedSeconds ?? 0)) }]);
    }

    if (snapshot.executionsLastHour) {
        const counts = snapshot.executionsLastHour;
        const statuses = [...new Set([...EXECUTION_STATUSES, ...Object.keys(counts)])];
        out.add('phone_farm_executions_last_hour', 'Executions updated in the last hour, by status.',
            statuses.map((status) => ({ labels: { status }, value: counts[status] ?? 0 })));
    }

    if (snapshot.heartbeats) {
        const freshest = snapshot.heartbeats[0];
        out.add('phone_farm_worker_heartbeat_present', 'Whether any worker has ever written a heartbeat (1) or not (0).',
            [{ value: freshest ? 1 : 0 }]);
        if (freshest) {
            out.add('phone_farm_worker_heartbeat_age_seconds', 'Seconds since the freshest worker heartbeat, by the database clock.',
                [{ value: freshest.ageSeconds }]);
        }
        out.add('phone_farm_worker_host_heartbeat_age_seconds', 'Seconds since each host\'s worker last wrote its heartbeat.',
            snapshot.heartbeats.map((row) => ({ labels: { host: row.host }, value: row.ageSeconds })));
        out.add('phone_farm_worker_queues', 'Device queues each host\'s worker is subscribed to.',
            snapshot.heartbeats.map((row) => ({ labels: { host: row.host }, value: row.queues })));
    }
    return out.render();
}

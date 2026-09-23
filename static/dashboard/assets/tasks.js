const schedulesElement = document.querySelector('#schedules');
const executionsElement = document.querySelector('#executions');
const refresh = document.querySelector('#refresh-tasks');
const errorBanner = document.querySelector('#tasks-error');
const connectionBanner = document.querySelector('#connection-banner');
const toastElement = document.querySelector('#toast');
let toastTimer;
function toast(message, tone = 'ok') {
    toastElement.textContent = message;
    toastElement.classList.toggle('err', tone === 'err');
    toastElement.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastElement.classList.remove('visible'), 4_000);
}
/** The error banner: a plain title, the cause as text, and a Retry that reloads both lists. */
function showError(message) {
    errorBanner.hidden = message === null;
    if (message === null) {
        errorBanner.replaceChildren();
        return;
    }
    const title = document.createElement('strong');
    title.textContent = 'Could not load tasks.';
    const cause = document.createElement('p');
    cause.textContent = message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button secondary';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void load(true));
    errorBanner.replaceChildren(title, cause, retry);
}
function statusPill(state) {
    const pill = document.createElement('span');
    pill.className = `status ${state}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = state;
    pill.append(dot, label);
    return pill;
}
function emptyState(target, title, body) {
    target.className = 'task-list empty-state';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = body;
    target.replaceChildren(heading, text);
}
function shortDevice(udid) {
    return udid.length > 20 ? `${udid.slice(0, 8)}…${udid.slice(-6)}` : udid;
}
function date(value) {
    return value ? new Date(value).toLocaleString() : '—';
}
async function request(url, options) {
    let response;
    try {
        response = await fetch(url, options);
    }
    catch (error) {
        connectionBanner.hidden = false;
        throw error;
    }
    connectionBanner.hidden = true;
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}
function button(label, subject, action, done) {
    const value = document.createElement('button');
    value.className = 'icon-button';
    value.type = 'button';
    value.textContent = label;
    value.setAttribute('aria-label', `${label} ${subject}`);
    value.addEventListener('click', () => {
        value.disabled = true;
        value.setAttribute('aria-busy', 'true');
        void action().then((result) => {
            if (result !== false)
                toast(done);
        }).catch((error) => {
            toast(error instanceof Error ? error.message : String(error), 'err');
        }).finally(() => {
            value.disabled = false;
            value.removeAttribute('aria-busy');
        });
    });
    return value;
}
function renderSchedules(items) {
    if (!items.length) {
        emptyState(schedulesElement, 'No schedules yet', 'Schedule a doomscroll or a post from a device page and it appears here.');
        return;
    }
    schedulesElement.className = 'task-list';
    schedulesElement.replaceChildren(...items.map((schedule) => {
        const row = document.createElement('article');
        row.className = 'task-row';
        const copy = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = `${schedule.taskType} · ${shortDevice(schedule.deviceUdid)}`;
        const meta = document.createElement('p');
        meta.textContent = `${schedule.timing.kind} · next ${date(schedule.nextRunAt)}`;
        copy.append(title, meta);
        const state = statusPill(schedule.status);
        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        const subject = `${schedule.taskType} schedule for ${shortDevice(schedule.deviceUdid)}`;
        if (schedule.status === 'active' || schedule.status === 'paused')
            actions.append(button('Edit', subject, async () => {
                const timingText = window.prompt('Edit timing JSON', JSON.stringify(schedule.timing));
                if (!timingText)
                    return false;
                const windowText = window.prompt('Run-within window in minutes', String(schedule.runWindowMinutes));
                if (!windowText)
                    return false;
                const timing = JSON.parse(timingText);
                const recurringPublish = schedule.payload.type === 'post' && schedule.payload.destination === 'publish'
                    && (timing.kind === 'daily' || timing.kind === 'weekly');
                if (recurringPublish && !window.confirm('Confirm that this recurring schedule may publish publicly without confirmation on each occurrence.'))
                    return false;
                await request(`/api/schedules/${schedule.id}`, {
                    method: 'PATCH', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ timing, runWindowMinutes: Number(windowText), recurringPublishConfirmed: recurringPublish }),
                });
                await load();
            }, 'Schedule updated.'));
        if (schedule.status === 'active')
            actions.append(button('Pause', subject, async () => { await request(`/api/schedules/${schedule.id}/pause`, { method: 'POST' }); await load(); }, 'Schedule paused.'));
        if (schedule.status === 'paused')
            actions.append(button('Resume', subject, async () => { await request(`/api/schedules/${schedule.id}/resume`, { method: 'POST' }); await load(); }, 'Schedule resumed.'));
        if (schedule.status !== 'cancelled' && schedule.status !== 'completed')
            actions.append(button('Cancel', subject, async () => { await request(`/api/schedules/${schedule.id}/cancel`, { method: 'POST' }); await load(); }, 'Schedule cancelled.'));
        row.append(state, copy, actions);
        return row;
    }));
}
function renderExecutions(items) {
    if (!items.length) {
        emptyState(executionsElement, 'No runs yet', 'Runs appear here as soon as the worker picks up a schedule.');
        return;
    }
    executionsElement.className = 'task-list';
    executionsElement.replaceChildren(...items.map((execution) => {
        const row = document.createElement('article');
        row.className = 'task-row';
        const copy = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = `${execution.taskType} · ${shortDevice(execution.deviceUdid)}`;
        const meta = document.createElement('p');
        meta.textContent = `${date(execution.scheduledFor)}${execution.error ? ` · ${execution.error}` : ''}`;
        meta.title = meta.textContent;
        copy.append(title, meta);
        const state = statusPill(execution.status);
        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        const subject = `${execution.taskType} run on ${shortDevice(execution.deviceUdid)}`;
        if (execution.status === 'queued' || (execution.status === 'running' && execution.taskType === 'doomscroll')) {
            const label = execution.status === 'queued' ? 'Cancel' : 'Stop';
            actions.append(button(label, subject, async () => {
                await request(`/api/executions/${execution.id}/stop`, { method: 'POST' });
                await load();
            }, label === 'Cancel' ? 'Run cancelled.' : 'Stop requested.'));
        }
        if (execution.status === 'failed' || execution.status === 'stopped') {
            actions.append(button('Retry', subject, async () => {
                if (execution.taskType === 'post' && !window.confirm('The post may already have reached TikTok. Retry only after checking the device.'))
                    return false;
                await request(`/api/executions/${execution.id}/retry`, { method: 'POST' });
                await load();
            }, 'Run queued again.'));
        }
        row.append(state, copy, actions);
        return row;
    }));
}
async function load(manual = false) {
    if (manual) {
        refresh.disabled = true;
        refresh.setAttribute('aria-busy', 'true');
    }
    try {
        const [scheduleData, executionData] = await Promise.all([
            request('/api/schedules'),
            request('/api/executions'),
        ]);
        showError(null);
        renderSchedules(scheduleData.schedules);
        renderExecutions(executionData.executions);
    }
    catch (error) {
        // Keep the last lists on screen; the banner says what went wrong.
        showError(error instanceof Error ? error.message : String(error));
        for (const list of [schedulesElement, executionsElement]) {
            if (list.getAttribute('aria-busy') === 'true')
                emptyState(list, 'Unavailable', 'Nothing to show until the tasks load.');
        }
    }
    finally {
        refresh.disabled = false;
        refresh.removeAttribute('aria-busy');
        schedulesElement.removeAttribute('aria-busy');
        executionsElement.removeAttribute('aria-busy');
    }
}
refresh.addEventListener('click', () => void load(true));
void load();
setInterval(() => void load(), 5_000);
export {};

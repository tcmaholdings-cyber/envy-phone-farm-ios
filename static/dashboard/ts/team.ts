export {};

// The Team panel (admin only). The page is rendered on the server with every
// value escaped; this script only sends same-origin JSON requests and reloads.
// A temporary password arrives in one API response and is shown once, in a
// dialog, through textContent — it is never part of the page's HTML.

interface Scopes {
    rack: string[];
    model: string[];
    device: Array<{ value: string; label: string }>;
}

function element<T extends Element>(selector: string): T {
    const value = document.querySelector<T>(selector);
    if (!value) throw new Error(`Missing element: ${selector}`);
    return value;
}

const errorBanner = element<HTMLElement>('#team-error');
const toastElement = element<HTMLElement>('#toast');
const userDialog = element<HTMLDialogElement>('#user-dialog');
const userForm = element<HTMLFormElement>('#user-form');
const userTitle = element<HTMLElement>('#user-dialog-title');
const userHelp = element<HTMLElement>('#user-dialog-help');
const userResult = element<HTMLElement>('#user-result');
const secretDialog = element<HTMLDialogElement>('#secret-dialog');
const secretUser = element<HTMLElement>('#secret-user');
const secretValue = element<HTMLOutputElement>('#secret-value');
const groupDialog = element<HTMLDialogElement>('#group-dialog');
const groupForm = element<HTMLFormElement>('#group-form');
const groupTitle = element<HTMLElement>('#group-dialog-title');
const groupResult = element<HTMLElement>('#group-result');
const grantForm = element<HTMLFormElement>('#grant-form');
const grantScope = element<HTMLSelectElement>('#grant-scope');
const grantValue = element<HTMLSelectElement>('#grant-value');
const scopes = JSON.parse(element<HTMLScriptElement>('#team-scopes').textContent ?? '{}') as Scopes;

let editingUserId: string | null = null;
let editingGroupId: string | null = null;
let toastTimer: number | undefined;

function toast(message: string, tone: 'ok' | 'err' = 'ok'): void {
    toastElement.textContent = message;
    toastElement.classList.toggle('err', tone === 'err');
    toastElement.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastElement.classList.remove('visible'), 4_000);
}

function showError(message: string | null): void {
    errorBanner.hidden = message === null;
    errorBanner.replaceChildren();
    if (message === null) return;
    const title = document.createElement('strong');
    title.textContent = message;
    errorBanner.append(title);
    errorBanner.scrollIntoView({ block: 'nearest' });
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
    });
    if (response.status === 401) { location.href = '/login?next=%2Fteam'; throw new Error('Signed out'); }
    if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Request failed (${response.status})`);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
}

function reload(): void { location.reload(); }

function showSecret(username: string, password: string): void {
    secretUser.textContent = username;
    secretValue.textContent = password;
    secretDialog.showModal();
}

function openUserDialog(mode: 'create' | 'edit', user?: { id: string; name: string; role: string }): void {
    editingUserId = mode === 'edit' && user ? user.id : null;
    userForm.reset();
    userResult.textContent = '';
    userTitle.textContent = mode === 'create' ? 'Add person' : 'Edit person';
    userHelp.textContent = mode === 'create'
        ? 'They get a temporary password, shown once, and choose their own at first sign-in.'
        : 'Change how this person is shown and what role they have.';
    for (const node of userForm.querySelectorAll<HTMLElement>('[data-create-only]')) {
        node.hidden = mode !== 'create';
        node.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = mode !== 'create'; });
    }
    if (user) {
        (userForm.elements.namedItem('displayName') as HTMLInputElement).value = user.name;
        (userForm.elements.namedItem('role') as HTMLSelectElement).value = user.role;
    }
    userDialog.showModal();
}

function openGroupDialog(group?: { id: string; name: string; description: string }): void {
    editingGroupId = group?.id ?? null;
    groupForm.reset();
    groupResult.textContent = '';
    groupTitle.textContent = group ? 'Rename group' : 'New group';
    if (group) {
        (groupForm.elements.namedItem('name') as HTMLInputElement).value = group.name;
        (groupForm.elements.namedItem('description') as HTMLInputElement).value = group.description;
    }
    groupDialog.showModal();
}

function fillScopeValues(): void {
    const type = grantScope.value as 'all' | keyof Scopes;
    grantValue.replaceChildren();
    if (type === 'all') {
        grantValue.add(new Option('Every phone', ''));
        grantValue.disabled = true;
        return;
    }
    const choices = type === 'device'
        ? scopes.device.map(({ value, label }) => new Option(label, value))
        : scopes[type].map((value) => new Option(type === 'rack' ? `Rack ${value}` : value, value));
    if (!choices.length) {
        grantValue.add(new Option(type === 'rack' ? 'No racks set on any phone yet' : type === 'model' ? 'No models known yet' : 'No phones registered', ''));
        grantValue.disabled = true;
        return;
    }
    grantValue.disabled = false;
    for (const choice of choices) grantValue.add(choice);
}

async function run(button: HTMLButtonElement | null, work: () => Promise<void>): Promise<void> {
    showError(null);
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
        await work();
    } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
    } finally {
        if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
}

document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const close = target?.closest<HTMLElement>('[data-close]');
    if (close) { close.closest('dialog')?.close(); return; }
    const button = target?.closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const { action, id = '', username = '', name = '', role = '', group = '', description = '' } = button.dataset;
    switch (action) {
        case 'new-user': openUserDialog('create'); break;
        case 'new-group': openGroupDialog(); break;
        case 'edit-user': openUserDialog('edit', { id, name, role }); break;
        case 'rename-group': openGroupDialog({ id, name, description }); break;
        case 'reset-password':
            if (!window.confirm(`Reset the password for ${username}? They are signed out everywhere and must use the new temporary password.`)) return;
            void run(button, async () => {
                const result = await api<{ temporaryPassword: string }>('POST', `/api/team/users/${encodeURIComponent(id)}/reset-password`);
                showSecret(username, result.temporaryPassword);
            });
            break;
        case 'toggle-user': {
            const disable = button.dataset.disabled === 'true';
            if (disable && !window.confirm(`Disable ${username}? They are signed out at once and cannot sign in until enabled.`)) return;
            void run(button, async () => {
                await api('PATCH', `/api/team/users/${encodeURIComponent(id)}`, { disabled: disable });
                reload();
            });
            break;
        }
        case 'delete-user':
            if (!window.confirm(`Delete ${username}? Their grants and group memberships are removed too. This cannot be undone.`)) return;
            void run(button, async () => { await api('DELETE', `/api/team/users/${encodeURIComponent(id)}`); reload(); });
            break;
        case 'delete-group':
            if (!window.confirm(`Delete the group ${name}? Members lose the access granted to the group.`)) return;
            void run(button, async () => { await api('DELETE', `/api/team/groups/${encodeURIComponent(id)}`); reload(); });
            break;
        case 'remove-member':
            void run(button, async () => {
                await api('DELETE', `/api/team/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(id)}`);
                reload();
            });
            break;
        case 'delete-grant':
            if (!window.confirm('Remove this access?')) return;
            void run(button, async () => { await api('DELETE', `/api/team/grants/${encodeURIComponent(id)}`); reload(); });
            break;
        default: break;
    }
});

userForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(userForm);
    const submit = userForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    userResult.textContent = '';
    void (async () => {
        if (submit) submit.disabled = true;
        try {
            if (editingUserId) {
                await api('PATCH', `/api/team/users/${encodeURIComponent(editingUserId)}`, {
                    displayName: String(data.get('displayName') ?? '').trim() || undefined, role: data.get('role'),
                });
                userDialog.close();
                reload();
                return;
            }
            const result = await api<{ user: { username: string }; temporaryPassword: string }>('POST', '/api/team/users', {
                username: String(data.get('username') ?? '').trim(),
                displayName: String(data.get('displayName') ?? '').trim(),
                role: data.get('role'),
                groupIds: data.getAll('groupIds'),
            });
            userDialog.close();
            showSecret(result.user.username, result.temporaryPassword);
        } catch (error) {
            userResult.textContent = error instanceof Error ? error.message : String(error);
        } finally {
            if (submit) submit.disabled = false;
        }
    })();
});

groupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(groupForm);
    const body = { name: String(data.get('name') ?? '').trim(), description: String(data.get('description') ?? '').trim() };
    groupResult.textContent = '';
    void (async () => {
        try {
            if (editingGroupId) await api('PATCH', `/api/team/groups/${encodeURIComponent(editingGroupId)}`, body);
            else await api('POST', '/api/team/groups', body);
            groupDialog.close();
            reload();
        } catch (error) {
            groupResult.textContent = error instanceof Error ? error.message : String(error);
        }
    })();
});

document.querySelectorAll<HTMLFormElement>('form[data-form="add-member"]').forEach((form) => {
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const userId = String(new FormData(form).get('userId') ?? '');
        if (!userId) return;
        void run(form.querySelector('button'), async () => {
            await api('POST', `/api/team/groups/${encodeURIComponent(form.dataset.group ?? '')}/members`, { userId });
            reload();
        });
    });
});

grantScope.addEventListener('change', fillScopeValues);
grantForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(grantForm);
    const [subjectType, subjectId] = String(data.get('subject') ?? '').split(':');
    if (!subjectType || !subjectId) { showError('Choose who gets access.'); return; }
    const scopeType = grantScope.value;
    if (scopeType !== 'all' && !grantValue.value) { showError(`Choose which ${scopeType} this covers.`); return; }
    void run(grantForm.querySelector('button[type="submit"]'), async () => {
        await api('POST', '/api/team/grants', {
            subjectType, subjectId, scopeType, scopeValue: scopeType === 'all' ? undefined : grantValue.value, level: data.get('level'),
        });
        reload();
    });
});

element<HTMLButtonElement>('#secret-copy').addEventListener('click', () => {
    void navigator.clipboard?.writeText(secretValue.textContent ?? '')
        .then(() => toast('Copied.'), () => toast('Copy failed — select the text instead.', 'err'));
});
element<HTMLButtonElement>('#secret-done').addEventListener('click', () => {
    secretValue.textContent = '';
    secretDialog.close();
    reload();
});
secretDialog.addEventListener('cancel', (event) => event.preventDefault());

document.querySelectorAll<HTMLTimeElement>('time[data-local-time]').forEach((node) => {
    const when = new Date(node.dateTime);
    if (!Number.isNaN(when.getTime())) node.textContent = when.toLocaleString();
});
fillScopeValues();

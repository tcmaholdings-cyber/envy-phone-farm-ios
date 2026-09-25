import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createAuthApp, DEFAULT_TENANT_ID, sessionCookie, TEST_DEVICES, useDevicesFile, type MemoryAuthStore } from './auth-support.js';
import { inject } from './support.js';

await useDevicesFile(TEST_DEVICES);
const { hashPassword } = await import('../src/auth/password.js');

const PASSWORD = 'correct horse battery';

async function addUser(store: MemoryAuthStore, username: string, role: 'platform' | 'admin' | 'operator', options: { password?: string; displayName?: string; mustChange?: boolean } = {}) {
    const user = await store.createUser({
        username, role, displayName: options.displayName ?? username, tenantId: role === 'platform' ? null : DEFAULT_TENANT_ID,
        passwordHash: await hashPassword(options.password ?? PASSWORD), mustChangePassword: options.mustChange ?? false,
    });
    return user;
}

type App = Awaited<ReturnType<typeof createAuthApp>>['app'];

async function login(app: App, username: string, password = PASSWORD, extra: { headers?: Record<string, string>; remoteAddress?: string; next?: string } = {}) {
    return inject(app, {
        method: 'POST', url: '/login', remoteAddress: extra.remoteAddress,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra.headers },
        payload: new URLSearchParams({ username, password, ...(extra.next ? { next: extra.next } : {}) }).toString(),
    });
}

test('without a session, pages redirect to sign-in, the API answers 401, and only the sign-in assets are public', async (context) => {
    const { app } = await createAuthApp();
    context.after(() => app.close());
    const home = await inject(app, { method: 'GET', url: '/', headers: { accept: 'text/html' } });
    assert.equal(home.statusCode, 302);
    assert.equal(home.headers.location, '/login');
    const tasks = await inject(app, { method: 'GET', url: '/tasks?x=1', headers: { accept: 'text/html' } });
    assert.equal(tasks.headers.location, `/login?next=${encodeURIComponent('/tasks?x=1')}`);
    const api = await inject(app, { method: 'GET', url: '/api/devices' });
    assert.equal(api.statusCode, 401);
    assert.deepEqual(api.json(), { error: 'Authentication required' });
    const htmx = await inject(app, { method: 'GET', url: '/api/fragments/devices', headers: { 'hx-request': 'true' } });
    assert.equal(htmx.statusCode, 401);
    assert.equal(htmx.headers['hx-redirect'], '/login', 'an expired session in a polling grid sends the page to sign-in');
    for (const url of ['/health', '/login', '/assets/styles.css', '/assets/fonts/poppins-latin-400.woff2']) {
        assert.equal((await inject(app, { method: 'GET', url })).statusCode, 200, url);
    }
    for (const url of ['/assets/grid.js', '/assets/device.js', '/assets/team.js', '/assets/htmx.min.js', '/api/me', '/api/team']) {
        assert.equal((await inject(app, { method: 'GET', url })).statusCode, 401, url);
    }
    assert.equal((await inject(app, { method: 'GET', url: '/team' })).headers.location, `/login?next=${encodeURIComponent('/team')}`);
    const page = await inject(app, { method: 'GET', url: '/login?next=%22%3E%3Cscript%3E' });
    assert.doesNotMatch(page.body, /<script>/, 'the next parameter is never reflected raw');
    assert.match(page.body, /<form class="auth-form" method="post" action="\/login">/);
    assert.match(page.body, /autocomplete="current-password"/);
    assert.doesNotMatch(page.body, /topbar-nav/, 'the sign-in page shows no navigation');
});

test('signing in sets an HttpOnly, SameSite=Lax session cookie and stores only its hash', async (context) => {
    const { app, store, audit } = await createAuthApp();
    context.after(() => app.close());
    const user = await addUser(store, 'kash', 'platform', { displayName: 'Kash <Owner>' });
    const response = await login(app, 'Kash', PASSWORD, { next: '/tasks' });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, '/tasks');
    const cookie = sessionCookie(response);
    assert.ok(cookie);
    assert.match(cookie.raw, /HttpOnly/);
    assert.match(cookie.raw, /SameSite=Lax/);
    assert.match(cookie.raw, /Path=\//);
    assert.match(cookie.raw, /Max-Age=604800/, 'the cookie lives no longer than the absolute session limit');
    assert.doesNotMatch(cookie.raw, /Secure/, 'plain http://127.0.0.1 must keep working');
    assert.equal(store.sessions.length, 1);
    assert.notEqual(store.sessions[0]!.tokenHash, cookie.value);
    assert.equal(store.sessions[0]!.tokenHash, crypto.createHash('sha256').update(cookie.value).digest('hex'));
    assert.ok(!JSON.stringify(store.sessions).includes(cookie.value), 'the raw token is stored nowhere');
    assert.ok(store.users.find(({ id }) => id === user.id)?.lastLoginAt);
    assert.equal(audit.at(-1)?.event, 'login.success');
    assert.ok(!JSON.stringify(audit).includes(PASSWORD), 'audit events never carry a password');

    const home = await inject(app, { method: 'GET', url: '/', cookies: { pf_session: cookie.value } });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /<span class="nav-user">Kash &lt;Owner&gt;<\/span>/);
    assert.match(home.body, /<form class="nav-logout" method="post" action="\/logout"><button class="button secondary app-logout" type="submit">Log out<\/button><\/form>/);
    assert.match(home.body, /<a class="nav-link" href="\/team">Team<\/a>/);
    assert.match(home.body, /<body class="page-grid">/, 'a platform page carries no role marker');
    const me = await inject(app, { method: 'GET', url: '/api/me', cookies: { pf_session: cookie.value } });
    assert.deepEqual(me.json(), { id: user.id, username: 'kash', displayName: 'Kash <Owner>', role: 'platform', tenantId: null, mustChangePassword: false });
});

test('the cookie is Secure behind the HTTPS tunnel (loopback peer) and not when the proto header comes from elsewhere', async (context) => {
    const { app, store } = await createAuthApp();
    context.after(() => app.close());
    await addUser(store, 'rex', 'admin');
    const tunnel = await login(app, 'rex', PASSWORD, { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '198.51.100.7' } });
    assert.match(sessionCookie(tunnel)!.raw, /; Secure/);
    assert.equal(store.sessions.at(-1)!.ip, '198.51.100.7', 'the session records the real client IP from Cloudflare');
    const visitor = await login(app, 'rex', PASSWORD, { remoteAddress: '127.0.0.1', headers: { 'cf-visitor': '{"scheme":"https"}' } });
    assert.match(sessionCookie(visitor)!.raw, /; Secure/);
    const lan = await login(app, 'rex', PASSWORD, { remoteAddress: '192.168.1.40', headers: { 'x-forwarded-proto': 'https', 'cf-connecting-ip': '198.51.100.7' } });
    assert.doesNotMatch(sessionCookie(lan)!.raw, /Secure/);
    assert.equal(store.sessions.at(-1)!.ip, '192.168.1.40');
});

test('a wrong password, an unknown user and a disabled account get the same answer', async (context) => {
    const { app, store, audit } = await createAuthApp();
    context.after(() => app.close());
    await addUser(store, 'mikey', 'admin');
    const disabled = await addUser(store, 'gone', 'operator');
    await store.updateUser(disabled.id, { disabled: true });
    const bodies = [];
    for (const [username, password] of [['mikey', 'wrong password!!'], ['nobody', PASSWORD], ['gone', PASSWORD]] as const) {
        const response = await login(app, username, password);
        assert.equal(response.statusCode, 401, username);
        assert.equal(sessionCookie(response), null);
        bodies.push(response.body.replace(/ value="[^"]*"/g, ''));
    }
    assert.equal(bodies[0], bodies[1]);
    assert.equal(bodies[1], bodies[2]);
    assert.match(bodies[0]!, /That username and password do not match an active account/);
    assert.deepEqual(audit.map(({ event, detail }) => `${event}:${detail}`), [
        'login.failure:wrong password', 'login.failure:unknown user', 'login.failure:account disabled',
    ], 'the server log still says why');
    const json = await inject(app, { method: 'POST', url: '/login', payload: { username: 'mikey', password: 'nope' } });
    assert.equal(json.statusCode, 401);
    assert.deepEqual(json.json(), { error: 'That username and password do not match an active account.' });
});

test('repeated failures lock the username (even with the right password) and a busy IP locks every username', async (context) => {
    const { app, store, clock, audit } = await createAuthApp();
    context.after(() => app.close());
    await addUser(store, 'kash', 'admin');
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await login(app, 'kash', 'bad guess number')).statusCode, 401);
    const locked = await login(app, 'kash', PASSWORD);
    assert.equal(locked.statusCode, 429);
    assert.equal(sessionCookie(locked), null);
    assert.equal(locked.headers['retry-after'], '30');
    assert.match(locked.body, /Too many sign-in attempts/);
    assert.equal(audit.at(-1)?.event, 'login.throttled');
    const elsewhere = await login(app, 'kash', PASSWORD, { remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.50' } });
    assert.equal(elsewhere.statusCode, 429, 'the username lock follows the name to another IP');
    clock.advance(31_000);
    const after = await login(app, 'kash', PASSWORD);
    assert.equal(after.statusCode, 303, 'the lock expires');

    // One tunnelled client spraying usernames: after 20 failures the IP is locked.
    const spray = { remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.99' } };
    for (let attempt = 0; attempt < 20; attempt += 1) await login(app, `user${attempt}`, 'whatever pass', spray);
    await addUser(store, 'rex', 'operator');
    assert.equal((await login(app, 'rex', PASSWORD, spray)).statusCode, 429);
    assert.equal((await login(app, 'rex', PASSWORD, { remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.100' } })).statusCode, 303,
        'a different client IP is unaffected');
});

test('log out is a same-origin POST that ends the session', async (context) => {
    const { app, store } = await createAuthApp();
    context.after(() => app.close());
    await addUser(store, 'kash', 'admin');
    const cookie = sessionCookie(await login(app, 'kash'))!.value;
    const forged = await app.inject({ method: 'POST', url: '/logout', cookies: { pf_session: cookie }, headers: { origin: 'https://evil.example' } });
    assert.equal(forged.statusCode, 403, 'the CSRF guard blocks a cross-site logout');
    const bare = await app.inject({ method: 'POST', url: '/logout', cookies: { pf_session: cookie } });
    assert.equal(bare.statusCode, 403, 'no Origin, no write');
    assert.equal(store.sessions.length, 1);
    const response = await inject(app, { method: 'POST', url: '/logout', cookies: { pf_session: cookie } });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, '/login');
    assert.match(sessionCookie(response)!.raw, /Expires=Thu, 01 Jan 1970/);
    assert.equal(store.sessions.length, 0);
    assert.equal((await inject(app, { method: 'GET', url: '/api/devices', cookies: { pf_session: cookie } })).statusCode, 401);
    const getLogout = await inject(app, { method: 'GET', url: '/logout' });
    assert.equal(getLogout.statusCode, 404, 'there is no GET logout for an <img> tag to trigger');
});

test('sessions slide on activity, expire after 12 idle hours, and end after 7 days regardless', async (context) => {
    const { app, store, clock } = await createAuthApp();
    context.after(() => app.close());
    await addUser(store, 'kash', 'admin');
    const ok = (cookie: string) => inject(app, { method: 'GET', url: '/api/devices', cookies: { pf_session: cookie } }).then((r) => r.statusCode);

    const idle = sessionCookie(await login(app, 'kash'))!.value;
    clock.advance(12 * 60 * 60_000 - 60_000);
    assert.equal(await ok(idle), 200, 'just inside the idle window');
    clock.advance(12 * 60 * 60_000 + 60_000);
    assert.equal(await ok(idle), 401, 'idle too long');
    assert.equal(store.sessions.length, 0, 'an expired session is deleted');

    const busy = sessionCookie(await login(app, 'kash'))!.value;
    for (let hours = 6; hours < 7 * 24; hours += 6) {
        clock.advance(6 * 60 * 60_000);
        assert.equal(await ok(busy), 200, `still active after ${hours}h of steady use`);
    }
    clock.advance(6 * 60 * 60_000);
    assert.equal(await ok(busy), 401, 'the 7-day absolute limit ends even an active session');
});

test('disabling a user or resetting their password ends their sessions at once', async (context) => {
    const { app, store, accounts } = await createAuthApp();
    context.after(() => app.close());
    const admin = await addUser(store, 'kash', 'admin');
    const operator = await addUser(store, 'va1', 'operator');
    const cookie = sessionCookie(await login(app, 'va1'))!.value;
    assert.equal((await inject(app, { method: 'GET', url: '/api/devices', cookies: { pf_session: cookie } })).statusCode, 200);
    await accounts.resetPassword({ id: admin.id, username: 'kash' }, operator.id);
    assert.equal((await inject(app, { method: 'GET', url: '/api/devices', cookies: { pf_session: cookie } })).statusCode, 401);
    await store.updateUser(operator.id, { passwordHash: await hashPassword(PASSWORD), mustChangePassword: false });
    const again = sessionCookie(await login(app, 'va1'))!.value;
    await accounts.updateUser({ id: admin.id, username: 'kash' }, operator.id, { disabled: true });
    assert.equal((await inject(app, { method: 'GET', url: '/api/devices', cookies: { pf_session: again } })).statusCode, 401);
});

test('a temporary password forces a password change before anything else', async (context) => {
    const { app, store, accounts } = await createAuthApp();
    context.after(() => app.close());
    await addUser(store, 'kash', 'admin');
    const created = await accounts.createUser(null, { username: 'NewVA', role: 'operator', displayName: 'New VA' });
    assert.equal(created.user.username, 'newva');
    assert.equal(created.user.mustChangePassword, true);
    assert.ok(!('passwordHash' in created.user), 'the API shape never carries the hash');

    const signIn = await login(app, 'newva', created.temporaryPassword, { next: '/tasks' });
    assert.equal(signIn.statusCode, 303);
    assert.equal(signIn.headers.location, '/account/password');
    const cookie = sessionCookie(signIn)!.value;
    const cookies = { pf_session: cookie };
    const page = await inject(app, { method: 'GET', url: '/', cookies, headers: { accept: 'text/html' } });
    assert.equal(page.statusCode, 302);
    assert.equal(page.headers.location, '/account/password');
    assert.equal((await inject(app, { method: 'GET', url: '/api/devices', cookies })).statusCode, 403);
    assert.equal((await inject(app, { method: 'GET', url: '/api/me', cookies })).json().mustChangePassword, true);
    const form = await inject(app, { method: 'GET', url: '/account/password', cookies });
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /Choose your password/);
    assert.match(form.body, /Temporary password/);

    const change = (current: string, next: string, confirm = next) => inject(app, {
        method: 'POST', url: '/account/password', cookies,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ currentPassword: current, newPassword: next, confirmPassword: confirm }).toString(),
    });
    assert.match((await change('not the temp one', 'a brand new password')).body, /current password is not correct/);
    assert.match((await change(created.temporaryPassword, 'short')).body, /at least 12/);
    assert.match((await change(created.temporaryPassword, 'a brand new password', 'a different one!!')).body, /do not match/);
    assert.match((await change(created.temporaryPassword, created.temporaryPassword)).body, /not the current one/);

    const other = sessionCookie(await login(app, 'newva', created.temporaryPassword))!.value;
    const done = await change(created.temporaryPassword, 'a brand new password');
    assert.equal(done.statusCode, 303);
    assert.equal(done.headers.location, '/');
    assert.equal(store.users.find(({ username }) => username === 'newva')!.mustChangePassword, false);
    assert.equal((await inject(app, { method: 'GET', url: '/api/devices', cookies })).statusCode, 200, 'this session continues');
    assert.equal((await inject(app, { method: 'GET', url: '/api/devices', cookies: { pf_session: other } })).statusCode, 401, 'other sessions end');
    assert.equal((await login(app, 'newva', created.temporaryPassword)).statusCode, 401, 'the temporary password is dead');
    assert.equal((await login(app, 'newva', 'a brand new password')).statusCode, 303);
});

test('a signed-in visit to /login goes straight to the destination', async (context) => {
    const { app, store } = await createAuthApp();
    context.after(() => app.close());
    await addUser(store, 'kash', 'admin');
    const cookie = sessionCookie(await login(app, 'kash'))!.value;
    const response = await inject(app, { method: 'GET', url: '/login?next=/tasks', cookies: { pf_session: cookie } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/tasks');
    const offsite = await inject(app, { method: 'GET', url: '/login?next=//evil.example', cookies: { pf_session: cookie } });
    assert.equal(offsite.headers.location, '/');
});

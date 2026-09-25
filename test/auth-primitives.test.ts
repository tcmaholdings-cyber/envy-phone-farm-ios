import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';

import { clientIp, isHttpsRequest, isLoopbackAddress } from '../src/auth/net.js';
import { generatePassword, hashPassword, MIN_PASSWORD_LENGTH, passwordProblem, verifyPassword } from '../src/auth/password.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { BACKOFF_POLICY, EXPIRY_POLICY, throttleBackoffScenario, throttleExpiryScenario } from './throttle-scenarios.js';
import { safeNextPath } from '../src/auth/routes.js';

test('a password hash verifies the right password and nothing else, and never contains the password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.match(hash, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.ok(!hash.includes('correct horse'));
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('correct horse battery stapl', hash), false);
    assert.equal(await verifyPassword('', hash), false);
});

test('every hash has its own salt', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here'), hashPassword('same password here')]);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('same password here', a), true);
    assert.equal(await verifyPassword('same password here', b), true);
});

test('verification compares with timingSafeEqual and rejects malformed or truncated hashes without throwing', async (context) => {
    const hash = await hashPassword('another long password');
    const calls: number[] = [];
    const original = crypto.timingSafeEqual;
    context.mock.method(crypto, 'timingSafeEqual', (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
        calls.push(a.byteLength);
        return original(a, b);
    });
    assert.equal(await verifyPassword('another long password', hash), true);
    assert.deepEqual(calls, [64], 'the 64-byte digests are compared in constant time');
    const parts = hash.split('$');
    for (const bad of [
        '', 'plaintext', 'bcrypt$10$abc', `${parts.slice(0, 5).join('$')}$`, `${parts.slice(0, 5).join('$')}$AAAA`,
        `scrypt$0$8$1$${parts[4]}$${parts[5]}`, `scrypt$${2 ** 24}$8$1$${parts[4]}$${parts[5]}`,
    ]) {
        assert.equal(await verifyPassword('another long password', bad), false, bad);
    }
});

test('generated temporary passwords are long, varied and unambiguous', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
        const password = generatePassword();
        assert.match(password, /^[a-km-zA-HJ-NP-Z2-9]{5}(-[a-km-zA-HJ-NP-Z2-9]{5}){3}$/);
        assert.ok(password.length >= MIN_PASSWORD_LENGTH);
        assert.equal(passwordProblem(password), null);
        seen.add(password);
    }
    assert.equal(seen.size, 50);
});

test('password rules: at least 12 characters, not the username', () => {
    assert.match(passwordProblem('short') ?? '', /12/);
    assert.match(passwordProblem(undefined) ?? '', /12/);
    assert.equal(passwordProblem('twelve chars'), null);
    assert.match(passwordProblem('Mikey-Account', 'mikey-account') ?? '', /username/);
    assert.match(passwordProblem('x'.repeat(300)) ?? '', /at most/);
});

test('loopback detection covers IPv4, IPv6 and v4-mapped addresses only', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true, address);
    for (const address of ['10.0.0.1', '192.168.1.5', '::ffff:10.0.0.1', '100.119.132.42', '', undefined]) {
        assert.equal(isLoopbackAddress(address), false, String(address));
    }
});

async function probe() {
    const app = Fastify();
    app.get('/probe', async (request) => ({ ip: clientIp(request), https: isHttpsRequest(request) }));
    await app.ready();
    return app;
}

test('CF-Connecting-IP is trusted only from a loopback peer (the local cloudflared)', async (context) => {
    const app = await probe();
    context.after(() => app.close());
    const tunnelled = await app.inject({ url: '/probe', remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(tunnelled.json().ip, '203.0.113.9');
    const forged = await app.inject({ url: '/probe', remoteAddress: '192.168.1.50', headers: { 'cf-connecting-ip': '203.0.113.9' } });
    assert.equal(forged.json().ip, '192.168.1.50', 'a LAN client cannot pick its own IP for the throttle');
    const garbage = await app.inject({ url: '/probe', remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': 'not-an-ip' } });
    assert.equal(garbage.json().ip, '127.0.0.1');
    const direct = await app.inject({ url: '/probe', remoteAddress: '127.0.0.1' });
    assert.equal(direct.json().ip, '127.0.0.1');
});

test('HTTPS is inferred from X-Forwarded-Proto / CF-Visitor only when the peer is loopback', async (context) => {
    const app = await probe();
    context.after(() => app.close());
    const https = async (remoteAddress: string, headers: Record<string, string>) =>
        (await app.inject({ url: '/probe', remoteAddress, headers })).json().https as boolean;
    assert.equal(await https('127.0.0.1', {}), false, 'plain local http');
    assert.equal(await https('127.0.0.1', { 'x-forwarded-proto': 'https' }), true);
    assert.equal(await https('127.0.0.1', { 'x-forwarded-proto': 'https, http' }), true);
    assert.equal(await https('127.0.0.1', { 'cf-visitor': '{"scheme":"https"}' }), true);
    assert.equal(await https('127.0.0.1', { 'cf-visitor': '{"scheme":"http"}' }), false);
    assert.equal(await https('127.0.0.1', { 'cf-visitor': 'nonsense' }), false);
    assert.equal(await https('10.0.0.8', { 'x-forwarded-proto': 'https' }), false, 'not trusted from a non-loopback peer');
});

test('the throttle allows free attempts, then backs off exponentially, per username and per IP', async () => {
    let now = 0;
    await throttleBackoffScenario(new LoginThrottle({ now: () => now, ...BACKOFF_POLICY }), (ms) => { now += ms; });
});

test('throttle entries expire after a quiet period, and unknown names are counted like real ones', async () => {
    let now = 0;
    await throttleExpiryScenario(new LoginThrottle({ now: () => now, ...EXPIRY_POLICY }), (ms) => { now += ms; });
});

test('post-login redirects stay on this site', () => {
    assert.equal(safeNextPath('/devices/abc?x=1'), '/devices/abc?x=1');
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/login', '/logout', '/x\r\nSet-Cookie: a=b', undefined, 42]) {
        assert.equal(safeNextPath(bad), '/', String(bad));
    }
});

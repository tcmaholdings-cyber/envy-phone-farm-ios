import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with node:crypto scrypt: a random 16-byte salt per hash, the
 * parameters stored alongside so they can be raised later without invalidating
 * old hashes, and a constant-time comparison.
 *
 * Stored form: `scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>`.
 */

const scrypt = promisify(crypto.scrypt) as (
    password: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, options: crypto.ScryptOptions,
) => Promise<Buffer>;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// 128 * N * r bytes = 32 MiB at the defaults; allow headroom for raised costs.
const MAX_MEMORY = 128 * 2 ** 20;

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
        N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEMORY,
    });
    return ['scrypt', COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** False for a wrong password and for anything that is not a hash this module wrote. Never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [cost, blockSize, parallelism] = parts.slice(1, 4).map(Number) as [number, number, number];
    if (![cost, blockSize, parallelism].every((value) => Number.isInteger(value) && value > 0)) return false;
    if (cost > 2 ** 20 || blockSize > 32 || parallelism > 16) return false;
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (!salt.length || expected.length < 16) return false;
    try {
        const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
            N: cost, r: blockSize, p: parallelism, maxmem: MAX_MEMORY,
        });
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same scrypt work as a real check when the username does not exist,
 * so response time does not reveal which usernames are real.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
    dummyHash ??= hashPassword(crypto.randomBytes(24).toString('base64url'));
    await verifyPassword(password, await dummyHash);
    return false;
}

// No 0/O/1/l/I: the temporary password is read off a screen and typed on another device.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random temporary password: four groups of five characters (~115 bits). */
export function generatePassword(): string {
    const groups: string[] = [];
    for (let group = 0; group < 4; group += 1) {
        let chunk = '';
        for (let index = 0; index < 5; index += 1) chunk += ALPHABET[crypto.randomInt(ALPHABET.length)];
        groups.push(chunk);
    }
    return groups.join('-');
}

/** Null when acceptable, otherwise the reason — safe to show the user. */
export function passwordProblem(password: unknown, username?: string): string | null {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
    if (username && password.trim().toLowerCase() === username.trim().toLowerCase()) {
        return 'The password cannot be your username.';
    }
    return null;
}

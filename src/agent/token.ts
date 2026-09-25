import crypto from 'node:crypto';

/**
 * Service-to-service authentication for the host agent (docs/multi-host.md):
 * one shared bearer token, PHONE_FARM_AGENT_TOKEN, identical on every host of a
 * farm. Honoured only by the /agent/* routes; it is never a dashboard session.
 */
export const AGENT_TOKEN_MIN_LENGTH = 32;

/** The configured token, or undefined when the agent is off. */
export function agentToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const token = env.PHONE_FARM_AGENT_TOKEN?.trim();
    return token || undefined;
}

/** The bearer credential in an Authorization header, if any. */
export function bearerToken(header: string | undefined): string | undefined {
    return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || undefined : undefined;
}

/** Compare a presented bearer token with the configured one without leaking its length or prefix through timing. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
    if (!presented) return false;
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(presented), digest(expected));
}

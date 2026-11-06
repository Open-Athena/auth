/**
 * Apps registered at runtime rather than in a provider's static `clients`
 * list: the store behind a broker's admin, handed to the provider as
 * `lookupClient: clientLookup(registry)`. D1 implementation:
 * `d1ClientRegistry` in `@open-athena/auth/provider/d1`.
 */
import { b64uEncode } from '../core/base64.js';
/** For `ProviderOptions.lookupClient`: active clients only, so disabling cuts off the next request. */
export const clientLookup = (registry) => async (id) => {
    const c = await registry.get(id);
    return c && c.disabledAt === null
        ? { id: c.id, secretHash: c.secretHash, redirectUris: c.redirectUris, postLogoutRedirectUris: c.postLogoutRedirectUris }
        : null;
};
/** A new client secret: 256 random bits. Show it once; store `hashClientSecret(secret)`. */
export const mintClientSecret = () => b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
const CLIENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** What's wrong with this client id, or null. */
export const clientIdProblem = (id) => CLIENT_ID.test(id) ? null : 'Use lower-case letters, digits and hyphens, starting and ending with a letter or digit.';
const LOOPBACK = new Set(['localhost', '127.0.0.1']);
/**
 * What's wrong with this callback URL for a client registered at runtime, or
 * null. Stricter than the provider, which only needs an exact match: https
 * under one of `domains`, or loopback for local development. This is the limit
 * on what a stolen admin session can do. Must already be in normal form,
 * because the provider compares it exactly with what the app sends.
 */
export function redirectUriProblem(raw, domains) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return `${raw}: not a URL`;
    }
    if (u.username || u.password)
        return `${raw}: no credentials in the URL`;
    if (u.hash || raw.includes('#'))
        return `${raw}: no fragment`;
    if (!LOOPBACK.has(u.hostname)) {
        if (u.protocol !== 'https:')
            return `${raw}: must be https`;
        if (!domains.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`)))
            return `${raw}: must be under ${domains.join(', ')}`;
    }
    else if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return `${raw}: must be http or https`;
    }
    if (u.toString() !== raw)
        return `${raw}: write it as ${u.toString()}`;
    return null;
}

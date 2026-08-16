/**
 * First-party session cookies: `<b64u(claims)>.<b64u(HMAC-SHA256)>`.
 *
 * The claim shape `{v,sub,exp}` is deliberately standardized across consumers
 * (the cookie *name* is not) so a shared codec can read any app's session; see
 * specs/overview.md's "standardize the claim shape" question.
 *
 * `sub` is `e:<email>` for an SSO identity or `g:<grant_id>` for a share link.
 * Grant-backed subs carry no authority of their own: every request re-joins the
 * grant row, so revocation is instant (see `authenticate`).
 */
import { b64uDecodeBytes, b64uDecodeString, b64uEncode } from './base64.js';
export const DEFAULT_COOKIE_NAME = 'oa_auth';
export const DEFAULT_SESSION_TTL_S = 30 * 24 * 3600;
const enc = new TextEncoder();
export const emailSub = (email) => `e:${email}`;
export const grantSub = (id) => `g:${id}`;
/** Split a `sub` into its kind and value, or null if it is not a shape we mint. */
export function parseSub(sub) {
    if (sub.startsWith('e:'))
        return { kind: 'email', value: sub.slice(2) };
    if (sub.startsWith('g:'))
        return { kind: 'grant', value: sub.slice(2) };
    return null;
}
async function hmacKey(secret, usages) {
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}
export async function signSession(sub, secret, nowMs, ttlS = DEFAULT_SESSION_TTL_S) {
    const claims = { v: 1, sub, exp: Math.floor(nowMs / 1000) + ttlS };
    const body = b64uEncode(enc.encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), enc.encode(body));
    return `${body}.${b64uEncode(sig)}`;
}
/** Returns the `sub` claim, or null if the value is malformed, forged, or expired. */
export async function verifySession(value, secret, nowMs) {
    const i = value.indexOf('.');
    if (i < 0)
        return null;
    const body = value.slice(0, i);
    let sig;
    let claims;
    try {
        sig = b64uDecodeBytes(value.slice(i + 1));
    }
    catch {
        return null;
    }
    // Verify before parsing: an unauthenticated payload never reaches JSON.parse.
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, enc.encode(body))))
        return null;
    try {
        claims = JSON.parse(b64uDecodeString(body));
    }
    catch {
        return null;
    }
    const { v, sub, exp } = (claims ?? {});
    if (v !== 1 || typeof sub !== 'string' || typeof exp !== 'number')
        return null;
    // `<=` so expiry is judged identically everywhere: grants (`expiresAt > nowS`),
    // Access JWTs, and sessions all treat "exactly at exp" as expired.
    if (exp * 1000 <= nowMs)
        return null;
    return sub;
}
function cookieAttrs({ secure = true, sameSite = 'Lax', path = '/' }, maxAge) {
    return `HttpOnly;${secure ? ' Secure;' : ''} SameSite=${sameSite}; Path=${path}; Max-Age=${maxAge}`;
}
export function sessionCookie(value, opts = {}) {
    const { name = DEFAULT_COOKIE_NAME, ttlS = DEFAULT_SESSION_TTL_S } = opts;
    return `${name}=${value}; ${cookieAttrs(opts, ttlS)}`;
}
export function clearCookie(opts = {}) {
    const { name = DEFAULT_COOKIE_NAME } = opts;
    return `${name}=; ${cookieAttrs(opts, 0)}`;
}
export function readCookie(req, name) {
    for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name)
            return v.join('=');
    }
    return null;
}
/** `Secure` breaks cookies on plain-http dev origins, so derive it from the request. */
export const isSecureRequest = (req) => new URL(req.url).protocol === 'https:';

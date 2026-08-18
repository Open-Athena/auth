/**
 * Cloudflare Access as an SSO IdP — the *only* CF-gated path in the Tier-2
 * shape. Everything else is public at the edge; this endpoint trades an Access
 * identity for a first-party session cookie and bounces back.
 *
 * We verify the RS256 `Cf-Access-Jwt-Assertion` ourselves rather than trusting
 * `Cf-Access-Authenticated-User-Email`, for two reasons: the friendly header is
 * not forwarded through Pages origin-to-origin proxying, and full verification
 * keeps the identity trustworthy even if the edge gating is later
 * misconfigured or removed.
 *
 * Peers of this file: Google/GitHub OIDC, WorkOS, or no IdP at all
 * (share-links-only). None of them touch `core`.
 */
import { b64uDecodeBytes, b64uDecodeString } from '../core/base64.js';
import { emailSub, isSecureRequest, sessionCookie, signSession } from '../core/session.js';
const enc = new TextEncoder();
/**
 * Verify an Access JWT against the Zero Trust team's public certs and return
 * the authenticated email, or null. `aud` is checked when `expectedAud` is
 * given — do give it: without it any app in the same team is accepted.
 */
export async function verifyAccessJwt(jwt, teamDomain, expectedAud, nowMs = Date.now()) {
    const parts = jwt.split('.');
    if (parts.length !== 3)
        return null;
    const [h, p, s] = parts;
    let header;
    try {
        header = JSON.parse(b64uDecodeString(h));
    }
    catch {
        return null;
    }
    if (header.alg !== 'RS256')
        return null;
    const certs = await fetch(`${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } }).then(r => r.json());
    const jwk = certs.keys.find(k => k.kid === header.kid);
    if (!jwk)
        return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uDecodeBytes(s), enc.encode(`${h}.${p}`));
    if (!ok)
        return null;
    let claims;
    try {
        claims = JSON.parse(b64uDecodeString(p));
    }
    catch {
        return null;
    }
    if (claims.iss !== teamDomain)
        return null;
    // `<=`, not `<`: RFC 7519 requires the current time to be *before* `exp`, and
    // it matches how grant expiry is judged (`expiresAt > nowS`).
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs)
        return null;
    if (expectedAud && !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(expectedAud))
        return null;
    return typeof claims.email === 'string' ? claims.email : null;
}
/** Reject absolute and protocol-relative `next` values — an open redirect off a login path. */
function safeNext(raw) {
    return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}
/**
 * Build the `/auth/sso` handler: verify Access -> mint session -> 302 to `next`.
 * Usable directly as a Pages Function `onRequest`.
 */
export function ssoHandler({ gate, teamDomain, aud }) {
    return async ({ request }) => {
        const email = await accessEmail(request, teamDomain, aud);
        if (email instanceof Response)
            return email;
        const signedIn = await gate.signIn(email, request);
        if (!signedIn)
            return new Response(`${email} is not authorized for this app\n`, { status: 403 });
        return bounce(request, signedIn.cookie);
    };
}
/**
 * `ssoHandler` without a gate — for a deployment that can mint sessions but
 * can't verify them, because the store lives somewhere else. watchy's Pages
 * project is the case: its `/auth/sso` is the only Access-gated path, but the
 * auth authority (and D1 binding) is a separate Worker, so taking a whole gate
 * costs it a binding it has no other use for.
 *
 * Safe because a session cookie carries no authorization: the claim is only
 * `e:<email>`, and scopes are re-derived from `policy` on every `authenticate`.
 * So this mints for any Access-verified email and the gate decides later —
 * the same order of operations `ssoHandler` uses, minus the early rejection
 * (and minus the `signin` audit row, which needs the gate's sink).
 */
export function ssoSessionHandler({ secret, teamDomain, aud, cookieName, sessionTtlS }) {
    return async ({ request }) => {
        const email = await accessEmail(request, teamDomain, aud);
        if (email instanceof Response)
            return email;
        const value = await signSession(emailSub(email), secret, Date.now(), sessionTtlS);
        return bounce(request, sessionCookie(value, { name: cookieName, secure: isSecureRequest(request), ttlS: sessionTtlS }));
    };
}
/** The Access identity, or the response to return instead. */
async function accessEmail(request, teamDomain, aud) {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!jwt)
        return new Response('no Access JWT — is this path still gated?\n', { status: 401 });
    const email = await verifyAccessJwt(jwt, teamDomain, aud);
    if (!email)
        return new Response('Access JWT failed verification\n', { status: 401 });
    return email;
}
const bounce = (request, cookie) => new Response(null, {
    status: 302,
    headers: {
        location: safeNext(new URL(request.url).searchParams.get('next')),
        'set-cookie': cookie,
        'cache-control': 'no-store',
    },
});

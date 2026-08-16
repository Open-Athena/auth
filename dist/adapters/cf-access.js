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
        const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
        if (!jwt)
            return new Response('no Access JWT — is this path still gated?\n', { status: 401 });
        const email = await verifyAccessJwt(jwt, teamDomain, aud);
        if (!email)
            return new Response('Access JWT failed verification\n', { status: 401 });
        const signedIn = await gate.signIn(email, request);
        if (!signedIn)
            return new Response(`${email} is not authorized for this app\n`, { status: 403 });
        const next = safeNext(new URL(request.url).searchParams.get('next'));
        return new Response(null, { status: 302, headers: { location: next, 'set-cookie': signedIn.cookie } });
    };
}
